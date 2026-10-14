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

