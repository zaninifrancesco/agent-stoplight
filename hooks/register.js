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
  const w = waiters.get(id) ?? new Map()
  if (w.has(sid)) return false
  w.set(sid, who)
  waiters.set(id, w)
  const rel = relPath(root, mine.get(id).path)
  alerts.waiting = { at: await $.clock.now(), who, rel }
  await note($, '🔔', who + ' is waiting for ' + rel)
  const isIdle = !inTurn && turnEndedAt > 0 && (await $.clock.now()) - lastToolAt > BUSY_MS
  if (isIdle && holdMode !== 'session') {
    // Our task is already over (we are only in the grace period): no reason to make them wait
    await handOver($, [id])
  } else {
    $.ui.toast('🔔 ' + who + ' is waiting for ' + rel + ' · it goes to them when this task ends')
    expireLater($, WAIT_ALERT_MS)
    await untangle($)
  }
  needsRedraw = true
  return true
}

// Read every live lease in the repo: who is working here and on what.
async function scan($) {
  const now = await $.clock.now()
  let entries = []
  try {
    entries = await $.fs.list(leaseDir)
  } catch {
    // No lease directory yet, so nobody holds anything.
  }
  const rows = []
  const others = []
  const bySession = new Map()
  const waitSeen = new Set()
  for (const entry of entries.slice(0, 400)) {
    if (entry.name.endsWith('.wait')) {
      // Someone is waiting for one of our files?
      const id = entry.name.split('.')[0]
      if (!mine.has(id)) continue
      const w = decodeLease(await $.fs.read(leaseDir + '/' + entry.name))
      if (!w || w.sid === me || w.ts === 0 || now - w.ts > TTL_MS) continue
      waitSeen.add(id + ':' + w.sid)
      if (await onWaiter($, id, w.sid, w.label)) fileWaiters.add(id + ':' + w.sid)
      continue
    }
    if (!entry.name.endsWith('.lease')) continue
    const lease = decodeLease(await $.fs.read(leaseDir + '/' + entry.name))
    if (!lease || classify(lease, me, now, TTL_MS).state === 'free') continue
    const isMine = lease.sid === me
    const w = waiters.get(leaseId(lease.path))
    rows.push({ mine: isMine, rel: relPath(root, lease.path), owner: lease.label, ageMs: now - lease.since, waiters: w ? [...w.values()] : [] })
    if (!isMine) {
      others.push({ sid: lease.sid, label: lease.label, path: lease.path })
      bySession.set(lease.sid, { label: lease.label, files: (bySession.get(lease.sid)?.files ?? 0) + 1 })
    }
  }
  // Waiters we only knew from a .wait file that is gone or stale have stopped waiting
  for (const key of [...fileWaiters]) {
    if (waitSeen.has(key)) continue
    const [id, sid] = key.split(':')
    waiters.get(id)?.delete(sid)
    if (waiters.get(id)?.size === 0) waiters.delete(id)
    fileWaiters.delete(key)
  }
  board = boardRows(rows)
  peers = [...bySession.values()]
  peerLeases = others
}

function redraw($) {
  $.ui.invalidate('ui.render')
}

// Redraw once an alert has run out, so the band drops back to the counters.
function expireLater($, ms) {
  $.clock.after(ms + 100, () => redraw($))
}

// Wake this session up with a prompt from the mod. Not awaited by callers: it resolves only once the
// session is idle and the new turn has started.
async function resumeTask($, text) {
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    await note($, '⚠', 'could not resume: ' + String(err).slice(0, 80))
  }
}

// Files this session was waiting for are free. items: [{ path, rel, by }]
async function onFreed($, items) {
  const now = await $.clock.now()
  for (const i of items) {
    const w = waitingFor.get(i.path)
    waitingFor.delete(i.path)
    await writeWait($, i.path, 0)
    // No summary by message (or no message at all): the owner may have left one on disk
    if (!i.summary) {
      const h = await readHandoff($, leaseId(i.path), now)
      if (h && (!w || !w.ownerSid || h.sid === w.ownerSid)) {
        i.summary = clipSummary(h.summary)
        i.by = i.by || h.label
      }
    }
  }
  // Newer news than "blocked": don't leave a red pill up for a file that is free now
  delete alerts.blocked
  const canWake = autoResume && canWakeHere && !isPaused
  const wake = canWake ? items.filter((i) => canResume(resumes.get(i.path), now)) : []
  const manual = items.filter((i) => !wake.includes(i))
  if (wake.length > 0) {
    for (const i of wake) resumes.set(i.path, [...(resumes.get(i.path) ?? []), now])
    const rel = wake[0].rel + (wake.length > 1 ? ' +' + (wake.length - 1) : '')
    alerts.resumed = { at: now, rel }
    $.ui.toast('▶ ' + rel + ' is free again' + (wake[0].by ? ' (' + wake[0].by + ' released it)' : '') + ': resuming the task')
    await note($, '▶', 'resuming: ' + wake.map((i) => i.rel).join(', ') + ' free again')
    resumeTask($, resumePrompt(wake))
  }
  if (manual.length > 0) {
    const rel = manual[0].rel + (manual.length > 1 ? ' +' + (manual.length - 1) : '')
    alerts.freed = { at: now, rel }
    const why = canWake ? ' (auto-resume limit reached for this file)' : ''
    $.ui.toast('🟢 ' + rel + ' is free again' + why + '. Ask Claude to retry.')
    await note($, '🟢', manual.map((i) => i.rel).join(', ') + ' free again' + why)
  }
  needsRedraw = true
  expireLater($, FLASH_MS)
}

// This session's task is over and someone is waiting: give them the files now, with what Claude said
// when it finished, instead of keeping them for the grace period.
async function handOver($, ids) {
  for (const id of ids) {
    const held = mine.get(id)
    const ws = waiters.get(id)
    if (!held || !ws || ws.size === 0) continue
    const rel = relPath(root, held.path)
    const who = [...ws.values()].join(', ')
    await release($, [id], 'handed to ' + who, lastSummary)
    alerts.handed = { at: await $.clock.now(), rel, who }
    $.ui.toast('➜ handed ' + rel + ' to ' + who)
    expireLater($, FLASH_MS)
  }
}

// Two sessions waiting on each other's files would wait forever. Both see the cycle; the one with the
// larger id gives back the file the other is waiting for, and waits its turn instead.
async function untangle($) {
  for (const [id, ws] of waiters) {
    for (const [sid, who] of ws) {
      const isMutual = [...waitingFor.values()].some((w) => w.ownerSid === sid)
      if (!isMutual || !shouldYield(me, sid) || !mine.has(id)) continue
      const rel = relPath(root, mine.get(id).path)
      alerts.deadlock = { at: await $.clock.now(), who, rel }
      $.ui.toast('↔ ' + who + ' and this session were waiting on each other: handed over ' + rel)
      await note($, '↔', 'deadlock with ' + who + ': handed over ' + rel)
      await release($, [id], 'deadlock with ' + who)
      expireLater($, FLASH_MS)
    }
  }
}

async function onTick($) {
  tick += 1
  const before = JSON.stringify([peers, board])
  try {
    const now = await $.clock.now()
    const due = dueForRelease([...mine].map(([id, h]) => ({ id, lastUsed: h.lastUsed })), { mode: holdMode, inTurn, turnEndedAt, now })
    if (due.length > 0) await release($, due, holdMode === 'turn' && !inTurn ? 'task finished' : 'idle')
    if (tick % (HEARTBEAT_MS / REFRESH_MS) === 0) await heartbeat($)
    await scan($)
    const freed = [...waitingFor].filter(([path]) => !peerLeases.some((l) => l.path === path)).map(([path, w]) => ({ path, rel: w.rel, by: '' }))
    if (freed.length > 0) await onFreed($, freed)
  } catch {
    // A failed scan just leaves the last known picture on screen.
  }
  if (JSON.stringify([peers, board]) !== before || needsRedraw) {
    needsRedraw = false
    redraw($)
  }
}

async function onMessage($, msg) {
  const id = leaseId(msg.path)
  const rel = relPath(root, msg.path)
  if (msg.kind === 'waiting') {
    if (!mine.has(id)) {
      // We no longer hold it (released, or the lease went stale): say so, so the peer can go ahead.
      await send($, msg.from.sid, { kind: 'released', path: msg.path }, rel + ' is not held by ' + label + ' any more.')
      return
    }
    // A message makes it a firm waiter, even if we had only seen its .wait file so far
    fileWaiters.delete(id + ':' + msg.from.sid)
    await onWaiter($, id, msg.from.sid, msg.from.label)
  } else if (waitingFor.has(msg.path)) {
    await onFreed($, [{ path: msg.path, rel, by: msg.from.label, summary: msg.summary }])
  }
  await scan($)
  redraw($)
}

// Called when this session is refused files: queue up, tell the owners, and check for a cycle.
async function wait($, locked) {
  const now = await $.clock.now()
  for (const l of locked) {
    waitingFor.set(l.norm, { rel: l.rel, owner: l.owner, ownerSid: l.sid })
    await writeWait($, l.norm, now)
  }
  for (const l of locked) if (l.sid) await tellOwner($, l, l.norm, l.rel)
  await untangle($)
}

function queuedSummary() {
  const list = [...waitingFor.values()]
  return list.length > 0 ? { rel: list[0].rel, owner: list[0].owner, count: list.length } : null
}

function statusText(now) {
  const freeIn = releaseInMs({ mode: holdMode, inTurn, turnEndedAt, now, held: mine.size })
  const lines = [
    'agent-stoplight ' + (isPaused ? '(paused)' : 'is guarding ' + root),
    'you are ' + label + ', holding ' + mine.size + ' file(s)' + (freeIn !== null ? ' (free in ' + countdownText(freeIn) + ')' : ''),
    'hold ' + holdMode + ' · auto-resume ' + (autoResume ? 'on' : 'off') + ' · strict ' + (isStrict ? 'on' : 'off') + ' · shell guard ' + (guardShell ? 'on' : 'off'),
  ]
  for (const r of board) lines.push(r.light + ' ' + r.rel + ' · ' + r.owner + ' · ' + ageText(r.ageMs) + (r.waiters.length ? ' · 🔔 ' + r.waiters.join(', ') + ' waiting' : ''))
  if (board.length === 0) lines.push('no live leases')
  for (const w of waitingFor.values()) lines.push('⏳ waiting for ' + w.rel + ' (' + w.owner + ')')
  return lines.join('\n')
}

export function register(on, options) {
  // userConfig from the manifest: /plugin configure agent-stoplight sets these
  isStrict = Boolean(options && options.strict)
  guardShell = !(options && options.guard_shell === false)
  autoResume = !(options && options.auto_resume === false)
  if (options && HOLD_MODES.includes(options.hold)) holdMode = options.hold

  on('session.start', async ($, e, next) => {
    me = await $.session.id()
    label = labelFor(me)
    root = await $.session.root()
    cwd = await $.session.cwd()
    base = normalizePath(root).replace(/\/$/, '')
    isWindows = /^[a-z]:\//.test(base)
    isInteractive = e.isInteractive !== false
    leaseDir = base + '/.claude/stoplight/leases'
    traceOn = Boolean(await $.env.get('STOPLIGHT_TRACE'))
    // Environment overrides, handy for CI and for trying a mode once
    const strictEnv = await $.env.get('STOPLIGHT_STRICT')
    if (strictEnv) isStrict = strictEnv !== '0'
    const holdEnv = await $.env.get('STOPLIGHT_HOLD')
    if (HOLD_MODES.includes(holdEnv)) holdMode = holdEnv
    try {
      // Keep leases out of `git status`. Writing a file creates its missing parent directories,
      // and strict mode's mkdir needs the lease directory to exist already.
      await $.fs.write(base + '/.claude/stoplight/.gitignore', '*\n')
      await $.fs.write(leaseDir + '/.keep', '')
    } catch {
      // Not fatal: leases still work, they just show up as untracked files.
    }
    $.clock.every(REFRESH_MS, () => onTick($))
    // The "free in m:ss" countdown on the band moves every second while it runs
    $.clock.every(1000, () => {
      if (releaseInMs({ mode: holdMode, inTurn, turnEndedAt, now: Date.now(), held: mine.size }) !== null) redraw($)
    })
    await note($, '🚦', 'session ' + label + ' started in ' + root)
    // Which apps draw this session: a session some app draws can take a resume prompt
    let surfaces = []
    try {
      surfaces = await $.session.surfaces()
    } catch {
      // Older builds: fall back to the event's own fields
    }
    const drawnBy = JSON.stringify([e.surface ?? null, surfaces ?? null])
    canWakeHere = isInteractive || /desktop|vscode/i.test(drawnBy)
    if (traceOn) await note($, '·', 'session.start isInteractive=' + e.isInteractive + ' surface=' + e.surface + ' surfaces=' + JSON.stringify(surfaces) + ' canWake=' + canWakeHere)
    await $.command.register({
      name: 'stoplight',
      description: 'Who holds which files. release · pause · resume · status · hold turn|idle|session · auto on|off · strict on|off · shell on|off',
      argumentHint: '[release|status|hold turn|auto off|strict on|shell off]',
    })
    return next(e)
  })

  // Files are held for the length of the main conversation's turn (subagent turns don't count).
  on('turn.start', async ($, e, next) => {
    if (traceOn) await note($, '·', 'turn.start ' + e.turnId + (e.agentId ? ' agent ' + e.agentId : ''))
    if (!e.agentId) {
      inTurn = true
      activeTurn = e.turnId ?? null
      redraw($)
    }
    return next(e)
  })

  // Every tool call, from Claude or a subagent, means this session is busy right now
  on('tool.call', async ($, e, next) => {
    lastToolAt = await $.clock.now()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (traceOn) await note($, '·', 'turn.complete ' + e.turnId + (e.agentId ? ' agent ' + e.agentId : '') + (e.isAborted ? ' aborted' : '') + (e.turnId !== activeTurn ? ' (not the active turn ' + activeTurn + ')' : ''))
    // Only the end of the turn we saw start counts as the end of our task. An end with no start seen
    // still stops the "in turn" state (so files go back after the grace period) but never hands over early.
    const isOurs = !e.agentId && activeTurn !== null && e.turnId === activeTurn
    const isUnmatched = !e.agentId && activeTurn === null
    if (isOurs || isUnmatched) {
      activeTurn = null
      inTurn = false
      turnEndedAt = await $.clock.now()
      if (typeof e.answer === 'string' && e.answer.trim()) lastSummary = clipSummary(e.answer)
      // Files someone is waiting for go to them right away; the rest keep the grace period
      if (isOurs && holdMode !== 'session' && !e.isAborted) {
        try {
          await handOver($, [...waiters.keys()])
        } catch {
          // The grace-period release still happens on the next tick
        }
      }
      redraw($)
    }
    return next(e)
  })

  // The guard. Fails open: if anything goes wrong the edit is allowed and a dim line says why.
  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const target = pathOf(e)
    if (isPaused || !target || !me) return next(e)
    const norm = resolvePath(cwd, target)
    const rel = relPath(root, norm)
    let verdict = { state: 'mine', isNew: false }
    try {
      verdict = await acquire($, norm)
    } catch (err) {
      $.ui.log('agent-stoplight: could not check the lease, letting the edit through (' + String(err).slice(0, 100) + ')')
      return next(e)
    }

    if (verdict.state === 'held') {
      alerts.blocked = { at: await $.clock.now(), rel, owner: verdict.owner, ageMs: verdict.ageMs }
      blockedCount += 1
      $.ui.toast('🔴 ' + rel + ' is locked by ' + verdict.owner + (autoResume && canWakeHere ? ' · waiting in line, resumes by itself' : ''))
      await note($, '🔴', 'blocked ' + rel + ' (held by ' + verdict.owner + ')')
      redraw($)
      expireLater($, FLASH_MS)
      await wait($, [{ norm, rel, owner: verdict.owner, sid: verdict.sid }])
      return { deny: denyMessage(rel, verdict, autoResume && canWakeHere) }
    }

    waitingFor.delete(norm)
    if (verdict.isNew) {
      await note($, '🟢', 'took ' + rel)
      const near = nearbyPeers(norm, peerLeases)
      if (near.length > 0) {
        const who = near.map((p) => p.label).join(', ')
        const files = near.flatMap((p) => p.files).slice(0, 3)
        alerts.near = { at: await $.clock.now(), who, dir: relPath(root, dirOf(norm)), files }
        $.ui.toast('🟡 ' + who + ' is also editing in ' + relPath(root, dirOf(norm)) + '/ (' + files.join(', ') + ')')
        await note($, '🟡', who + ' is editing next to ' + rel)
        expireLater($, FLASH_MS)
      }
      redraw($)
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // Shell commands: best effort. Only writes the parser recognises are guarded (see lib/shell.js);
  // everything else runs as usual. Same fail-open rule as the edit guard.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    if (isPaused || !guardShell || !me || typeof e.command !== 'string') return next(e)
    const locked = []
    try {
      for (const t of shellTargets(e.command, e.tool, cwd)) {
        const norm = resolvePath(t.cwd || cwd, t.path)
        if (norm.startsWith(leaseDir)) continue
        const verdict = await acquire($, norm)
        if (verdict.state === 'held') locked.push({ norm, rel: relPath(root, norm), owner: verdict.owner, ageMs: verdict.ageMs, sid: verdict.sid })
        else if (verdict.isNew) await note($, '🟢', 'took ' + relPath(root, norm) + ' (shell)')
      }
    } catch (err) {
      $.ui.log('agent-stoplight: could not check this command, letting it run (' + String(err).slice(0, 100) + ')')
      return next(e)
    }
    if (locked.length === 0) {
      redraw($)
      return next(e)
    }
    const first = locked[0]
    alerts.blocked = { at: await $.clock.now(), rel: first.rel + (locked.length > 1 ? ' +' + (locked.length - 1) : ''), owner: first.owner, ageMs: first.ageMs }
    blockedCount += 1
    $.ui.toast('🔴 command not run: ' + locked.map((l) => l.rel).join(', ') + ' locked by ' + first.owner)
    await note($, '🔴', 'blocked a ' + e.tool + ' command touching ' + locked.map((l) => l.rel).join(', '))
    redraw($)
    expireLater($, FLASH_MS)
    await wait($, locked)
    return { deny: shellDenyMessage(locked, autoResume && canWakeHere) }
  }).catch(async ($, e, next) => next(e))

  // Protocol messages from other agent-stoplight sessions are for this mod, not for Claude.
  on('session.receive', async ($, e, next) => {
    if (traceOn) await note($, '✉', 'received (' + (e.origin && e.origin.kind) + '): ' + String(e.text).replace(/\s+/g, ' ').slice(0, 160))
    const msg = decodeMessage(e.text)
    if (!msg) return next(e)
    try {
      await onMessage($, msg)
    } catch {
      // A malformed or unexpected message is dropped either way.
    }
    return { consumed: 'agent-stoplight protocol message' }
  }).catch(async ($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (me) await release($)
    return next(e)
  })

  on('command.run', { command: 'stoplight' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'release') {
      const n = await release($, null, 'by hand')
      await scan($)
      redraw($)
      return { text: 'Released ' + n + ' file(s). Other sessions can edit them now.' }
    }
    const toggle = arg.match(/^(strict|shell|auto)\s+(on|off)$/)
    if (toggle) {
      const enable = toggle[2] === 'on'
      if (toggle[1] === 'strict') isStrict = enable
      else if (toggle[1] === 'shell') guardShell = enable
      else autoResume = enable
      await note($, '⚙', toggle[1] + ' ' + toggle[2])
      redraw($)
      const what = { strict: 'Strict mode (atomic claims, slower first edit of each file)', shell: 'Shell command guarding', auto: 'Automatic resume when a file comes free' }[toggle[1]]
      return { text: what + ' is ' + (enable ? 'on' : 'off') + ' for this session.' }
    }
    const hold = arg.match(/^hold\s+(\w+)$/)
    if (hold) {
      if (!HOLD_MODES.includes(hold[1])) return { text: 'Hold mode must be one of: ' + HOLD_MODES.join(', ') + '.' }
      holdMode = hold[1]
      await note($, '⚙', 'hold ' + holdMode)
      redraw($)
      const how = { turn: 'while Claude works on a task, then 2 minutes more', idle: 'until a file goes 10 minutes without an edit', session: 'until this session ends' }[holdMode]
      return { text: 'Files are now held ' + how + '.' }
    }
    if (arg === 'pause' || arg === 'resume') {
      isPaused = arg === 'pause'
      await note($, isPaused ? '⏸' : '▶', isPaused ? 'paused' : 'resumed')
      redraw($)
      return { text: isPaused ? 'agent-stoplight paused: edits are no longer checked.' : 'agent-stoplight resumed.' }
    }
    await scan($)
    if (arg === 'status') return { text: statusText(await $.clock.now()) }
    await $.ui.open({ id: PANE, title: '🚦 Stoplight', focus: true, closeOnEscape: true })
    return {}
  })

  // The band above the prompt: always visible, coloured pills, one alert at a time.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const others = await next(e)
    const now = await $.clock.now()
    const columns = (e.props && e.props.bodyColumns) || 120
    const segments = bandSegments(
      {
        mine: mine.size,
        peers,
        blockedCount,
        paused: isPaused,
        strict: isStrict,
        now,
        alert: pickAlert(alerts, now),
        queued: queuedSummary(),
        freeInMs: releaseInMs({ mode: holdMode, inTurn, turnEndedAt, now, held: mine.size }),
      },
      columns,
    )
    const row = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: segments.map((s, i) =>
        Text({ key: 'seg-' + i, color: s.color, backgroundColor: s.bg, dimColor: s.dim, weight: s.bold ? 'bold' : undefined, children: [s.text] }),
      ),
    })
    return Box({ flexDirection: 'column', children: [row, others].filter(Boolean) })
  })

  // The /stoplight board: who holds what, who is waiting, and what just happened.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const columns = (e.props && e.props.bodyColumns) || 80
    const freeInMs = releaseInMs({ mode: holdMode, inTurn, turnEndedAt, now, held: mine.size })
    const header = bandSegments({ mine: mine.size, peers, blockedCount, paused: isPaused, strict: isStrict, now, alert: null, freeInMs }, columns).slice(0, -1)

    const fileRows = board.map((r, i) =>
      Box({
        key: 'file-' + i,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ backgroundColor: r.light === '🟢' ? 'green' : 'red', color: r.light === '🟢' ? 'black' : 'white', children: [' ' + r.light + ' '] }),
          Text({ weight: 'bold', children: [r.rel] }),
          Text({ dimColor: true, children: [r.owner + ' · ' + ageText(r.ageMs)] }),
          ...(r.waiters.length > 0 ? [Text({ color: 'yellow', weight: 'bold', children: ['🔔 ' + r.waiters.join(', ') + ' waiting'] })] : []),
        ],
      }),
    )
    const waitRows = [...waitingFor.values()].map((w, i) =>
      Box({
        key: 'wait-' + i,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ backgroundColor: 'blue', color: 'white', children: [' ⏳ '] }),
          Text({ weight: 'bold', children: [w.rel] }),
          Text({ dimColor: true, children: ['held by ' + w.owner + (autoResume && canWakeHere ? ' · resumes by itself' : ' · retry by hand')] }),
        ],
      }),
    )
    const recent = events.slice(0, 8).map((ev, i) => Text({ key: 'ev-' + i, dimColor: i > 0, children: [ev.light + ' ' + ev.text + '  ·  ' + ageText(now - ev.at) + ' ago'] }))

    return Box({
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'row', columnGap: 2, children: header.map((s, i) => Text({ key: 'h-' + i, color: s.color, backgroundColor: s.bg, dimColor: s.dim, weight: s.bold ? 'bold' : undefined, children: [s.text] })) }),
        Text({ dimColor: true, children: ['You are ' + label + ' · hold ' + holdMode + ' · auto-resume ' + (autoResume ? 'on' : 'off') + ' · leases in ' + relPath(root, leaseDir)] }),
        Text({ children: [' '] }),
        Text({ weight: 'bold', children: ['FILES'] }),
        ...(fileRows.length > 0 ? fileRows : [Text({ dimColor: true, children: ['No live leases. Every file is 🟢 free.'] })]),
        ...(waitRows.length > 0 ? [Text({ children: [' '] }), Text({ weight: 'bold', children: ['WAITING FOR'] }), ...waitRows] : []),
        Text({ children: [' '] }),
        Text({ weight: 'bold', children: ['RECENT'] }),
        ...(recent.length > 0 ? recent : [Text({ dimColor: true, children: ['Nothing yet.'] })]),
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({
              key: 'release',
              label: 'Release mine',
              hotkey: 'r',
              onPress: async () => {
                await release($, null, 'by hand')
                await scan($)
                redraw($)
              },
            }),
            Button({
              key: 'refresh',
              label: 'Refresh',
              hotkey: 'f',
              onPress: async () => {
                await scan($)
                redraw($)
              },
            }),
            Button({
              key: 'pause',
              label: isPaused ? 'Resume' : 'Pause',
              hotkey: 'p',
              onPress: async () => {
                isPaused = !isPaused
                await note($, isPaused ? '⏸' : '▶', isPaused ? 'paused' : 'resumed')
                redraw($)
              },
            }),
          ],
        }),
