#!/usr/bin/env python3
"""sitech residential fetcher — pulls bot-blocked Georgian news sources from this
laptop's home IP and pushes the raw HTML to the tt-ingest worker.

Fetch modes:
  curl    — plain HTTP (fast); works for sites that only block datacenter IPs
  browser — Playwright's bundled chromium (headless) for sites behind a
            Cloudflare JS challenge ("Just a moment...")

Runs every 10 minutes via systemd user timer (sitech-push.timer).
Also bridges sitech.ge: pushes cybernews.com items to the sitech-crawler /ingest
(~every 30 min, chromium browser mode - see the sitech.ge section below).
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time

WORKER = "https://tt-ingest.sitech-georgia.workers.dev/push"
KEY_FILE = os.path.expanduser("~/.sitech/push_key")
LOG_FILE = os.path.expanduser("~/.sitech/push.log")
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

SOURCES = {
    "rustavi2": {"url": "https://www.rustavi2.ge/ka/news", "mode": "curl"},
    "bm": {"url": "https://bm.ge/", "mode": "curl"},
    "tvpirveli": {"url": "https://tvpirveli.ge/", "mode": "browser"},
    "tabula": {"url": "https://tabula.ge/ge/news", "mode": "browser"},
    "1tv": {"url": "https://1tv.ge/", "mode": "curl"},
    "publika": {"url": "https://www.publika.ge/feed/", "mode": "curl"},
    "bpn": {"url": "https://www.bpn.ge/", "mode": "browser"},
    "kvirispalitra": {"url": "https://kvirispalitra.ge/", "mode": "browser"},
    "gurianews": {"url": "https://gurianews.com/", "mode": "browser"},
}

# The sites rate-limit bursts (Cloudflare error 1010) — space the requests out.
DELAY_BETWEEN = 15   # seconds between sources
RETRY_AFTER = 45     # seconds before retrying a failed source
BROWSER_BUDGET = 30000  # ms of virtual time for the JS challenge

# ───────── sitech.ge crawler bridge (added 2026-10-04) ─────────
# cybernews.com answers every datacenter/non-browser client with a Cloudflare challenge;
# the sitech-crawler worker cannot fetch it. This machine CAN (chromium passes), so the
# news sitemap + homepage are fetched here and items are pushed to the crawler's /ingest.
SITECH_INGEST = "https://crawler.sitech.ge/ingest"
CN_SECTIONS = ("news", "privacy", "security", "ai", "cyber-war", "crypto", "tech",
               "gaming", "gadgets", "science", "editorial", "cybercrime")


def parse_cybernews_sitemap(xml: str):
    items = []
    for block in re.findall(r"<url>(.*?)</url>", xml, re.S)[:40]:
        loc = re.search(r"<loc>([^<]+)</loc>", block)
        title = re.search(r"<news:title>([^<]+)</news:title>", block)
        date = re.search(r"<news:publication_date>([^<]+)</news:publication_date>", block)
        if not loc:
            continue
        url = loc.group(1).strip()
        parts = url.split("/")
        if len(parts) < 6 or parts[3] not in CN_SECTIONS or not url.endswith("/"):
            continue
        t = title.group(1).strip() if title else ""
        if not t:
            t = " ".join(w.capitalize() for w in url.rstrip("/").split("/")[-1].split("-"))
        items.append({"title": t, "link": url, "date": date.group(1).strip() if date else ""})
    return items


def parse_cybernews_home(html: str):
    items, seen = [], set()
    pat = r'href="(https://cybernews\.com/(?:' + "|".join(CN_SECTIONS) + r')/[a-z0-9-]+/)"[^>]*>([^<]{10,200})</a>'
    for m in re.finditer(pat, html):
        url, text = m.group(1), re.sub(r"\s+", " ", m.group(2)).strip()
        if url in seen:
            continue
        seen.add(url)
        text = re.sub(r"\s+[A-Z][a-z]{2}\s+\d{1,2}(\s+\d+ min read)?\s*$", "", text).strip()
        if len(text) > 10:
            items.append({"title": text, "link": url})
        if len(items) >= 40:
            break
    return items


def push_cybernews() -> str:
    first_err = ""
    items = []
    try:
        items = parse_cybernews_sitemap(fetch_browser("https://cybernews.com/news-sitemap.xml"))
    except Exception as exc:  # noqa: BLE001
        first_err = f"{type(exc).__name__}: {str(exc)[:80]}"
    if len(items) < 3:
        try:
            home = parse_cybernews_home(fetch_browser("https://cybernews.com/"))
            if home:
                items = home
        except Exception as exc2:  # noqa: BLE001
            return f"cybernews: FAILED sitemap({first_err}) home({type(exc2).__name__}: {str(exc2)[:80]})"
    if not items:
        return f"cybernews: FAILED no items (sitemap err: {first_err or 'empty'})"
    body = json.dumps({"source": "cybernews", "items": items}).encode("utf-8")
    try:
        cn_key = open(os.path.expanduser("~/.sitech/crawler_run_key"), encoding="utf-8").read().strip()
    except OSError:
        cn_key = ""
    proc = subprocess.run(
        ["curl", "-sS", "--compressed", "--max-time", "90", "-X", "POST",
         "-H", "Content-Type: application/json",
         "-H", f"x-run-key: {cn_key}",
         "--data-binary", "@-", SITECH_INGEST],
        input=body, capture_output=True, timeout=120,
    )
    if proc.returncode != 0:
        return f"cybernews: ingest curl exit {proc.returncode}"
    try:
        res = json.loads(proc.stdout.decode("utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return f"cybernews: bad ingest response {proc.stdout[:100]!r}"
    return f"cybernews[browser]: items={len(items)} upserted={res.get('upserted')} ok={res.get('ok')}"


def key() -> str:
    with open(KEY_FILE, encoding="utf-8") as fh:
        return fh.read().strip()


def find_chromium() -> str:
    """Prefer the full chromium build — it passes Cloudflare challenges that the
    headless-shell build fails (headless-shell passes tvpirveli but not tabula)."""
    patterns = [
        os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome"),
        os.path.expanduser(
            "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"
        ),
    ]
    for pat in patterns:
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    raise RuntimeError("no chromium found under ~/.cache/ms-playwright")


def fetch_curl(url: str) -> str:
    """curl — Python's urllib TLS fingerprint trips Cloudflare's bot check (1010)."""
    proc = subprocess.run(
        [
            "curl", "-sSL", "--compressed", "--max-time", "40",
            "-A", UA,
            "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "-H", "Accept-Language: ka-GE,ka;q=0.9,en;q=0.8",
            url,
        ],
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl exit {proc.returncode}: {proc.stderr[:140]!r}")
    body = proc.stdout.decode("utf-8", errors="ignore")
    if len(body) < 500:
        raise RuntimeError(f"tiny body ({len(body)} bytes)")
    return body


def fetch_browser(url: str) -> str:
    """Headless chromium — executes the Cloudflare JS challenge and dumps the DOM."""
    binary = find_chromium()
    proc = subprocess.run(
        [
            binary, "--headless=new", "--disable-gpu", "--no-sandbox",
            f"--user-agent={UA}",
            f"--virtual-time-budget={BROWSER_BUDGET}",
            "--dump-dom", url,
        ],
        capture_output=True,
        timeout=180,
    )
    body = proc.stdout.decode("utf-8", errors="ignore")
    if "Just a moment" in body[:1200] or "Attention Required" in body[:1200]:
        raise RuntimeError("cloudflare challenge not passed")
    if len(body) < 2000:
        raise RuntimeError(f"tiny body ({len(body)} bytes)")
    return body


def fetch(url: str, mode: str) -> str:
    return fetch_browser(url) if mode == "browser" else fetch_curl(url)


def push(slug: str, html: str) -> dict:
    body = json.dumps({"source": slug, "html": html}).encode("utf-8")
    proc = subprocess.run(
        [
            "curl", "-sS", "--compressed", "--max-time", "90", "-X", "POST",
            "-H", "Content-Type: application/json",
            "-H", f"x-admin-key: {key()}",
            "--data-binary", "@-",
            WORKER,
        ],
        input=body,
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl exit {proc.returncode}: {proc.stderr[:140]!r}")
    out = proc.stdout.decode("utf-8", errors="ignore")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError(f"bad worker response: {out[:140]!r}")


def main() -> int:
    if "--cybernews" in sys.argv:
        line = push_cybernews()
        print(line)
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass
        return 0 if "FAILED" not in line else 1
    lines = []
    ok = 0
    items = list(SOURCES.items())
    for idx, (slug, cfg) in enumerate(items):
        if idx:
            time.sleep(DELAY_BETWEEN)
        url, mode = cfg["url"], cfg["mode"]
        try:
            html = fetch(url, mode)
        except Exception as exc:  # noqa: BLE001 — one retry after a cooldown
            lines.append(f"{slug}: retry ({type(exc).__name__}: {str(exc)[:70]})")
            time.sleep(RETRY_AFTER)
            try:
                html = fetch(url, mode)
            except Exception as exc2:  # noqa: BLE001
                lines.append(f"{slug}: FAILED {type(exc2).__name__}: {str(exc2)[:90]}")
                continue
        try:
            res = push(slug, html)
            lines.append(f"{slug}[{mode}]: html={len(html)} parsed={res.get('parsed')} new={res.get('inserted')}")
            ok += 1
        except Exception as exc:  # noqa: BLE001
            lines.append(f"{slug}: push ERROR {type(exc).__name__}: {str(exc)[:90]}")
    cn_line = ""
    if datetime.datetime.now().minute % 30 < 10:
        cn_line = push_cybernews()
        lines.append(cn_line)
    out = "\n".join(lines)
    print(out)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(out + "\n")
    except OSError:
        pass
    return 0 if ok == len(SOURCES) and "FAILED" not in cn_line else 1


if __name__ == "__main__":
    sys.exit(main())
