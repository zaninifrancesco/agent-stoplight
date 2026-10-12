#!/usr/bin/env bash
# Usage: tools/race.sh <runId> <sessions>
# Starts N headless Claude Code sessions (claude -p, no model call: the slash command is answered by the mod)
# that race on the same claim keys, then counts surviving distinct store keys.
# Runs on Windows (Git Bash), macOS and Linux.
set -u
export MSYS_NO_PATHCONV=1
RUN="${1:?runId}"; N="${2:-6}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
NATIVE="$(native "$ROOT")"
mkdir -p "$ROOT/claims" "$ROOT/results"
# date +%N is missing on macOS, so take the clock from node
START=$(( $(node -e 'console.log(Date.now())') + 7000 ))
for i in $(seq 1 "$N"); do
  claude -p "/spike $RUN $START $NATIVE race" --plugin-dir "$NATIVE" > "$ROOT/results/$RUN-out-$i.txt" 2>&1 &
done
wait
echo "--- per-session output"; head -c 300 "$ROOT"/results/"$RUN"-out-*.txt | head -40
echo "--- verify distinct-key survival (expect $((N * 40)))"
claude -p "/spike verify $RUN $((N * 40))" --plugin-dir "$NATIVE" 2>&1 | tail -2
node "$(native "$ROOT/tools/analyze.mjs")" "$RUN"
