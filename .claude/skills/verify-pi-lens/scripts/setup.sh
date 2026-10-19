#!/usr/bin/env bash
# One-time setup the drive recipes need. Everything lands under $VERIFY_ROOT, a
# directory beside the worktree that survives across runs.
#
#   setup.sh pyrefly            # Pyrefly 1.3.2 + ruff in a venv
#   setup.sh tree <rev|HEAD>    # a built copy of <rev>, to verify a commit
#                               #  other than the checkout (e.g. the base)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pins HOME and the uv cache under the lane TMPDIR, in a fixed "setup" run dir.
VERIFY_RUN_ID=setup . "$here/env.sh"

case "${1:-}" in
	pyrefly)
		# Pyrefly (the #4320 server) and ruff (the python formatter) share one venv.
		venv="$VERIFY_ROOT/py-venv"
		if [ ! -x "$venv/bin/pyrefly" ]; then
			uv venv "$venv"
			uv pip install --python "$venv/bin/python" "pyrefly==${PYREFLY_VERSION:-1.3.2}" ruff
		fi
		"$venv/bin/pyrefly" --version
		;;
	tree)
		rev="${2:?usage: setup.sh tree <rev>}"
		repo="$(git rev-parse --show-toplevel)"
		sha="$(git -C "$repo" rev-parse --verify "$rev^{commit}")"
		dest="$VERIFY_ROOT/trees/$sha"
		if [ ! -f "$dest/mcp/server.js" ]; then
			rm -rf "$dest"
			mkdir -p "$dest"
			git -C "$repo" archive "$sha" | tar -x -C "$dest"
			# A symlink, never npm: a mutating npm verb through it would empty the
			# shared install. Teardown unlinks it before anything removes the tree.
			ln -s "$(cd "$repo" && realpath node_modules)" "$dest/node_modules"
			(cd "$dest" && npm run build >"$VERIFY_ROOT/trees/$sha.build.log" 2>&1)
		fi
		echo "$dest"
		;;
	*)
		echo "usage: setup.sh pyrefly | tree <rev>" >&2
		exit 2
		;;
esac
