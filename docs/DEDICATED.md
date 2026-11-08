# Dedicated server (always-on match host) on CentOS

The multiplayer match normally runs in one player's browser and ends when that player leaves. A dedicated server
runs the match on your own machine around the clock instead: players come and go, the match goes on. It runs the game
headless in Chrome (`scripts/dedicated.mjs`), hosts with no player of its own (all 30 places are for players), and
draws nothing.

**No public IP is needed.** Players connect to it browser-to-browser over WebRTC; the server only makes outbound
connections (HTTPS to your Vercel site for the lobby, UDP to the players through your router).

## What the machine needs

- CentOS Stream 8 or 9, Rocky Linux or AlmaLinux 8+ (64-bit). **CentOS 7 will not work**: current Chrome needs a newer
  system library (glibc) than CentOS 7 has.
- Always on (no sleep), on a wired connection if possible.
- Upload: about 2 Mbit/s for a full 30-player match (≈ 8–9 KB/s per player); more is better.
- CPU: the simulation of the full map (≈ 50 soldiers, vehicles, destruction) wants a modern desktop core or two;
  RAM: 4 GB free for Chrome. No graphics card is needed.

## 1. On Vercel (once)

1. Add **Upstash Redis** from the Vercel Marketplace to the project (the lobby needs it).
2. Add an environment variable **`DEDICATED_KEY`**: a long random secret (e.g. `openssl rand -hex 24`). Only the server
   knows it; it lets the server take the match over and stops players from taking it from the server.
3. Optional: a TURN relay for players behind strict networks: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
4. Redeploy.

## 2. On the CentOS machine

```bash
# Node.js 20+ and Google Chrome
sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs
sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm

# A user to run it, and the launcher
sudo useradd --system --create-home --home-dir /opt/pr-host prhost
sudo cp scripts/dedicated.mjs /opt/pr-host/
cd /opt/pr-host && sudo -u prhost npm init -y >/dev/null && sudo -u prhost npm install playwright-core@1

# Settings (readable by root and prhost only)
sudo tee /etc/pr-host.env >/dev/null <<'EOF'
GAME_URL=https://your-game.vercel.app
DEDICATED_KEY=the-same-secret-as-on-vercel
SERVER_NAME=Al Zahran Server
EOF
sudo chown root:prhost /etc/pr-host.env && sudo chmod 640 /etc/pr-host.env

# Start it now and at every boot
sudo cp deploy/pr-host.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pr-host
```

Make sure the machine does not sleep: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.

## 3. Watching it

- Log: `journalctl -u pr-host -f` — a line a minute: players, simulation rate, upload, tickets, round.
- Status (on the machine): `curl -s http://127.0.0.1:8790/` — the same as JSON, with each player's ping.
- In the game: the lobby shows the server as the host; players simply choose **Multiplayer**.

The launcher restarts Chrome if the page crashes, hangs or the simulation stalls; systemd restarts the launcher if it
dies. When a round ends, a new one starts 30 s later and players rejoin by themselves.

## Troubleshooting

- **"lobby NOT HELD" in the log**: `DEDICATED_KEY` differs between the machine and Vercel, or Upstash Redis is missing.
- **Some players cannot connect** ("Could not connect to the host directly"): your connection is probably behind
  carrier-grade NAT — set up a TURN relay (step 1.3).
- **Simulation rate below ~30 in the log with many players**: the machine is too slow for a full match.
- **Chrome fails to start**: check `CHROME=/usr/bin/google-chrome` in `/etc/pr-host.env`; on minimal installs also
  `sudo dnf install -y liberation-fonts nss alsa-lib`.
