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
  expect(await call($, clock, { tool: 'Edit', file_path: released })).toEqual({ result: 'tool ran' })
  expect(files.get(leasePath(stale))).toContain(ME)
  expect(files.get(leasePath(released))).toContain(ME)
})

test('editing a file this session already holds costs no file system access', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const writes = fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: ROOT + '/a.ts' })
  const after = writes.length
  await call($, clock, { tool: 'Edit', file_path: ROOT + '/a.ts' })
  await call($, clock, { tool: 'Write', file_path: ROOT + '/a.ts' })
  expect(writes.length).toBe(after)
})

test('losing a claim race to a peer refuses the edit', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/race.ts'
  const files = new Map<string, string>()
  // The moment this session writes its lease, the peer overwrites it: last writer wins
  fakeFs(on, files, { afterWrite: (path) => { if (path === leasePath(target)) files.set(path, peerLease(target, 1_000_000)) } })
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'Edit', file_path: target })
  expect(out.deny).toContain('s-peee')
})

test('fails open: a broken file system lets the edit through', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.exists', () => ({ deny: 'disk on fire' }))
  on('fs.write', () => ({ deny: 'disk on fire' }))
  on('fs.list', () => ({ deny: 'disk on fire' }))
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  expect(await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })).toEqual({ result: 'tool ran' })
})

test('tools that do not write files never touch the file system', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const writes = fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)
  const before = writes.length

  expect(await call($, clock, { tool: 'Read', file_path: ROOT + '/a.ts' })).toEqual({ result: 'tool ran' })
  expect(await call($, clock, { tool: 'Bash', command: 'ls' })).toEqual({ result: 'tool ran' })
  expect(writes.length).toBe(before)
})

test('a relative path and an absolute path are the same file, so they share one lease', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>([[leasePath(target), peerLease(target, 999_000)]])
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  // Claude passes both spellings of the same file; a peer holding it must block all of them
  for (const spelling of ['src/api.ts', './src/api.ts', 'src/../src/api.ts', ROOT + '/src/api.ts']) {
    const out: any = await call($, clock, { tool: 'Edit', file_path: spelling })
    expect(out.deny).toContain('s-peee')
  }
})

test('a relative path takes the same lease an absolute path would', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: 'src/ui.ts' })
  expect(files.get(leasePath(ROOT + '/src/ui.ts'))).toContain(ME)
})

test('NotebookEdit is guarded through notebook_path', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const nb = ROOT + '/analysis.ipynb'
  const files = new Map<string, string>([[leasePath(nb), peerLease(nb, 999_000)]])
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const out: any = await call($, clock, { tool: 'NotebookEdit', notebook_path: nb })
  expect(out.deny).toContain('analysis.ipynb')
})

test('/stoplight pause lets everything through, resume guards again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>([[leasePath(target), peerLease(target, 999_000)]])
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'pause' })
  expect(await call($, clock, { tool: 'Edit', file_path: target })).toEqual({ result: 'tool ran' })
  await $.command.run({ command: 'stoplight', args: 'resume' })
  const out: any = await call($, clock, { tool: 'Edit', file_path: target })
  expect(out.deny).toContain('s-peee')
})

test('/stoplight release hands the files back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: ROOT + '/a.ts' })
  const answer = await $.command.run({ command: 'stoplight', args: 'release' })
  expect(answer.text).toContain('Released 1 file')
  // ts 0 means released, so a peer treats the file as free
  expect(files.get(leasePath(ROOT + '/a.ts'))?.split('\t')[2]).toBe('0')
})

test('session end releases every lease', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('session.end', () => ({ sessionId: ME }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: ROOT + '/a.ts' })
  await call($, clock, { tool: 'Edit', file_path: ROOT + '/b.ts' })
  await $.session.end({ reason: 'other' })
  expect(files.get(leasePath(ROOT + '/a.ts'))?.split('\t')[2]).toBe('0')
  expect(files.get(leasePath(ROOT + '/b.ts'))?.split('\t')[2]).toBe('0')
})

test('the band shows the lights and turns red after a block', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>([[leasePath(target), peerLease(target, 999_000)]])
  fakeFs(on, files)
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['claude code band'] }))
  await start($)

  const props = { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} }
  const mountBand = () => $.ui.mount({ plugin: 'agent-stoplight', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props })

  let ui = await mountBand()
  expect(await ui.find({ type: 'Text', text: '🟢 0 yours' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '🔴 0 blocks' })).toBeDefined()
  await ui.unmount()

  await call($, clock, { tool: 'Edit', file_path: target })
  ui = await mountBand()
  const pill: any = await ui.find({ type: 'Text', text: /^ 🔴 BLOCKED src\/api\.ts · held by s-peee/ })
  expect(pill).toBeDefined()
  expect(pill.props.backgroundColor).toBe('red')
  await ui.unmount()

  // The alert runs out and the band goes back to counters
  await clock.advance(20_000)
  ui = await mountBand()
  expect(await ui.find({ type: 'Text', text: /BLOCKED/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '🔴 1 block' })).toBeDefined()
  await ui.unmount()
})

const protocol = (kind: string, path: string, from = { sid: PEER, label: 's-peee' }) =>
  '[agent-stoplight] ' + JSON.stringify({ v: 1, kind, path: normalizePath(path), from }) + '\nhuman text'

test('a blocked session tells the owner once that it is waiting', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>([[leasePath(target), peerLease(target, 999_000)]])
  fakeFs(on, files)
  const { sent, toasts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: target })
  await call($, clock, { tool: 'Edit', file_path: target })
  expect(sent.length).toBe(1)
  expect(sent[0].to).toContain(PEER)
  expect(sent[0].text.startsWith('[agent-stoplight] ')).toBe(true)
  expect(sent[0].text).toContain('"kind":"waiting"')
  expect(sent[0].text).toContain('is waiting for src/api.ts')
  expect(toasts.some((t) => t.startsWith('🔴 src/api.ts is locked by s-peee'))).toBe(true)
})

test('the holder sees who is waiting, and is told nothing about it reaches Claude', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  fakeFs(on, files)
  const { sent, toasts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('session.receive', ($: any, e: any) => ({ text: e.text }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })
  const r: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: protocol('waiting', ROOT + '/src/api.ts') })
  expect(r.consumed).toBeDefined()
  expect(toasts.some((t) => t.startsWith('🔔 s-peee is waiting for src/api.ts'))).toBe(true)

  const status = await $.command.run({ command: 'stoplight', args: 'status' })
  expect(status.text).toContain('🔔 s-peee waiting')

  // Releasing hands the file over and tells the waiter
  await $.command.run({ command: 'stoplight', args: 'release' })
  const released = sent.filter((m) => m.text.includes('"kind":"released"'))
  expect(released.length).toBe(1)
  expect(released[0].to).toContain(PEER)
})

test('a waiting message for a file we no longer hold is answered with released', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  fakeFs(on, new Map())
  const { sent } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const r: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: protocol('waiting', ROOT + '/src/api.ts') })
  expect(r.consumed).toBeDefined()
  expect(sent.length).toBe(1)
  expect(sent[0].text).toContain('"kind":"released"')
})

test('a released message wakes the waiting session up and the band says so', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  fakeFs(on, new Map([[leasePath(target), peerLease(target, 999_000)]]))
  const { toasts, prompts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['claude code band'] }))
  await start($)

  await call($, clock, { tool: 'Edit', file_path: target })
  const r: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: protocol('released', target) })
  expect(r.consumed).toBeDefined()
  expect(toasts.some((t) => t.startsWith('▶ src/api.ts is free again (s-peee released it): resuming the task'))).toBe(true)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('src/api.ts (released by s-peee) is free again')
  expect(prompts[0]).toContain('Read it again before changing anything')

  const props = { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'agent-stoplight', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', viewport: { columns: 120, rows: 30 }, props })
  const pill: any = await ui.find({ type: 'Text', text: ' ▶ src/api.ts is free: resuming the task ' })
  expect(pill).toBeDefined()
  expect(pill.props.backgroundColor).toBe('green')
  await ui.unmount()
})

test('a released message for a file we were not waiting for is ignored', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  fakeFs(on, new Map())
  const { toasts, prompts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  const r: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: protocol('released', ROOT + '/src/api.ts') })
  expect(r.consumed).toBeDefined()
  expect(prompts.length).toBe(0)
  expect(toasts.length).toBe(0)
})

test('with auto-resume off, a refused file is announced free once the owner lets go, even without a message', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const target = ROOT + '/src/api.ts'
  const files = new Map<string, string>([[leasePath(target), peerLease(target, 999_000)]])
  fakeFs(on, files)
  const { toasts, prompts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  await $.command.run({ command: 'stoplight', args: 'auto off' })
  const out: any = await call($, clock, { tool: 'Edit', file_path: target })
  // Without auto-resume Claude is told to move on or ask the user, not to stop and wait
  expect(out.deny).toContain('Work on a different file')
  expect(prompts.length).toBe(0)
  // Still held: the next scan says nothing
  await clock.advance(5_000)
  expect(toasts.some((t) => t.includes('free again'))).toBe(false)

  // The owner exits and marks the lease released (ts 0); the next scan notices
  files.set(leasePath(target), peerLease(target, 0))
  await clock.advance(5_000)
  expect(toasts.filter((t) => t.startsWith('🟢 src/api.ts is free again')).length).toBe(1)
  // ...and only once
  await clock.advance(5_000)
  expect(toasts.filter((t) => t.startsWith('🟢 src/api.ts is free again')).length).toBe(1)
})

test('ordinary messages from other sessions still reach Claude', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  fakeFs(on, new Map())
  session(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('session.receive', ($: any, e: any) => ({ text: e.text }))
  await start($)

  const r: any = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: 'Status? One line.' })
  expect(r.consumed).toBeUndefined()
  expect(r.text).toBe('Status? One line.')
})

test('a peer editing in the same directory turns the light yellow, not red', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const peerFile = ROOT + '/src/db.ts'
  const files = new Map<string, string>([[leasePath(peerFile), peerLease(peerFile, 999_000)]])
  fakeFs(on, files)
  const { toasts } = session(on)
  on('session.start', () => ({ cwd: ROOT }))
  await start($)

  // Let the 5-second scan pick up the peer's lease
  await clock.advance(5_000)
  const out = await call($, clock, { tool: 'Edit', file_path: ROOT + '/src/api.ts' })
  expect(out).toEqual({ result: 'tool ran' })
  expect(toasts.some((t) => t.startsWith('🟡 s-peee is also editing in src/ (db.ts)'))).toBe(true)

  // A file in another directory is not "nearby"
  const before = toasts.length
  await call($, clock, { tool: 'Edit', file_path: ROOT + '/docs/readme.md' })
  expect(toasts.length).toBe(before)
})
