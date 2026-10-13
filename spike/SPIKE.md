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
