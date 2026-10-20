#!/usr/bin/env sh
# The local CI set for pi-lens's pre-push hook (policy: ci.local.requireBeforePush).
# Hand-authored rather than harness-bridge ci generate output: this repository's
# verification is npm test / npm run build, not containerised act stages. The
# contract is the hook's: --fast is the pre-push subset (seconds), --all adds
# the full suite (minutes; also the push-gate evidence per policy).
set -eu

MODE="${1:---all}"
case "$MODE" in
  --list)
    echo "local CI stages: lint typecheck test build"
    echo "fast subset (pre-push): lint typecheck"
    exit 0 ;;
  --fast|--all) ;;
  *) echo "usage: scripts/ci/local.sh [--fast|--all|--list]" >&2; exit 2 ;;
esac

echo "local CI: oxlint"
npm run lint:js
echo "local CI: check:types"
npm run check:types
if [ "$MODE" != "--fast" ]; then
  echo "local CI: npm test"
  npm test
  echo "local CI: npm run build"
  npm run build
fi
