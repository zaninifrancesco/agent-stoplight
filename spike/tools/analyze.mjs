// Usage: node analyze.mjs <runId>
// Reads ../results/<runId>-*.json (one file per session) and reports, per claim primitive,
// how many keys ended with exactly one winner (correct), none (starved) or several (double grant).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'results')
const runId = process.argv[2]
if (!runId) throw new Error('usage: node analyze.mjs <runId>')

const sessions = readdirSync(dir)
  .filter((f) => f.startsWith(runId + '-') && f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))

const families = {
  'mkdir via cmd /c (Windows)': (s) => s.claims.cmd.map((c) => [c.key, c.ok]),
  'mkdir binary (macOS/Linux)': (s) => s.claims.path.map((c) => [c.key, c.ok]),
  'mkdir via node -e': (s) => s.claims.node.map((c) => [c.key, c.ok]),
  'store a (naive get/set)': (s) => s.store.a.map((c) => [c.key, c.won]),
  'store b (verify now)': (s) => s.store.b.map((c) => [c.key, c.won]),
  'store c (verify after 30ms)': (s) => s.store.c.map((c) => [c.key, c.won]),
  'fs lease a (read-back now)': (s) => (s.fs?.a ?? []).map((c) => [c.key, c.won]),
  'fs lease b (read-back 10ms)': (s) => (s.fs?.b ?? []).map((c) => [c.key, c.won]),
  'fs lease c (read-back 25ms)': (s) => (s.fs?.c ?? []).map((c) => [c.key, c.won]),
}

// errors and retries
const errs = (list) => (list ?? []).filter((c) => c.error).length
console.log(
  `errors  store a/b/c: ${sessions.map((s) => `${errs(s.store.a)}/${errs(s.store.b)}/${errs(s.store.c)}`).join('  ')}   fs a/b/c: ${sessions.map((s) => `${errs(s.fs?.a)}/${errs(s.fs?.b)}/${errs(s.fs?.c)}`).join('  ')}`,
)
const retried = sessions.flatMap((s) => s.distinct ?? [])
console.log(`distinct-key store.set: ${retried.length} writes, failed after 20 tries=${retried.filter((c) => !c.ok).length}, needed retry=${retried.filter((c) => c.attempts > 1).length}, max attempts=${Math.max(0, ...retried.map((c) => c.attempts))}`)
console.log('')

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
console.log(`run ${runId}: ${sessions.length} sessions, barrier waits (ms): ${sessions.map((s) => s.barrierWaitMs).join(', ')}`)
console.log('')
for (const [name, pick] of Object.entries(families)) {
  const wins = new Map()
  for (const s of sessions) for (const [key, won] of pick(s)) wins.set(key, (wins.get(key) ?? 0) + (won ? 1 : 0))
  const counts = [...wins.values()]
  const one = counts.filter((c) => c === 1).length
  const none = counts.filter((c) => c === 0).length
  const many = counts.filter((c) => c > 1).length
  console.log(`${name.padEnd(30)} keys=${counts.length}  exactly-one=${one}  none=${none}  DOUBLE-GRANT=${many}`)
}

console.log('')
const lat = {}
for (const s of sessions) for (const [k, v] of Object.entries(s.latency)) (lat[k] ??= []).push(v)
for (const [k, v] of Object.entries(lat)) console.log(`latency ${k.padEnd(12)} median over sessions: ${median(v).toFixed(2)} ms`)
console.log('')
for (const key of ['cmd', 'path', 'node', 'storeA', 'storeB', 'storeC']) {
  const m = sessions.map((s) => s.summary[key]?.median).filter((x) => x !== undefined)
  const p = sessions.map((s) => s.summary[key]?.p95).filter((x) => x !== undefined)
  console.log(`claim ${key.padEnd(7)} per-call median ${median(m)} ms, worst p95 ${Math.max(...p)} ms`)
}
