#!/usr/bin/env bash
# One-time setup of this machine as the always-on match host (dedicated server). Run from the repository root:
#
#   sudo bash deploy/setup-host.sh https://your-game.vercel.app ~/.config/pr-host/dedicated_key ["Server name"]
#
# Re-running it is safe (it updates the launcher and the settings). What it does:
#   - a system user `prhost` that runs the server (no login), home /opt/pr-host
#   - the launcher (scripts/dedicated.mjs) and its one library (playwright-core) copied there
#   - /etc/pr-host.env with the game address and the secret key (readable by root and prhost only)
#   - the systemd service pr-host: starts at boot, restarts if it dies
#   - the machine never sleeps: suspend/hibernate disabled, closing the lid does nothing
# See docs/DEDICATED.md for watching it and troubleshooting.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
URL="${1:-}"; KEYFILE="${2:-}"; NAME="${3:-Al Zahran Server}"
[[ "$URL" =~ ^https?:// ]] || { echo "First argument: the game's address, e.g. https://your-game.vercel.app" >&2; exit 1; }
[ -s "$KEYFILE" ] || { echo "Second argument: the file holding DEDICATED_KEY (the same value as on Vercel)" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO/scripts/dedicated.mjs" ] && [ -d "$REPO/node_modules/playwright-core" ] || { echo "Run from the repository (with node_modules installed: npm ci)." >&2; exit 1; }
command -v /usr/bin/node >/dev/null || { echo "Needs Node.js 20+ at /usr/bin/node: dnf module enable -y nodejs:20 && dnf install -y nodejs" >&2; exit 1; }
CHROME="$(command -v google-chrome || command -v google-chrome-stable || true)"
[ -n "$CHROME" ] || { echo "Needs Google Chrome: dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm" >&2; exit 1; }

echo "== user and files"
id prhost >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/pr-host --shell /sbin/nologin prhost
install -d -o prhost -g prhost -m 750 /opt/pr-host /opt/pr-host/node_modules
install -o prhost -g prhost -m 640 "$REPO/scripts/dedicated.mjs" /opt/pr-host/dedicated.mjs
rm -rf /opt/pr-host/node_modules/playwright-core
cp -r "$REPO/node_modules/playwright-core" /opt/pr-host/node_modules/
chown -R prhost:prhost /opt/pr-host/node_modules

echo "== settings (/etc/pr-host.env)"
umask 027
cat > /etc/pr-host.env <<EOF
GAME_URL=${URL%/}
DEDICATED_KEY=$(tr -d '[:space:]' < "$KEYFILE")
SERVER_NAME=${NAME}
CHROME=${CHROME}
EOF
chown root:prhost /etc/pr-host.env && chmod 640 /etc/pr-host.env

echo "== service"
install -m 644 "$REPO/deploy/pr-host.service" /etc/systemd/system/pr-host.service
systemctl daemon-reload
systemctl enable pr-host >/dev/null
systemctl restart pr-host

echo "== never sleep (lid closed included)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
install -d /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/pr-host-nosleep.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
systemctl kill -s HUP systemd-logind || true

echo
echo "Done. The server is starting (the map takes about a minute to load)."
echo "  log:     journalctl -u pr-host -f"
echo "  status:  curl -s http://127.0.0.1:8790/"
echo "  stop:    sudo systemctl stop pr-host     (start: sudo systemctl start pr-host)"
