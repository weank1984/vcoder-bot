#!/bin/bash
# Launch the reconstructed Grok Bot with VCoder routing.
# Requires: an unlocked Mac GUI session and Docker running.
#
# vcoder now runs embedded in-process inside the box's host bundle
# (VcoderCoreRuntimeImpl, see source/host/extensions/inference/vcoder-runtime-bridge.ts)
# instead of a spawned Linux CLI subprocess, so no staged vcoder-cli binary is
# needed anymore (SAND_VCODER_BOX_CLI_PATH / SAND_VCODER_CLI_PATH are unused).
set -e
APP="/Applications/Grok Bot 0.18 Reconstructed.app"

export SAND_VCODER_MODEL="${SAND_VCODER_MODEL:-deepseek-v4.1-flash}"
export SAND_ROUTER_BYPASS_LOGIN=1
exec "$APP/Contents/MacOS/Grok Bot"
