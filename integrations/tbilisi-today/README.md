# tbilisi.today integration for SiRelay

This directory contains the Linux Mint residential fetchers for tbilisi.today. It is an
**additive integration** in the existing `sitechfromgeorgia/sirelay` repository, not a
second relay coordinator or a replacement for SiRelay's own agent and keys.

The four fetchers use the existing private `~/.sitech/push_key`. Nothing in this
repository contains a token or password. `push_sources.py`, `og_fetch.py` and
`img_push.py` were copied byte-for-byte from the live laptop before the first
install; `content_fetch.py` is the new missing-text path.

## One-time install on Linux Mint

Run the following from the laptop or through its existing agent tunnel:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/sitechfromgeorgia/sirelay/master/integrations/tbilisi-today/install.sh)"
```

The installer clones SiRelay to a temporary directory, validates the existing
`~/.sitech/push_key`, and installs the explicit script/unit allowlist. It keeps
backups of changed files under `~/.sitech/.tt-relay-backup-*/` and never touches
logs, credentials, or the existing SiRelay agent. `sitech-content.timer` and
`sitech-relay-update.timer` are enabled; the three existing timers are preserved.

## Automatic updates

`sitech-relay-update.timer` runs hourly. The updater compares the installed
revision (`~/.sitech/tt-relay-version`) against `sirelay` master. On change it
clones that revision, validates script syntax and unit structure, saves backups,
updates changed files atomically, reloads systemd and enables new timers.
A failed fetch or validation leaves the installed version unchanged, so the next
run retries. This does **not** deploy the SiRelay coordinator.

```bash
python3 ~/.sitech/update_tt_relay.py --check
systemctl --user start sitech-relay-update.service
journalctl --user -u sitech-relay-update.service -n 30 --no-pager
```

Jobs: source listings every 10 min (`sitech-push`), images every 5 min
(`sitech-imgpush`), article og:image every 10 min (`sitech-og`), missing full
article text every 10 min (`sitech-content`). The source-facing routes are
admin-gated on tt-ingest. The new text lane is for tvpirveli (challenge-blocked)
and bpn leftovers; bpn also has a bounded server-side Browser Rendering fallback.

**Publishing rule:** Edit this directory in the existing SiRelay repo, test in
a scratch HOME and on one real laptop article with `--dry` before enabling the
content timer, then push master. Do not commit pycache, installers with embedded
keys, logs or any `~/.sitech/` state. Verify the laptop's installed SHA and timer,
then read the D1 article back before declaring end to end success.
