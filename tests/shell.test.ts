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
  expect(bash('mv old.ts new.ts')).toEqual(['old.ts', 'new.ts'])
  expect(bash('mv -t dest a.ts b.ts')).toEqual(['a.ts', 'b.ts', 'dest'])
  expect(bash('cp -r template/ out/')).toEqual(['out/'])
  expect(bash('cp a.ts')).toEqual([])
  expect(bash('rm -f old.txt other.txt')).toEqual(['old.txt', 'other.txt'])
  expect(bash('touch new.ts')).toEqual(['new.ts'])
  expect(bash('truncate -s 0 big.log')).toEqual(['big.log'])
  expect(bash('ln -sf target link')).toEqual(['link'])
  expect(bash('dd if=/dev/zero of=disk.img bs=1M count=1')).toEqual(['disk.img'])
})

test('git commands that rewrite working-tree files', () => {
  expect(bash('git checkout -- src/api.ts')).toEqual(['src/api.ts'])
  expect(bash('git checkout main')).toEqual([])
  expect(bash('git restore --staged src/ui.ts')).toEqual(['src/ui.ts'])
  expect(bash('git rm -r --cached build')).toEqual(['build'])
  expect(bash('git -C sub mv a.ts b.ts')).toEqual(['a.ts', 'b.ts'])
  expect(bash('git status')).toEqual([])
})

test('wrappers, assignments, chains and cd', () => {
  expect(bash('FOO=1 sudo tee /etc/hosts')).toEqual(['/etc/hosts'])
  expect(bash('npm run build && echo done > status.txt; rm tmp.txt')).toEqual(['status.txt', 'tmp.txt'])
  const t = shellTargets('cd src && mv api.ts api2.ts', 'Bash', '/repo')
  expect(t.map((x: any) => x.cwd + ' ' + x.path)).toEqual(['/repo/src api.ts', '/repo/src api2.ts'])
})

test('what it deliberately leaves alone: globs, variables, home paths, other languages', () => {
  expect(bash('rm -rf build/*.o')).toEqual([])
  expect(bash('echo x > $OUT')).toEqual([])
  expect(bash('rm ~/notes.txt')).toEqual([])
  expect(bash('python -c "open(\'x\',\'w\')"')).toEqual([])
  expect(bash('ls -la')).toEqual([])
})

test('PowerShell cmdlets, aliases, named and positional parameters', () => {
  expect(ps("Set-Content -Path src\\api.ts -Value 'x'")).toEqual(['src\\api.ts'])
  expect(ps("'x' | Out-File notes.txt")).toEqual(['notes.txt'])
  expect(ps("Add-Content log.txt 'line'")).toEqual(['log.txt'])
  expect(ps('Move-Item a.txt b.txt; Remove-Item -LiteralPath "c d.txt"')).toEqual(['a.txt', 'b.txt', 'c d.txt'])
  expect(ps('Copy-Item -Path a.txt -Destination out\\a.txt')).toEqual(['out\\a.txt'])
  expect(ps('Rename-Item -Path src\\api.ts -NewName api2.ts')).toEqual(['src\\api.ts', 'src/api2.ts'])
  expect(ps('del old.txt')).toEqual(['old.txt'])
  expect(ps('Get-Content x.txt > y.txt')).toEqual(['y.txt'])
  expect(ps('Get-ChildItem -Recurse')).toEqual([])
  expect(ps('Remove-Item *.log')).toEqual([])
})
