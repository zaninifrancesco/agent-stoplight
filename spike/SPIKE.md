# Phase 0 spike: how do parallel sessions claim a file atomically?

**Question.** `agent-stoplight` has to decide, inside a `tool.call` hook, "does another live session hold this file?" and claim it if not. The claim must be (a) correct when two sessions race and (b) cheap enough to run on every file edit. Which primitive in the mods API gives that?

**Setup.** A throwaway mod (`spike/`, plugin `stoplight-spike`) exposes `/spike`, which runs each candidate primitive. `tools/race.sh` launches N headless sessions (`claude -p "/spike …" --plugin-dir …`, no model call) that hit the same 40 keys at once; `tools/analyze.mjs` counts, per key, how many sessions believed they won. Correct is exactly one winner. Two or more is a *double grant*.

**Environment.** Windows 11, Claude Code 2.1.302, Node 24, one machine, 6 concurrent sessions. macOS/Linux were not tested, so process-spawn costs there are unknown.

## Results

### Correctness: 6 sessions racing 40 keys each (`race2`, 240 attempts per primitive)

| Primitive | Exactly one winner | Double grants | Verdict |
|---|---|---|---|
| `mkdir` via `$.process.run(['cmd','/c','mkdir',…])` | 40 / 40 | **0** | Atomic |
| `mkdir` via `$.process.run(['node','-e',…])` | 40 / 40 | **0** | Atomic |
| `$.store` get-then-set (naive) | 12 / 40 | **28** | Unusable |
| `$.store` set, then read back at once | 6 / 40 | **34** | Unusable |
| `$.store` set, read back after 30 ms | 13 / 40 | **27** | Unusable |
| Lease file: `$.fs.write`, read back at once | 38 / 40 | 2 | Near-atomic |
| Lease file: `$.fs.write`, read back after 10 ms | 39 / 40 | 1 | Near-atomic |
| Lease file: `$.fs.write`, read back after 25 ms | 39 / 40 | 1 | Near-atomic |

The racing was deliberately harsh: six sessions pounding the same 40 keys back to back. Real collisions need two sessions to claim the same *new* file within tens of milliseconds.

### Cost per call

| Operation | Alone | 6 sessions at once |
|---|---|---|
| `$.process.run` → `cmd /c mkdir` (atomic claim) | ~200 ms | ~450 ms median, ~1 s p95 |
| `$.process.run` → `node -e` mkdir | ~290 ms | ~730 ms median |
| `$.fs.exists` | 0.27 ms | 0.5 ms |
| `$.fs.read` | 1.5 ms | 2.8 ms |
| `$.fs.write` | 2.8 ms | 8 ms |
| `$.store.get` | 1.9 ms | 5.5 ms |
| `$.store.set` | 29 ms | 179 ms |
| Lease-file claim, new file (write + read back, 0–25 ms wait) | n/m | 30–67 ms median, ~200 ms p95 |
| Lease-file check, file already leased (`exists`) | n/m | ~19 ms median |

*n/m = not measured alone. A solo claim is roughly write + read-back (about 4 ms) plus the wait.*

### Other findings

- **`$.store.set` throws under cross-session contention**: `Lock file is already being held`. In the first run 5 of 6 sessions died on it. With 20 retries every write landed (33 of 240 writes needed a retry, at most 6 attempts), and no distinct-key write was lost (240 / 240). So the store is safe for per-session data with retries, and wrong for arbitration.
- **`$.fs.write` is not atomic** (documented: it replaces content in place). Keep lease contents tiny, and treat an unparsable or partial read as "unknown, retry".
- **`$.fs` has no mkdir, rename or exclusive-create.** The only atomic primitive reachable from a mod is a child process.
- **Hook time limit** (10 s, `$.clock.sleep` counts, mods API calls don't) is not a concern for a claim path.
- **Dev gotchas.** Git Bash rewrites a leading `/` in `claude -p "/spike …"` into a Windows path, so set `MSYS_NO_PATHCONV=1`. `--plugin-dir` needs a Windows path when `claude` is a native Windows binary. Hyphenated slash commands did not route in `-p` runs, hence `/spike verify` and `/spike clean`.

## Conclusion

No in-process primitive is perfectly atomic, and the one that is (a child process doing `mkdir`) costs 200–700 ms here. The design that fits the budget:

1. **Held-by-me fast path, ~0 ms.** Keep the set of files this session holds in memory. A repeat edit costs nothing.
2. **Check, ~0.3–3 ms.** For a file this session doesn't hold, `$.fs.exists` then `$.fs.read` on `<repo>/.claude/stoplight/leases/<hash>`. Live lease owned by someone else, so deny with an actionable message (🔴).
3. **Claim, ~10–30 ms once per file.** `$.fs.write` the session id, wait ~10 ms, read it back, and proceed only if it is still ours. Last writer wins, so after both writes land, everyone reads the same winner. This is best-effort: it can double-grant only when two sessions claim the same new file within the same few milliseconds, which the stress test hit in about 1–2% of attempts. A double grant degrades to today's behaviour, no worse than running without the mod.
4. **Optional strict mode.** Setting `strict: true` makes the claim an atomic `mkdir` through `$.process.run`, accepting ~200 ms+ on first touch of each file. Worth benchmarking on macOS/Linux, where spawning `mkdir` should be far cheaper.
5. **Never use `$.store` for leases.** Use it only for settings and history, with retries.
6. **Staleness.** Lease files carry a timestamp. A heartbeat from `$.clock.every` refreshes the ones this session holds, and leases older than the TTL are ignored. Release on `session.end`.

## Still open

- Re-run the benchmark on macOS and Linux; confirm strict mode is viable there.
- Whether `$.process.spawn` accepts stdin. If it does, a per-machine helper could give atomic claims at IPC speed. Not verified.
- Bash writes (`sed -i`, `mv`, redirects) bypass `Edit`/`Write` interception. This is a Phase 3 problem.
- Session liveness: `$.session.id()` identifies a session, but a crashed session is only detectable by lease TTL.
- The exact field name carrying the file path on `Edit`/`Write` events (`e.file_path` per the docs' examples). Confirm from the generated types in an interactive `--plugin-dir` session.

## Reproduce

```bash
export MSYS_NO_PATHCONV=1          # Git Bash on Windows only
claude plugin validate ./spike
bash spike/tools/race.sh myrun 6   # runs 6 sessions, prints the table above
```
