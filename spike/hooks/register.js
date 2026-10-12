// agent-stoplight Phase 0 spike.
// Question: which primitive in the mods API gives an ATOMIC cross-session claim, and what does it cost?
//
//   /spike <runId> <startAtEpochMs> <absDirWithBackslashes> <mode>   mode = race | solo
//   /spike-verify <runId> <expectedDistinctKeys>
//   /spike-clean
//
// Each session writes <dir>\results\<runId>-<sessionId>.json; tools/analyze.mjs reads them.

const KEYS = 40

async function sleep($, ms) {
  try {
    await $.clock.sleep(ms)
  } catch {
    await $.clock.sleep({ ms })
  }
}

async function runCmdMkdir($, path) {
  const t0 = await $.clock.now()
  try {
    const r = await $.process.run(['cmd', '/c', 'mkdir', path.replace(/\//g, '\\')])
    return { ok: r.exitCode === 0, ms: (await $.clock.now()) - t0, code: r.exitCode }
  } catch (err) {
    return { ok: false, ms: (await $.clock.now()) - t0, error: String(err) }
  }
}

async function runNodeMkdir($, path) {
  const t0 = await $.clock.now()
  const script = 'try{require("fs").mkdirSync(process.argv[1]);process.exit(0)}catch(e){process.exit(e.code==="EEXIST"?3:4)}'
  try {
    const r = await $.process.run(['node', '-e', script, path])
    return { ok: r.exitCode === 0, ms: (await $.clock.now()) - t0, code: r.exitCode }
  } catch (err) {
    return { ok: false, ms: (await $.clock.now()) - t0, error: String(err) }
  }
}

async function runPathMkdir($, path) {
  const t0 = await $.clock.now()
  try {
    const r = await $.process.run(['mkdir', path])
    return { ok: r.exitCode === 0, ms: (await $.clock.now()) - t0, code: r.exitCode }
  } catch (err) {
    return { ok: false, ms: (await $.clock.now()) - t0, error: String(err) }
  }
}

// store claim protocols. a = naive, b = verify immediately, c = verify after 30 ms.
// $.store can throw under cross-session contention ("Lock file is already being held"), so errors are recorded, not fatal.
async function storeClaim($, variant, key, me) {
  const t0 = await $.clock.now()
  try {
    const seen = await $.store.get(key)
    if (seen !== undefined) return { won: false, seen, ms: (await $.clock.now()) - t0 }
    await $.store.set(key, me)
    if (variant === 'a') return { won: true, ms: (await $.clock.now()) - t0 }
    if (variant === 'c') await sleep($, 30)
    const back = await $.store.get(key)
    return { won: back === me, back, ms: (await $.clock.now()) - t0 }
  } catch (err) {
    return { won: false, error: String(err).slice(0, 120), ms: (await $.clock.now()) - t0 }
  }
}

// lease-file claim: if no file, write my id, wait, read back; I own it only if my id survived
async function fsClaim($, variant, path, me) {
  const t0 = await $.clock.now()
  try {
    if (await $.fs.exists(path)) return { won: false, ms: (await $.clock.now()) - t0, existed: true }
    await $.fs.write(path, me)
    if (variant === 'b') await sleep($, 10)
    if (variant === 'c') await sleep($, 25)
    const back = await $.fs.read(path)
    return { won: back === me, back: String(back).slice(0, 40), ms: (await $.clock.now()) - t0 }
  } catch (err) {
    return { won: false, error: String(err).slice(0, 120), ms: (await $.clock.now()) - t0 }
  }
}

// set with retries; reports attempts so we can see how bad contention gets
async function setRetry($, key, value) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await $.store.set(key, value)
      return { ok: true, attempts: attempt }
    } catch (err) {
      await sleep($, 5)
    }
  }
  return { ok: false, attempts: 20 }
}

function summarize(list) {
  const xs = list.map((x) => x.ms).sort((p, q) => p - q)
  if (xs.length === 0) return null
  return { n: xs.length, min: xs[0], median: xs[Math.floor(xs.length / 2)], p95: xs[Math.floor(xs.length * 0.95)], max: xs[xs.length - 1] }
}

async function batchMs($, n, fn) {
  const t0 = await $.clock.now()
  for (let i = 0; i < n; i++) await fn(i)
  return ((await $.clock.now()) - t0) / n
}

async function experiments($, a) {
  const me = await $.session.id()
  const out = { runId: a.runId, mode: a.mode, me, claims: { cmd: [], node: [], path: [] }, store: { a: [], b: [], c: [] }, distinct: [], latency: {}, summary: {} }
  // Forward slashes work on every platform, Windows included; only cmd's mkdir needs backslashes.
  const dir = a.dir.replace(/\\/g, '/')
  const isWindows = /^[a-zA-Z]:\//.test(dir)
  out.platform = isWindows ? 'windows' : 'posix'
  const file = dir + '/results/' + a.runId + '-' + me + '.json'
  const flush = () => $.fs.write(file, JSON.stringify(out, null, 2))

  if (a.mode === 'race') {
    const wait = a.startAt - (await $.clock.now())
    out.barrierWaitMs = wait
    if (wait > 0) await sleep($, Math.min(wait, 4000))
  }

  // P1: filesystem mkdir claims through $.process.run
  // On Windows the atomic claim is `cmd /c mkdir`; elsewhere it is the plain `mkdir` binary.
  if (isWindows) {
    for (let i = 0; i < KEYS; i++) {
      const c = await runCmdMkdir($, dir + '/claims/' + a.runId + '-cmd-' + i)
      out.claims.cmd.push({ key: i, ...c })
    }
  } else {
    for (let i = 0; i < KEYS; i++) {
      const c = await runPathMkdir($, dir + '/claims/' + a.runId + '-path-' + i)
      out.claims.path.push({ key: i, ...c })
    }
  }
  for (let i = 0; i < KEYS; i++) {
    const c = await runNodeMkdir($, dir + '/claims/' + a.runId + '-node-' + i)
    out.claims.node.push({ key: i, ...c })
  }
  await flush()

  // P2: $.store claim protocols
  for (const variant of ['a', 'b', 'c']) {
    for (let i = 0; i < KEYS; i++) {
      const r = await storeClaim($, variant, 'claim:' + a.runId + ':' + variant + ':' + i, me)
      out.store[variant].push({ key: i, ...r })
    }
  }
  await flush()

  // P2b: filesystem lease files, claimed with write + read-back (the candidate design). fsA = read-back at once, fsB = after 10 ms, fsC = after 25 ms
  out.fs = { a: [], b: [], c: [] }
  for (const variant of ['a', 'b', 'c']) {
    for (let i = 0; i < KEYS; i++) {
      out.fs[variant].push({ key: i, ...(await fsClaim($, variant, dir + '/claims/' + a.runId + '-fs' + variant + '-' + i + '.lease', me)) })
    }
  }
  await flush()

  // P3: do writes to DISTINCT keys from concurrent sessions all survive?
  for (let i = 0; i < KEYS; i++) out.distinct.push({ key: i, ...(await setRetry($, 'd:' + a.runId + ':' + me + ':' + i, i)) })
  await flush()

  // P4: single-call latency of the in-process primitives
  const p = dir + '/scratch-' + me + '.txt'
  out.latency = {
    storeGetMs: await batchMs($, 200, () => $.store.get('claim:none')),
    storeSetMs: await batchMs($, 100, (i) => setRetry($, 'lat:' + me + ':' + i, i)),
    fsWriteMs: await batchMs($, 100, () => $.fs.write(p, 'x')),
    fsReadMs: await batchMs($, 200, () => $.fs.read(p)),
    fsExistsMs: await batchMs($, 200, () => $.fs.exists(p)),
    clockNowMs: await batchMs($, 200, () => $.clock.now()),
  }

  out.summary = {
    cmd: summarize(out.claims.cmd),
    path: summarize(out.claims.path),
    node: summarize(out.claims.node),
    storeA: summarize(out.store.a),
    storeB: summarize(out.store.b),
    storeC: summarize(out.store.c),
  }
  await flush()
  return out
}

async function verify($, runId, expected) {
  const raw = await $.store.keys()
  const keys = Array.isArray(raw) ? raw : Object.keys(raw ?? {})
  const distinct = keys.filter((k) => k.startsWith('d:' + runId + ':')).length
  return { keysTotal: keys.length, distinct, expected, lost: expected - distinct }
}

async function clean($) {
  const raw = await $.store.keys()
  const keys = Array.isArray(raw) ? raw : Object.keys(raw ?? {})
  for (const k of keys) await $.store.delete(k)
  return keys.length
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spike', description: 'agent-stoplight spike: claim races + latency', argumentHint: '<runId> <startAt> <dir> <race|solo>' })
    await $.command.register({ name: 'spike-verify', description: 'agent-stoplight spike: count surviving distinct keys', argumentHint: '<runId> <expected>' })
    await $.command.register({ name: 'spike-clean', description: 'agent-stoplight spike: wipe the spike store' })
    return next(e)
  })

  on('command.run', { command: 'spike' }, async ($, e) => {
    const [runId, startAt, dir, mode] = e.args.trim().split(/\s+/)
    // `/spike verify <runId> <expected>` and `/spike clean` (hyphenated commands were not routed in -p runs)
    if (runId === 'verify') return { text: 'verify ' + JSON.stringify(await verify($, startAt, Number(dir))) }
    if (runId === 'clean') return { text: 'cleaned ' + (await clean($)) + ' keys' }
    // `/spike mkparents <path>`: does $.fs.write create missing parent directories? does it overwrite?
    if (runId === 'mkparents') {
      try {
        await $.fs.write(startAt, 'one')
        await $.fs.write(startAt, 'two')
        return { text: 'mkparents ok, read back: ' + (await $.fs.read(startAt)) }
      } catch (err) {
        return { text: 'mkparents FAILED: ' + String(err) }
      }
    }
    try {
      const out = await experiments($, { runId, startAt: Number(startAt), dir, mode: mode ?? 'solo' })
      return { text: 'spike ok ' + JSON.stringify(out.summary) + ' latency ' + JSON.stringify(out.latency) }
    } catch (err) {
      return { text: 'spike FAILED: ' + String(err) + ' ' + (err && err.stack ? err.stack : '') }
    }
  })

  on('command.run', { command: 'spike-verify' }, async ($, e) => {
    const [runId, expected] = e.args.trim().split(/\s+/)
    return { text: 'verify ' + JSON.stringify(await verify($, runId, Number(expected))) }
  })

  on('command.run', { command: 'spike-clean' }, async ($) => {
    return { text: 'cleaned ' + (await clean($)) + ' keys' }
  })
}
