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
