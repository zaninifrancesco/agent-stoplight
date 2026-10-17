// agent-stoplight: traffic lights for parallel Claude Code sessions.
//
// Before a session edits a file it takes a small lease file in <repo>/.claude/stoplight/leases/.
//   🔴 another live session holds the lease: the edit is refused with an instruction Claude can act on,
//      and the holder is told someone is waiting (a message between sessions, kept from its Claude).
//   🟡 a peer is editing other files in the same directory: the edit goes ahead, with a warning.
//   🟢 the file is free, or already ours.
// A session holds its files while it works on a task (hold mode "turn"), and a session that was refused
// waits in line and is resumed automatically when the file comes free. Two sessions waiting on each other
// are untangled without the user. The band above the prompt shows all of it.
// Design and measurements: spike/SPIKE.md.
import {
  TTL_MS, HEARTBEAT_MS, REFRESH_MS, CLAIM_WAIT_MS, FLASH_MS, WAIT_ALERT_MS, NOTIFY_DEDUPE_MS, HOLD_MODES,
  normalizePath, resolvePath, leaseId, encodeLease, decodeLease, classify, labelFor, relPath, pathOf, dirOf,
  denyMessage, bandSegments, boardRows, ageText, nearbyPeers, encodeMessage, decodeMessage, pickAlert, pushEvent,
  shellDenyMessage, lockName, mkdirArgv, dueForRelease, releaseInMs, countdownText, resumePrompt, shouldYield, canResume, clipSummary,
} from './lib/lease.js'
import { shellTargets } from './lib/shell.js'

const PANE = 'stoplight'

// This session's identity and where leases live. Filled in at session.start.
let me = ''
let label = ''
let root = ''
let cwd = ''
let base = ''
let leaseDir = ''

let isPaused = false
// Strict: claim through an atomic mkdir (slower, never double-grants). Shell: also guard Bash/PowerShell writes.
let isStrict = false
let guardShell = true
let isWindows = false
// How long files are held (see HOLD_MODES), and whether a waiting session is resumed by itself.
let holdMode = 'turn'
let autoResume = true
let isInteractive = true
// The main conversation's turn: files are held while it runs, then for a grace period.
let inTurn = false
let turnEndedAt = 0
// The id of the main conversation's running turn. A turn.complete for any other id is not the end of
// our task (a first real-world test saw one arrive mid-task, which handed a file over too early).
let activeTurn = null
// Last time this session ran any tool: a session that is using tools is busy, whatever the turn events say
let lastToolAt = 0
// A session counts as idle only after this long without a tool call
const BUSY_MS = 8_000
// A hand-off note on disk is trusted for this long after the release
const HANDOFF_FRESH_MS = 10 * 60_000
// Waiters known only from a .wait file ("leaseId:sid"), dropped when the file goes stale
const fileWaiters = new Set()
// Can this session be woken up by a prompt from the mod? True in the terminal, the Desktop app and
// VS Code; false in claude -p and the Agent SDK, which end with their turn. The Desktop app reports
// isInteractive false, so the surface decides too.
let canWakeHere = true
// Claude's closing words for the last task, handed to whoever takes a file over next
let lastSummary = ''

// leaseId -> { path, since, lastUsed }: files this session holds
const mine = new Map()
// leaseId -> Map(sid -> label): sessions waiting for a file this session holds
const waiters = new Map()
// sid + leaseId -> when we last told that owner we're waiting
const notified = new Map()
// normalized path -> { rel, owner, ownerSid }: files this session was refused and is waiting for.
// A scan that finds one free announces it even when the owner never sent "released" (it can't from
// session.end, where messaging is unavailable).
const waitingFor = new Map()
// normalized path -> [timestamps]: auto-resumes per file, to cap them
const resumes = new Map()
// Live leases of other sessions, from the last scan: [{ sid, label, path }]
let peerLeases = []
let peers = []
let board = []
let blockedCount = 0
const alerts = {}
let events = []
let tick = 0
let traceOn = false
let traceLines = []
let needsRedraw = false

async function sleep($, ms) {
  try {
    await $.clock.sleep(ms)
  } catch {
    await $.clock.sleep({ ms })
  }
}

function leaseFile(id) {
  return leaseDir + '/' + id + '.lease'
}

// The file-system side of the protocol, next to the leases. It works in every permission mode: in auto
// mode Claude Code may refuse $.session.send (a real Desktop run did), and then these files are all
// the two sessions have.
//   <id>.<sid8>.wait   "this session is waiting for file <id>" (a lease-format line; ts 0 = not any more)
//   <id>.handoff       who released file <id> last, and what its Claude said when it finished (JSON)
function waitFile(id, sid) {
  return leaseDir + '/' + id + '.' + String(sid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + '.wait'
}

function handoffFile(id) {
  return leaseDir + '/' + id + '.handoff'
}

async function writeWait($, path, ts) {
  try {
    await $.fs.write(waitFile(leaseId(path), me), encodeLease({ sid: me, label, ts, since: ts, path }))
  } catch {
    // Messages may still get through; and a stale wait file simply expires.
  }
}

async function readHandoff($, id, now) {
  try {
    if (!(await $.fs.exists(handoffFile(id)))) return null
    const h = JSON.parse(await $.fs.read(handoffFile(id)))
    return h && typeof h.sid === 'string' && now - Number(h.ts) < HANDOFF_FRESH_MS ? h : null
  } catch {
    return null
  }
}

// Something happened worth showing in the board's "Recent" list (and in the trace file when STOPLIGHT_TRACE is set).
async function note($, light, text) {
  const at = await $.clock.now()
  events = pushEvent(events, { at, light, text })
  if (!traceOn) return
  traceLines = [...traceLines, new Date(at).toISOString() + ' ' + light + ' ' + text].slice(-200)
  try {
    await $.fs.write(base + '/.claude/stoplight/trace-' + label + '.log', traceLines.join('\n') + '\n')
  } catch {
    // Tracing is a debugging aid; never let it break the guard.
  }
}

async function readLease($, id) {
  const file = leaseFile(id)
  if (!(await $.fs.exists(file))) return null
  let lease = decodeLease(await $.fs.read(file))
  if (!lease) {
    // A write may be half-finished. Look once more before treating the file as garbage.
    await sleep($, 5)
    lease = decodeLease(await $.fs.read(file))
  }
  return lease
}

// Try to take (or confirm) the lease for a path.
// Resolves { state: 'mine', isNew } or { state: 'held', owner, sid, ageMs }.
async function acquire($, norm) {
  const id = leaseId(norm)
  const now = await $.clock.now()
  const held = mine.get(id)
  if (held) {
    held.lastUsed = now
    return { state: 'mine', isNew: false }
  }

  const observed = await readLease($, id)
  const verdict = classify(observed, me, now, TTL_MS)
  if (verdict.state === 'held') return verdict

  if (isStrict) {
    const r = await $.process.run(mkdirArgv(leaseDir + '/' + lockName(id, observed), isWindows))
    if (r.exitCode !== 0) {
      // Someone else won this exact transition. Their lease may still be on its way: look twice.
      for (let i = 0; i < 3; i++) {
        const theirs = await readLease($, id)
        const v = classify(theirs, me, await $.clock.now(), TTL_MS)
        if (v.state === 'held') return v
        await sleep($, 20)
      }
      // No lease ever showed up. A lock left by a crash mid-claim is stale after the TTL; then fall back.
      let lock = null
      try {
        lock = await $.fs.stat(leaseDir + '/' + lockName(id, observed))
      } catch {
        // No way to tell its age: treat the claim as still in progress.
      }
      const mtime = lock && Number(lock.mtimeMs ?? lock.modifiedMs ?? lock.mtime)
      if (!(Number.isFinite(mtime) && (await $.clock.now()) - mtime > TTL_MS)) {
        return { state: 'held', owner: 'another session (claim in progress)', sid: '', ageMs: 0 }
      }
    }
    await $.fs.write(leaseFile(id), encodeLease({ sid: me, label, ts: now, since: now, path: norm }))
    mine.set(id, { path: norm, since: now, lastUsed: now })
    return { state: 'mine', isNew: true }
  }

  await $.fs.write(leaseFile(id), encodeLease({ sid: me, label, ts: now, since: now, path: norm }))
  await sleep($, CLAIM_WAIT_MS)
  // Last writer wins: if a racing session wrote after us, its id is what we read back.
  const back = await readLease($, id)
  if (back && back.sid !== me) return classify(back, me, await $.clock.now(), TTL_MS)

  mine.set(id, { path: norm, since: now, lastUsed: now })
  return { state: 'mine', isNew: true }
}

async function send($, sid, msg, human) {
  try {
    const r = await $.session.send({ to: { sessionId: sid }, text: encodeMessage({ ...msg, from: { sid: me, label } }, human) })
    await note($, '✉', msg.kind + ' → ' + sid.slice(0, 8) + (r && r.isDelivered ? ' delivered' : ' not delivered: ' + (r && r.reason)))
    return Boolean(r && r.isDelivered)
  } catch (err) {
    await note($, '✉', msg.kind + ' → ' + sid.slice(0, 8) + ' failed: ' + String(err).slice(0, 80))
    return false
  }
}

// Tell the owner of a file that this session is waiting for it, at most once a minute per file.
async function tellOwner($, verdict, norm, rel) {
  const key = verdict.sid + ':' + leaseId(norm)
  const now = await $.clock.now()
  if (now - (notified.get(key) ?? -Infinity) < NOTIFY_DEDUPE_MS) return
  notified.set(key, now)
  await send($, verdict.sid, { kind: 'waiting', path: norm }, label + ' (another Claude Code session) is waiting for ' + rel + ', which you hold. It will be resumed automatically when you let go of the file.')
}

// Mark leases as released (ts 0) and tell whoever was waiting, with `summary` (what this session's Claude
// said when it finished) as context for them. `ids` null means every file. Returns how many.
async function release($, ids = null, reason = '', summary = '') {
  let n = 0
  const freed = [...mine].filter(([id]) => ids === null || ids.includes(id))
  for (const [id] of freed) mine.delete(id)
  for (const [id, held] of freed) {
    try {
      // The hand-off note goes first, so a waiter that sees the lease free also finds the summary
      if (summary) await $.fs.write(handoffFile(id), JSON.stringify({ sid: me, label, ts: await $.clock.now(), summary }))
      await $.fs.write(leaseFile(id), encodeLease({ sid: me, label, ts: 0, since: held.since, path: held.path }))
      n += 1
    } catch {
      // Best effort: an unreleased lease expires on its own after the TTL.
    }
    for (const [sid] of waiters.get(id) ?? []) {
      const msg = summary ? { kind: 'released', path: held.path, summary } : { kind: 'released', path: held.path }
      await send($, sid, msg, relPath(root, held.path) + ' is free again: ' + label + ' released it.')
    }
    waiters.delete(id)
  }
  if (n > 0) {
    await note($, '🟢', 'released ' + (n === 1 && freed[0] ? relPath(root, freed[0][1].path) : n + ' file(s)') + (reason ? ' (' + reason + ')' : ''))
    needsRedraw = true
  }
  return n
}

// Re-stamp the leases this session holds, and give up any that a peer has taken over.
async function heartbeat($) {
  const now = await $.clock.now()
  for (const [id, held] of mine) {
    const current = await readLease($, id)
    if (current && current.sid !== me && classify(current, me, now, TTL_MS).state === 'held') {
      mine.delete(id)
      await note($, '⚠', 'lost ' + relPath(root, held.path) + ' to ' + current.label)
      continue
    }
    await $.fs.write(leaseFile(id), encodeLease({ sid: me, label, ts: now, since: held.since, path: held.path }))
  }
  // Keep our place in line fresh, or the owner would take a stale wait file for a session that gave up
  for (const [path] of waitingFor) await writeWait($, path, now)
}

// Someone is waiting for a file this session holds (told by message or by a .wait file).
// Resolves true when this is news.
async function onWaiter($, id, sid, who) {
