#!/bin/bash
# Launch the reconstructed Grok Bot with VCoder (deepseek) routing.
# Requires: an unlocked Mac GUI session and Docker running.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Grok Bot 0.18 Reconstructed.app"

# Point at the staged Linux VCoder CLI (must exist; stage a Linux vcoder-cli build
# into ~/.grokbot/local-docker-runtime/vcoder-<sha>/vcoder-cli otherwise).
CLI="$(ls -d "$HOME"/.grokbot/local-docker-runtime/vcoder-*/vcoder-cli 2>/dev/null | head -1 || true)"
if [ -z "$CLI" ]; then
  echo "error: no staged Linux VCoder CLI found under ~/.grokbot/local-docker-runtime/vcoder-*/vcoder-cli" >&2
  exit 1
fi

export SAND_VCODER_MODEL="${SAND_VCODER_MODEL:-deepseek-v4-flash}"
export SAND_ROUTER_BYPASS_LOGIN=1
export SAND_VCODER_BOX_CLI_PATH="$CLI"
exec "$APP/Contents/MacOS/Grok Bot"
