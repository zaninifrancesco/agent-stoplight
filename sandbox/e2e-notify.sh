#!/usr/bin/env bash
# End-to-end check of the session-to-session protocol, with two REAL Claude Code sessions (haiku):
#   A edits src/api.ts, then stays alive in a long `sleep` so it keeps the lease.
#   B tries to edit src/api.ts: it must be refused, and A must be told B is waiting.
#   When A ends, it releases the file and tries to tell B.
# Both sessions run with STOPLIGHT_TRACE=1, so each writes .claude/stoplight/trace-<label>.log.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/.." && pwd)"
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
PLUGIN_N="$(native "$PLUGIN")"
# A workspace of its own, so the tests never touch the one you use by hand
WORK="$(SANDBOX_DIR="${E2E_DIR:-$HOME/agent-stoplight-sandbox-e2e}" bash "$HERE/reset.sh")" || { echo "FAIL  could not reset the workspace"; exit 1; }
cd "$WORK"
STATE="$WORK/.claude/stoplight"
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

echo "--- A starts, takes src/api.ts and holds it"
STOPLIGHT_TRACE=1 claude -p "Use the Edit tool to add the line '// A was here' at the very top of src/api.ts. Then run exactly this Bash command and nothing else, and let it finish (it keeps this session busy on purpose): node -e \"setTimeout(() => {}, 70000)\". Then reply DONE." \
  --plugin-dir "$PLUGIN_N" --model haiku --permission-mode acceptEdits --allowedTools "Bash(node -e:*)" > "$WORK/a.out" 2>&1 &
A_PID=$!

for _ in $(seq 1 90); do
  grep -q 'A was here' src/api.ts 2>/dev/null && break
  sleep 1
done
check "A edited api.ts" "grep -q 'A was here' src/api.ts"
A_TRACE="$(ls "$STATE"/trace-*.log 2>/dev/null | head -1)"
echo "A trace: $A_TRACE"

echo
echo "--- B tries the same file"
OUT_B="$(STOPLIGHT_TRACE=1 claude -p "Use the Edit tool to change the word hello to goodbye in src/api.ts. If the tool refuses, do not retry and do not use another tool. Tell me exactly what the tool said." \
  --plugin-dir "$PLUGIN_N" --model haiku --permission-mode acceptEdits 2>&1)"
echo "$OUT_B" | head -6
check "B was refused (api.ts still says hello)" "grep -q 'hello' src/api.ts && ! grep -q 'goodbye' src/api.ts"
B_TRACE="$(ls -t "$STATE"/trace-*.log | grep -v "$(basename "$A_TRACE")" | head -1)"
echo "B trace: $B_TRACE"
check "B sent a waiting message to A" "grep -q 'waiting → ' \"$B_TRACE\""
grep '✉' "$B_TRACE" | sed 's/^/      B: /'

sleep 5
check "A was told that B is waiting" "grep -q '🔔 .* is waiting for src/api.ts' \"$A_TRACE\""

echo
echo "--- waiting for A to finish (it releases on exit)"
wait "$A_PID"
check "A released its file at the end" "grep -qE 'released (src/api.ts|1 file)' \"$A_TRACE\""
grep -E '✉|🔔|released' "$A_TRACE" | sed 's/^/      A: /'

echo
if [ "$fail" = 0 ]; then echo "e2e-notify: ALL PASS"; else echo "e2e-notify: FAILURES"; fi
exit "$fail"
