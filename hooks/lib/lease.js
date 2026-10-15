// Pure logic for agent-stoplight. Nothing here touches the mods API, so it can be unit tested directly.
// (A hooks module may import its own files, but may not pass `$` to them.)

export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// A lease is stale when its owner hasn't refreshed it for this long (the owner crashed or was killed).
export const TTL_MS = 120_000
// Owners refresh their leases this often, and every session rescans peers on the same tick.
export const HEARTBEAT_MS = 30_000
export const REFRESH_MS = 5_000
// After writing a lease, wait this long before reading it back. Last writer wins, so once both
// writes have landed every claimant reads the same owner. See spike/SPIKE.md.
export const CLAIM_WAIT_MS = 10
// How long a blocked / nearby / freed alert stays on the band.
export const FLASH_MS = 15_000
// "Someone is waiting for your file" stays up longer: it asks the user to do something.
export const WAIT_ALERT_MS = 60_000
// Don't tell the same owner about the same file more than once a minute.
export const NOTIFY_DEDUPE_MS = 60_000
// Messages between agent-stoplight sessions start with this, so the receiving mod can keep them from Claude.
export const MSG_PREFIX = '[agent-stoplight] '

// How long a session keeps its files:
//   turn    (default) while Claude works on a task, then GRACE_MS after the turn ends, for a quick "continue"
//   idle    until a file goes IDLE_MS without an edit
//   session until the session ends (or /stoplight release)
// In turn and idle modes a file nobody has touched for IDLE_MS is let go, even in the middle of a long turn.
export const HOLD_MODES = ['turn', 'idle', 'session']
export const GRACE_MS = 120_000
export const IDLE_MS = 600_000
// A waiting session is resumed automatically at most this many times per file in this window,
// so two sessions can never ping-pong forever.
export const RESUME_LIMIT = 3
export const RESUME_WINDOW_MS = 30 * 60_000

// Windows paths are case-insensitive and use either slash; make both spellings of a path equal.
export function normalizePath(p) {
  let s = String(p).replace(/\\/g, '/').replace(/\/+/g, '/')
  if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase()
  // Collapse "." and ".." so two spellings of one file get one lease
  const isAbsolute = s.startsWith('/')
  const parts = []
  for (const part of s.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..' && parts.length > 1 && parts[parts.length - 1] !== '..') parts.pop()
    else parts.push(part)
  }
  return (isAbsolute ? '/' : '') + parts.join('/')
}

// Claude often passes a relative path ("src/api.ts") and sometimes an absolute one for the same file.
// Resolve against the session's working directory first, or the two would take different leases.
export function resolvePath(cwd, p) {
  const s = String(p).replace(/\\/g, '/')
  const isAbsolute = s.startsWith('/') || /^[a-zA-Z]:\//.test(s)
  return normalizePath(isAbsolute ? s : String(cwd).replace(/\\/g, '/').replace(/\/$/, '') + '/' + s)
}

function fnv(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

// 64 bits of FNV-1a (two seeds) as 16 hex characters: a stable file name for a path.
export function leaseId(normalizedPath) {
  return fnv(normalizedPath, 2166136261).toString(16).padStart(8, '0') + fnv(normalizedPath, 0x9747b28c).toString(16).padStart(8, '0')
}

// One short line of tab-separated fields, so a single write is as close to atomic as it gets.
export function encodeLease(l) {
  return [l.sid, l.label, l.ts, l.since, l.path.replace(/[\t\r\n]/g, ' ')].join('\t')
}

export function decodeLease(text) {
  if (typeof text !== 'string') return null
  const parts = text.split('\t')
  if (parts.length !== 5) return null
  const ts = Number(parts[2])
  const since = Number(parts[3])
  if (!parts[0] || !Number.isFinite(ts) || !Number.isFinite(since) || !parts[4]) return null
  return { sid: parts[0], label: parts[1], ts, since, path: parts[4] }
}

// ts === 0 marks a released lease.
export function classify(lease, me, now, ttl = TTL_MS) {
  if (!lease) return { state: 'free' }
  if (lease.sid === me) return { state: 'mine' }
  if (lease.ts === 0) return { state: 'free', reason: 'released' }
  if (now - lease.ts > ttl) return { state: 'free', reason: 'stale' }
  return { state: 'held', owner: lease.label, sid: lease.sid, ageMs: now - lease.ts, sinceMs: now - lease.since }
}

export function labelFor(sessionId) {
  return 's-' + String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4)
}

export function relPath(root, normalizedPath) {
  const r = normalizePath(root).replace(/\/$/, '')
  return normalizedPath.startsWith(r + '/') ? normalizedPath.slice(r.length + 1) : normalizedPath
}

// The file a write tool is about to change. Edit and Write use file_path, NotebookEdit uses notebook_path.
export function pathOf(e) {
  return e.file_path ?? e.notebook_path ?? e.path ?? null
}

export function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return s + 's'
  const m = Math.round(s / 60)
  return m < 90 ? m + 'm' : Math.round(m / 60) + 'h'
}

// What Claude should do while it waits: with auto-resume it can simply stop, the mod wakes it up.
function waitAdvice(autoResume, one) {
  return autoResume
    ? 'Work on something else that does not need ' + (one ? 'it' : 'them') + '. If you cannot continue without ' + (one ? 'it' : 'them') +
        ', end your turn now with one short line saying what you are waiting for: agent-stoplight will resume you automatically as soon as ' +
        (one ? 'it is' : 'they are') + ' free. Do not try to change ' + (one ? 'it' : 'them') + ' another way.'
    : 'Work on a different file, or tell the user ' + (one ? 'it is' : 'they are') + ' locked and try again later.'
}

// Written for Claude, so it says what to do next rather than just "denied".
export function denyMessage(rel, held, autoResume = false) {
  return (
    'agent-stoplight: ' + rel + ' is locked by another Claude Code session (' + held.owner + ', active ' + ageText(held.ageMs) + ' ago) and was not changed. ' +
    'Do not edit it now. ' + waitAdvice(autoResume, true)
  )
}

// For a shell command that would touch locked files. items: [{ rel, owner, ageMs }]
export function shellDenyMessage(items, autoResume = false) {
  const list = items.map((i) => i.rel + ' (locked by ' + i.owner + ', active ' + ageText(i.ageMs) + ' ago)').join(', ')
  const one = items.length === 1
  return (
    'agent-stoplight: this command was not run because it would change ' + list + ', held by another Claude Code session. ' +
