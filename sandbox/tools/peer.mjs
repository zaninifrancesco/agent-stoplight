// Simulates another Claude Code session so the guard can be tested without a second terminal.
//
//   node peer.mjs <repoRoot> hold <file> [<file> ...]   take (and keep refreshing) leases for these files
//   node peer.mjs <repoRoot> hold --once <file> ...      write the leases once and exit (they go stale after the TTL)
//   node peer.mjs <repoRoot> release <file> ...          mark the leases released
//
// It reuses the plugin's own lease format (hooks/lib/lease.js), so the two can never drift apart.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', '..', 'hooks', 'lib', 'lease.js')).href)

const [root, verb, ...rest] = process.argv.slice(2)
if (!root || !['hold', 'release'].includes(verb)) {
  console.error('usage: node peer.mjs <repoRoot> hold|release [--once] <file> ...')
  process.exit(2)
}
const once = rest.includes('--once')
const files = rest.filter((f) => f !== '--once').map((f) => (isAbsolute(f) ? f : resolve(root, f)))
if (files.length === 0) {
  console.error('no files given')
  process.exit(2)
}

const SID = 'peer-simulator-0000'
const LABEL = 's-peer'
const leaseDir = join(root, '.claude', 'stoplight', 'leases')
mkdirSync(leaseDir, { recursive: true })
const since = Date.now()

function write(ts) {
  for (const f of files) {
    const norm = lib.normalizePath(f)
    writeFileSync(join(leaseDir, lib.leaseId(norm) + '.lease'), lib.encodeLease({ sid: SID, label: LABEL, ts, since, path: norm }))
  }
}

if (verb === 'release') {
  write(0)
  console.log('peer released', files.length, 'file(s)')
} else {
  write(Date.now())
  console.log('peer', LABEL, 'holds', files.length, 'file(s)' + (once ? '' : ' (Ctrl+C to release)'))
  if (!once) {
    const timer = setInterval(() => write(Date.now()), 5000)
    const stop = () => {
      clearInterval(timer)
      write(0)
      console.log('\npeer released its files')
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }
}
