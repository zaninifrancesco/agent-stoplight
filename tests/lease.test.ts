// Unit tests for the pure lease logic: no session, no mods API.
import { expect, test } from 'claude-code/testing'
import {
  TTL_MS, normalizePath, resolvePath, leaseId, encodeLease, decodeLease, classify, labelFor, relPath, pathOf, ageText, denyMessage, bandSegments, boardRows,
  cells, nearbyPeers, dirOf, encodeMessage, decodeMessage, pickAlert, pushEvent, shellDenyMessage,
  GRACE_MS, IDLE_MS, dueForRelease, releaseInMs, countdownText, resumePrompt, shouldYield, canResume, clipSummary,
} from '../hooks/lib/lease.js'

test('normalizePath makes both slash styles and drive-letter case equal', () => {
  expect(normalizePath('C:\\Repo\\src\\api.ts')).toBe('c:/repo/src/api.ts')
  expect(normalizePath('c:/repo//src/api.ts')).toBe('c:/repo/src/api.ts')
  // POSIX paths keep their case: those file systems are case-sensitive
  expect(normalizePath('/Repo/Src/Api.ts')).toBe('/Repo/Src/Api.ts')
})

test('normalizePath collapses dot segments and resolvePath anchors relative paths at the cwd', () => {
  expect(normalizePath('/repo/src/../src/./api.ts')).toBe('/repo/src/api.ts')
  expect(resolvePath('/repo', 'src/api.ts')).toBe('/repo/src/api.ts')
  expect(resolvePath('/repo', './src/../src/api.ts')).toBe('/repo/src/api.ts')
  expect(resolvePath('/repo', '/abs/x.ts')).toBe('/abs/x.ts')
  expect(resolvePath('C:\\Repo\\', 'src\\api.ts')).toBe('c:/repo/src/api.ts')
  expect(resolvePath('/repo', 'C:\\Other\\x.ts')).toBe('c:/other/x.ts')
})

test('leaseId is stable, 16 hex characters and different for different paths', () => {
  const a = leaseId('/repo/src/a.ts')
  expect(a).toBe(leaseId('/repo/src/a.ts'))
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(a === leaseId('/repo/src/b.ts')).toBe(false)
})

test('a lease survives encode then decode, including a path with a tab', () => {
  const text = encodeLease({ sid: 'abc', label: 's-abc', ts: 5000, since: 1000, path: '/repo/we\tird.ts' })
  expect(text.includes('\n')).toBe(false)
  expect(decodeLease(text)).toEqual({ sid: 'abc', label: 's-abc', ts: 5000, since: 1000, path: '/repo/we ird.ts' })
})

test('decodeLease rejects partial or garbage content', () => {
  expect(decodeLease('')).toBe(null)
  expect(decodeLease('abc\ts-abc\t5000')).toBe(null)
  expect(decodeLease('abc\ts-abc\tNaN\t1\t/p')).toBe(null)
  expect(decodeLease(undefined)).toBe(null)
})

test('classify: free, mine, held, stale and released', () => {
  const now = 1_000_000
  const peer = { sid: 'peer', label: 's-peer', ts: now - 10_000, since: now - 60_000, path: '/p' }
  expect(classify(null, 'me', now)).toEqual({ state: 'free' })
  expect(classify({ ...peer, sid: 'me' }, 'me', now)).toEqual({ state: 'mine' })
  expect(classify(peer, 'me', now)).toEqual({ state: 'held', owner: 's-peer', sid: 'peer', ageMs: 10_000, sinceMs: 60_000 })
  expect(classify({ ...peer, ts: now - TTL_MS - 1 }, 'me', now).state).toBe('free')
  expect(classify({ ...peer, ts: now - TTL_MS }, 'me', now).state).toBe('held')
  expect(classify({ ...peer, ts: 0 }, 'me', now)).toEqual({ state: 'free', reason: 'released' })
})

test('helpers: label, relative path, tool path field, age text', () => {
  expect(labelFor('3f2a9c1e-5b7d')).toBe('s-3f2a')
  expect(relPath('C:\\Repo', normalizePath('C:\\Repo\\src\\api.ts'))).toBe('src/api.ts')
  expect(relPath('/repo', '/elsewhere/x.ts')).toBe('/elsewhere/x.ts')
  expect(pathOf({ file_path: '/a' })).toBe('/a')
  expect(pathOf({ notebook_path: '/n.ipynb' })).toBe('/n.ipynb')
  expect(pathOf({})).toBe(null)
  expect(ageText(4_000)).toBe('4s')
  expect(ageText(120_000)).toBe('2m')
  expect(ageText(2 * 3600_000)).toBe('2h')
})

test('denyMessage tells Claude what to do next', () => {
  const msg = denyMessage('src/api.ts', { owner: 's-ab12', ageMs: 4_000 })
  expect(msg).toContain('src/api.ts')
  expect(msg).toContain('s-ab12')
  expect(msg).toContain('Work on a different file')
})

test('band: pills for each light, one alert at a time, paused', () => {
  const base = { mine: 2, peers: [] as { label: string; files: number }[], blockedCount: 0, paused: false, now: 100_000, alert: null as any }
  const text = (s: ReturnType<typeof bandSegments>) => s.map((x) => x.text).join(' | ')

  expect(text(bandSegments(base))).toBe('🚦 stoplight |  🟢 2 yours  | 🟡 no peers | 🔴 0 blocks | /stoplight')
  expect(bandSegments(base)[1].bg).toBe('green')
  expect(text(bandSegments({ ...base, mine: 0 }))).toContain('🟢 0 yours')

  const withPeers = bandSegments({ ...base, peers: [{ label: 's-ab12', files: 3 }, { label: 's-cd34', files: 1 }] })
  expect(text(withPeers)).toContain(' 🟡 2 peers  | s-ab12 (3) · s-cd34 (1)')
  expect(withPeers.find((s) => s.text.startsWith(' 🟡'))?.bg).toBe('yellow')

  const blocked = bandSegments({ ...base, blockedCount: 1, alert: { kind: 'blocked', at: 95_000, rel: 'src/api.ts', owner: 's-ab12', ageMs: 4_000 } })
  const pill = blocked[blocked.length - 1]
  expect(pill.text).toBe(' 🔴 BLOCKED src/api.ts · held by s-ab12 4s ago ')
  expect(pill.bg).toBe('red')
  // The hint gives way to the alert
  expect(text(blocked)).not.toContain('/stoplight')

  expect(text(bandSegments({ ...base, alert: { kind: 'waiting', at: 0, who: 's-ab12', rel: 'src/api.ts' } }))).toContain('🔔 s-ab12 is waiting for src/api.ts · /stoplight release')
  expect(text(bandSegments({ ...base, alert: { kind: 'near', at: 0, who: 's-ab12', dir: 'src', files: ['db.ts'] } }))).toContain('🟡 s-ab12 is also editing in src/ (db.ts)')
  expect(text(bandSegments({ ...base, alert: { kind: 'freed', at: 0, rel: 'src/api.ts' } }))).toContain('🟢 src/api.ts is free again')

  expect(text(bandSegments({ ...base, paused: true }))).toContain('⏸ paused')
})

test('band fits narrow terminals and never drops the blocked file name', () => {
  const state = {
    mine: 2,
    peers: [{ label: 's-ab12', files: 3 }, { label: 's-cd34', files: 1 }],
    blockedCount: 1,
