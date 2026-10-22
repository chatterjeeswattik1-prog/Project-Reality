#!/usr/bin/env bash
# Run the game on the AMD Radeon dGPU (PRIME render offload) in Chrome.
# Needs the card on the amdgpu driver (see README "GPU"); otherwise Mesa silently falls back to the Intel iGPU —
# the loading screen shows which GPU is rendering.
cd "$(dirname "$0")/.."
export DRI_PRIME=1
if ! curl -s -o /dev/null http://localhost:5173/; then (npx vite --port 5173 --strictPort >/tmp/project-realism-vite.log 2>&1 &); sleep 4; fi
exec google-chrome --use-angle=gl --ignore-gpu-blocklist --enable-gpu-rasterization --user-data-dir="$HOME/.cache/project-realism-chrome" "http://localhost:5173/?q=${1:-low}"
