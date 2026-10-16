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
