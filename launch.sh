#!/usr/bin/env bash
# launch.sh — runs the Electron app, handling NixOS's library path requirements.

set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if the bundled electron works directly (non-NixOS systems).
BUNDLED_ELECTRON="$APP_DIR/node_modules/.bin/electron"

if "$BUNDLED_ELECTRON" --version > /dev/null 2>&1; then
  exec "$BUNDLED_ELECTRON" "$APP_DIR" "$@"
fi

# Bundled electron failed (likely NixOS). Fall back to nix-shell electron.
if command -v nix-shell > /dev/null 2>&1; then
  echo "NixOS detected — launching via nix-shell..."
  exec nix-shell -p electron --run "electron '$APP_DIR' --no-sandbox $*"
fi

echo "ERROR: Could not find a working Electron binary."
echo "Try: nix-shell -p electron --run \"electron . --no-sandbox\""
exit 1
