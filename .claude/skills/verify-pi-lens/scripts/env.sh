#!/usr/bin/env bash
# Source this, do not execute it. It pins every directory a verify run can write
# to under one lane TMPDIR, so nothing reaches the maintainer's real home, /tmp
# (tmpfs), or the repo being verified.
#
#   export TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp
#   . .claude/skills/verify-pi-lens/scripts/env.sh
#
# Sets: VERIFY_ROOT (venvs, built trees), RUN (disposable run dir), EVIDENCE
# (survives cleanup), plus HOME, PI_LENS_HOME, PILENS_DATA_DIR and the XDG and
# uv cache dirs pinned inside RUN.

if [ -z "${TMPDIR:-}" ]; then
	echo "verify-pi-lens: TMPDIR is unset; export the lane TMPDIR first" >&2
	return 1 2>/dev/null || exit 1
fi
case "$TMPDIR" in
	/tmp | /tmp/* | /var/tmp | /var/tmp/*)
		echo "verify-pi-lens: TMPDIR=$TMPDIR is tmpfs; use the lane directory" >&2
		return 1 2>/dev/null || exit 1
		;;
esac

VERIFY_ROOT="$TMPDIR/verify-pi-lens"
VERIFY_RUN_ID="${VERIFY_RUN_ID:-$(date +%Y%m%dT%H%M%S)-$$}"
RUN="$VERIFY_ROOT/runs/$VERIFY_RUN_ID"
EVIDENCE="$VERIFY_ROOT/evidence/$VERIFY_RUN_ID"
mkdir -p "$RUN/home" "$RUN/xdg" "$RUN/uv-cache" "$EVIDENCE"

export VERIFY_ROOT VERIFY_RUN_ID RUN EVIDENCE
export HOME="$RUN/home"
export PI_LENS_HOME="$RUN/home/.pi-lens"
export PILENS_DATA_DIR="$RUN/home/.pi-lens-data"
export XDG_CACHE_HOME="$RUN/xdg/cache"
export XDG_CONFIG_HOME="$RUN/xdg/config"
export XDG_DATA_HOME="$RUN/xdg/data"
export UV_CACHE_DIR="$RUN/uv-cache"
