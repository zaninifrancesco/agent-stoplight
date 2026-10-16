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
