// Unit tests for the shell write detector (lib/shell.js).
import { expect, test } from 'claude-code/testing'
import { shellTargets, tokenize } from '../hooks/lib/shell.js'

const bash = (cmd: string) => shellTargets(cmd, 'Bash', '/repo').map((t: any) => t.path)
const ps = (cmd: string) => shellTargets(cmd, 'PowerShell', 'C:/repo').map((t: any) => t.path)

test('tokenize keeps quoted text whole and separates operators', () => {
  const words = (c: string) => tokenize(c).map((t: any) => t.type + ':' + t.text)
  expect(words('echo "a > b" && ls')).toEqual(['word:echo', 'word:a > b', 'op:&&', 'word:ls'])
  expect(words("printf 'x;y' >out.txt")).toEqual(['word:printf', 'word:x;y', 'redir:>', 'word:out.txt'])
  expect(words('cmd 2>&1 | tee log')).toEqual(['word:cmd', 'op:|', 'word:tee', 'word:log'])
  expect(words('a 2>err.txt')).toEqual(['word:a', 'redir:2>', 'word:err.txt'])
})

test('redirects and tee', () => {
  expect(bash('echo hi > src/api.ts')).toEqual(['src/api.ts'])
  expect(bash('echo hi >> notes.md')).toEqual(['notes.md'])
  expect(bash('npm test 2>&1 | tee build.log')).toEqual(['build.log'])
  expect(bash('tee -a one.txt two.txt < input')).toEqual(['one.txt', 'two.txt'])
  expect(bash('ls > /dev/null 2>&1')).toEqual([])
  expect(bash('cat < input.txt')).toEqual([])
  expect(bash('echo "a > b"')).toEqual([])
})

test('in-place editors: sed -i and perl -i, but not plain sed', () => {
  expect(bash("sed -i 's/hello/goodbye/' src/api.ts src/ui.ts")).toEqual(['src/api.ts', 'src/ui.ts'])
  expect(bash("sed -i.bak -e 's/a/b/' -e 's/c/d/' src/db.ts")).toEqual(['src/db.ts'])
  expect(bash("sed --in-place 's/a/b/' x.txt")).toEqual(['x.txt'])
  expect(bash("sed 's/a/b/' src/db.ts")).toEqual([])
  expect(bash("perl -pi -e 's/x/y/' a.pl b.pl")).toEqual(['a.pl', 'b.pl'])
  expect(bash("perl -ne 'print' a.pl")).toEqual([])
})

test('file management: mv, cp, rm, touch, truncate, ln, dd', () => {
