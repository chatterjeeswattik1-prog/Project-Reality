#!/usr/bin/env bash
# Bake the bots' navmesh (needed after any change to the city generator or props.glb). ~9 min.
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild scripts/navmesh.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/navmesh.mjs --log-level=warning
node --max-old-space-size=6000 node_modules/.cache/navmesh.mjs "${1:-1337}"
