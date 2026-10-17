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
