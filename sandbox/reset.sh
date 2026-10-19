#!/usr/bin/env bash
# Rebuild the demo workspace from sandbox/template: a clean copy of the project with no leases.
#
# The workspace lives OUTSIDE this repository on purpose: Claude Code treats a directory loaded with
# --plugin-dir as a protected path and refuses edits inside it, which would hide what we want to test.
#
#   SANDBOX_DIR=/some/where bash sandbox/reset.sh     (default: ~/agent-stoplight-sandbox)
#
# The directory is emptied, not removed, so a terminal still sitting in it doesn't break the reset.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${SANDBOX_DIR:-$HOME/agent-stoplight-sandbox}"
mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$HERE/template/." "$DEST/"
echo "$DEST"
