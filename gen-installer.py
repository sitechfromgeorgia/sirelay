#!/usr/bin/env python3
"""
SiRelay installer generator — creates ONE-CLICK installers per machine.

Each installer embeds that machine's UNIQUE key (never in the public repo).
Output goes to ./installers/ — distribute privately (private gist/DM), NOT to GitHub.

  python3 gen-installer.py edo-laptop windows
  python3 gen-installer.py office-pc linux
  python3 gen-installer.py macbook mac
"""
import json, secrets, sys, pathlib

ROOT = pathlib.Path(__file__).parent
NODES_FILE = pathlib.Path("/root/.sirelay-nodes.json")
OUT = ROOT / "installers"
SERVER = "http://38.242.159.2:8123"
AGENT_URL = "https://github.com/sitechfromgeorgia/sirelay/releases/latest/download/sirelay.js"

def get_key(name: str) -> str:
    keys = json.loads(NODES_FILE.read_text()) if NODES_FILE.exists() else {}
    if name not in keys:
        keys[name] = secrets.token_hex(24)
        NODES_FILE.write_text(json.dumps(keys, indent=2))
        NODES_FILE.chmod(0o600)
    return keys[name]

WINDOWS = r"""@echo off
REM ============================================
REM  SiRelay one-click installer — node: {name}
REM  Run once. Everything else is automatic.
REM ============================================
set DIR=%USERPROFILE%\.sirelay
mkdir "%DIR%" 2>nul
cd /d "%DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Opening download page...
  start https://nodejs.org/en/download
  pause & exit /b 1
)

echo [1/4] Downloading agent...
powershell -Command "Invoke-WebRequest -Uri '{agent_url}' -OutFile 'sirelay.js'"

echo [2/4] Writing config...
(
echo {{
echo   "server": "{server}",
echo   "key": "{key}",
echo   "name": "{name}"
echo }}
) > sirelay.config.json

echo [3/4] Hidden launcher...
(
echo Set s = CreateObject^("Wscript.Shell"^)
echo s.CurrentDirectory = "%DIR%"
echo s.Run "node sirelay.js", 0, False
) > run-hidden.vbs

echo [4/4] Autostart on login (Task Scheduler, hidden)...
schtasks /create /f /tn "SiRelay" /tr "wscript \"%DIR%\run-hidden.vbs\"" /sc onlogon /rl limited >nul
start "" wscript "%DIR%\run-hidden.vbs"

echo.
echo  SiRelay is running in the background. Done!
timeout /t 4
"""

LINUX = """#!/bin/bash
# SiRelay one-click installer — node: {name}
set -e
DIR="$HOME/.sirelay"
mkdir -p "$DIR" && cd "$DIR"
command -v node >/dev/null || {{ echo "Node.js required (apt install nodejs)"; exit 1; }}

echo "[1/3] Downloading agent..."
curl -sL "{agent_url}" -o sirelay.js

echo "[2/3] Config..."
cat > sirelay.config.json <<'EOF'
{{
  "server": "{server}",
  "key": "{key}",
  "name": "{name}"
}}
EOF

echo "[3/3] systemd user service (autostart)..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/sirelay.service" <<EOF
[Unit]
Description=SiRelay agent
After=network-online.target
[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) sirelay.js
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now sirelay
echo "SiRelay running. Check: systemctl --user status sirelay"
"""

MAC = """#!/bin/bash
# SiRelay one-click installer — node: {name}
set -e
DIR="$HOME/.sirelay"
mkdir -p "$DIR" && cd "$DIR"
command -v node >/dev/null || {{ echo "Install Node: brew install node"; exit 1; }}

echo "[1/3] Downloading agent..."
curl -sL "{agent_url}" -o sirelay.js

echo "[2/3] Config..."
cat > sirelay.config.json <<'EOF'
{{
  "server": "{server}",
  "key": "{key}",
  "name": "{name}"
}}
EOF

echo "[3/3] launchd (autostart)..."
PLIST="$HOME/Library/LaunchAgents/ge.sitech.sirelay.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ge.sitech.sirelay</string>
<key>ProgramArguments</key><array><string>$(command -v node)</string><string>$DIR/sirelay.js</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"
echo "SiRelay running (launchd)."
"""

def main():
    name, platform = sys.argv[1], sys.argv[2]
    key = get_key(name)
    tpl = {"windows": WINDOWS, "linux": LINUX, "mac": MAC}[platform]
    body = tpl.format(name=name, key=key, server=SERVER, agent_url=AGENT_URL)
    OUT.mkdir(exist_ok=True)
    ext = {"windows": "bat", "linux": "sh", "mac": "command"}[platform]
    f = OUT / f"sirelay-{name}.{ext}"
    f.write_text(body)
    print(f"✓ {f}  (node={name}, key={key[:8]}…)")

if __name__ == "__main__":
    main()
