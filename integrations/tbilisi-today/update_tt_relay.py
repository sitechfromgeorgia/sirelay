#!/usr/bin/env python3
"""Deploy the tbilisi.today residential workers from the existing SiRelay repo.

No secrets are copied or logged. Only the explicitly named script/unit files are owned.
The updater checks the remote SHA hourly, stages a clean checkout, and replaces changed
files with backups; it does not touch the SiRelay agent or coordinator.
"""
import argparse
import datetime as dt
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = "https://github.com/sitechfromgeorgia/sirelay.git"
BRANCH = "master"
RELATIVE = Path("integrations/tbilisi-today")
SCRIPTS = ("content_fetch.py", "push_sources.py", "og_fetch.py", "img_push.py", "update_tt_relay.py")
UNITS = (
    "sitech-push.service", "sitech-push.timer", "sitech-og.service", "sitech-og.timer",
    "sitech-imgpush.service", "sitech-imgpush.timer", "sitech-content.service",
    "sitech-content.timer", "sitech-relay-update.service", "sitech-relay-update.timer",
)
HOME = Path.home()
DEST = HOME / ".sitech"
USER_UNITS = HOME / ".config/systemd/user"
VERSION = DEST / "tt-relay-version"
LOG = DEST / "tt-relay-update.log"
LOCK = DEST / ".tt-relay-update.lock"


def git(*args, timeout=90):
    p = subprocess.run(["git", *map(str, args)], text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"git {' '.join(str(x) for x in args[:2])} failed: {p.stderr.strip()[:180]}")
    return p.stdout.strip()


def log(msg):
    print(msg, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(dt.datetime.now(dt.timezone.utc).isoformat() + " " + msg + "\n")


def remote_sha():
    lines = git("ls-remote", REPO, f"refs/heads/{BRANCH}", timeout=45).splitlines()
    if len(lines) != 1 or len(lines[0].split()[0]) != 40:
        raise RuntimeError("remote master SHA unavailable")
    return lines[0].split()[0]


def local_sha():
    return VERSION.read_text(encoding="utf-8").strip() if VERSION.exists() else ""


def validate(src):
    for name in SCRIPTS:
        p = src / name
        if not p.is_file() or p.is_symlink() or p.stat().st_size < 100:
            raise RuntimeError(f"invalid pack script: {name}")
        check = subprocess.run([sys.executable, "-B", "-c", "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())", str(p)],
                               capture_output=True, text=True, timeout=20)
        if check.returncode:
            raise RuntimeError(f"syntax error in {name}: {check.stderr[-250:]}")
    for name in UNITS:
        p = src / "systemd" / name
        if not p.is_file() or p.is_symlink():
            raise RuntimeError(f"missing unit: {name}")
        text = p.read_text(encoding="utf-8")
        if ("[Unit]" not in text or (name.endswith(".timer") and "[Timer]" not in text)
                or (name.endswith(".service") and "[Service]" not in text)):
            raise RuntimeError(f"invalid unit: {name}")


def install_from(src, sha, no_systemd=False):
    validate(src)
    changes = []
    for name in SCRIPTS:
        changes.append((src / name, DEST / name, 0o700))
    for name in UNITS:
        changes.append((src / "systemd" / name, USER_UNITS / name, 0o644))
    changes = [(a,b,mode) for a,b,mode in changes if not b.exists() or a.read_bytes() != b.read_bytes()]
    backup_dir = DEST / (".tt-relay-backup-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    done = []
    try:
        for src_file, dst, mode in changes:
            dst.parent.mkdir(parents=True, exist_ok=True)
            had_old = dst.exists()
            if had_old:
                backup_dir.mkdir(mode=0o700, exist_ok=True)
                backup = backup_dir / dst.name
                shutil.copy2(dst, backup)
            fd, tmp = tempfile.mkstemp(prefix=".tt-relay-", dir=dst.parent)
            try:
                with os.fdopen(fd,"wb") as f: f.write(src_file.read_bytes())
                os.chmod(tmp, mode)
                os.replace(tmp, dst)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
            done.append((dst, had_old))
        if not no_systemd:
            subprocess.run(["systemctl","--user","daemon-reload"], check=True, timeout=60)
            for name in ("sitech-content.timer", "sitech-relay-update.timer"):
                subprocess.run(["systemctl","--user","enable","--now",name], check=True, timeout=60,
                               capture_output=True, text=True)
        VERSION.write_text(sha + "\n", encoding="utf-8")
        log(f"applied {sha[:12]}: {len(changes)} file(s) changed" + (f"; backup {backup_dir}" if backup_dir.exists() else ""))
        return len(changes)
    except Exception:
        for dst, had_old in reversed(done):
            if had_old: os.replace(backup_dir / dst.name, dst)
            else: dst.unlink(missing_ok=True)
        if not no_systemd:
            subprocess.run(["systemctl","--user","daemon-reload"], timeout=60, check=False)
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--from-dir", type=Path, help="clean local checkout for the first install or tests")
    ap.add_argument("--no-systemd", action="store_true", help="sandbox tests only")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
    with LOCK.open("w") as f:
        try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return 0
        try:
            local = local_sha()
            if a.from_dir:
                repo = a.from_dir.resolve()
                sha = git("-C",repo,"rev-parse","HEAD")
                if not (repo / RELATIVE / "content_fetch.py").is_file():
                    raise RuntimeError("not a SiRelay checkout with a tbilisi.today integration")
                return install_from(repo / RELATIVE, sha, a.no_systemd)
            sha = remote_sha()
            if a.check:
                print("installed:", local[:12] or "none", "remote:", sha[:12],
                      "state:", "current" if sha==local else "update available")
                return 0
            if sha == local and not a.force: return 0
            with tempfile.TemporaryDirectory(prefix="tt-relay-") as td:
                repo = Path(td) / "sirelay"
                git("clone", "--depth=1", "--branch", BRANCH, REPO, repo, timeout=120)
                actual = git("-C",repo,"rev-parse","HEAD")
                if actual != sha:  # master moved during the clone; retry next hour
                    log("master moved during download; will retry next tick")
                    return -1
                return install_from(repo / RELATIVE, sha, a.no_systemd)
        except Exception as e:
            log(f"update failed: {type(e).__name__}: {e}")
            return -1


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)  # 0 changed and N changed are both successes
