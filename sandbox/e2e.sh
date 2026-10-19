#!/usr/bin/env bash
# End-to-end check through the real Claude Code tool-call path (three small model calls, haiku).
#   A) a simulated peer holds src/api.ts  -> the edit must be refused and the file left alone
#   B) nobody holds src/ui.ts             -> the edit goes through and this session leases the file
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/.." && pwd)"
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
PLUGIN_N="$(native "$PLUGIN")"

# A workspace of its own, so the tests never touch the one you use by hand
WORK="$(SANDBOX_DIR="${E2E_DIR:-$HOME/agent-stoplight-sandbox-e2e}" bash "$HERE/reset.sh")" || { echo "FAIL  could not reset the workspace"; exit 1; }
cd "$WORK"
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
run_claude() { claude -p "$1" --plugin-dir "$PLUGIN_N" --model haiku --permission-mode acceptEdits 2>&1; }

# Where does the mod think the repo root is? Leases for the simulated peer must go in the same place.
ROOT_LINE="$(run_claude '/stoplight status' | grep -m1 'is guarding' || true)"
ROOT="${ROOT_LINE#*is guarding }"
echo "guarding: $ROOT"
[ -n "$ROOT" ] || { echo "FAIL  could not read the guarded root"; exit 1; }
LEASES="$(cygpath -u "$ROOT" 2>/dev/null || echo "$ROOT")/.claude/stoplight/leases"
rm -rf "$LEASES"

echo
echo "--- A: a live peer holds src/api.ts"
node "$(native "$HERE/tools/peer.mjs")" "$ROOT" hold --once src/api.ts || { echo "FAIL  peer simulator"; exit 1; }
OUT_A="$(run_claude "Use the Edit tool to change the word hello to goodbye in src/api.ts. If the tool reports a refusal, do not retry and do not use any other tool. Then tell me exactly what the tool said.")"
echo "$OUT_A" | head -8
check "api.ts left untouched" "grep -q 'hello' src/api.ts && ! grep -q 'goodbye' src/api.ts"
check "Claude was shown the stoplight refusal" "echo \"\$OUT_A\" | grep -q 'agent-stoplight'"
check "the refusal names the peer" "echo \"\$OUT_A\" | grep -q 's-peer'"

echo
echo "--- B: nobody holds src/ui.ts"
OUT_B="$(run_claude "Use the Edit tool to change the number of equals signs in src/ui.ts from three to four on each side of the banner. Reply DONE when finished.")"
echo "$OUT_B" | head -5
check "ui.ts was edited" "grep -q '====' src/ui.ts"
check "this session now holds a lease for ui.ts" "grep -l 'src/ui.ts' \"$LEASES\"/*.lease >/dev/null 2>&1"

echo
echo "--- C: a live peer holds src/db.ts, Claude tries to change it from Bash"
node "$(native "$HERE/tools/peer.mjs")" "$ROOT" hold --once src/db.ts >/dev/null
OUT_C="$(claude -p "Run exactly this Bash command: sed -i 's/ada/grace/' src/db.ts . If it is refused, do not retry and do not use any other tool. Then tell me exactly what the tool said." \
  --plugin-dir "$PLUGIN_N" --model haiku --permission-mode acceptEdits --allowedTools "Bash(sed:*)" 2>&1)"
echo "$OUT_C" | head -6
check "db.ts left untouched" "grep -q 'ada' src/db.ts && ! grep -q 'grace' src/db.ts"
check "Claude was told the command was not run" "echo \"\$OUT_C\" | grep -q 'not run'"

echo
echo "--- D: strict mode claims through an atomic mkdir"
OUT_D="$(STOPLIGHT_STRICT=1 claude -p "Use the Edit tool to change the word tiny to small in README.md. Reply DONE." \
  --plugin-dir "$PLUGIN_N" --model haiku --permission-mode acceptEdits 2>&1)"
echo "$OUT_D" | head -3
check "the strict edit went through" "grep -q 'A small project' README.md"
check "a lock directory was created for it" "ls -d \"$LEASES\"/*@*.lock >/dev/null 2>&1"

echo
if [ "$fail" = 0 ]; then echo "e2e: ALL PASS"; else echo "e2e: FAILURES"; fi
exit "$fail"
