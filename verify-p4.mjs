/**
 * Adversarial verification of the Perforce backend (shared task task-5 / A5).
 *
 * This suite deliberately does NOT re-run the authors' suites. It tries to
 * falsify the feature from the outside:
 *
 *   1. the `type: "text+w\n"` regression (parseOpened on the shape the REAL
 *      server prints, an ordinary edit must be `M`, a genuine type change `T`,
 *      and an internal blank line in a multi-paragraph description must survive);
 *   2. the read-only claim: every p4 invocation recorded across one full
 *      state+diff cycle, plus a static audit of every `call([...])` head in
 *      lib/p4.js;
 *   3. boundaries the authors' suites do not reach: client root vs subdirectory
 *      vs outside, a client with no user, an empty answer, `..`/absolute paths,
 *      maxFiles/maxDiffBytes at 0/1/exact fit, deleted/binary/absent files,
 *      a shelf whose files are all outside the client view, unknown sessionId,
 *      vcs=git on a p4-only directory and vcs=p4 on a git-only directory, the
 *      60 s detection cache (driven through the injected clock, never by sleeping)
 *      and the environment handed to the p4 child;
 *   4. the README's stated order, cache, read-only guarantee and performance
 *      table, where they can be checked at all.
 *
 * Evidence policy: the real server is used read-only only (`info`, `opened`,
 * `fstat`, `changes`). Writing commands are never issued. The strongest
 * candidate for a hidden write — a plain `p4 status`, which lib/p4.js issues for
 * the optional local-edit scan — was checked against the vendor's own help on
 * the live server:
 *
 *     p4 help status
 *       status      -- 'reconcile -n + opened' (output uses local paths)
 *       status -A   -- synonym for 'reconcile -ead' (output uses local paths)
 *
 * so the production call is a preview; `-A` (the writing form) is never used.
 *
 * Reporting shape: the seven issues this suite found on 2026-10-16 have since
 * been FIXED in production, so they are reported through `resolved()` — a
 * RESOLVED line naming the issue and the check that now pins the corrected
 * behaviour — and their assertions were inverted, never weakened or deleted. An
 * unfixed issue would still be printed as a FINDING; no FINDING is expected and
 * a `check` failing does fail the run.
 *
 *   node dsh-changelist/verify-p4.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRoutes, safeRepoPath } from './index.js'
import * as p4 from './lib/p4.js'
import { DEFAULT_DETECT_TTL_MS, createBackendRouter, createDetectCache } from './lib/vcs.js'
import {
  FAKE_P4_CLIENT,
  FAKE_P4_OUTSIDE,
  FAKE_P4_ROOT,
  FAKE_P4_SHIM,
  buildP4Fixture,
  createFakeP4ExecFile,
  fakeP4Env,
  readP4Calls,
  resetP4Calls,
} from './p4-fixture.mjs'
import { fileRedirectExecFile } from './test-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = path.resolve(HERE, '..')

// ------------------------------------------------------------------ harness

let checks = 0
let failures = 0
const findings = []
const resolvedItems = []
const notes = []
const skips = []

const shown = (value) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function check(label, actual, expected) {
  checks += 1
  try {
    assert.deepEqual(actual, expected)
    console.log(`  ok   ${label}`)
  } catch {
    failures += 1
    console.log(`  FAIL ${label}\n       expected ${shown(expected)}\n       actual   ${shown(actual)}`)
  }
}

function checkThat(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A counterexample: documented, reported, not a failure of this suite. */
function finding(label, repro, observed) {
  findings.push({ label, repro, observed })
  console.log(`  !!   COUNTEREXAMPLE ${label}`)
  console.log(`       repro    ${repro}`)
  console.log(`       observed ${observed}`)
}

/**
 * An issue this suite reported earlier that production has since fixed. The
 * `checks` named must be the assertions that now pin the corrected behaviour.
 */
function resolved(label, checks, evidence) {
  resolvedItems.push({ label, checks, evidence })
  console.log(`  OK   RESOLVED ${label}`)
  console.log(`       pinned by ${checks}`)
  console.log(`       evidence  ${evidence}`)
}

function note(label, value) {
  notes.push({ label, value })
  console.log(`  note ${label}: ${value}`)
}

function skip(label, why) {
  skips.push(label)
  console.log(`  skip ${label} — ${why}`)
}

const toText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))

// ------------------------------------------------------------ ztag fixtures
//
// The REAL `p4 -ztag` wire shape (captured read-only from 192.0.2.10 on
// 2026-10-16) puts a blank line after every tag block, including the last one.
// `ztagBody` reproduces exactly that.

const ztagRecord = (pairs) =>
  pairs
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `... ${key} ${value}`)
    .join('\n') + '\n'

const ztagBody = (records) => records.map(ztagRecord).join('\n') + '\n'

/** Real `p4 -ztag opened` output captured from the live server, verbatim. */
const REAL_OPENED = [
  '... depotFile //ProjW-Client/Main/Content/Example/BehaviorTree/Asset_Example.json',
  '... clientFile //example_client/Content/Example/BehaviorTree/Asset_Example.json',
  '... rev 8',
  '... haveRev 8',
  '... action edit',
  '... change default',
  '... type text+w',
  '... user p4user',
  '... client example_client',
  '',
  '... depotFile //ProjW-Client/Main/Content/Example/style/Asset_Example_Style.json',
  '... clientFile //example_client/Content/Example/style/Asset_Example_Style.json',
  '... rev 2',
  '... haveRev 2',
  '... action edit',
  '... change default',
  '... type text+w',
  '... user p4user',
  '... client example_client',
  '',
  '',
].join('\n')

/** A scripted runner: records every call, answers by predicate. */
function scriptRunner(handlers) {
  const calls = []
  const runner = async (args, cwd, callOptions) => {
    calls.push({ args: [...args], cwd: cwd ?? null, timeoutMs: callOptions?.timeoutMs ?? null })
    for (const handler of handlers) {
      if (!handler.match(args)) continue
      const reply = typeof handler.reply === 'function' ? handler.reply(args) : handler.reply
      return {
        status: reply.status ?? 0,
        stdout: Buffer.from(reply.stdout ?? '', 'utf8'),
        stderr: reply.stderr ?? '',
        timedOut: reply.timedOut === true,
      }
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: '' }
  }
  runner.calls = calls
  return runner
}

// ------------------------------------------------------------------ fixture

buildP4Fixture()
resetP4Calls()

const ROOT = FAKE_P4_ROOT
const OUTSIDE = FAKE_P4_OUTSIDE
const CLIENT = FAKE_P4_CLIENT
const USER = 'p4user'
const STREAM = '//ProjW-Client/Main'
const SUBDIR = path.join(ROOT, 'Config', 'Raw', 'ai', 'style', 'BTstyle')
const EDIT = 'Content/Example/style/Asset_Example_Style.json'
const ADD = 'Content/Example/New/A.bin'
const GONE = 'Content/Example/Gone.txt'
const LARGE = 'Content/Example/docs/large.txt'
const NOTES = 'Content/Example/docs/notes.md'
const CTX = { root: ROOT, client: CLIENT, stream: STREAM }
const depot = (rel) => `${STREAM}/${rel}`

const fakeExec = createFakeP4ExecFile()
const fakeRun = p4.createProcessRunner({
  p4Path: FAKE_P4_SHIM,
  timeoutMs: 20_000,
  env: fakeP4Env(),
  execFileFn: fakeExec,
})

const infoRecords = (clientRoot = ROOT, user = USER) => [
  [
    ['userName', user],
    ['clientName', CLIENT],
    ['clientRoot', clientRoot],
    ['clientStream', STREAM],
    ['serverAddress', 'fake:1666'],
  ],
]

const openedOne = (type, action = 'edit') =>
  ztagBody([
    [
      ['depotFile', depot(EDIT)],
      ['clientFile', `//${CLIENT}/${EDIT}`],
      ['rev', '2'],
      ['haveRev', '2'],
      ['action', action],
      ['change', 'default'],
      ['type', type],
      ['user', USER],
      ['client', CLIENT],
    ],
  ])

const fstatOne = ({ headType, type }) =>
  ztagBody([
    [
      ['depotFile', depot(EDIT)],
      ['clientFile', `//${CLIENT}/${EDIT}`],
      ['headType', headType],
      ['type', type],
      ['haveRev', '2'],
      ['headRev', '2'],
      ['action', 'edit'],
    ],
  ])

// ------------------------------------------------- 1. the text+w regression

console.log('1. regression: `type: "text+w\\n"` and the head-type comparison')

checkThat(
  'the captured real answer really terminates each record with a blank line (the trigger)',
  REAL_OPENED.includes('... client example_client\n\n'),
  'the record-terminating blank line is absent from the sample',
)

// The exact shape named in the task: `type` is the LAST tag of the record, so the
// record-terminating blank line arrives as a continuation of `type` and a naive
// parser reports "text+w\n".
const TYPE_LAST = [
  '... depotFile //ProjW-Client/Main/Content/Example/style/x.json',
  '... clientFile //fake_client/Content/Example/style/x.json',
  '... rev 2',
  '... haveRev 2',
  '... action edit',
  '... change default',
  '... type text+w',
  '',
  '',
].join('\n')
const typeLast = p4.parseOpened(TYPE_LAST)
check('a record whose last tag is `type` does not absorb the blank line', typeLast[0]?.type, 'text+w')
checkThat('the task-shaped type is byte-for-byte "text+w"', JSON.stringify(typeLast[0]?.type) === '"text+w"', shown(typeLast[0]?.type))

const realEntries = p4.parseOpened(REAL_OPENED)
check('real-shape opened parses both records', realEntries.length, 2)
// deepEqual on the bare string is the point: 'text+w\n' !== 'text+w'.
check('real-shape type is exactly whitespace-free', realEntries.map((entry) => entry.type), ['text+w', 'text+w'])
checkThat(
  'no parsed value carries leading/trailing whitespace',
  realEntries.every((entry) =>
    [entry.type, entry.action, entry.change, entry.depotFile, entry.clientFile, entry.user, entry.client].every(
      (value) => value === null || value === value.trim(),
    ),
  ),
  shown(realEntries),
)
check('real-shape client paths map to client-relative paths', realEntries.map((entry) => entry.path), [
  'Content/Example/BehaviorTree/Asset_Example.json',
  'Content/Example/style/Asset_Example_Style.json',
])
check('the defect form is a genuinely different string', 'text+w\n' === 'text+w', false)

// An internal blank line in a multi-paragraph description must survive the trim
// that removes the record-terminating newline.
const MULTI_PARAGRAPH = [
  '... change 4321',
  '... user p4user',
  '... client fake_client',
  '... status pending',
  '... desc alpha line one',
  '',
  'beta line two',
  '',
  '... depotFile0 //ProjW-Client/Main/Content/Example/docs/notes.md',
  '... action0 edit',
  '... type0 text',
  '... rev0 1',
  '',
  '',
].join('\n')
const multi = p4.parseChangelistSpec(MULTI_PARAGRAPH)
check('a multi-paragraph description keeps its internal blank line', multi[0]?.description, 'alpha line one\n\nbeta line two')
check('the indexed file list beside a multi-line description survives', [multi[0]?.files, multi[0]?.change], [1, 4321])

// The state path: fstat supplies headType, opened supplies the workspace type.
const stateM = await p4.readWorkspace({
  run: scriptRunner([
    { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
    { match: (args) => args.includes('opened'), reply: { stdout: openedOne('text+w') } },
    { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text+w', type: 'text+w' }) } },
  ]),
  dir: SUBDIR,
})
check('an ordinary edit whose type equals headType is M, never T', stateM.files.map((file) => [file.path, file.status, file.p4Type]), [
  [EDIT, 'M', 'text+w'],
])

const stateNoTypeTag = await p4.readWorkspace({
  run: scriptRunner([
    { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
    { match: (args) => args.includes('opened'), reply: { stdout: openedOne('text+w') } },
    { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text+w' }) } },
  ]),
  dir: SUBDIR,
})
check('when fstat sends only headType the opened type is still compared', stateNoTypeTag.files.map((file) => file.status), ['M'])

const stateT = await p4.readWorkspace({
  run: scriptRunner([
    { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
    { match: (args) => args.includes('opened'), reply: { stdout: openedOne('text+w') } },
    { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text', type: 'text+w' }) } },
  ]),
  dir: SUBDIR,
})
check('a genuine type change is still T', stateT.files.map((file) => [file.status, file.p4Type]), [['T', 'text+w']])

const stateEditType = await p4.readWorkspace({
  run: scriptRunner([
    { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
    { match: (args) => args.includes('opened'), reply: { stdout: openedOne('text+w', 'edit/type') } },
    { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text+w', type: 'text+w' }) } },
  ]),
  dir: SUBDIR,
})
check('p4 action edit/type is T on its own', stateEditType.files.map((file) => file.status), ['T'])

// --------------------------------------- 2. read-only: recorded + static

console.log('2. read-only audit (recorded commands + static call-site scan)')

const WRITE_VERBS = new Set([
  'submit',
  'sync',
  'edit',
  'add',
  'delete',
  'revert',
  'integrate',
  'merge',
  'resolve',
  'copy',
  'move',
  'shelve',
  'unshelve',
  'reconcile',
  'clean',
  'changelist',
  'obliterate',
  'purge',
])
const READ_HEADS = new Set([
  '-ztag info',
  '-ztag opened',
  '-ztag status',
  '-ztag fstat',
  '-ztag changes',
  '-ztag describe',
  '-ztag where',
  'diff',
  'diff2',
  'print',
])

resetP4Calls()
await p4.readWorkspace({ run: fakeRun, dir: SUBDIR, localEdits: true, shelved: true, readFile: async (file) => fs.readFileSync(file) })
await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: EDIT, clientRoot: CTX, p4Type: 'text+w' })
await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: ADD, depotPath: depot(ADD), change: '1234' })
await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: GONE, clientRoot: CTX, p4Type: 'text' })
await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: 'Content/Example/DoesNotExist.txt', clientRoot: CTX, p4Type: 'text' })
const auditCalls = readP4Calls()

const headOf = (line) => {
  const tokens = line.split(/\s+/)
  return tokens[0] === '-ztag' ? `-ztag ${tokens[1]}` : tokens[0]
}
const auditHeads = [...new Set(auditCalls.map(headOf))].sort()
check('every recorded verb is a documented read-only query', auditHeads.every((head) => READ_HEADS.has(head)), true)
checkThat(
  'no recorded invocation names a writing command',
  !auditCalls.some((line) => WRITE_VERBS.has(headOf(line).replace('-ztag ', ''))),
  shown(auditCalls),
)
checkThat(
  'no fstat in the cycle enumerates //client/...',
  !auditCalls.some((line) => /(^|\s)fstat(\s|$)/.test(line) && /\/\.\.\./.test(line)),
  shown(auditCalls.filter((line) => line.includes('fstat'))),
)
checkThat(
  'the local scan is scoped to the session subdirectory, never to the client root',
  auditCalls.filter((line) => /(^|\s)status(\s|$)/.test(line)).every((line) => !line.includes('//')),
  shown(auditCalls.filter((line) => /(^|\s)status(\s|$)/.test(line))),
)
check('the primary source is one `opened` over the client', auditCalls.filter((line) => /(^|\s)opened(\s|$)/.test(line)), [
  `-ztag opened //${CLIENT}/...`,
])
note('recorded p4 invocations for one full state+diff cycle', shown(auditCalls))

const p4Source = fs.readFileSync(path.join(HERE, 'lib', 'p4.js'), 'utf8')
const callHeads = [...p4Source.matchAll(/await call\(\s*\[\s*'([^']+)'(?:\s*,\s*'([^']+)')?/g)].map((match) =>
  match[1] === '-ztag' ? `-ztag ${match[2] ?? ''}`.trim() : match[1],
)
checkThat('the static scan found every call site', callHeads.length >= 10, shown(callHeads))
check('every static call head is a read-only query', [...new Set(callHeads)].sort().every((head) => READ_HEADS.has(head)), true)
note('static call heads in lib/p4.js', shown([...new Set(callHeads)].sort()))
check('there is exactly one `status` call site in lib/p4.js', callHeads.filter((head) => head === '-ztag status').length, 1)
const statusCalls = auditCalls.filter((line) => /(^|\s)status(\s|$)/.test(line))
// `p4 help status` on the live server: "status -- 'reconcile -n + opened'".
check('the one status call is the scoped scan and carries no -A', statusCalls.length, 1)
checkThat('the status call passes no -A (the writing form)', !statusCalls[0].includes('-A'), shown(statusCalls))
checkThat(
  'the status call passes none of the other writing flags (-w / -c change#)',
  !/\s-[Aw]\b/.test(statusCalls[0]) && !/\s-c\s/.test(statusCalls[0]),
  shown(statusCalls[0]),
)
note('vendor evidence for `p4 status`', "p4 help status: status -- 'reconcile -n + opened'; status -A is 'reconcile -ead' (writing) and is never used")

const routeSource = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
checkThat(
  'index.js exposes no scan option that would reconcile without a preview',
  !/reconcile\s+-ead|\bstatus\s+-A\b/.test(routeSource),
  'index.js names a writing reconcile form',
)

// ------------------------------------------- 3. workspace / directory edges

console.log('3. readWorkspace: dir at the root, in a subdirectory, outside the root')

resetP4Calls()
const rootState = await p4.readWorkspace({ run: fakeRun, dir: ROOT, localEdits: true })
check('dir === client root still answers', [rootState.ok, rootState.dir, rootState.files.length], [true, ROOT, 4])
checkThat(
  'the unbounded root scan is refused with a note',
  rootState.notes.some((entry) => entry.includes('根目录')),
  shown(rootState.notes),
)
check(
  'no status command is issued for the client root by default',
  readP4Calls().filter((line) => /(^|\s)status(\s|$)/.test(line)),
  [],
)

resetP4Calls()
const subState = await p4.readWorkspace({ run: fakeRun, dir: SUBDIR, localEdits: true, readFile: async (file) => fs.readFileSync(file) })
check('dir === subdirectory answers', [subState.ok, subState.total > rootState.total], [true, true])
const subScan = readP4Calls().find((line) => /(^|\s)status(\s|$)/.test(line))
check('the scan target is the subdirectory spec', subScan, `-ztag status Content/Example/style/...`)

const outsideState = await p4.readWorkspace({ run: fakeRun, dir: OUTSIDE })
check('dir outside the client root is not-a-workspace', [outsideState.ok, outsideState.reason], [false, 'not-a-workspace'])

const untouched = scriptRunner([])
const providedOutside = await p4.readWorkspace({
  run: untouched,
  dir: OUTSIDE,
  workspace: { client: CLIENT, root: ROOT, port: 'fake:1666' },
})
check('a caller-supplied root that does not cover dir refuses without spawning p4', [providedOutside.reason, untouched.calls.length], [
  'not-a-workspace',
  0,
])

// A `..` in `dir` is tolerated (the p4 child runs with the client root as cwd,
// so the OS resolves it back inside), but it must never leak into reported paths.
const dotted = `${ROOT}\\..\\root\\Config\\Raw\\ai\\style\\BTstyle`
const dottedState = await p4.readWorkspace({ run: fakeRun, dir: dotted })
check('a `..` in dir does not throw or escape', [dottedState.ok, dottedState.files.length], [true, 4])
checkThat('no reported path contains ..', dottedState.files.every((file) => !file.path.includes('..')), shown(dottedState.files.map((file) => file.path)))

// An opened file whose client path tries to traverse upward is skipped, not mapped.
const traverseRun = scriptRunner([
  { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
  {
    match: (args) => args.includes('opened'),
    reply: {
      stdout: ztagBody([
        [
          ['depotFile', '//ProjW-Client/Main/evil.txt'],
          ['clientFile', `//${CLIENT}/../../outside/evil.txt`],
          ['action', 'edit'],
          ['change', 'default'],
          ['type', 'text'],
        ],
      ]),
    },
  },
])
const traverseState = await p4.readWorkspace({ run: traverseRun, dir: SUBDIR })
// The traversing clientFile is discarded; the depot path is mapped through the
// stream instead, so nothing carrying `..` is ever reported.
check('a traversing clientFile is discarded and the depot mapping wins', traverseState.files.map((file) => file.path), ['evil.txt'])
checkThat(
  'no reported path carries a .. segment',
  traverseState.files.every((file) => !file.path.includes('..')),
  shown(traverseState.files.map((file) => file.path)),
)

// ------------------------------------------------------ empty / no-user cases

console.log('4. readWorkspace: empty answer and a client with no user')

const emptyState = await p4.readWorkspace({
  run: scriptRunner([{ match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } }]),
  dir: SUBDIR,
})
check('an empty answer is ok with zero files', [emptyState.ok, emptyState.total, emptyState.files.length, emptyState.truncated], [
  true,
  0,
  0,
  false,
])
check('an empty answer carries no changelist groups', emptyState.changelists, [])
check('an empty answer reports no revisions', emptyState.revisions, null)
check('an empty answer still names the workspace', [emptyState.workspace.client, emptyState.workspace.stream], [CLIENT, STREAM])

const noUserRun = scriptRunner([
  {
    match: (args) => args.includes('info'),
    reply: { stdout: ztagBody([[
      ['clientName', CLIENT],
      ['clientRoot', ROOT],
      ['clientStream', STREAM],
      ['serverAddress', 'fake:1666'],
    ]]) },
  },
  { match: (args) => args.includes('opened'), reply: { stdout: openedOne('text+w') } },
  { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text+w', type: 'text+w' }) } },
])
const noUserState = await p4.readWorkspace({ run: noUserRun, dir: SUBDIR, shelved: true })
check('a client with no user answers with its files', [noUserState.ok, noUserState.files.length, noUserState.workspace.user], [true, 1, null])
check('a client with no user triggers no shelved query', noUserRun.calls.filter((call) => call.args.includes('shelved')), [])
check('a client with no user triggers no changes query at all', noUserRun.calls.filter((call) => call.args.includes('changes')), [])
checkThat(
  'the skipped shelf is explained in a note',
  noUserState.notes.some((entry) => entry.includes('用户名')),
  shown(noUserState.notes),
)

// ---------------------------------------------------------- shelf outside view

console.log('5. a shelved changelist whose files are all outside the client view')

const outsideShelfRun = scriptRunner([
  { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
  { match: (args) => args.includes('opened'), reply: { stdout: '' } },
  {
    match: (args) => args.includes('changes') && args.includes('shelved'),
    reply: {
      stdout: ztagBody([
        [
          ['change', '999'],
          ['time', '1792121681'],
          ['user', USER],
          ['client', CLIENT],
          ['status', 'pending'],
          ['shelved', ''],
          ['desc', 'outside shelf'],
        ],
      ]),
    },
  },
  {
    match: (args) => args.includes('describe'),
    reply: {
      stdout: ztagBody([
        [
          ['change', '999'],
          ['user', USER],
          ['client', CLIENT],
          ['status', 'pending'],
          ['shelved', ''],
          ['desc', 'outside shelf'],
          ['depotFile0', '//OtherDepot/secret.txt'],
          ['action0', 'add'],
          ['type0', 'text'],
          ['rev0', '1'],
        ],
      ]),
    },
  },
  {
    match: (args) => args.includes('where'),
    reply: { stdout: ztagBody([[['depotFile', `${STREAM}/...`], ['clientFile', `//${CLIENT}/...`]]]) },
  },
])
const outsideShelf = await p4.readWorkspace({ run: outsideShelfRun, dir: SUBDIR, shelved: true })
check('an out-of-view shelf yields no file rows', [outsideShelf.ok, outsideShelf.files.length, outsideShelf.total], [true, 0, 0])
check('an out-of-view shelf leaves no empty changelist group behind', outsideShelf.changelists, [])
checkThat(
  'the dropped shelf is explained in a note',
  outsideShelf.notes.some((entry) => entry.includes('不在该客户端视图内')),
  shown(outsideShelf.notes),
)
checkThat(
  'mapping was attempted instead of guessing a client path',
  outsideShelfRun.calls.some((call) => call.args.includes('where')),
  shown(outsideShelfRun.calls.map((call) => call.args)),
)

// ------------------------- pending changelists that own nothing in this client

console.log('5b. a pending changelist from another client of the same user')

const phantomRun = scriptRunner([
  { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
  { match: (args) => args.includes('opened'), reply: { stdout: '' } },
  {
    match: (args) => args.includes('changes') && args.includes('pending'),
    reply: {
      stdout: ztagBody([
        [
          ['change', '777'],
          ['time', '1792121681'],
          ['user', USER],
          ['client', 'other_client'],
          ['status', 'pending'],
          ['desc', 'work on another client'],
        ],
      ]),
    },
  },
  {
    match: (args) => args.includes('describe'),
    reply: {
      stdout: ztagBody([
        [
          ['change', '777'],
          ['user', USER],
          ['client', 'other_client'],
          ['status', 'pending'],
          ['desc', 'work on another client'],
          ['depotFile0', '//OtherDepot/y.txt'],
          ['action0', 'edit'],
          ['type0', 'text'],
          ['rev0', '1'],
        ],
      ]),
    },
  },
])
const phantom = await p4.readWorkspace({ run: phantomRun, dir: SUBDIR })
check('a foreign pending changelist contributes no file rows', [phantom.total, phantom.files.length], [0, 0])
check('a foreign pending changelist now yields no group at all', phantom.changelists, [])
if (phantom.changelists.length === 0) {
  resolved(
    'a pending changelist from another client of the same user no longer becomes a phantom group',
    '"a foreign pending changelist now yields no group at all"',
    'lib/p4.js:1470 now drops a numbered change whose `client` is not this client, on top of the existing no-visible-rows guard.',
  )
}

// The corrected guard must not swing the other way: a change that belongs to
// THIS client and owns a visible row still renders with its file count.
const genuineRun = scriptRunner([
  { match: (args) => args.includes('info'), reply: { stdout: ztagBody(infoRecords()) } },
  {
    match: (args) => args.includes('opened'),
    reply: {
      stdout: ztagBody([
        [
          ['depotFile', depot(EDIT)],
          ['clientFile', `//${CLIENT}/${EDIT}`],
          ['rev', '2'],
          ['haveRev', '2'],
          ['action', 'edit'],
          ['change', '888'],
          ['type', 'text+w'],
          ['user', USER],
          ['client', CLIENT],
        ],
      ]),
    },
  },
  { match: (args) => args.includes('fstat'), reply: { stdout: fstatOne({ headType: 'text+w', type: 'text+w' }) } },
  {
    match: (args) => args.includes('changes') && args.includes('pending'),
    reply: {
      stdout: ztagBody([
        [
          ['change', '888'],
          ['time', '1792121681'],
          ['user', USER],
          ['client', CLIENT],
          ['status', 'pending'],
          ['desc', 'work in this client'],
        ],
      ]),
    },
  },
])
const genuine = await p4.readWorkspace({ run: genuineRun, dir: SUBDIR })
check('a genuine pending change for THIS client still renders with its file count', genuine.changelists.map((entry) => [String(entry.number), entry.files, entry.client]), [
  ['888', 1, CLIENT],
])
check('...and still owns its visible row', genuine.files.map((file) => [file.path, file.change]), [[EDIT, 888]])

// ------------------------------------------------------------- limits

console.log('6. maxFiles / maxDiffBytes boundaries (0, 1, exact fit)')

const fit = await p4.readWorkspace({ run: fakeRun, dir: SUBDIR, limits: { maxFiles: 4 } })
check('maxFiles exact fit does not truncate', [fit.files.length, fit.total, fit.truncated], [4, 4, false])
const one = await p4.readWorkspace({ run: fakeRun, dir: SUBDIR, limits: { maxFiles: 1 } })
check('maxFiles 1 truncates to one row', [one.files.length, one.total, one.truncated], [1, 4, true])
const zero = await p4.readWorkspace({ run: fakeRun, dir: SUBDIR, limits: { maxFiles: 0 } })
check('maxFiles 0 yields no rows but keeps the total', [zero.files.length, zero.total, zero.truncated], [0, 4, true])
checkThat('maxFiles 0 is explained', zero.notes.some((entry) => entry.includes('0')), shown(zero.notes))

const full = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: LARGE, clientRoot: CTX, p4Type: 'text' })
const fullBytes = Buffer.byteLength(full.text, 'utf8')
checkThat('the large comparison has real content', full.ok && fullBytes > 300, `${fullBytes} bytes`)
const exactFit = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: LARGE, clientRoot: CTX, p4Type: 'text', limits: { maxDiffBytes: fullBytes } })
check('maxDiffBytes exact fit keeps the whole comparison', [exactFit.truncated, exactFit.text], [false, full.text])
const underFit = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: LARGE, clientRoot: CTX, p4Type: 'text', limits: { maxDiffBytes: fullBytes - 1 } })
check('maxDiffBytes one byte short truncates on a line boundary', [underFit.truncated, underFit.text.endsWith('\n'), underFit.text.length <= fullBytes], [true, true, true])
const zeroBytes = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: LARGE, clientRoot: CTX, p4Type: 'text', limits: { maxDiffBytes: 0 } })
check('maxDiffBytes 0 does not throw', [zeroBytes.ok, zeroBytes.truncated, typeof zeroBytes.text], [true, true, 'string'])
const oneByte = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: LARGE, clientRoot: CTX, p4Type: 'text', limits: { maxDiffBytes: 1 } })
check('maxDiffBytes 1 does not throw', [oneByte.ok, oneByte.truncated, typeof oneByte.text], [true, true, 'string'])

// ------------------------------------------- binary / deleted / absent diffs

console.log('7. readDiff: deleted, binary and not-in-depot files')

const noSpawn = scriptRunner([])
const binaryByType = await p4.readDiff({ run: noSpawn, dir: SUBDIR, path: ADD, clientRoot: CTX, p4Type: 'binary' })
check('a known binary type is answered without spawning p4', [binaryByType.ok, binaryByType.binary, binaryByType.text, noSpawn.calls.length], [
  true,
  true,
  '',
  0,
])
const nulBody = await p4.readDiff({
  run: scriptRunner([{ match: (args) => args[0] === 'diff', reply: { stdout: '--- a/x\n+++ b/x\n\0binary\n' } }]),
  dir: SUBDIR,
  path: 'Content/Example/style/blob.dat',
  clientRoot: CTX,
  p4Type: 'text',
})
check('a NUL in the comparison body is read as binary', [nulBody.ok, nulBody.binary, nulBody.text], [true, true, ''])

const deletedRun = scriptRunner([
  { match: (args) => args[0] === 'diff', reply: { stdout: '', stderr: '' } },
  { match: (args) => args[0] === 'print', reply: { stdout: 'line one\nline two\n' } },
])
const deleted = await p4.readDiff({
  run: deletedRun,
  dir: SUBDIR,
  path: 'Content/Example/Dead.txt',
  depotPath: '//ProjW-Client/Main/Content/Example/Dead.txt',
  clientRoot: CTX,
  p4Type: 'text',
  changed: true,
  readFile: async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
})
check('a deleted file with a depot path synthesises an all-deletions comparison', [
  deleted.ok,
  deleted.deleted === true,
  deleted.text.includes('--- a/'),
  deleted.text.includes('-line one'),
], [true, true, true, true])
check('the deleted comparison needs the changed flag to reach the synthesis', deletedRun.calls.some((call) => call.args.includes('print')), true)

const added = await p4.readDiff({
  run: scriptRunner([
    { match: (args) => args[0] === 'diff', reply: { stdout: '', stderr: '//x - no such file(s).\n' } },
    { match: (args) => args[0] === 'print', reply: { status: 1, stdout: '', stderr: 'no such file\n' } },
  ]),
  dir: SUBDIR,
  path: 'Content/Example/New/Newly.txt',
  depotPath: '//ProjW-Client/Main/Content/Example/New/Newly.txt',
  clientRoot: CTX,
  p4Type: 'text',
  changed: true,
  readFile: async () => Buffer.from('alpha\nbeta\n', 'utf8'),
})
check('a file that is not in the depot synthesises an all-additions comparison', [
  added.ok,
  added.untracked === true,
  added.text.startsWith('--- /dev/null'),
  added.text.includes('+alpha'),
], [true, true, true, true])

const absent = await p4.readDiff({ run: fakeRun, dir: SUBDIR, path: 'Content/Example/DoesNotExist.txt', clientRoot: CTX, p4Type: 'text' })
check('p4 saying "no such file(s)" is an empty comparison, not an error', [absent.ok, absent.text, absent.binary], [true, '', false])

check('a shelved comparison uses the @=change spec', await (async () => {
  const shelvedRun = scriptRunner([
    { match: (args) => args[0] === 'diff', reply: { stdout: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n' } },
  ])
  await p4.readDiff({
    run: shelvedRun,
    dir: SUBDIR,
    path: NOTES,
    depotPath: depot(NOTES),
    change: '1234',
    shelved: true,
    clientRoot: CTX,
  })
  return shelvedRun.calls[0]?.args.join(' ')
})(), `diff -du -f ${depot(NOTES)}@=1234`)

check('an explicit origin beats the shelved flag', await (async () => {
  const result = await p4.readDiff({ run: scriptRunner([]), dir: SUBDIR, path: NOTES, clientRoot: CTX, p4Type: 'text', shelved: true, origin: 'opened' })
  return result.origin
})(), 'opened')

// A path handed straight to the module is not traversal-checked; the route is.
const readPaths = []
await p4.readDiff({
  run: scriptRunner([
    { match: (args) => args[0] === 'diff', reply: { status: 1, stdout: '', stderr: 'fatal\n' } },
    { match: (args) => args[0] === 'print', reply: { status: 1, stdout: '', stderr: 'fatal\n' } },
  ]),
  dir: SUBDIR,
  path: '../../outside/secret.txt',
  clientRoot: CTX,
  p4Type: 'text',
  changed: true,
  readFile: async (file) => {
    readPaths.push(file)
    return Buffer.from('secret\n', 'utf8')
  },
})
check('readDiff itself does not guard the local path (index.js does)', readPaths.some((entry) => entry.includes('..')), true)
check('index.js safeRepoPath rejects the same path before readDiff sees it', safeRepoPath('../../outside/secret.txt'), null)
note('defense in depth', 'lib/p4.js readDiff trusts `path`; the only production caller (index.js:619) rejects .. / absolute paths first')

// ------------------------------------------- file-type classification policy
// `+x` is the executable bit of a text file and p4 diffs it normally; `+F`
// (whole-file storage), `binary`, `apple` and `resource` stay non-text, and the
// modifier match is a list comparison, so `+Sx` is not read as `+F`.

const plusXRun = scriptRunner([
  { match: (args) => args[0] === 'diff', reply: { stdout: '--- a/tools/build.sh\n+++ b/tools/build.sh\n@@ -1 +1 @@\n-old\n+new\n' } },
])
const plusX = await p4.readDiff({ run: plusXRun, dir: SUBDIR, path: 'tools/build.sh', clientRoot: CTX, p4Type: 'text+x' })
check('a text+x file is diffed, not reported binary', [plusX.ok, plusX.binary, plusX.text.includes('+new'), plusXRun.calls.filter((call) => call.args[0] === 'diff').length], [
  true,
  false,
  true,
  1,
])
const classification = {}
for (const type of ['text', 'text+w', 'text+x', 'text+Sx', 'text+F', 'binary', 'binary+w', 'apple', 'resource']) {
  const probe = await p4.readDiff({ run: scriptRunner([]), dir: SUBDIR, path: 'tools/x', clientRoot: CTX, p4Type: type })
  classification[type] = probe.binary
}
check('type classification: +x is text; +F/binary/apple/resource stay binary; +Sx is not +F', classification, {
  text: false,
  'text+w': false,
  'text+x': false,
  'text+Sx': false,
  'text+F': true,
  binary: true,
  'binary+w': true,
  apple: true,
  resource: true,
})
resolved(
  'text+x is no longer classified as binary',
  '"a text+x file is diffed, not reported binary" + the classification matrix',
  'lib/p4.js:750-759 matches modifiers as a list and only `f` counts; `+x` and `+Sx` stay text while `+F`/binary/apple/resource stay binary.',
)

// ------------------------------------------------- 8. the vcs backend router

console.log('8. lib/vcs.js: order, failure reasons, 60 s cache')

const P4_OK = { ok: true, client: CLIENT, root: ROOT, port: 'fake:1666', user: USER, charset: 'utf8', stream: STREAM }
const routerFor = ({ git, p4: p4Answer, cache }) =>
  createBackendRouter({ isGitWorkTree: async () => git, probeP4: async () => p4Answer, cache })
const probeCache = createDetectCache()
const bothRouter = routerFor({ git: true, p4: P4_OK, cache: probeCache })
const bothAuto = await bothRouter.resolve({ dir: 'D:\\both' })
check('a directory under both advertises both backends', bothAuto.available, ['git', 'p4'])
check('auto prefers git and reports what it skipped', [bothAuto.vcs, bothAuto.skipped], ['git', 'p4'])
const bothP4 = await bothRouter.resolve({ dir: 'D:\\both', requested: 'p4' })
check('an explicit p4 request on a both-directory wins', [bothP4.vcs, bothP4.workspace?.client], ['p4', CLIENT])
const gitOnly = await routerFor({ git: true, p4: { ok: false, reason: 'not-a-workspace', detail: null } }).resolve({ dir: 'D:\\git' })
check('git-only auto resolves to git', [gitOnly.vcs, gitOnly.available], ['git', ['git']])
const p4Only = await routerFor({ git: false, p4: P4_OK }).resolve({ dir: 'D:\\p4' })
check('p4-only auto resolves to p4', [p4Only.vcs, p4Only.available, p4Only.workspace?.root], ['p4', ['p4'], ROOT])

const gitOnP4 = await routerFor({ git: false, p4: P4_OK }).resolve({ dir: 'D:\\p4', requested: 'git' })
check('vcs=git on a p4-only directory refuses instead of lying', [gitOnP4.vcs, gitOnP4.reason, gitOnP4.available], [
  null,
  'not-a-repository',
  ['p4'],
])
const p4OnGit = await routerFor({ git: true, p4: { ok: false, reason: 'not-a-workspace', detail: null } }).resolve({ dir: 'D:\\git', requested: 'p4' })
check('vcs=p4 on a git-only directory refuses with p4 own reason', [p4OnGit.vcs, p4OnGit.reason, p4OnGit.available], [
  null,
  'not-a-workspace',
  ['git'],
])
const p4Down = await routerFor({ git: false, p4: { ok: false, reason: 'p4-unavailable', detail: 'Connect to server failed' } }).resolve({ dir: 'D:\\x' })
check('an unreachable server survives into the answer with its detail', [p4Down.vcs, p4Down.reason, p4Down.detail], [
  null,
  'p4-unavailable',
  'Connect to server failed',
])
const p4Error = await routerFor({ git: false, p4: { ok: false, reason: 'p4-error', detail: 'client unknown' } }).resolve({ dir: 'D:\\y' })
check('a p4 error is forwarded as p4-error', p4Error.reason, 'p4-error')
const nowhere = await routerFor({ git: false, p4: { ok: false, reason: 'not-a-workspace', detail: 'outside root' } }).resolve({ dir: 'D:\\z' })
check('a directory neither backend owns is not-a-repository with p4 detail kept', [nowhere.reason, nowhere.detail], [
  'not-a-repository',
  'outside root',
])
const noDir = await routerFor({ git: false, p4: P4_OK }).resolve({})
check('a request without dir is not-a-repository', [noDir.vcs, noDir.reason], [null, 'not-a-repository'])

check('the documented detection TTL is 60 s', DEFAULT_DETECT_TTL_MS, 60_000)
let clock = 1_000
const ttlCache = createDetectCache({ now: () => clock })
ttlCache.set('k', { vcs: 'p4' })
clock = 1_000 + 59_999
check('a value is reused just inside the TTL', ttlCache.get('k')?.vcs, 'p4')
clock = 1_000 + 60_001
check('a value expires just past the TTL', ttlCache.get('k'), null)
check('an expired entry is dropped from the cache', ttlCache.size, 0)

clock = 0
let probes = 0
const countingRouter = createBackendRouter({
  isGitWorkTree: async () => false,
  probeP4: async () => {
    probes += 1
    return P4_OK
  },
  cache: createDetectCache({ now: () => clock }),
})
await countingRouter.resolve({ dir: 'D:\\count', envKey: 'a' })
await countingRouter.resolve({ dir: 'D:\\count', envKey: 'a' })
check('a second request inside the TTL reuses the probe', probes, 1)
clock = 60_001
await countingRouter.resolve({ dir: 'D:\\count', envKey: 'a' })
check('a request after the TTL re-probes', probes, 2)
await countingRouter.resolve({ dir: 'D:\\count', envKey: 'b' })
check('a different connection key gets its own cache entry', probes, 3)

// A case-variant explicit request must resolve AND cache as the canonical
// backend, so the second call does not get the first call's AUTO answer.
const poisonCache = createDetectCache()
const poisonRouter = routerFor({ git: true, p4: P4_OK, cache: poisonCache })
const firstVariant = await poisonRouter.resolve({ dir: 'D:\\poison', requested: 'P4' })
const canonical = await poisonRouter.resolve({ dir: 'D:\\poison', requested: 'p4' })
check('vcs=P4 resolves as Perforce', firstVariant.vcs, 'p4')
check('vcs=P4 caches as Perforce, so a later vcs=p4 is not poisoned', canonical.vcs, 'p4')
check('the case-variant and canonical requests share the cache entry', poisonCache.size, 1)

// An unrecognised value is not a backend: it must fall back to auto detection,
// not refuse and not error.
const junkRun = routerFor({ git: false, p4: P4_OK })
const junk = await junkRun.resolve({ dir: 'D:\\junk', requested: 'svn' })
check('an unrecognised vcs value falls back to auto detection', [junk.vcs, junk.reason], ['p4', null])
const junkBoth = await routerFor({ git: true, p4: P4_OK }).resolve({ dir: 'D:\\junk2', requested: 'not-a-vcs' })
check('an unrecognised vcs value on a both-directory picks the auto winner', junkBoth.vcs, 'git')

// A junk value lands under its own cache key rather than the canonical 'auto'
// key; the answer is still the auto answer, so this is a wasted probe, not a
// wrong answer.
const junkProbes = { count: 0 }
const junkCache = createDetectCache()
const junkCountingRouter = createBackendRouter({
  isGitWorkTree: async () => false,
  probeP4: async () => {
    junkProbes.count += 1
    return P4_OK
  },
  cache: junkCache,
})
await junkCountingRouter.resolve({ dir: 'D:\\junk3', requested: 'svn' })
await junkCountingRouter.resolve({ dir: 'D:\\junk3', requested: 'auto' })
note('unrecognised vcs cache key', `a junk value and 'auto' produce the same answer but two cache entries (probes: ${junkProbes.count})`)

resolved(
  'a mixed-case or unrecognised vcs request no longer poisons the canonical cache key',
  '"vcs=P4 resolves as Perforce", "vcs=P4 caches as Perforce…", the shared-entry size and the two auto-fallback checks',
  "lib/vcs.js:117 lowercases `requested` once and maps anything outside {auto,git,p4} to auto before the case-sensitive branches, so `vcs=P4` is Perforce and `vcs=svn` is auto.",
)

// ------------------------------------------------------ 9. the HTTP routes

console.log('9. index.js routes: sessionId, authorization, env, p4-only/git-only')

const gitRepoDir = HERE.replace(/[\\/]+$/, '')
const spawnSink = []
const captureExecFile = (sink) => {
  const fake = createFakeP4ExecFile()
  return (file, args, options, callback) => {
    sink.push({
      file,
      args: [...(args ?? [])],
      env: options?.env ? { ...options.env } : null,
      cwd: options?.cwd ?? null,
      timeout: options?.timeout ?? null,
    })
    if (file === FAKE_P4_SHIM) return fake(file, args, options, callback)
    return fileRedirectExecFile(file, args, options, callback)
  }
}

const routeCtx = {
  logger: { warn() {}, info() {} },
  get: (name) =>
    name === 'workspaceRegistry'
      ? { list: () => [{ id: 'w-p4', path: ROOT, sessionIds: ['p4s'] }] }
      : name === 'sessions'
        ? { list: () => [{ id: 'p4s', header: { cwd: ROOT } }], get: (id) => (id === 'p4s' ? { id, header: { cwd: ROOT } } : undefined) }
        : undefined,
}
const routeSink = []
const routes = createRoutes(
  routeCtx,
  {
    allowedPaths: [ROOT, SUBDIR, gitRepoDir],
    p4Path: FAKE_P4_SHIM,
    gitPath: 'git',
    diagnostics: false,
  },
  { execFile: captureExecFile(routeSink) },
)

const unknownSession = await routes.handleState(new Request('http://localhost/api/changelist.state?sessionId=nope&vcs=p4'))
const unknownSessionBody = await unknownSession.json()
check('an unknown sessionId is a 404', [unknownSession.status, unknownSessionBody.ok], [404, false])
check('an unknown sessionId spawns nothing at all', routeSink.length, 0)

const denied = await routes.handleState(new Request('http://localhost/api/changelist.state?dir=C%3A%5CWindows%5CSystem32&vcs=p4'))
check('an unauthorized dir is a 403 with no spawn', [denied.status, routeSink.length], [403, 0])

for (const candidate of ['../../outside/secret.txt', 'C:/Windows/win.ini', '//OtherDepot/secret.txt', '/etc/passwd']) {
  const response = await routes.handleDiff(
    new Request(`http://localhost/api/changelist.diff?dir=${encodeURIComponent(ROOT)}&vcs=p4&path=${encodeURIComponent(candidate)}`),
  )
  check(`the diff route rejects path ${JSON.stringify(candidate)}`, response.status, 400)
}

const p4RouteState = await (await routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(ROOT)}&vcs=p4`))).json()
check('the p4 route answers for a p4-only dir', [p4RouteState.ok, p4RouteState.vcs], [true, 'p4'])
const gitOnlyRoute = await (await routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(gitRepoDir)}&vcs=p4`))).json()
check('vcs=p4 on a git-only dir refuses with not-a-workspace', [gitOnlyRoute.ok, gitOnlyRoute.vcs, gitOnlyRoute.reason], [false, null, 'not-a-workspace'])
const gitOnlyAuto = await (await routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(gitRepoDir)}&vcs=auto`))).json()
check('auto on the git-only dir reaches git', gitOnlyAuto.vcs, 'git')

// A `depotPath` is trusted only in shape: a malformed spec is refused with 400
// before any p4 command runs, a real `//depot/...` spec still reaches p4.
const malformedDepot = await routes.handleDiff(
  new Request(
    `http://localhost/api/changelist.diff?dir=${encodeURIComponent(ROOT)}&vcs=p4&path=${encodeURIComponent(EDIT)}&depotPath=${encodeURIComponent('not-a-depot-path')}`,
  ),
)
const malformedBody = await malformedDepot.json()
check('a malformed depotPath is refused with 400 rather than forwarded', [malformedDepot.status, malformedBody.ok, malformedBody.vcs], [400, false, 'p4'])
for (const bad of ['/depot/x', '//depot', '//depot/', 'depot/x']) {
  const response = await routes.handleDiff(
    new Request(`http://localhost/api/changelist.diff?dir=${encodeURIComponent(ROOT)}&vcs=p4&path=${encodeURIComponent(EDIT)}&depotPath=${encodeURIComponent(bad)}`),
  )
  check(`the diff route rejects depotPath ${JSON.stringify(bad)}`, response.status, 400)
}
const legitimateDepot = await (
  await routes.handleDiff(
    new Request(
      `http://localhost/api/changelist.diff?dir=${encodeURIComponent(ROOT)}&vcs=p4&path=${encodeURIComponent('Content/Example/DoesNotExist.txt')}&depotPath=${encodeURIComponent(depot(NOTES))}&changed=1`,
    ),
  )
).json()
check('a legitimate //depot/... depotPath still reaches p4', [legitimateDepot.ok, String(legitimateDepot.text).length > 0], [true, true])
resolved(
  'the diff route no longer forwards an unvalidated depotPath',
  '"a malformed depotPath is refused with 400 rather than forwarded", the four rejected shapes and "a legitimate //depot/... depotPath still reaches p4"',
  'the diff route rejects anything failing /^\\/\\/[^/]+\\/.+/ with 400 (vcs:"p4") before readP4Diff; a well-formed spec still flows through. (Quoted without a line number: the file moves.)',
)
note(
  'accepted depot-path scope (now documented)',
  'a well-formed spec outside the client view (e.g. //OtherDepot/x) is still forwarded — read-only, and governed by the Perforce user\'s own ACLs; the validation site now states exactly that instead of claiming the route cannot read outside the client view.',
)

// ------------------------------------- 10. environment handed to the p4 child

console.log('10. the environment the route hands to the p4 child')

const savedEnv = {}
for (const key of ['P4CONFIG', 'P4OPTIONS', 'MY_API_KEY', 'DSH_TOKEN', 'P4PASSWD', 'P4TICKETS', 'P4TRUST', 'P4IGNORE']) {
  savedEnv[key] = process.env[key]
}
process.env.P4CONFIG = 'C:\\ambient-dir\\.p4config'
process.env.P4OPTIONS = '-z'
process.env.MY_API_KEY = 'ambient-secret'
process.env.DSH_TOKEN = 'ambient-token'
process.env.P4PASSWD = 'ambient-password'
process.env.P4TICKETS = 'C:\\ambient-tickets.txt'
process.env.P4TRUST = 'C:\\ambient-trust.txt'
process.env.P4IGNORE = 'C:\\ambient-ignore.txt'

const envSink = []
let envState = null
try {
  const envRoutes = createRoutes(
    routeCtx,
    {
      allowedPaths: [ROOT, SUBDIR],
      p4Path: FAKE_P4_SHIM,
      gitPath: 'definitely-not-git',
      vcs: 'p4',
      diagnostics: false,
      p4TimeoutMs: 4000,
      p4ScanTimeoutMs: 12_345,
      p4LocalEdits: true,
    },
    { execFile: captureExecFile(envSink) },
  )
  envState = await (
    await envRoutes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(SUBDIR)}&vcs=p4&localEdits=1`))
  ).json()
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const p4Envs = envSink.filter((entry) => entry.file === FAKE_P4_SHIM).map((entry) => entry.env)
check('the route really spawned p4', [envState?.ok, p4Envs.length > 0], [true, true])
check('an unrelated credential-shaped variable never reaches p4', p4Envs.every((env) => env.MY_API_KEY === undefined && env.DSH_TOKEN === undefined), true)
// P4OPTIONS is deliberately not carried; the route clears it explicitly, so the
// child sees an empty value (never an ambient client/diff option).
check('no non-empty P4OPTIONS reaches the p4 child', p4Envs.every((env) => !env.P4OPTIONS), true)
check('the route clears P4OPTIONS explicitly', p4Envs.every((env) => env.P4OPTIONS === ''), true)
check('an ambient P4OPTIONS is dropped by p4Environment itself', p4.p4Environment({ P4OPTIONS: '-z', P4DIFF: 'meld' }).P4OPTIONS, undefined)
check('P4CONFIG is emptied when nothing ambient is set', p4.p4Environment({ PATH: 'x' }).P4CONFIG, '')
check('a null P4CONFIG override now clears an ambient P4CONFIG', p4.p4Environment({ P4CONFIG: 'C:\\ambient\\.p4config' }, { P4CONFIG: null }).P4CONFIG, '')
check('an empty-string P4CONFIG override clears it too', p4.p4Environment({ P4CONFIG: 'ambient' }, { P4CONFIG: '' }).P4CONFIG, '')
check('an undefined P4CONFIG override leaves the ambient value alone', p4.p4Environment({ P4CONFIG: 'ambient' }, { P4CONFIG: undefined }).P4CONFIG, 'ambient')
check('no spawned p4 child keeps the ambient P4CONFIG', p4Envs.filter((env) => env.P4CONFIG !== '').length, 0)
resolved(
  'an ambient P4CONFIG no longer leaks into the p4 child environment',
  '"a null P4CONFIG override now clears an ambient P4CONFIG", "an empty-string P4CONFIG override clears it too", "an undefined P4CONFIG override leaves the ambient value alone" and "no spawned p4 child keeps the ambient P4CONFIG"',
  'p4Environment now treats null/\'\' as "clear it" and undefined as "not mentioned", so the route\'s { P4CONFIG: null, P4OPTIONS: null } actually empties both.',
)

// Pin exactly which Perforce settings ENV_P4 carries, per the corrected README.
const envProbe = p4.p4Environment({
  PATH: 'x',
  P4PORT: 'p:1666',
  P4USER: 'u',
  P4CLIENT: 'c',
  P4CHARSET: 'utf8',
  P4CONFIG: 'cfg',
  P4TRUST: 'trust',
  P4PASSWD: 'pw',
  P4TICKETS: 'tix',
  P4IGNORE: 'ign',
  P4OPTIONS: '-z',
  P4DIFF: 'meld',
  P4MERGE: 'x',
  MY_API_KEY: 'k',
  DSH_TOKEN: 't',
  AWS_SECRET_ACCESS_KEY: 'a',
})
check('the exact Perforce settings ENV_P4 carries', Object.keys(envProbe).filter((key) => key.startsWith('P4')).sort(), [
  'P4CHARSET',
  'P4CLIENT',
  'P4CONFIG',
  'P4IGNORE',
  'P4PASSWD',
  'P4PORT',
  'P4TICKETS',
  'P4TRUST',
  'P4USER',
])
check('P4OPTIONS / P4DIFF / P4MERGE are deliberately not carried', [envProbe.P4OPTIONS, envProbe.P4DIFF, envProbe.P4MERGE], [
  undefined,
  undefined,
  undefined,
])
check('unrelated credential-shaped variables stay dropped', [envProbe.MY_API_KEY, envProbe.DSH_TOKEN, envProbe.AWS_SECRET_ACCESS_KEY], [
  undefined,
  undefined,
  undefined,
])
resolved(
  'the README env claim is now pinned to the real ENV_P4 list',
  'the exact-key list, "P4OPTIONS / P4DIFF / P4MERGE are deliberately not carried" and the credential-drop check',
  'ENV_P4 carries P4PORT/P4USER/P4CLIENT/P4CHARSET/P4CONFIG/P4TRUST/P4PASSWD/P4TICKETS/P4IGNORE; P4OPTIONS is not carried and the route clears it; unrelated credential-shaped variables are dropped.',
)

const statusSpawn = envSink.find((entry) => entry.args.includes('status'))
check('the local scan is bounded by p4ScanTimeoutMs', statusSpawn?.timeout, 12_345)
check('the scan spec is the session subdirectory', statusSpawn?.args.filter((token) => token.includes('...')), ['Content/Example/style/...'])
const openedSpawn = envSink.find((entry) => entry.args.includes('opened'))
const fstatSpawn = envSink.find((entry) => entry.args.includes('fstat'))
const infoSpawns = envSink.filter((entry) => entry.args.includes('info'))
const p4Spawns = envSink.filter((entry) => entry.file === FAKE_P4_SHIM)
// index.js:415-423 forwards timeoutMs into p4Limits(), and index.js:432 builds
// the cross-request detection probe with probeTimeoutMs, so the configured
// deadline reaches every p4 command; the scan keeps its own longer deadline.
check('a configured p4TimeoutMs reaches an ordinary command', openedSpawn?.timeout, 4000)
check('a configured p4TimeoutMs reaches fstat as well', fstatSpawn?.timeout, 4000)
check('a configured p4TimeoutMs reaches the cross-request detection probe', infoSpawns[0]?.timeout, 4000)
check('p4ScanTimeoutMs still wins for the local scan', statusSpawn?.timeout === 12_345 && statusSpawn?.timeout !== 4000, true)
check(
  'no p4 spawn falls back to the frozen default while a timeout is configured',
  p4Spawns.filter((entry) => entry.timeout === 20_000),
  [],
)
checkThat(
  'the single detection probe takes the configured timeout',
  infoSpawns.length === 1 && infoSpawns.every((entry) => entry.timeout === 4000),
  shown(infoSpawns.map((entry) => [entry.args.slice(0, 2).join(' '), entry.timeout])),
)
// Printed unconditionally so any future regression to the frozen default is
// visible in the log, not only in a failing assertion.
note('captured p4 spawn timeouts (configured p4TimeoutMs=4000, p4ScanTimeoutMs=12345)', shown(p4Spawns.map((entry) => [entry.args.slice(0, 2).join(' '), entry.timeout])))
resolved(
  'the documented p4TimeoutMs setting is no longer dead, including the detection probe',
  '"a configured p4TimeoutMs reaches an ordinary command", "…reaches fstat as well", "…reaches the cross-request detection probe", "p4ScanTimeoutMs still wins for the local scan" and "no p4 spawn falls back to the frozen default while a timeout is configured"',
  'p4Limits() carries settings.p4TimeoutMs into limits, which readWorkspace merges into limits and passes as callOptions.timeoutMs, and the detection probe receives probeTimeoutMs: settings.p4TimeoutMs; captured timeouts are 4000 for `-ztag info`/`-ztag opened`/`-ztag fstat`/`-ztag changes`/`-ztag describe` and 12345 for `-ztag status`.',
)
note('index.js scanRun seam', 'index.js:587 passes `scanRun` to readP4Workspace, but lib/p4.js never reads it (dead parameter). Behaviour is still bounded because the scan passes callOptions.timeoutMs = p4ScanTimeoutMs, which this check confirms.')

// ---------------------------------------------------- 11. live server probe

console.log('11. live server (read-only) — same regression on real bytes')

const REAL = {
  p4: 'C:\\Program Files\\Perforce\\p4.exe',
  port: '192.0.2.10:1666',
  user: 'p4user',
  client: 'example_client',
  root: 'E:\\Projects\\Example',
  dir: 'E:\\Projects\\Example\\Config\\Raw\\ai\\style\\BTstyle',
}
if (!fs.existsSync(REAL.p4)) skip('live server', `p4 not installed at ${REAL.p4}`)
else if (!fs.existsSync(REAL.dir)) skip('live server', `client subdirectory missing: ${REAL.dir}`)
else {
  const realEnv = p4.p4Environment({ ...process.env, P4CONFIG: undefined }, {
    P4PORT: REAL.port,
    P4USER: REAL.user,
    P4CLIENT: REAL.client,
    P4CHARSET: 'utf8',
  })
  const realRun = p4.createProcessRunner({ p4Path: REAL.p4, timeoutMs: 20_000, env: realEnv, execFileFn: fileRedirectExecFile })
  let realProbe = null
  try {
    realProbe = await p4.createWorkspaceProbe({ run: realRun })(REAL.dir)
  } catch (error) {
    realProbe = { ok: false, reason: 'p4-unavailable', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!realProbe.ok) skip('live server', `${realProbe.reason}: ${realProbe.detail}`)
  else {
    check('live probe names the configured client and root', [realProbe.client, realProbe.root], [REAL.client, REAL.root])
    const started = Date.now()
    const liveOpened = await realRun(['-ztag', 'opened', `//${REAL.client}/...`], REAL.dir)
    const liveMs = Date.now() - started
    const liveRaw = toText(liveOpened.stdout)
    const liveEntries = p4.parseOpened(liveRaw)
    check('live `opened` exits cleanly', liveOpened.status, 0)
    checkThat(
      'live: the real answer terminates records with a blank line (the regression trigger)',
      /\.\.\. [^\r\n]+\r?\n\r?\n/.test(liveRaw),
      shown(liveRaw.slice(0, 200)),
    )
    checkThat(
      'live: every parsed opened type is whitespace-free',
      liveEntries.every((entry) => entry.type === null || (entry.type === entry.type.trim() && !/\s/.test(entry.type))),
      shown(liveEntries.map((entry) => entry.type)),
    )
    checkThat(
      'live: every parsed opened record keeps a client-relative path',
      liveEntries.every((entry) => typeof entry.path === 'string' && !entry.path.startsWith('/') && !entry.path.includes('..')),
      shown(liveEntries.map((entry) => entry.path)),
    )
    note('live `p4 -ztag opened //client/...`', `${liveMs} ms for ${liveEntries.length} record(s) (README claims 1 file / 0.1 s)`)

    const liveState = await p4.readWorkspace({ run: realRun, dir: REAL.dir, limits: { ...p4.P4_DEFAULT_LIMITS } })
    check('live readWorkspace answers ok', [liveState.ok, liveState.vcs], [true, 'p4'])
    const openedEdits = liveState.files.filter((file) => file.origin === 'opened' && file.action === 'edit')
    // Compare like with like: `readWorkspace` may also carry `add`/`delete`
    // actions, so the recorder's full opened list is not the right counterpart.
    // The workspace's contents change over time, so the claim is "every edited
    // file the server reports appears as an edit here", not a fixed count.
    const norm = (value) => String(value ?? '').trim().toLowerCase()
    // Group by action rather than by file: this workspace is a live game
    // checkout whose contents change between runs, but the claim that matters —
    // every opened file the server reports survives the round trip with the same
    // depot path and the same action — holds regardless of which files exist.
    const byAction = (list, key) => {
      const counts = new Map()
      for (const entry of list) {
        const action = key(entry) ?? '(none)'
        counts.set(action, (counts.get(action) ?? 0) + 1)
      }
      return [...counts.entries()].sort().map(([action, count]) => `${action}=${count}`)
    }
    const openedList = liveState.files.filter((file) => file.origin === 'opened')
    checkThat(
      'live: the opened set survives the round trip (same size, same actions)',
      liveEntries.length > 0 && byAction(liveEntries, (entry) => entry.action).join() === byAction(openedList, (file) => file.action).join(),
      `${shown(byAction(liveEntries, (entry) => entry.action))} vs ${shown(byAction(openedList, (file) => file.action))}`,
    )
    checkThat(
      'live: every opened depot path comes back unchanged',
      liveEntries.every((entry) => openedList.some((file) => norm(file.depotPath) === norm(entry.depotFile))),
      `shown=${shown(openedList.map((file) => file.depotPath))} reported=${shown(liveEntries.map((entry) => entry.depotFile))}`,
    )
    const liveMeta = p4.parseFileMeta(
      toText(
        (
          await realRun(
            [
              '-ztag',
              'fstat',
              '-m',
              '10',
              '-T',
              'depotFile,headType,type',
              ...openedEdits.map((file) => file.depotPath),
            ],
            REAL.dir,
          )
        ).stdout,
      ),
    )
    const oracle = openedEdits.map((file) => {
      const meta = liveMeta.get(file.depotPath)
      return meta && meta.headType && file.p4Type && file.p4Type !== meta.headType ? 'T' : 'M'
    })
    check('live: status matches an independent headType oracle (M, not T)', openedEdits.map((file) => file.status), oracle)
    note('live statuses', shown(openedEdits.map((file) => [file.path, file.p4Type, liveMeta.get(file.depotPath)?.headType, file.status])))
  }
}

// ------------------------------------------------------------------ summary

console.log('')
for (const entry of notes) console.log(`note: ${entry.label} — ${entry.value}`)
console.log(`\n${resolvedItems.length} previously reported issue(s) now resolved:`)
for (const entry of resolvedItems) console.log(`  - ${entry.label} [${entry.checks}]`)
if (findings.length > 0) {
  console.log(`\n${findings.length} open counterexample(s):`)
  for (const entry of findings) console.log(`  - ${entry.label}`)
} else {
  console.log('\nNo open counterexamples.')
}
if (skips.length > 0) for (const label of skips) console.log(`  skip: ${label}`)
if (failures > 0) {
  console.log(`\nverify-p4.mjs FAILED its own expectations: ${failures}`)
} else {
  console.log('')
}
console.log(`${checks - failures}/${checks} checks passed, ${resolvedItems.length} resolved, ${findings.length} open counterexample(s), ${skips.length} skipped`)
process.exit(failures === 0 ? 0 : 1)