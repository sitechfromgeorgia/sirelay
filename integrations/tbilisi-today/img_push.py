#!/usr/bin/env python3
"""sitech blocked-image relay - pulls the image URLs whose CDNs refuse datacenter egress
(rustavi2.ge, gurianews.com) from tt-web's /img-queue, fetches them from this laptop's
residential IP, and pushes the bytes back through /img-put (stored in R2, served via /img).

Runs every 15 minutes via systemd user timer (sitech-imgpush.timer). Model: og_fetch.py.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse

WORKER = "https://tbilisi.today"
KEY_FILE = os.path.expanduser("~/.sitech/push_key")
LOG_FILE = os.path.expanduser("~/.sitech/img_push.log")
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
BATCH = int(sys.argv[1]) if len(sys.argv) > 1 else 200   # queue pull size (worker caps at 500; 200 keeps every 5-min pull fast)
DELAY = 1.2          # seconds between image fetches
MAX_BYTES = 3 * 1024 * 1024


def key() -> str:
    with open(KEY_FILE, encoding="utf-8") as fh:
        return fh.read().strip()


def get_queue(limit: int, days: int) -> list:
    url = f"{WORKER}/img-queue?limit={limit}&days={days}&key={urllib.parse.quote(key())}"
    proc = subprocess.run(
        ["curl", "-sS", "--compressed", "--max-time", "60", "-A", UA, url],
        capture_output=True, timeout=90,
    )
    try:
        return json.loads(proc.stdout.decode()).get("items", [])
    except json.JSONDecodeError:
        print("queue fetch failed: " + proc.stdout.decode()[:200], file=sys.stderr)
        return []


def fetch_image(url: str):
    """-> (path, content_type, size) on success; ('', ctype, size) otherwise. Caller unlinks path."""
    fd, path = tempfile.mkstemp(prefix="imgpush-", suffix=".bin")
    os.close(fd)
    try:
        proc = subprocess.run(
            ["curl", "-sSL", "--compressed", "--max-time", "45", "-A", UA,
             "-o", path, "-w", "%{http_code} %{content_type} %{size_download}", url],
            capture_output=True, timeout=75,
        )
        parts = proc.stdout.decode("utf-8", "ignore").strip().split(" ", 2)
        code = int(parts[0]) if parts and parts[0].isdigit() else 0
        ctype = parts[1] if len(parts) > 1 else ""
        size = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
        if code == 200 and ctype.startswith("image/") and 0 < size <= MAX_BYTES:
            return path, ctype, size
        os.unlink(path)
        return "", ctype, size
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        return "", "", 0


def put_image(url: str, path: str, ctype: str) -> dict:
    q = urllib.parse.quote(url, safe="")
    c = urllib.parse.quote(ctype, safe="")
    proc = subprocess.run(
        ["curl", "-sS", "--compressed", "--max-time", "60", "-X", "POST",
         "-H", f"x-admin-key: {key()}", "-H", "Content-Type: application/octet-stream",
         "--data-binary", "@" + path, f"{WORKER}/img-put?u={q}&ct={c}"],
        capture_output=True, timeout=90,
    )
    try:
        return json.loads(proc.stdout.decode())
    except json.JSONDecodeError:
        return {"error": proc.stdout.decode()[:120]}


def main() -> int:
    items = get_queue(BATCH, 90)
    if not items:
        print("queue empty")
        return 0
    todo = [it for it in items if not it.get("have")]
    if not todo:
        print(f"queue={len(items)} all stored already")
        return 0
    ok = skipped = failed = 0
    for i, it in enumerate(todo):
        if i:
            time.sleep(DELAY)
        url = str(it.get("u", ""))
        path, ctype, size = fetch_image(url)
        if not path:
            failed += 1
            print(f"  FETCH-FAIL {url[:110]} [{ctype} {size}]", flush=True)
            continue
        resp = put_image(url, path, ctype)
        try:
            os.unlink(path)
        except OSError:
            pass
        if resp.get("ok"):
            if resp.get("skipped"):
                skipped += 1
            else:
                ok += 1
        else:
            failed += 1
            print(f"  PUT-FAIL {url[:110]} {resp.get('error')}", flush=True)
    line = (
        f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} queue={len(items)} "
        f"todo={len(todo)} pushed={ok} skipped={skipped} failed={failed}"
    )
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
