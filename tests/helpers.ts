// Shared fixtures for the hook tests: a fake file system, session stubs and lease builders.
import { mock } from 'claude-code/testing'
import { encodeLease, leaseId, normalizePath } from '../hooks/lib/lease.js'

export const ROOT = '/work/repo'
export const ME = 'meeeeeee-1111'
export const PEER = 'peeeeeer-2222'

// An in-memory file system shared by the fs stubs of one test.
export function fakeFs(on: any, files: Map<string, string>, hooks: { afterWrite?: (path: string) => void } = {}) {
  // On Windows the harness makes /work/repo absolute as C:\work\repo, so compare paths without the drive
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  const writes: string[] = []
  on('fs.exists', ($: any, e: any) => ({ value: files.has(key(e.path)) }))
  on('fs.read', ($: any, e: any) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.write', ($: any, e: any) => {
    files.set(key(e.path), e.text ?? e.content)
    writes.push(key(e.path))
    hooks.afterWrite?.(key(e.path))
    return { value: undefined }
  })
  on('fs.list', ($: any, e: any) => {
    const dir = key(e.path).replace(/\/$/, '') + '/'
    return { value: [...files.keys()].filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes('/')).map((f) => ({ name: f.slice(dir.length), kind: 'file', size: 1, isLink: false })) }
  })
  return writes
}

// Stubs for everything a session answers. Returns what the mod sent and showed, for assertions.
export function session(on: any, root: string = ROOT) {
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: ME }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.send', ($: any, e: any) => {
    sent.push({ to: String(e.to), text: e.text })
    return { isDelivered: true }
  })
  // Prompts the mod submits to wake the session up. $.prompt.submit fires the prompt.submit event,
  // so the stub answers with that event's result shape.
  const prompts: string[] = []
  on('prompt.submit', ($: any, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  mock.env(on, {})
  // What Claude Code itself does with a tool call that the mod lets through
  on('tool.call', () => ({ result: 'tool ran' }))
  return { sent, toasts, prompts }
}

export const leasePath = (file: string) => ROOT + '/.claude/stoplight/leases/' + leaseId(normalizePath(file)) + '.lease'
export const peerLease = (file: string, ts: number) => encodeLease({ sid: PEER, label: 's-peee', ts, since: ts, path: normalizePath(file) })

// The mod waits on the mock clock while claiming a lease, so the test must move time while the call is pending.
export async function call($: any, clock: any, args: any) {
  const pending = $.tool.call(args)
  for (let i = 0; i < 8; i++) await clock.advance(10)
  return pending
}

export async function start($: any, cwd: string = ROOT) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd })
}
