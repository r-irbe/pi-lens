#!/usr/bin/env bash
# Registered as the Pyrefly "command" in the workspace's .pi-lens/lsp.json. It
# copies both directions of the LSP stream into $VERIFY_LSP_WIRE.in / .out, so
# the evidence holds every didChangeWatchedFiles pi-lens sent and every answer,
# then runs the real Pyrefly in their place.
exec "$VERIFY_PYREFLY" "$@" \
	< <(tee -a "$VERIFY_LSP_WIRE.in") \
	> >(tee -a "$VERIFY_LSP_WIRE.out")
