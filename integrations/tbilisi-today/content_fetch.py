#!/usr/bin/env python3
"""sitech content fetcher - pulls tvpirveli/bpn article bodies from the laptop's residential IP
and reports them back to tt-ingest (/content-queue -> /content-put).

Runs every 10 minutes via systemd user timer (sitech-content.timer), same shape as og_fetch.py.

Why this lane exists (2026-10-01, Lucy deep audit P1-5): both outlets' article pages answer a
Cloudflare managed challenge (tvpirveli) or serve a JS-only shell (bpn) to the worker, the SiRelay
edge and Browser Rendering alike. Even from this residential IP plain curl gets a challenge page
for tvpirveli, while the bundled Playwright Chromium renders both sites. So: curl first, Chromium
fallback when the response looks like a challenge or the extraction falls short.

The body must clear 400 chars (the worker stores nothing shorter - a shorter extraction is
reported as a miss, which burns one of the row's 6 relay tries).

Usage:
  python3 content_fetch.py                 # normal run: fetch queue, post results
  python3 content_fetch.py --dry --limit 5 # first look: extract + print, post NOTHING
  python3 content_fetch.py --selftest FILE # run the extractor on a local HTML file
"""
import glob
import html as html_mod
import json
import os
import re
import subprocess
import sys
import time

WORKER = "https://tt-ingest.sitech-georgia.workers.dev"
KEY_FILE = os.path.expanduser("~/.sitech/push_key")
LOG_FILE = os.path.expanduser("~/.sitech/content.log")
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
BATCH = 12          # articles per run
DELAY = 4           # seconds between article fetches
MIN_CHARS = 400     # a stored body must clear this (worker policy)
MAX_CHARS = 20000   # same cap the worker applies on store

CHALLENGE_MARKERS = ("Just a moment", "cf-challenge", "Attention Required", "DDoS protection")

# Same teaser-tail cut as the worker's extractBodyText: related-news blocks ("მსგავსი სიახლეები")
# list OTHER articles; stored as part of the body they poison entity extraction.
TEASER_MARKS = (
    "მსგავსი სიახლეები", "მსგავსი ამბები", "ასევე ნახეთ", "ნახეთ ასევე",
    "სხვა სიახლეები", "Related news", "Similar news",
)


def key() -> str:
    with open(KEY_FILE, encoding="utf-8") as fh:
        return fh.read().strip()


def curl(url: str, timeout: int = 30) -> str:
    proc = subprocess.run(
        ["curl", "-sSL", "--compressed", "--max-time", str(timeout), "-A", UA, url],
        capture_output=True,
        timeout=timeout + 15,
    )
    return proc.stdout.decode("utf-8", errors="ignore")


def chrome_binary() -> str:
    """The Playwright-managed Chromium (no sudo needed, already on this machine)."""
    for pat in (
        "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
        "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    ):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    return ""


def browser_dom(url: str, timeout: int = 45) -> str:
    """Full rendered DOM after the challenge JS has run (--virtual-time-budget lets it settle)."""
    chrome = chrome_binary()
    if not chrome:
        return ""
    try:
        proc = subprocess.run(
            [
                chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                "--virtual-time-budget=12000", f"--user-agent={UA}", "--dump-dom", url,
            ],
            capture_output=True,
            timeout=timeout + 30,
        )
    except subprocess.TimeoutExpired:
        return ""
    return proc.stdout.decode("utf-8", errors="ignore")


def get_queue(limit: int) -> list:
    out = curl(f"{WORKER}/content-queue?limit={limit}&key={key()}")
    try:
        return json.loads(out).get("queue", [])
    except json.JSONDecodeError:
        return []


def post_results(items: list) -> dict:
    body = json.dumps({"items": items}).encode()
    proc = subprocess.run(
        [
            "curl", "-sS", "--compressed", "--max-time", "60", "-X", "POST",
            "-H", "Content-Type: application/json", "-H", f"x-admin-key: {key()}",
            "--data-binary", "@-", f"{WORKER}/content-put",
        ],
        input=body, capture_output=True, timeout=90,
    )
    try:
        return json.loads(proc.stdout.decode())
    except json.JSONDecodeError:
        return {"error": proc.stdout.decode()[:120]}


def strip_tags(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return html_mod.unescape(s)


def norm(s: str) -> str:
    return re.sub(r"[ \t\u00a0]+", " ", s).replace("\u200b", "").strip()


CONTAINERS = (
    r"<article\b[^>]*>(.*?)</article>",
    r"<div[^>]+itemprop=[\"']articleBody[\"'][^>]*>(.*?)</div>",
    r"<div[^>]+class=[\"'][^\"']*(?:article|entry|post|news|story)[-_ ]?(?:body|content|text|detail|inner|descr)[^\"']*[\"'][^>]*>(.*?)</div>",
    r"<main\b[^>]*>(.*?)</main>",
)


def paras(fragment: str) -> list:
    out = []
    for m in re.finditer(r"<p\b[^>]*>(.*?)</p>", fragment, re.S | re.I):
        t = norm(strip_tags(m.group(1)))
        if len(t) >= 40 and (not out or out[-1] != t):
            out.append(t)
    return out


def best_run(ps: list) -> list:
    """Longest consecutive run of paragraphs (article bodies are contiguous; menus/captions break it)."""
    best, cur, best_len, cur_len = [], [], 0, 0
    for p in ps:
        cur.append(p)
        cur_len += len(p)
        if len(p) < 60:
            if cur_len > best_len:
                best, best_len = cur[:], cur_len
            cur, cur_len = [], 0
    if cur_len > best_len:
        best = cur
    return best


def cut_teasers(text: str) -> str:
    cuts = [text.find(mk) for mk in TEASER_MARKS]
    cuts = [i for i in cuts if i > 300]
    return text[: min(cuts)].strip() if cuts else text


def article_text(html: str):
    """-> (text, strategy). Containers first, then whole-document paragraph runs."""
    best, best_pat = "", ""
    for pat in CONTAINERS:
        for m in re.finditer(pat, html, re.S | re.I):
            cand = "\n\n".join(paras(m.group(1)))
            if len(cand) > len(best):
                best, best_pat = cand, "container"
    if len(best) >= MIN_CHARS:
        return cut_teasers(best)[:MAX_CHARS], best_pat
    ps = paras(html)
    if not ps:
        return "", "none"
    run = "\n\n".join(best_run(ps))
    if len(run) >= MIN_CHARS:
        return cut_teasers(run)[:MAX_CHARS], "p-run"
    return cut_teasers("\n\n".join(ps))[:MAX_CHARS], "p-all"


def looks_like_challenge(html: str) -> bool:
    if len(html) < 15000:
        return True
    return any(marker in html for marker in CHALLENGE_MARKERS)


def fetch_text(item: dict):
    """-> (result_item, via, strategy); result_item carries text or error."""
    html = ""
    try:
        html = curl(item["url"])
    except Exception as exc:  # noqa: BLE001
        print(f"  #{item['id']}: curl {type(exc).__name__}", flush=True)
    text, strategy = article_text(html) if html else ("", "none")
    via = "curl"
    if len(text) < MIN_CHARS or looks_like_challenge(html):
        dom = browser_dom(item["url"])
        if dom:
            t2, s2 = article_text(dom)
            if len(t2) > len(text):
                text, strategy, via = t2, s2, "browser"
    if len(text) >= MIN_CHARS:
        return {"id": item["id"], "text": text}, via, strategy
    return {"id": item["id"], "error": f"short {len(text)}"}, via, strategy


def main() -> int:
    if "--selftest" in sys.argv:
        path = sys.argv[sys.argv.index("--selftest") + 1]
        text, strategy = article_text(open(path, encoding="utf-8", errors="ignore").read())
        print(f"selftest {path}: {len(text)} chars, strategy={strategy}")
        print("preview:", text[:200].replace("\n", " "))
        return 0
    dry = "--dry" in sys.argv
    limit = BATCH
    if "--limit" in sys.argv:
        try:
            limit = max(1, int(sys.argv[sys.argv.index("--limit") + 1]))
        except (ValueError, IndexError):
            pass
    queue = get_queue(limit)
    if not queue:
        print("queue empty")
        return 0
    results = []
    misses = []
    for i, item in enumerate(queue):
        if i:
            time.sleep(DELAY)
        try:
            res, via, strategy = fetch_text(item)
        except Exception as exc:  # noqa: BLE001
            res, via, strategy = {"id": item["id"], "error": type(exc).__name__}, "-", "-"
        if "text" in res:
            print(f"  #{res['id']} ok {len(res['text'])} chars via={via}/{strategy}", flush=True)
            if dry:
                print("     preview:", res["text"][:90].replace("\n", " "))
            results.append(res)
        else:
            print(f"  #{res['id']} miss ({res['error']}) via={via}", flush=True)
            misses.append(res["id"])
            results.append(res)
    if dry:
        ok = len(results) - len(misses)
        print(f"DRY RUN: queue={len(queue)} ok={ok} missed={len(misses)} (nothing posted)")
        return 0
    resp = post_results(results)
    line = (
        f"queue={len(queue)} found={len(results) - len(misses)} missed={len(misses)} "
        f"posted={resp.get('updated', resp.get('error'))}"
    )
    if misses:
        line += f" miss_ids={','.join(str(m) for m in misses[:8])}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
