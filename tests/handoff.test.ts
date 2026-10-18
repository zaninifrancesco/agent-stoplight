// Hook tests for the hand-off: hold policy (turn / idle / session), waiting in line,
// automatic resume, the resume budget and untangling two sessions that wait on each other.
import { expect, mock, test } from 'claude-code/testing'
import { GRACE_MS, IDLE_MS, encodeLease, leaseId, normalizePath } from '../hooks/lib/lease.js'
import { ROOT, ME, PEER, fakeFs, session, leasePath, peerLease, call, start } from './helpers.ts'

const lease = (files: Map<string, string>, file: string) => files.get(leasePath(file)) ?? ''
const isReleased = (text: string) => text.split('\t')[2] === '0'

function turns(on: any) {
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}
const turnStart = ($: any, turnId = 't1') => $.turn.start({ turnId })
const turnEnd = ($: any, turnId = 't1') => $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, usage: null })

test('hold "turn": files are kept during the task and handed back after the grace period', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  turns(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await turnStart($)
  await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })
  // A long turn keeps the file
  await clock.advance(5 * 60_000)
  expect(isReleased(lease(files, ROOT + '/src/api.ts'))).toBe(false)

  await turnEnd($)
  // Inside the grace period: still ours (a quick "continue" keeps it)
  await clock.advance(GRACE_MS - 10_000)
  expect(isReleased(lease(files, ROOT + '/src/api.ts'))).toBe(false)
  // After it: released without anyone touching anything
  await clock.advance(15_000)
  expect(isReleased(lease(files, ROOT + '/src/api.ts'))).toBe(true)
})

test('hold "turn": a new task inside the grace period keeps the files', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  turns(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await turnStart($, 't1')
  await call($, clock, { tool: 'Edit', file_path: ROOT + '/a.ts' })
  await turnEnd($, 't1')
  await clock.advance(60_000)
  await turnStart($, 't2')
  await clock.advance(GRACE_MS)
  expect(isReleased(lease(files, ROOT + '/a.ts'))).toBe(false)
})

test('a file untouched for the idle limit is let go even in the middle of a long task', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
