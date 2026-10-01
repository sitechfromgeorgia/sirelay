#!/usr/bin/env python3
"""Offline integration test: initial install, real git update, invalid update rollback."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import update_tt_relay as mod

ROOT = Path(__file__).resolve().parent
UPDATER = ROOT / "update_tt_relay.py"


def git(*args):
    p = subprocess.run(["git", *map(str, args)], text=True, capture_output=True)
    if p.returncode:
        raise AssertionError(p.stderr)
    return p.stdout.strip()


class RelayUpdaterTest(unittest.TestCase):
    def test_initial_update_and_syntax_failure(self):
        with tempfile.TemporaryDirectory(prefix="tt-relay-test-") as temp:
            base = Path(temp)
            home = base / "home"
            (home / ".sitech").mkdir(parents=True)
            key = home / ".sitech/push_key"
            key.write_text("fake-test-only", encoding="utf-8")
            origin = base / "origin.git"
            work = base / "work"
            git("init", "--bare", "--initial-branch=master", origin)
            git("clone", origin, work)
            pack = work / "integrations/tbilisi-today"
            shutil.copytree(ROOT, pack, ignore=shutil.ignore_patterns("__pycache__"))
            git("-C", work, "add", ".")
            git("-C", work, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "v1")
            git("-C", work, "push", "origin", "master")
            mod.REPO = str(origin)
            mod.HOME = home
            mod.DEST = home / ".sitech"
            mod.USER_UNITS = home / ".config/systemd/user"
            mod.VERSION = mod.DEST / "tt-relay-version"
            mod.LOCK = mod.DEST / ".tt-relay-update.lock"
            mod.LOG = mod.DEST / "tt-relay-update.log"
            old_argv = sys.argv
            sys.argv = [str(UPDATER), "--no-systemd"]
            try:
                self.assertGreater(mod.main(), 0)
                sha1 = mod.VERSION.read_text().strip()
                self.assertEqual(sha1, git("-C", work, "rev-parse", "HEAD"))
                self.assertEqual(key.read_text(), "fake-test-only")
                self.assertEqual(mod.main(), 0)  # no new commit, no work
                src = pack / "content_fetch.py"
                src.write_text(src.read_text() + "\n# integration test version two\n")
                git("-C", work, "add", ".")
                git("-C", work, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "v2")
                git("-C", work, "push", "origin", "master")
                self.assertEqual(mod.main(), 1)
                sha2 = mod.VERSION.read_text().strip()
                self.assertNotEqual(sha1, sha2)
                self.assertIn("integration test version two", (mod.DEST / "content_fetch.py").read_text())
                self.assertEqual(len(list(mod.DEST.glob(".tt-relay-backup-*"))), 1)
                src.write_text("broken syntax (\n" + ("# filler for syntax-gate test\n" * 5))
                git("-C", work, "add", ".")
                git("-C", work, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "bad")
                git("-C", work, "push", "origin", "master")
                self.assertEqual(mod.main(), -1)
                self.assertEqual(mod.VERSION.read_text().strip(), sha2)
                self.assertIn("integration test version two", (mod.DEST / "content_fetch.py").read_text())
                self.assertEqual(key.read_text(), "fake-test-only")
            finally:
                sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()
