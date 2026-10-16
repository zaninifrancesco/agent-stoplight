// Best-effort detection of the files a shell command would change, for the Bash and PowerShell tools.
// Pure: no mods API. It recognises the common ways agents write files from a shell (redirects, tee,
// sed -i, mv/cp/rm, git checkout/restore, PowerShell's *-Content and *-Item cmdlets). Anything it
// can't read — globs, variables, scripts in other languages — is left alone, and the command runs.

const MAX_TARGETS = 20
const NULL_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', '$null', '-'])

// Split a command line into words and operators, honouring quotes. `escape` is \ for bash, ` for PowerShell.
export function tokenize(command, escape = '\\') {
  const tokens = []
  let word = ''
  let inWord = false
  let quote = ''
  const s = String(command)
  const push = () => {
    if (inWord) tokens.push({ type: 'word', text: word })
    word = ''
    inWord = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === escape && quote === '"' && i + 1 < s.length) word += s[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
      continue
    }
    if (c === escape && i + 1 < s.length) {
      word += s[++i]
      inWord = true
      continue
    }
    if (c === ' ' || c === '\t') {
      push()
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      // 2>&1, >&2: a file-descriptor duplication, not a separator
      if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<')) {
        word += c
        inWord = true
        continue
      }
      push()
      const two = s.slice(i, i + 2)
      tokens.push({ type: 'op', text: two === '&&' || two === '||' ? two : c })
      if (two === '&&' || two === '||') i++
      continue
    }
    if (c === '>' || c === '<') {
      // A leading fd number belongs to the redirect: 2>file
      const fd = inWord && /^\d$/.test(word) ? word : ''
      if (fd) {
        word = ''
        inWord = false
      } else push()
      let op = c
      if (s[i + 1] === '>' || s[i + 1] === '|') op += s[++i]
      if (s[i + 1] === '&') {
        // >&2 or 2>&1: duplication, read the fd and move on
        i++
        let dup = ''
        while (/\d/.test(s[i + 1] ?? '')) dup += s[++i]
        if (dup) continue
        op = '&' + op
      }
      tokens.push({ type: c === '>' ? 'redir' : 'in', text: fd + op })
      continue
    }
    word += c
    inWord = true
  }
  push()
  return tokens
}

// Group tokens into simple commands: { words: [...], redirects: [target, ...] }
function commands(tokens) {
  const out = []
  let cur = { words: [], redirects: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'op') {
      out.push(cur)
      cur = { words: [], redirects: [] }
    } else if (t.type === 'redir') {
      const next = tokens[i + 1]
      if (next && next.type === 'word') {
        cur.redirects.push(next.text)
        i++
      }
    } else if (t.type === 'in') {
      i++ // < file: read, not written
    } else {
      cur.words.push(t.text)
    }
  }
  out.push(cur)
  return out.filter((c) => c.words.length > 0 || c.redirects.length > 0)
}

const isOption = (w) => w.length > 1 && w.startsWith('-')
const positionals = (words) => {
  const out = []
  let afterDashes = false
  for (const w of words) {
    if (!afterDashes && w === '--') afterDashes = true
    else if (afterDashes || !isOption(w)) out.push(w)
  }
  return out
}

// Options that take a value, per command, so the value isn't mistaken for a file
const VALUE_OPTIONS = {
  sed: ['-e', '-f', '-l', '--expression', '--file'],
  perl: ['-e', '-E', '-M', '-I'],
  truncate: ['-s', '-r', '--size', '--reference'],
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  install: ['-t', '-m', '-o', '-g', '--mode', '--owner', '--group', '--target-directory'],
  tee: [],
  git: ['-C', '-c', '-s', '--source'],
}

function stripValues(cmd, words) {
  const takes = VALUE_OPTIONS[cmd] ?? []
  const kept = []
  const values = {}
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const eq = w.indexOf('=')
    if (w.startsWith('--') && eq > 0 && takes.includes(w.slice(0, eq))) {
      ;(values[w.slice(0, eq)] ??= []).push(w.slice(eq + 1))
    } else if (takes.includes(w)) {
      ;(values[w] ??= []).push(words[i + 1])
      i++
    } else kept.push(w)
  }
  return { kept, values }
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'nice', 'exec', 'builtin', 'doas'])

function bashTargets(c) {
  let words = [...c.words]
  // Drop wrappers and leading VAR=value assignments
  while (words.length > 0 && (WRAPPERS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift()
  const targets = [...c.redirects]
  if (words.length === 0) return targets
  const cmd = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const args = words.slice(1)

  if (cmd === 'tee') return targets.concat(positionals(args))
  if (cmd === 'sed' || cmd === 'gsed') {
    if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return targets
    const { kept, values } = stripValues('sed', args)
    const pos = positionals(kept)
    return targets.concat(values['-e'] || values['-f'] || values['--expression'] || values['--file'] ? pos : pos.slice(1))
  }
  if (cmd === 'perl') {
    if (!args.some((a) => /^-[a-zA-Z]*i/.test(a))) return targets
    const { kept, values } = stripValues('perl', args)
    const pos = positionals(kept)
    return targets.concat(values['-e'] || values['-E'] ? pos : pos.slice(1))
  }
  if (['rm', 'touch', 'unlink', 'shred', 'rmdir', 'mkdir'].includes(cmd)) return targets.concat(positionals(args))
  if (cmd === 'truncate') return targets.concat(positionals(stripValues('truncate', args).kept))
  if (cmd === 'mv') {
    const { kept, values } = stripValues('mv', args)
    return targets.concat(positionals(kept), values['-t'] ?? [], values['--target-directory'] ?? [])
  }
  if (cmd === 'cp' || cmd === 'install' || cmd === 'ln') {
    const { kept, values } = stripValues(cmd === 'ln' ? 'cp' : cmd, args)
    const dir = values['-t'] ?? values['--target-directory']
    if (dir) return targets.concat(dir)
    const pos = positionals(kept)
    return targets.concat(pos.length > 1 ? [pos[pos.length - 1]] : [])
  }
  if (cmd === 'dd') return targets.concat(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)))
  if (cmd === 'git') {
    const { kept } = stripValues('git', args)
    const sub = kept.find((w) => !isOption(w))
    const rest = kept.slice(kept.indexOf(sub) + 1)
    if (sub === 'checkout') {
      const dd = rest.indexOf('--')
      return targets.concat(dd >= 0 ? rest.slice(dd + 1) : [])
    }
    if (sub === 'restore' || sub === 'rm' || sub === 'mv') return targets.concat(positionals(rest))
    return targets
  }
  if (cmd === 'prettier' && args.some((a) => a === '--write' || a === '-w')) return targets.concat(positionals(args))
  return targets
}

// PowerShell: cmdlets and their aliases, parameters by name or by position.
const PS = {
  'set-content': 'path', sc: 'path', 'add-content': 'path', ac: 'path', 'clear-content': 'path', clc: 'path',
  'out-file': 'filepath', 'new-item': 'path', ni: 'path',
  'remove-item': 'path', ri: 'path', rm: 'path', del: 'path', erase: 'path', rd: 'path', rmdir: 'path',
  'move-item': 'move', mi: 'move', mv: 'move', move: 'move',
  'copy-item': 'copy', ci: 'copy', cp: 'copy', copy: 'copy', cpi: 'copy',
  'rename-item': 'rename', ren: 'rename', rni: 'rename',
}
const PS_VALUE_PARAMS = ['-path', '-literalpath', '-filepath', '-destination', '-newname', '-value', '-encoding', '-itemtype', '-name', '-filter', '-include', '-exclude', '-credential', '-stream', '-width']

function psTargets(c) {
  const targets = [...c.redirects]
  if (c.words.length === 0) return targets
  const cmd = c.words[0].toLowerCase()
