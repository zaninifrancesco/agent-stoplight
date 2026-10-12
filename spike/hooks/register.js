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

