#!/usr/bin/env bash
# One-time install for Edo's Linux Mint laptop. Existing SiRelay repo is the source.
set -euo pipefail
command -v git >/dev/null || { printf 'git is required\n' >&2; exit 1; }
command -v python3 >/dev/null || { printf 'python3 is required\n' >&2; exit 1; }
command -v systemctl >/dev/null || { printf 'systemd user services are required\n' >&2; exit 1; }
[ -s "$HOME/.sitech/push_key" ] || { printf 'Existing ~/.sitech/push_key is missing; stopping.\n' >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Public repository, no token in the URL. The updater pins files to this exact checkout SHA.
git clone --quiet --depth=1 --branch master https://github.com/sitechfromgeorgia/sirelay.git "$TMP/sirelay"
python3 "$TMP/sirelay/integrations/tbilisi-today/update_tt_relay.py" --from-dir "$TMP/sirelay"
printf 'Installed from SiRelay. Check: systemctl --user list-timers "sitech-*"\n'
