/**
 * `lib/p4.js` verification against the deterministic fake p4.
 *
 * Everything runs through the injected runner seams, so no server and no game
 * workspace are touched. The fake p4 answers from
 * `.changelist-test/p4-fake/` and records every invocation, which is how the
 * never-enumerate-the-workspace rule is asserted.
 *
 *   node dsh-changelist/p4-test.mjs      (from the workspace root)
 *   node p4-test.mjs                     (from the plugin directory)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  FAKE_P4_OUTSIDE,
  FAKE_P4_ROOT,
  FAKE_P4_SCRIPT,
  FAKE_P4_SHIM,
  P4_MODES,
  buildP4Fixture,
  createFakeP4ExecFile,
  fakeP4Env,
  readP4Calls,
  resetP4Calls,
} from './p4-fixture.mjs'
import * as p4 from './lib/p4.js'

// ---------------------------------------------------------------- harness
let checks = 0
const failures = []
const skipped = []

function describeValue(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function check(label, thunk, expected) {
  checks += 1
  let actual
  try {
    actual = typeof thunk === 'function' ? thunk() : thunk
    assert.deepEqual(actual, expected)
    console.log(`  ok   ${label}`)
  } catch {
    failures.push(label)
    console.log(`  FAIL ${label}\n       expected ${describeValue(expected)}\n       actual   ${describeValue(actual)}`)
  }
}

function skip(label, why) {
  skipped.push(label)
  console.log(`  skip ${label} — ${why}`)
}

// ---------------------------------------------------------------- fixture
buildP4Fixture()
const firstBuild = fs.readFileSync(FAKE_P4_SCRIPT, 'utf8')
buildP4Fixture()
const secondBuild = fs.readFileSync(FAKE_P4_SCRIPT, 'utf8')
resetP4Calls()

const ROOT = FAKE_P4_ROOT
const CLIENT = 'fake_client'
const USER = 'p4user'
const STREAM = '//ProjW-Client/Main'
const SUBDIR = path.join(ROOT, 'Config', 'Raw', 'ai', 'style', 'BTstyle')
const DOCS = path.join(ROOT, 'Config', 'Raw', 'ai', 'docs')
const EDIT = 'Content/Example/style/Asset_Example_Style.json'
const DEMO = 'Content/Example/style/Asset_Demo_Blackboard_Style.json'
const ADD = 'Content/Example/New/A.bin'
const GONE = 'Content/Example/Gone.txt'
const ED2 = 'Content/Example/Edited2.txt'
const NOTES = 'Content/Example/docs/notes.md'
const LARGE = 'Content/Example/docs/large.txt'
const CTX = { root: ROOT, client: CLIENT, stream: STREAM }
const depot = (rel) => `${STREAM}/${rel}`
const text = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
const readFile = async (filePath, maxBytes) => {
  const buffer = fs.readFileSync(filePath)
  return typeof maxBytes === 'number' && maxBytes > 0 ? buffer.subarray(0, maxBytes) : buffer
}

const run = p4.createProcessRunner({
  p4Path: FAKE_P4_SHIM,
  timeoutMs: 20_000,
  env: fakeP4Env(),
  execFileFn: createFakeP4ExecFile(),
})
const runFor = (mode) =>
  p4.createProcessRunner({
    p4Path: FAKE_P4_SHIM,
    timeoutMs: 20_000,
    env: fakeP4Env(mode),
    execFileFn: createFakeP4ExecFile({ mode }),
  })
const call = async (args, cwd = ROOT) => await run(args, cwd)
const raw = async (args, cwd = ROOT) => text((await call(args, cwd)).stdout)

const WRITE_COMMANDS = new Set([
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
])

// ---------------------------------------------------------------- 1. breeze
console.log('1. fixture hygiene')
check('the generated fake p4 is byte-identical after a rebuild', firstBuild === secondBuild, true)
check('the shim exists where tests point p4Path', fs.existsSync(FAKE_P4_SHIM), true)

// ---------------------------------------------------------------- 2. environment
console.log('2. p4Environment / findP4Executable')
check(
  'p4Environment keeps Perforce settings and drops secrets',
  () => {
    const env = p4.p4Environment({
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      P4PORT: 'p:1666',
      P4USER: USER,
      P4CLIENT: CLIENT,
      P4CHARSET: 'utf8',
      MY_API_KEY: 'secret',
      DSH_HOME: '/y',
    })
    return {
      PATH: env.PATH,
      SystemRoot: env.SystemRoot,
      P4PORT: env.P4PORT,
      P4USER: env.P4USER,
      P4CLIENT: env.P4CLIENT,
      P4CHARSET: env.P4CHARSET,
      P4CONFIG: env.P4CONFIG,
      api: env.MY_API_KEY,
      home: env.DSH_HOME,
    }
  },
  {
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    P4PORT: 'p:1666',
    P4USER: USER,
    P4CLIENT: CLIENT,
    P4CHARSET: 'utf8',
    P4CONFIG: '',
    api: undefined,
    home: undefined,
  },
)
check(
  'p4Environment turns panel overrides into P4 variables',
  () =>
    p4.p4Environment({}, { port: 'h:1666', user: 'me', client: 'cl', charset: 'utf8', P4CONFIG: null }),
  { P4PORT: 'h:1666', P4USER: 'me', P4CLIENT: 'cl', P4CHARSET: 'utf8', P4CONFIG: '' },
)
check('findP4Executable takes an explicit existing path', p4.findP4Executable({ explicit: FAKE_P4_SHIM }), FAKE_P4_SHIM)
check('findP4Executable rejects an explicit missing path', p4.findP4Executable({ explicit: 'C:\\nope\\p4.exe' }), null)
check('findP4Executable takes P4EXECUTABLE', p4.findP4Executable({ env: { P4EXECUTABLE: FAKE_P4_SHIM } }), FAKE_P4_SHIM)
check(
  'findP4Executable falls back to the bare name for PATH lookup',
  p4.findP4Executable({ explicit: 'p4', env: {}, existsSyncFn: () => false }),
  'p4',
)
check(
  'findP4Executable returns null when nothing exists',
  p4.findP4Executable({ env: {}, existsSyncFn: () => false }),
  null,
)

// ---------------------------------------------------------------- 3. runner + probe
console.log('3. createProcessRunner / createWorkspaceProbe')
const okRunner = run
const openedResult = await call(['-ztag', 'opened', `//${CLIENT}/...`])
check('the runner keeps stdout as a Buffer', Buffer.isBuffer(openedResult.stdout), true)
check('the runner reports a clean exit', [openedResult.status, openedResult.stderr], [0, ''])
const timedOut = await run(['-ztag', 'info'], ROOT, { timeoutMs: 1 })
check('a deadline is surfaced as timedOut, not a crash', [timedOut.status, timedOut.timedOut], [-1, true])
const missingRunner = p4.createProcessRunner({ p4Path: 'p4-fixture-not-installed', execFileFn: createFakeP4ExecFile() })
const missing = await missingRunner(['-ztag', 'info'], ROOT)
check('a missing executable yields a non-zero status', missing.status !== 0, true)

const probe = p4.createWorkspaceProbe({ run: okRunner, probeTimeoutMs: 5_000 })
const probed = await probe(SUBDIR)
check(
  'probe names the client, root, stream and user',
  [probed.ok, probed.client, probed.root, probed.stream, probed.user],
  [true, CLIENT, ROOT, STREAM, USER],
)
const probeOutside = await probe(FAKE_P4_OUTSIDE)
check('probe refuses a directory outside the client root', [probeOutside.ok, probeOutside.reason], [false, 'not-a-workspace'])
const probeUnreachable = await p4.createWorkspaceProbe({ run: runFor(P4_MODES.unreachable) })(SUBDIR)
check(
  'an unreachable server is p4-unavailable',
  [probeUnreachable.ok, probeUnreachable.reason, probeUnreachable.detail.includes('Perforce client error')],
  [false, 'p4-unavailable', true],
)
const probeNoClient = await p4.createWorkspaceProbe({ run: runFor(P4_MODES.noclient) })(SUBDIR)
check(
  'an unknown client is p4-error',
  [probeNoClient.ok, probeNoClient.reason, probeNoClient.detail.includes('unknown')],
  [false, 'p4-error', true],
)
const probeNotWorkspace = await p4.createWorkspaceProbe({ run: runFor(P4_MODES.notworkspace) })(SUBDIR)
check(
  'a client root that does not cover the directory is not-a-workspace',
  [probeNotWorkspace.ok, probeNotWorkspace.reason],
  [false, 'not-a-workspace'],
)
const probeWithoutRunner = await p4.createWorkspaceProbe({})(SUBDIR)
check(
  'a probe without a runner degrades to p4-unavailable',
  [probeWithoutRunner.ok, probeWithoutRunner.reason, probeWithoutRunner.detail],
  [false, 'p4-unavailable', 'no p4 runner'],
)

// ---------------------------------------------------------------- 4. parsers
console.log('4. parseOpened')
const openedRaw = await raw(['-ztag', 'opened', `//${CLIENT}/...`])
const opened = p4.parseOpened(openedRaw)
const openedByPath = new Map(opened.map((entry) => [entry.path, entry]))
check('opened returns every recorded file', opened.length, 4)
check(
  'an edit in the default changelist',
  [openedByPath.get(EDIT).action, openedByPath.get(EDIT).change, openedByPath.get(EDIT).type, openedByPath.get(EDIT).haveRev],
  ['edit', 'default', 'text+w', 2],
)
check(
  'an add in numbered changelist 1234 stays binary',
  [openedByPath.get(ADD).action, openedByPath.get(ADD).change, openedByPath.get(ADD).type],
  ['add', 1234, 'binary'],
)
check('an add carries no haveRev tag at all', /^\.\.\. haveRev /m.test(openedRaw.split('\n\n').find((block) => block.includes(ADD))), false)
check(
  'a delete keeps its action and revision',
  [openedByPath.get(GONE).action, openedByPath.get(GONE).change, openedByPath.get(GONE).haveRev],
  ['delete', 'default', 3],
)
check('a second numbered changelist is preserved', openedByPath.get(ED2).change, 1235)

console.log('5. parseStatus')
const statusRaw = await raw(['-ztag', 'status', SUBDIR])
const statusEntries = p4.parseStatus(statusRaw, { root: ROOT, client: CLIENT })
const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]))
check('the tagged scan reports the subdirectory only', [...statusByPath.keys()].sort(), [DEMO, EDIT].sort())
check(
  'an opened file found by the scan stays origin=opened',
  [statusByPath.get(EDIT).origin, statusByPath.get(EDIT).change, statusByPath.get(EDIT).action],
  ['opened', 'default', 'edit'],
)
check(
  'a local-only add is origin=local with no changelist',
  [statusByPath.get(DEMO).origin, statusByPath.get(DEMO).change, statusByPath.get(DEMO).action],
  ['local', null, 'add'],
)
const docsStatus = p4.parseStatus(await raw(['-ztag', 'status', DOCS]), { root: ROOT, client: CLIENT })
check(
  'the subdir argument is honoured (docs scan excludes BTstyle)',
  [docsStatus.map((entry) => entry.path).sort(), docsStatus.some((entry) => entry.path === EDIT)],
  [[LARGE, NOTES].sort(), false],
)
const humanStatus = p4.parseStatus(await raw(['status', SUBDIR]), { root: ROOT, client: CLIENT })
const humanByPath = new Map(humanStatus.map((entry) => [entry.path, entry]))
check(
  'the human "submit change … to edit" form parses',
  [humanByPath.get(EDIT).origin, humanByPath.get(EDIT).change, humanByPath.get(EDIT).action],
  ['opened', 'default', 'edit'],
)
check(
  'the human "reconcile to add" form parses as local',
  [humanByPath.get(DEMO).origin, humanByPath.get(DEMO).action],
  ['local', 'add'],
)
check('parseStatus survives an empty answer', p4.parseStatus('', { root: ROOT, client: CLIENT }), [])

console.log('6. parseFileMeta')
const fstatRaw = await raw(['-ztag', 'fstat', '-m', '2', '-T', 'depotFile,clientFile,haveRev,headRev,headType,type,action', depot(EDIT), depot(ADD)])
const meta = p4.parseFileMeta(fstatRaw)
check(
  'fstat is keyed by depot path and keeps revisions',
  [meta.get(depot(EDIT)).haveRev, meta.get(depot(EDIT)).headRev, meta.get(depot(EDIT)).headType],
  [2, 2, 'text+w'],
)
check(
  'fstat reports a binary type and no revisions for a never-submitted add',
  [meta.get(depot(ADD)).headType, meta.get(depot(ADD)).haveRev, meta.get(depot(ADD)).headRev],
  ['binary', null, null],
)

console.log('7. parseChangelistSpec')
const shelvedSpec = p4.parseChangelistSpec(await raw(['-ztag', 'changes', '-s', 'shelved', '-l', '-m', '11', `${STREAM}/...`]))
check(
  'changes -s shelved yields the shelved change',
  [shelvedSpec.length, shelvedSpec[0].change, shelvedSpec[0].number, shelvedSpec[0].status, shelvedSpec[0].shelved, shelvedSpec[0].description],
  [1, 1234, 1234, 'shelved', true, 'numbered change'],
)
const pendingSpec = p4.parseChangelistSpec(await raw(['-ztag', 'changes', '-u', USER, '-s', 'pending', '-l', '-m', '11']))
check(
  'changes -s pending lists both numbered changelists',
  pendingSpec.map((entry) => [entry.number, entry.status, entry.shelved]),
  [
    [1234, 'shelved', true],
    [1235, 'pending', false],
  ],
)
const defaultSpec = p4.parseChangelistSpec(await raw(['-ztag', 'change', '-o']))
check(
  'change -o describes the default changelist',
  [defaultSpec.length, defaultSpec[0].change, defaultSpec[0].number, defaultSpec[0].isDefault, defaultSpec[0].status, defaultSpec[0].description],
  [1, 'default', 'default', true, 'pending', ''],
)
const numberedSpec = p4.parseChangelistSpec(await raw(['-ztag', 'change', '-o', '1234']))
check(
  'change -o 1234 carries its own description and shelf',
  [numberedSpec[0].number, numberedSpec[0].shelved, numberedSpec[0].description],
  [1234, true, 'numbered change'],
)
const described = p4.parseChangelistSpec(await raw(['-ztag', 'describe', '-S', '-s', '1234']))
check('describe counts the indexed file list', [described.length, described[0].number, described[0].files], [1, 1234, 1])

console.log('8. toClientPath')
const whereRaw = await raw(['-ztag', 'where', `//${CLIENT}/...`])
check('a client-syntax path becomes client-relative', p4.toClientPath(`//${CLIENT}/${ADD}`, CTX), ADD)
check('a local path under the root becomes client-relative', p4.toClientPath(path.join(ROOT, ...ADD.split('/')), CTX), ADD)
check('an already client-relative path is kept', p4.toClientPath(ADD, CTX), ADD)
check('a where-mapped depot path becomes client-relative', p4.toClientPath(depot(ADD), { ...CTX, where: whereRaw }), ADD)
check('a ".." relative path is rejected', p4.toClientPath('../escape/Foo.txt', CTX), null)
check('a depot path that traverses upward is rejected', p4.toClientPath(`${STREAM}/../../escape.txt`, CTX), null)
check('a local path that traverses upward is rejected', p4.toClientPath(`${ROOT.replace(/\\/g, '/')}/Config/../../escape.txt`, CTX), null)
check('a path outside the root is rejected', p4.toClientPath('C:\\Elsewhere\\x.txt', CTX), null)

// ---------------------------------------------------------------- 9. readWorkspace
console.log('9. readWorkspace')
const basic = await p4.readWorkspace({ run: okRunner, dir: SUBDIR })
check('a good workspace answers ok', [basic.ok, basic.vcs, basic.dir], [true, 'p4', SUBDIR])
check('all four opened files are reported', [basic.total, basic.files.length, basic.truncated], [4, 4, false])
check('paths are client-relative and sorted', basic.files.map((file) => file.path), [ADD, ED2, GONE, EDIT].sort())
const defaultGroup = basic.changelists.find((entry) => entry.isDefault)
const numberedGroups = basic.changelists.filter((entry) => !entry.isDefault)
check(
  'files are grouped by changelist',
  [defaultGroup.number, defaultGroup.files, numberedGroups.map((entry) => entry.number).sort((a, b) => a - b)],
  ['default', 2, [1234, 1235]],
)
const groupNumbers = basic.changelists.map((entry) => String(entry.number))
check('each changelist is grouped exactly once', new Set(groupNumbers).size, groupNumbers.length)
check(
  'the workspace descriptor is reported',
  [basic.workspace.client, basic.workspace.root, basic.workspace.stream, basic.workspace.user],
  [CLIENT, ROOT, STREAM, USER],
)
check('branch and base name the stream', [basic.branch, basic.base, basic.baseKind], [STREAM, STREAM, 'stream'])
check('revisions carry both ends', [typeof basic.revisions.have, typeof basic.revisions.head], ['number', 'number'])

const shelvedState = await p4.readWorkspace({ run: okRunner, dir: SUBDIR, localEdits: true, shelved: true, readFile })
const shelvedAdd = shelvedState.files.find((file) => file.path === ADD)
const localAdd = shelvedState.files.find((file) => file.path === DEMO)
check('opened + local + shelved all land in one answer', shelvedState.total, 5)
check(
  'a file opened in a shelved changelist is flagged',
  [shelvedAdd.shelved, shelvedAdd.shelved === true, shelvedAdd.change],
  [true, true, 1234],
)
check(
  'a not-opened local add is origin=local and counted',
  [localAdd.origin, localAdd.untracked, localAdd.added, localAdd.binary],
  ['local', true, 3, false],
)
check(
  'the shelved changelist is listed once with its flag',
  shelvedState.changelists.filter((entry) => entry.number === 1234).map((entry) => pear(entry)),
  [[1234, 'shelved', true, 1]],
)
check(
  'readWorkspace notes nothing unexpected',
  shelvedState.notes,
  [],
)

function pear(entry) {
  return [entry.number, entry.status, entry.shelved, entry.files]
}

resetP4Calls()
const truncated = await p4.readWorkspace({ run: okRunner, dir: SUBDIR, limits: { maxFiles: 2 } })
check('maxFiles truncates the file list', [truncated.files.length, truncated.total, truncated.truncated], [2, 4, true])
check('truncation is explained in a note', truncated.notes.some((note) => note.includes('2')), true)

const calls = readP4Calls()
const fstatCalls = calls.filter((line) => /(?:^|\s)-ztag fstat(?:\s|$)/.test(line))
const wideFstatCalls = fstatCalls.filter((line) => /(?:^|\s)\/\/[^\s]*\.\.\.(?:\s|$)/.test(line) || /(?:^|\s)\.\.\.(?:\s|$)/.test(line))
check('fstat is a single capped optimisation', fstatCalls.length, 1)
check('no fstat ever enumerates //client/...', wideFstatCalls, [])
check(
  'fstat only ever names explicit depot files',
  fstatCalls.every((line) => line.split(/\s+/).filter((token) => token.startsWith('//')).every((token) => !token.endsWith('/...'))),
  true,
)
check(
  'no writing command is ever issued',
  calls
    .map((line) => {
      const tokens = line.split(/\s+/)
      return tokens[0] === '-ztag' ? tokens[1] : tokens[0]
    })
    .filter((command) => WRITE_COMMANDS.has(command)),
  [],
)

console.log('10. readWorkspace degradations')
const unreachableState = await p4.readWorkspace({ run: runFor(P4_MODES.unreachable), dir: SUBDIR })
check(
  'an unreachable server degrades to p4-unavailable',
  [unreachableState.ok, unreachableState.reason, typeof unreachableState.message],
  [false, 'p4-unavailable', 'string'],
)
const noClientState = await p4.readWorkspace({ run: runFor(P4_MODES.noclient), dir: SUBDIR })
check('an unknown client degrades to p4-error', [noClientState.ok, noClientState.reason], [false, 'p4-error'])
const notWorkspaceState = await p4.readWorkspace({ run: runFor(P4_MODES.notworkspace), dir: SUBDIR })
check(
  'a directory outside the client root degrades to not-a-workspace',
  [notWorkspaceState.ok, notWorkspaceState.reason],
  [false, 'not-a-workspace'],
)
const noRunnerState = await p4.readWorkspace({ dir: SUBDIR })
check(
  'readWorkspace without a runner degrades to p4-unavailable',
  [noRunnerState.ok, noRunnerState.reason, noRunnerState.detail],
  [false, 'p4-unavailable', 'no p4 runner'],
)
const noDirState = await p4.readWorkspace({ run: okRunner })
check('readWorkspace without a directory degrades to p4-error', [noDirState.ok, noDirState.reason], [false, 'p4-error'])

const slowScanRun = async (args, cwd, callOptions) =>
  args.includes('status')
    ? { status: -1, stdout: Buffer.alloc(0), stderr: '', timedOut: true }
    : await okRunner(args, cwd, callOptions)
const scanTimedOut = await p4.readWorkspace({ run: slowScanRun, dir: SUBDIR, localEdits: true })
check(
  'a scan timeout keeps the answer and says so',
  [scanTimedOut.ok, scanTimedOut.notes.some((note) => note.includes('超时'))],
  [true, true],
)

// ---------------------------------------------------------------- 11. readDiff
console.log('11. readDiff')
const unified = await p4.readDiff({
  run: okRunner,
  dir: SUBDIR,
  path: EDIT,
  clientRoot: CTX,
  p4Type: 'text+w',
})
check(
  'an opened text file yields the unified diff',
  [unified.ok, unified.binary, unified.text.includes('@@ -1,2 +1,3 @@'), unified.text.includes('"a": 2'), unified.truncated],
  [true, false, true, true, false],
)
const headerOnly = await p4.readDiff({ run: okRunner, dir: SUBDIR, path: GONE, clientRoot: CTX, p4Type: 'text' })
check(
  'a header-only answer is a change-free comparison, not an error',
  [headerOnly.ok, headerOnly.text.includes('--- '), headerOnly.text.includes('@@')],
  [true, true, false],
)
const binaryByType = await p4.readDiff({ run: okRunner, dir: SUBDIR, path: ADD, clientRoot: CTX, p4Type: 'binary' })
check('a binary p4 type is reported without text', [binaryByType.ok, binaryByType.binary, binaryByType.text], [true, true, ''])
const binaryByStderr = await p4.readDiff({ run: okRunner, dir: SUBDIR, path: ADD, clientRoot: CTX })
check(
  'p4 saying "file(s) not text" is read as binary',
  [binaryByStderr.ok, binaryByStderr.binary, binaryByStderr.text],
  [true, true, ''],
)
const clipped = await p4.readDiff({
  run: okRunner,
  dir: SUBDIR,
  path: LARGE,
  clientRoot: CTX,
  p4Type: 'text',
  limits: { maxDiffBytes: 300 },
})
check(
  'maxDiffBytes truncates on a line boundary',
  [clipped.ok, clipped.truncated, clipped.text.length <= 320, clipped.text.endsWith('\n'), clipped.text.includes('@@')],
  [true, true, true, true, true],
)
const noChange = await p4.readDiff({ run: okRunner, dir: SUBDIR, path: 'Content/Example/DoesNotExist.txt', clientRoot: CTX, p4Type: 'text' })
check('an empty comparison is ok with no text', [noChange.ok, noChange.text, noChange.binary], [true, '', false])
const noRunnerDiff = await p4.readDiff({ path: EDIT })
check('readDiff without a runner fails with a message', [noRunnerDiff.ok, noRunnerDiff.message], [false, '没有可用的 p4 执行器'])

console.log('12. readP4VConfig (the connection P4V already knows)')
// The Host runs p4 with a scrubbed environment, so an installation whose
// P4PORT/P4USER live in P4V (or in the Windows registry, where `p4 set` puts
// them) would otherwise answer "no server configured" and the directory would be
// reported as a plain git-less folder. These are the exact file shapes P4V
// writes on this machine.
const p4vHome = 'X:/p4v-home'
const fakeP4V = (files) =>
  p4.readP4VConfig({
    home: p4vHome,
    readFileSyncFn: (file) => {
      for (const [name, body] of Object.entries(files)) if (file.endsWith(name)) return body
      throw new Error('ENOENT')
    },
  })
const CONNECTIONMAP =
  '<ConnectionMapList>\n <ConnectionMap>\n  <Name>0001</Name>\n  <User>p4user</User>\n' +
  '  <ServerAddress>192.0.2.10:1666</ServerAddress>\n  <P4Port>host.example.com:1666</P4Port>\n </ConnectionMap>\n</ConnectionMapList>'
const APPSETTINGS =
  '<PropertyList>\n <String varName="DefaultCharset">utf8-bom</String>\n' +
  ' <StringList varName="OpenWorkspaces">\n  <String>host.example.com:1666, p4user, ws_5116</String>\n </StringList>\n</PropertyList>'

check('both P4V files together yield port, user, client and charset', fakeP4V({ 'connectionmap.xml': CONNECTIONMAP, 'ApplicationSettings.xml': APPSETTINGS }), {
  port: 'host.example.com:1666',
  user: 'p4user',
  client: 'ws_5116',
  charset: 'utf8-bom',
  clientRoot: null,
  sources: ['connectionmap.xml', 'ApplicationSettings.xml'],
})
// The hostname (what the UI shows) wins over the IP P4V stores beside it.
check('the UI hostname is preferred over the stored IP', fakeP4V({ 'connectionmap.xml': CONNECTIONMAP }).port, 'host.example.com:1666')
check('a connection map alone still gives a usable port', fakeP4V({ 'connectionmap.xml': CONNECTIONMAP }).user, 'p4user')
check('an absent P4V install is silent, not an error', fakeP4V({}), {
  port: null,
  user: null,
  client: null,
  charset: null,
  clientRoot: null,
  sources: [],
})
check('a Buffer from the reader is accepted', fakeP4V({ 'connectionmap.xml': Buffer.from('<ConnectionMap><P4Port>p4.b:1666</P4Port><User>carol</User></ConnectionMap>') }).user, 'carol')
check('a workspace name containing a comma survives', fakeP4V({
  'ApplicationSettings.xml': '<PropertyList><StringList varName="OpenWorkspaces"><String>h:1666, u, ws, with, commas</String></StringList></PropertyList>',
}).client, 'ws, with, commas')
check('no home directory yields nulls rather than throwing', p4.readP4VConfig({ home: '', env: {} }), {
  port: null,
  user: null,
  client: null,
  charset: null,
  clientRoot: null,
  sources: [],
})

// ---------------------------------------------------------------- summary
console.log(`\n${checks - failures.length}/${checks} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
if (skipped.length > 0) for (const label of skipped) console.log(`  skip: ${label}`)
if (failures.length > 0) {
  console.log(`failures: ${failures.length}`)
  for (const label of failures) console.log(`  - ${label}`)
}
process.exit(failures.length === 0 ? 0 : 1)