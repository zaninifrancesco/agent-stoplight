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

