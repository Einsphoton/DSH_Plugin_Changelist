/**
 * End-to-end verification of the changelist data layer against a real git
 * repository (built by `test-fixture.mjs`).
 *
 * This session's sandbox forbids piped child stdio (`spawn git EPERM`), so the
 * runner here redirects stdout/stderr to files. The plugin's own runner
 * (`createProcessRunner`) is unchanged and uses ordinary pipes inside the Host;
 * everything above the runner — command choice, parsing, comparison synthesis —
 * is exercised exactly as shipped.
 *
 *   node dsh-changelist/selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  createFileReader,
  inspectWorkspace,
  readDiff,
  resolveBase,
  parseNameStatus,
  parseNumstat,
  scanContent,
} from './lib/git.js'
import { FIXTURE_OUTSIDE, FIXTURE_ROOT, buildFixture, createFixtureRunner } from './test-fixture.mjs'

const run = createFixtureRunner()
const fixture = buildFixture()
const repo = fixture.repo
const readFile = createFileReader()

let failures = 0
let checks = 0
function check(label, actual, expected) {
  checks++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`)
  }
}
function checkThat(label, condition, detail) {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

if (!fs.existsSync(path.join(repo, '.git'))) {
  console.error(`fixture missing at ${repo}\nrun: node dsh-changelist/test-fixture.mjs`)
  process.exit(2)
}

console.log('1. parser units')
const nameStatusSample = 'D\u0000docs/keep.txt\u0000M\u0000src/a.js\u0000R100\u0000src/old name.js\u0000src/new name.js\u0000'
check('parseNameStatus', parseNameStatus(nameStatusSample), [
  { status: 'D', path: 'docs/keep.txt', oldPath: null },
  { status: 'M', path: 'src/a.js', oldPath: null },
  { status: 'R', path: 'src/new name.js', oldPath: 'src/old name.js' },
])
const numstatSample =
  '0\t1\tdocs/keep.txt\u0000-\t-\tblob.bin\u00000\t0\t\u0000src/old name.js\u0000src/new name.js\u0000'
check('parseNumstat', [...parseNumstat(numstatSample).entries()], [
  ['docs/keep.txt', { added: 0, deleted: 1 }],
  ['blob.bin', { added: null, deleted: null }],
  ['src/new name.js', { added: 0, deleted: 0 }],
])
check('scanContent text', scanContent(Buffer.from('a\nb\nc\n')), { binary: false, lines: 3 })
check('scanContent no trailing newline', scanContent(Buffer.from('a\nb')), { binary: false, lines: 2 })
check('scanContent binary', scanContent(Buffer.from([1, 0, 2])), { binary: true, lines: null })

console.log('2. base resolution against a real upstream')
const base = await resolveBase(run, repo)
check('upstream base', { base: base.base, kind: base.kind, remote: base.remote }, {
  base: 'origin/main',
  kind: 'upstream',
  remote: 'origin',
})
const explicitMissing = await resolveBase(run, repo, 'origin/nope')
checkThat('unknown base falls back to HEAD', explicitMissing.base === 'HEAD' && explicitMissing.kind === 'local')

console.log('3. changelist vs remote')
const state = await inspectWorkspace({ run, readFile, dir: repo, base: base.base })
check('ok', state.ok, true)
check('branch', state.branch, 'main')
check('base', state.base, 'origin/main')
check('ahead', state.ahead, 1)
check('behind', state.behind, 0)
check('total', state.total, 6)

const byPath = Object.fromEntries(state.files.map((file) => [file.path, file]))
check('deleted file', { s: byPath['docs/keep.txt']?.status, a: byPath['docs/keep.txt']?.deleted }, {
  s: 'D',
  a: 1,
})
check('modified file', { s: byPath['src/a.js']?.status, a: byPath['src/a.js']?.added, d: byPath['src/a.js']?.deleted }, {
  s: 'M',
  a: 1,
  d: 0,
})
check('added (staged) file', { s: byPath['src/added.js']?.status, a: byPath['src/added.js']?.added, u: byPath['src/added.js']?.untracked }, {
  s: 'A',
  a: 2,
  u: false,
})
check('renamed file', { s: byPath['src/new name.js']?.status, old: byPath['src/new name.js']?.oldPath }, {
  s: 'R',
  old: 'src/old name.js',
})
check('untracked text file', { s: byPath['untracked.txt']?.status, a: byPath['untracked.txt']?.added, u: byPath['untracked.txt']?.untracked }, {
  s: 'A',
  a: 3,
  u: true,
})
check('untracked binary file', { bin: byPath['blob.bin']?.binary, u: byPath['blob.bin']?.untracked }, {
  bin: true,
  u: true,
})
check('paths sorted', state.files.map((f) => f.path), [...state.files.map((f) => f.path)].sort())

console.log('4. per-file comparisons')
const diffModified = await readDiff({ run, readFile, dir: repo, base: base.base, path: 'src/a.js' })
checkThat('modified diff has the added line', diffModified.text.includes('+export const a2 = 3'), diffModified.text)
checkThat('modified diff is unified', diffModified.text.includes('@@ -1 +1,2 @@'))
const diffUntracked = await readDiff({ run, readFile, dir: repo, base: base.base, path: 'untracked.txt' })
check('untracked diff synthesised', {
  untracked: diffUntracked.untracked,
  header: diffUntracked.text.split('\n')[0],
  lines: diffUntracked.text.split('\n').filter((l) => /^\+(?!\+\+)/.test(l)).length,
}, { untracked: true, header: '--- /dev/null', lines: 3 })
const diffBinary = await readDiff({ run, readFile, dir: repo, base: base.base, path: 'blob.bin' })
check('binary comparison refused', diffBinary.binary, true)
const diffDeleted = await readDiff({ run, readFile, dir: repo, base: base.base, path: 'docs/keep.txt' })
checkThat('deleted diff shows removal', diffDeleted.text.includes('-keep'))

console.log('5. non-repository directory')
// FIXTURE_OUTSIDE is a plain directory; the fixture root is also treated as one
// because the fixture runner sets GIT_CEILING_DIRECTORIES to this package. That
// ceiling matters: the package is itself a git checkout, so without it git's
// upward search would answer "yes, a work tree" for every path under the
// package and this probe would pass or fail depending on the current directory.
const notRepo = FIXTURE_OUTSIDE
const outside = await inspectWorkspace({ run, readFile, dir: notRepo, base: 'HEAD' })
check('outside a work tree', { ok: outside.ok, reason: outside.reason }, { ok: false, reason: 'not-a-repository' })
const fixtureRoot = await inspectWorkspace({ run, readFile, dir: FIXTURE_ROOT, base: 'HEAD' })
checkThat(
  'the fixture is shielded from the package checkout it lives in',
  fixtureRoot.ok === false && fixtureRoot.reason === 'not-a-repository',
  `FIXTURE_ROOT ok=${fixtureRoot.ok} reason=${fixtureRoot.reason}`,
)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
