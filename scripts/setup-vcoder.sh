#!/bin/bash
# Fetches and builds the VCoder packages this repo links to via
# package.json ("@vcoder/*": "file:../vcoder-bot-core/packages/*") at the commit pinned
# in vcoder.lock. Run before `npm ci`. Idempotent.
#
#   scripts/setup-vcoder.sh            # check out the pinned commit and build
#   scripts/setup-vcoder.sh --pin      # record the sibling checkout's HEAD as the new pin
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/vcoder.lock"
VCODER_DIR="${VCODER_DIR:-$ROOT/../vcoder-bot-core}"
# shellcheck disable=SC1090
source "$LOCK"

if [ "${1:-}" = "--pin" ]; then
  commit="$(git -C "$VCODER_DIR" rev-parse HEAD)"
  if ! git -C "$VCODER_DIR" branch -r --contains "$commit" | grep -q .; then
    echo "VCoder $commit is not pushed to any remote; push it before pinning." >&2; exit 1
  fi
  sed -i '' "s/^VCODER_COMMIT=.*/VCODER_COMMIT=$commit/" "$LOCK"
  echo "Pinned VCoder $commit in vcoder.lock"; exit 0
fi

if [ ! -e "$VCODER_DIR/.git" ]; then
  echo "Cloning $VCODER_REPO into $VCODER_DIR"
  git clone --branch "$VCODER_BRANCH" "$VCODER_REPO" "$VCODER_DIR"
fi
if [ "$(git -C "$VCODER_DIR" rev-parse HEAD)" != "$VCODER_COMMIT" ]; then
  if [ -n "$(git -C "$VCODER_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "$VCODER_DIR has uncommitted changes and is not at the pinned commit $VCODER_COMMIT; resolve it first." >&2; exit 1
  fi
  git -C "$VCODER_DIR" fetch --quiet origin
  git -C "$VCODER_DIR" checkout --quiet "$VCODER_COMMIT"
fi
echo "VCoder at $VCODER_COMMIT"

cd "$VCODER_DIR"
command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable)." >&2; exit 1; }
pnpm install --frozen-lockfile --filter "@vcoder/shared..." --filter "@vcoder/agent-core..." --filter "@vcoder/server..."
pnpm -C packages/agent-core build
pnpm -C packages/shared build
pnpm -C packages/server build
echo "VCoder packages built: $VCODER_DIR/packages/{shared,agent-core,server}/dist"
