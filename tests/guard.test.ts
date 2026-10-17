// Hook tests: the real mod runs against a fake file system, clock and session.
import { expect, mock, test } from 'claude-code/testing'
import { leaseId, normalizePath } from '../hooks/lib/lease.js'
import { ROOT, ME, PEER, fakeFs, session, leasePath, peerLease, call, start } from './helpers.ts'

test('a free file is allowed and leased to this session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out = await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })
  expect(out).toEqual({ result: 'tool ran' })
  expect(files.get(leasePath(ROOT + '/src/api.ts'))).toContain(ME)
})

test('a file held by a live peer is refused with an instruction for Claude', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>([[leasePath(ROOT + '/src/api.ts'), peerLease(ROOT + '/src/api.ts', 995_000)]])
  const writes = fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'Write', file_path: ROOT + '/src/api.ts' })
  expect(out.deny).toContain('src/api.ts')
  expect(out.deny).toContain('s-peee')
  // In an interactive session Claude is told it can simply stop: it will be resumed
  expect(out.deny).toContain('resume you automatically')
  expect(out.deny).toContain('Do not try to change it another way')
  // The peer's lease is untouched
  expect(writes.filter((w) => w.endsWith(leaseId(normalizePath(ROOT + '/src/api.ts')) + '.lease'))).toEqual([])
})

test('a stale or released peer lease is taken over', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const stale = ROOT + '/src/stale.ts'
  const released = ROOT + '/src/released.ts'
  const files = new Map<string, string>([
    [leasePath(stale), peerLease(stale, 1_000_000 - 200_000)],
    [leasePath(released), peerLease(released, 0)],
  ])
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  expect(await call($, clock, { tool: 'Edit', file_path: stale })).toEqual({ result: 'tool ran' })
