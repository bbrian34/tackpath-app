#!/usr/bin/env bash
# Re-render the TackPath product video in one command, from the repo root:
#
#   bash video/render.sh
#
# Output: video/out/tackpath-demo.mp4 (1920x1080, H.264, 3:00) and
# video/out/scenes.txt. Needs: node 18+, Chromium/Chrome (see
# tests/browser.js), the tackpath-driver repo cloned next to tackpath-app
# (or DRIVER_PAGE=/path/to/tackpath-driver/www/index.html). Nothing is sent
# anywhere: the pages run against a local stand-in backend.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# the test suites' own dependencies (playwright-core, PGlite)
[ -d ../tests/node_modules/playwright-core ] && [ -d ../tests/node_modules/@electric-sql/pglite ] || (cd ../tests && npm ci)

DRIVER_PAGE="${DRIVER_PAGE:-$HERE/../../tackpath-driver/www/index.html}"
[ -f "$DRIVER_PAGE" ] || { echo "driver app page not found: $DRIVER_PAGE (clone tackpath-driver next to tackpath-app, or set DRIVER_PAGE)"; exit 1; }
export DRIVER_PAGE

# ffmpeg: $FFMPEG, the one on PATH, or ffmpeg-static from npm
if [ -z "${FFMPEG:-}" ] && ! command -v ffmpeg >/dev/null 2>&1 && [ ! -d node_modules/ffmpeg-static ]; then
  npm install --no-save --no-package-lock --prefix "$HERE" ffmpeg-static@5.2.0
fi

node capture.mjs
node compose.mjs
