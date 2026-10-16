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
