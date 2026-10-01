#!/usr/bin/env python3
"""sitech og:image fetcher — pulls blocked-source article pages from the laptop's
residential IP and reports their og:image back to tt-ingest.

Runs every 10 minutes via systemd user timer (sitech-og.timer).

2026-09-24: added a headless-Chromium fallback. tvpirveli/tabula article pages answer a
Cloudflare managed challenge to plain curl (403, ~3.5 KB, <title>Just a moment...</title>,
no og tags) even from this residential IP, while the bundled Playwright Chromium solves it
and returns the real page (measured: 110 KB with the correct og:image). So: try curl first,
fall back to Chromium when the response looks like a challenge or yields no og:image.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

WORKER = "https://tt-ingest.sitech-georgia.workers.dev"
KEY_FILE = os.path.expanduser("~/.sitech/push_key")
LOG_FILE = os.path.expanduser("~/.sitech/og.log")
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
BATCH = 15          # articles per run
DELAY = 4           # seconds between article fetches

CHALLENGE_MARKERS = ("Just a moment", "cf-challenge", "Attention Required", "DDoS protection")


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


def get_queue(limit: int) -> list[dict]:
    out = curl(f"{WORKER}/og-queue?limit={limit}&key={key()}")
    try:
        return json.loads(out).get("queue", [])
    except json.JSONDecodeError:
        return []


def post_results(items: list[dict]) -> dict:
    body = json.dumps({"items": items}).encode()
    proc = subprocess.run(
        [
            "curl", "-sS", "--compressed", "--max-time", "60", "-X", "POST",
            "-H", "Content-Type: application/json", "-H", f"x-admin-key: {key()}",
            "--data-binary", "@-", f"{WORKER}/og-result",
        ],
        input=body, capture_output=True, timeout=90,
    )
    try:
        return json.loads(proc.stdout.decode())
    except json.JSONDecodeError:
        return {"error": proc.stdout.decode()[:120]}


def og_image(html: str) -> str:
    m = (
        re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
        or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html, re.I)
        or re.search(r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
    )
    img = (m.group(1) if m else "").strip()
    if img.startswith("//"):
        img = "https:" + img
    if not img.startswith("http") or re.search(r"logo|icon|placeholder|1x1|pixel|default", img, re.I):
        return ""
    return img


def looks_like_challenge(html: str) -> bool:
    if len(html) < 15000:
        return True
    return any(marker in html for marker in CHALLENGE_MARKERS)


def main() -> int:
    queue = get_queue(BATCH)
    if not queue:
        print("queue empty")
        return 0
    results = []
    via_browser = 0
    misses = []
    for i, item in enumerate(queue):
        if i:
            time.sleep(DELAY)
        img = ""
        try:
            html = curl(item["url"])
            img = og_image(html)
            if not img or looks_like_challenge(html):
                dom = browser_dom(item["url"])
                if dom:
                    img2 = og_image(dom)
                    if img2:
                        img = img2
                        via_browser += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  #{item['id']}: {type(exc).__name__}", flush=True)
        if img:
            results.append({"id": item["id"], "image_url": img})
        else:
            # Report the miss as well (empty image_url) so the worker can count the attempt and
            # eventually drop the item: without it, dead items stay in the queue forever and eat
            # most of every run (Edo 2026-09-25: „ფოტოები რატო არ ჩაისვა ამ სტატიებზე“).
            results.append({"id": item["id"], "image_url": ""})
            misses.append(item["id"])
    resp = post_results(results)
    line = (
        f"queue={len(queue)} found={len(results) - len(misses)} via_browser={via_browser} "
        f"missed={len(misses)} posted={resp.get('updated', resp.get('error'))}"
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
