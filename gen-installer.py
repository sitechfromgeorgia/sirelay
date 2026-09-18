#!/usr/bin/env python3
"""
SiRelay installer generator — creates ONE-CLICK installers per machine.

Each installer embeds that machine's UNIQUE key (never committed to repo).
Output goes to ./installers/ — distribute privately (secure DM/channel), NOT to GitHub.

Usage:
  python3 gen-installer.py <name> <windows|linux|mac> [--server URL]

Examples:
  python3 gen-installer.py edo-laptop windows --server http://my-coordinator:8123
  python3 gen-installer.py office-pc linux --server http://my-coordinator:8123
  python3 gen-installer.py macbook mac --server http://my-coordinator:8123
"""
import argparse
import json
import os
import pathlib
import secrets
import sys

ROOT = pathlib.Path(__file__).parent.resolve()
DEFAULT_NODES_FILE = (
    ROOT / ".sirelay-nodes.json"
    if sys.platform == "win32"
    else pathlib.Path("/root/.sirelay-nodes.json")
)
OUT = ROOT / "installers"
DEFAULT_SERVER = os.environ.get("SIRELAY_SERVER", "http://YOUR_SERVER:8123")
DEFAULT_AGENT_URL = (
    "https://github.com/sitechfromgeorgia/sirelay/releases/latest/download/sirelay.js"
)


def get_or_create_key(nodes_file: pathlib.Path, name: str) -> str:
    keys = {}
    if nodes_file.exists():
        try:
            keys = json.loads(nodes_file.read_text(encoding="utf8"))
        except Exception as e:
            print(f"Warning: Could not read {nodes_file}: {e}", file=sys.stderr)

    if name not in keys:
        keys[name] = secrets.token_hex(24)
        nodes_file.parent.mkdir(parents=True, exist_ok=True)
        nodes_file.write_text(json.dumps(keys, indent=2), encoding="utf8")
        try:
            nodes_file.chmod(0o600)
        except Exception:
            pass
    return keys[name]


WINDOWS = r"""@echo off
REM ============================================
REM  SiRelay One-Click Installer — node: {name}
REM  Run once. Everything else is automatic.
REM ============================================
set DIR=%USERPROFILE%\.sirelay
mkdir "%DIR%" 2>nul
cd /d "%DIR%"

echo [1/5] Checking Node.js runtime...
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required but not installed.
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo Attempting automatic installation via winget...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        echo Refreshing environment path...
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
    ) else (
        echo Opening Node.js download page...
        start https://nodejs.org/en/download
        pause & exit /b 1
    )
)

echo [2/5] Downloading agent...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '{agent_url}' -OutFile 'sirelay.js'"

echo [3/5] Writing configuration...
(
echo {{
echo   "server": "{server}",
echo   "key": "{key}",
echo   "name": "{name}"
echo }}
) > sirelay.config.json

echo [4/5] Creating background helper scripts...
(
echo Set s = CreateObject^("Wscript.Shell"^)
echo s.CurrentDirectory = "%DIR%"
echo s.Run "node sirelay.js", 0, False
) > run-hidden.vbs

(
echo @echo off
echo echo Stopping SiRelay task...
echo schtasks /end /tn "SiRelay" 2^>nul
echo schtasks /delete /f /tn "SiRelay" 2^>nul
echo echo SiRelay background service removed.
echo echo To completely delete data, remove: %USERPROFILE%\.sirelay
echo pause
) > uninstall.bat

(
echo @echo off
echo schtasks /query /tn "SiRelay" ^| findstr /i "Running" ^>nul
echo if errorlevel 1 ^(
echo   echo Resuming SiRelay...
echo   schtasks /run /tn "SiRelay"
echo   echo Status: RUNNING
echo ^) else ^(
echo   echo Pausing SiRelay...
echo   schtasks /end /tn "SiRelay"
echo   echo Status: PAUSED
echo ^)
echo pause
) > toggle-pause.bat

echo [5/5] Registering login autostart (Task Scheduler)...
schtasks /create /f /tn "SiRelay" /tr "wscript \"%DIR%\run-hidden.vbs\"" /sc onlogon /rl limited >nul
start "" wscript "%DIR%\run-hidden.vbs"

echo.
echo ========================================================
echo  SiRelay is now active in background.
echo  - To Pause / Resume: run "%DIR%\toggle-pause.bat"
echo  - To Uninstall:      run "%DIR%\uninstall.bat"
echo ========================================================
timeout /t 5
"""

LINUX = """#!/bin/bash
# SiRelay One-Click Installer — node: {name}
set -e
DIR="$HOME/.sirelay"
mkdir -p "$DIR" && cd "$DIR"

echo "[1/4] Checking Node.js..."
command -v node >/dev/null || {{ echo "Node.js 18+ is required (e.g. sudo apt install nodejs)"; exit 1; }}

echo "[2/4] Downloading agent..."
curl -sSL "{agent_url}" -o sirelay.js

echo "[3/4] Writing configuration..."
cat > sirelay.config.json <<'EOF'
{{
  "server": "{server}",
  "key": "{key}",
  "name": "{name}"
}}
EOF

echo "[4/4] Configuring systemd user service..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/sirelay.service" <<EOF
[Unit]
Description=SiRelay Residential Fetch Agent
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) sirelay.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$DIR/uninstall.sh" <<'EOF'
#!/bin/bash
systemctl --user stop sirelay 2>/dev/null || true
systemctl --user disable sirelay 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/sirelay.service"
systemctl --user daemon-reload
echo "SiRelay user service removed. Data directory: $HOME/.sirelay"
EOF
chmod +x "$DIR/uninstall.sh"

systemctl --user daemon-reload
systemctl --user enable --now sirelay
echo ""
echo "SiRelay running. Manage with:"
echo "  systemctl --user status sirelay"
echo "  systemctl --user stop sirelay    # pause"
echo "  systemctl --user start sirelay   # resume"
echo "  $DIR/uninstall.sh                # uninstall"
"""

MAC = """#!/bin/bash
# SiRelay One-Click Installer — node: {name}
set -e
DIR="$HOME/.sirelay"
mkdir -p "$DIR" && cd "$DIR"

echo "[1/4] Checking Node.js..."
command -v node >/dev/null || {{ echo "Node.js 18+ required (install via: brew install node)"; exit 1; }}

echo "[2/4] Downloading agent..."
curl -sSL "{agent_url}" -o sirelay.js

echo "[3/4] Writing configuration..."
cat > sirelay.config.json <<'EOF'
{{
  "server": "{server}",
  "key": "{key}",
  "name": "{name}"
}}
EOF

echo "[4/4] Setting up launchd service..."
PLIST="$HOME/Library/LaunchAgents/ge.sitech.sirelay.plist"
mkdir -p "$HOME/Library/LaunchAgents"
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

cat > "$DIR/uninstall.sh" <<EOF
#!/bin/bash
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "SiRelay launchd service uninstalled."
EOF
chmod +x "$DIR/uninstall.sh"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo ""
echo "SiRelay running via launchd."
echo "  Uninstall: $DIR/uninstall.sh"
"""


def main():
    parser = argparse.ArgumentParser(
        description="Generate private SiRelay installers"
    )
    parser.add_argument("name", help="Machine / node identifier (e.g. home-laptop)")
    parser.add_argument(
        "platform",
        choices=["windows", "linux", "mac"],
        help="Target platform",
    )
    parser.add_argument(
        "--server",
        default=DEFAULT_SERVER,
        help=f"SiRelay coordinator URL (default: {DEFAULT_SERVER})",
    )
    parser.add_argument(
        "--agent-url",
        default=DEFAULT_AGENT_URL,
        help="URL to fetch sirelay.js asset from",
    )
    parser.add_argument(
        "--nodes-file",
        default=str(DEFAULT_NODES_FILE),
        help=f"Path to nodes keys file (default: {DEFAULT_NODES_FILE})",
    )

    args = parser.parse_args()

    nodes_file = pathlib.Path(args.nodes_file)
    key = get_or_create_key(nodes_file, args.name)

    templates = {"windows": WINDOWS, "linux": LINUX, "mac": MAC}
    tpl = templates[args.platform]
    body = tpl.format(
        name=args.name,
        key=key,
        server=args.server.rstrip("/"),
        agent_url=args.agent_url,
    )

    OUT.mkdir(parents=True, exist_ok=True)
    extensions = {"windows": "bat", "linux": "sh", "mac": "command"}
    output_file = OUT / f"sirelay-{args.name}.{extensions[args.platform]}"
    output_file.write_text(body, encoding="utf8")

    if args.platform in ("linux", "mac"):
        output_file.chmod(0o755)

    print(f"[+] Generated installer: {output_file}")
    print(f"  Node: {args.name} | Server: {args.server}")
    print(f"  Key: {key[:8]}... (recorded in {nodes_file})")


if __name__ == "__main__":
    main()
