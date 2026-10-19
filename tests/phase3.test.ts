// Hook tests for shell commands, strict mode and Windows paths.
import { expect, mock, test } from 'claude-code/testing'
import { encodeLease, leaseId, normalizePath } from '../hooks/lib/lease.js'
import { ROOT, ME, PEER, fakeFs, session, leasePath, peerLease, call, start } from './helpers.ts'

test('a Bash command that would write a held file is not run, and the owner is told', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  fakeFs(on, new Map([[leasePath(target), peerLease(target, 999_000)]]))
  const { sent, toasts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'Bash', command: "sed -i 's/hello/goodbye/' src/api.ts src/ui.ts" })
  expect(out.deny).toContain('this command was not run')
  expect(out.deny).toContain('src/api.ts (locked by s-peee')
  expect(out.deny).not.toContain('src/ui.ts (locked')
  expect(toasts.some((t) => t.startsWith('🔴 command not run: src/api.ts'))).toBe(true)
  expect(sent.some((m) => m.to.includes(PEER) && m.text.includes('"kind":"waiting"'))).toBe(true)
})

test('a Bash command on free files runs and leases them; read-only commands lease nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  expect(await call($, clock, { tool: 'Bash', command: 'npm run build > build.log && git status' })).toEqual({ result: 'tool ran' })
  expect(files.get(leasePath(ROOT + '/build.log'))).toContain(ME)
  const leases = () => [...files.keys()].filter((k) => k.endsWith('.lease')).length
  const before = leases()
  expect(await call($, clock, { tool: 'Bash', command: 'ls -la && cat src/api.ts' })).toEqual({ result: 'tool ran' })
  expect(leases()).toBe(before)
})

test('cd inside a command moves where relative targets resolve', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  fakeFs(on, new Map([[leasePath(target), peerLease(target, 999_000)]]))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'Bash', command: 'cd src && echo x >> api.ts' })
  expect(out.deny).toContain('src/api.ts')
})

test('PowerShell writes are guarded too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/notes.txt'
  fakeFs(on, new Map([[leasePath(target), peerLease(target, 999_000)]]))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'PowerShell', command: "'hello' | Set-Content -Path notes.txt" })
  expect(out.deny).toContain('notes.txt')
})

test('/stoplight shell off lets shell commands through, edits stay guarded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  fakeFs(on, new Map([[leasePath(target), peerLease(target, 999_000)]]))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const answer = await $.command.run({ command: 'stoplight', args: 'shell off' })
  expect(answer.text).toContain('is off')
  expect(await call($, clock, { tool: 'Bash', command: 'echo x > src/api.ts' })).toEqual({ result: 'tool ran' })
  const out: any = await call($, clock, { tool: 'Edit', file_path: target })
  expect(out.deny).toContain('s-peee')
})

// Fake mkdir for strict mode: atomic by construction, like the real one.
function fakeMkdir(on: any, dirs: Set<string>, onRun?: () => void) {
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    onRun?.()
    const p = String(e.argv[e.argv.length - 1]).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
    if (dirs.has(p)) return { value: { exitCode: 1, stdout: '', stderr: 'exists' } }
    dirs.add(p)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return runs
}

test('strict mode claims with one mkdir and writes the lease straight away', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  const runs = fakeMkdir(on, new Set())
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'strict on' })
  // No clock advance needed: strict mode has no read-back wait
  expect(await $.tool.call({ tool: 'Edit', file_path: ROOT + '/src/api.ts' })).toEqual({ result: 'tool ran' })
  expect(runs.length).toBe(1)
  expect(runs[0][runs[0].length - 1]).toMatch(/@0\.lock$/)
  expect(files.get(leasePath(ROOT + '/src/api.ts'))).toContain(ME)
})

test('strict mode: losing the mkdir race to a peer refuses the edit', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>()
  fakeFs(on, files)
  // The peer already won this transition (no lease seen, so @0); its lease lands as we try
  const dirs = new Set([ROOT + '/.claude/stoplight/leases/' + leaseId(normalizePath(target)) + '@0.lock'])
  fakeMkdir(on, dirs, () => files.set(leasePath(target), peerLease(target, 1_000_000)))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'strict on' })
  const out: any = await call($, clock, { tool: 'Edit', file_path: target })
  expect(out.deny).toContain('s-peee')
})

test('strict mode: a fresh lock with no lease behind it reads as a claim in progress', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  fakeFs(on, new Map())
  on('fs.stat', () => ({ value: { mtimeMs: 999_000 } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'exists' } }))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'strict on' })
  const out: any = await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })
  expect(out.deny).toContain('claim in progress')
})

test('strict mode: a lock older than the TTL with no lease is stale and gets taken over', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  on('fs.stat', () => ({ value: { mtimeMs: 1_000_000 - 300_000 } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'exists' } }))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'strict on' })
  expect(await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })).toEqual({ result: 'tool ran' })
  expect(files.get(leasePath(ROOT + '/src/api.ts'))).toContain(ME)
})

test('Windows: drive letter, case and slash spellings of one file share one lease', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const WIN = 'C:\\Work\\Repo'
  const norm = normalizePath('C:/Work/Repo/src/api.ts')
  // fakeFs compares paths without the drive letter; the mod lower-cases Windows paths
  const files = new Map([
    ['/work/repo/.claude/stoplight/leases/' + leaseId(norm) + '.lease', encodeLease({ sid: PEER, label: 's-peee', ts: 999_000, since: 999_000, path: norm })],
  ])
  fakeFs(on, files)
  const runs = fakeMkdir(on, new Set())
  session(on, WIN)
  on('session.start', () => ({ cwd: WIN }))
  await start($, WIN)

  for (const spelling of ['C:\\Work\\Repo\\SRC\\Api.ts', 'c:/work/repo/src/api.ts', 'src\\api.ts', '.\\src\\..\\src\\api.ts']) {
    const out: any = await call($, clock, { tool: 'Edit', file_path: spelling })
    expect(out.deny).toContain('s-peee')
  }
  // Strict mode on Windows goes through cmd's mkdir, with backslashes
  await $.command.run({ command: 'stoplight', args: 'strict on' })
  await $.tool.call({ tool: 'Edit', file_path: 'src\\ui.ts' })
  expect(runs[0].slice(0, 3)).toEqual(['cmd', '/c', 'mkdir'])
  expect(runs[0][3]).toContain('\\.claude\\stoplight\\leases\\')
})

test('POSIX: strict mode runs plain mkdir and paths keep their case', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  const runs = fakeMkdir(on, new Set())
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'strict on' })
  await $.tool.call({ tool: 'Edit', file_path: ROOT + '/Src/Api.ts' })
  expect(runs[0][0]).toBe('mkdir')
  expect(files.get(leasePath(ROOT + '/Src/Api.ts'))).toContain('/work/repo/Src/Api.ts')
})
