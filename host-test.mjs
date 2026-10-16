/**
 * Host-half verification: drives the real route handlers against the real git
 * fixture, and checks that `apply` mounts exactly the three fenced routes.
 *
 * Sandbox note: `execFile` is replaced with a file-redirecting stand-in because
 * this authoring session forbids piped child stdio. The plugin's own runner
 * (piped `execFile`) is the production path.
 *
 *   node dsh-changelist/host-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, collectTargets, createRoutes, gitEnvironment, safeRepoPath, ROUTES } from './index.js'
import { createFileReader, inspectWorkspace } from './lib/git.js'
import {
  FAKE_P4_CLIENT,
  FAKE_P4_DEPOT,
  FAKE_P4_ROOT,
  FAKE_P4_SHIM,
  FAKE_P4_USER,
  buildP4Fixture,
  createFakeP4ExecFile,
  readP4Calls,
  resetP4Calls,
} from './p4-fixture.mjs'
import { FIXTURE_ROOT, buildFixture, createFixtureRunner, fileRedirectExecFile } from './test-fixture.mjs'

const repo = buildFixture().repo
// The Perforce fixture is built next to the git one; `p4Repo` is its synthetic
// client root, so the p4 cases exercise the real process chain the plugin uses.
const p4Repo = buildP4Fixture().root
resetP4Calls()

let failures = 0
let checks = 0
function check(label, actual, expected) {
  checks++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok   ${label}`)
  else {
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

const logger = { warn: () => {}, info: () => {} }
const ctx = {
  logger,
  get: (name) =>
    name === 'workspaceRegistry'
      ? { list: () => [{ id: 'w1', path: repo, title: 'fixture', sessionIds: ['s1', 's2'] }] }
      : name === 'sessions'
        ? {
            list: () => [{ id: 's1', header: { cwd: repo } }],
            get: (id) => (id === 's1' ? { id, header: { cwd: repo } } : undefined),
          }
        : undefined,
}

console.log('1. pure helpers')
check('gitEnvironment drops credentials', Object.keys(gitEnvironment({ PATH: 'x', MY_API_KEY: 'secret', DSH_HOME: '/y', SystemRoot: 'z' })).sort(), [
  'GIT_ASKPASS',
  'GIT_CONFIG_COUNT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
  'LC_ALL',
  'PATH',
  'SSH_ASKPASS',
  'SystemRoot',
])
check('safeRepoPath accepts relative', safeRepoPath('src/a.js'), 'src/a.js')
check('safeRepoPath rejects traversal', safeRepoPath('../secret'), null)
check('safeRepoPath rejects absolute', safeRepoPath('C:/secret'), null)
check('safeRepoPath rejects backslash traversal', safeRepoPath('src\\..\\..\\secret'), null)

console.log('2. target discovery')
const targets = collectTargets(ctx, { allowedPaths: [] })
check('one deduplicated target', targets.length, 1)
check('target identity', { kind: targets[0]?.kind, dir: targets[0]?.dir, live: targets[0]?.live, sessions: targets[0]?.sessions }, {
  kind: 'workspace',
  dir: repo,
  live: true,
  sessions: 2,
})

const throwingCtx = {
  logger,
  get: (name) =>
    name === 'workspaceRegistry'
      ? {
          list() {
            throw new Error('registry exploded')
          },
        }
      : name === 'sessions'
        ? { list: () => 'not an array' }
        : undefined,
}
check('a throwing source degrades to no targets', collectTargets(throwingCtx, { allowedPaths: [] }), [])
check('a bad answer does not break configured extras', collectTargets(throwingCtx, { allowedPaths: [repo] }).map((t) => t.kind), [
  'configured',
])

const rootOnlyCtx = { logger, get: (name) => (name === 'sandboxPolicy' ? { workspaceRoot: repo } : undefined) }
check('workspace root is the last-resort source', collectTargets(rootOnlyCtx, { allowedPaths: [] }).map((t) => [t.kind, t.dir]), [
  ['workspace-root', repo],
])
const rootFnCtx = { logger, get: (name) => (name === 'sandboxPolicy' ? { workspaceRoot: () => repo } : undefined) }
check('workspace root may be a getter', collectTargets(rootFnCtx, { allowedPaths: [] }).length, 1)
const rootBadCtx = {
  logger,
  get: (name) =>
    name === 'sandboxPolicy'
      ? {
          get workspaceRoot() {
            throw new Error('policy exploded')
          },
        }
      : undefined,
}
check('a throwing workspace root is contained', collectTargets(rootBadCtx, { allowedPaths: [] }), [])
check('the workspace root is deduplicated against a registered workspace', collectTargets(
  { logger, get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ id: 'w1', path: repo }] } : name === 'sandboxPolicy' ? { workspaceRoot: repo } : undefined) },
  { allowedPaths: [] },
).length, 1)

console.log('3. the state route')
const routes = createRoutes(ctx, { allowedPaths: [repo] }, { execFile: fileRedirectExecFile })
const targetsResponse = await routes.handleTargets(new Request('http://localhost/api/changelist.targets'))
check('targets route status', targetsResponse.status, 200)
const targetsBody = await targetsResponse.json()
checkThat('targets route lists the fixture', targetsBody.targets.some((t) => t.dir === repo))

const stateResponse = await routes.handleState(
  new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(repo)}`),
)
check('state route status', stateResponse.status, 200)
check('state content type', stateResponse.headers.get('content-type'), 'application/json; charset=utf-8')
const state = await stateResponse.json()
check('state ok', state.ok, true)
check('state base', state.base, 'origin/main')
check('state branch', state.branch, 'main')
check('state ahead/behind', [state.ahead, state.behind], [1, 0])
check('state total', state.total, 6)
check('state baseKind', state.baseKind, 'upstream')
checkThat('state carries no fetch result by default', state.fetch === null)

const unnamedDir = FIXTURE_ROOT
const denied = await routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(unnamedDir)}`))
check('unauthorized directory refused', denied.status, 403)
const badDir = await routes.handleState(new Request('http://localhost/api/changelist.state?dir=relative/path'))
check('relative directory refused', badDir.status, 400)

console.log('3b. the sessionId path (what the header chip uses)')
const sessionState = await routes.handleState(new Request('http://localhost/api/changelist.state?sessionId=s1'))
check('session state status', sessionState.status, 200)
const sessionBody = await sessionState.json()
check('session target kind', sessionBody.target?.kind, 'session')
check('session target dir comes from the session', sessionBody.target?.dir, repo)
check('session state is the same changelist', [sessionBody.ok, sessionBody.base, sessionBody.total], [true, 'origin/main', 6])
const sessionDiff = await routes.handleDiff(
  new Request(`http://localhost/api/changelist.diff?sessionId=s1&path=${encodeURIComponent('src/a.js')}`),
)
check('session diff status', sessionDiff.status, 200)
checkThat('session diff has the added line', String((await sessionDiff.json()).text).includes('+export const a2 = 3'))
const unknownSession = await routes.handleState(new Request('http://localhost/api/changelist.state?sessionId=nope'))
check('unknown session refused', unknownSession.status, 404)
checkThat('unknown session explains itself', String((await unknownSession.json()).message).includes('工作目录'))

console.log('4. the diff route')
const diffResponse = await routes.handleDiff(
  new Request(`http://localhost/api/changelist.diff?dir=${encodeURIComponent(repo)}&path=${encodeURIComponent('src/a.js')}`),
)
check('diff route status', diffResponse.status, 200)
const diff = await diffResponse.json()
checkThat('diff has the added line', String(diff.text).includes('+export const a2 = 3'), diff.text)
check('diff base', diff.base, 'origin/main')
const traversal = await routes.handleDiff(
  new Request(`http://localhost/api/changelist.diff?dir=${encodeURIComponent(repo)}&path=${encodeURIComponent('../secret')}`),
)
check('traversal path refused', traversal.status, 400)

console.log('4b. fetch, caps and truncation')
const fetchingRoutes = createRoutes(ctx, { allowedPaths: [repo], diagnostics: false }, { execFile: fileRedirectExecFile })
const fetched = await (
  await fetchingRoutes.handleState(new Request(`http://localhost/api/changelist.state?sessionId=s1&fetch=1`))
).json()
// This sandbox cannot run `git fetch` at all (its transport needs the shell,
// which is denied here), so the assertion pins the contract that matters: the
// outcome is reported with git's own message and the changelist still loads.
checkThat('a fetch outcome is reported', typeof fetched.fetch?.ok === 'boolean', JSON.stringify(fetched.fetch))
checkThat(
  'a failed fetch carries git’s message',
  fetched.fetch?.ok === true || (typeof fetched.fetch?.message === 'string' && fetched.fetch.message.length > 0),
  JSON.stringify(fetched.fetch),
)
check('and the changelist still loads regardless', fetched.ok, true)

const cappedRoutes = createRoutes(ctx, { allowedPaths: [repo], maxFiles: 2, diagnostics: false }, { execFile: fileRedirectExecFile })
const capped = await (await cappedRoutes.handleState(new Request(`http://localhost/api/changelist.state?sessionId=s1`))).json()
check('maxFiles caps the list but reports the true total', [capped.files.length, capped.total, capped.truncated], [2, 6, true])
checkThat('and explains the cap', capped.notes.some((note) => note.includes('2')), JSON.stringify(capped.notes))

const narrowRoutes = createRoutes(ctx, { allowedPaths: [repo], maxDiffBytes: 80, diagnostics: false }, { execFile: fileRedirectExecFile })
const narrow = await (
  await narrowRoutes.handleDiff(new Request(`http://localhost/api/changelist.diff?sessionId=s1&path=${encodeURIComponent('src/a.js')}`))
).json()
check('maxDiffBytes truncates the comparison', narrow.truncated, true)
checkThat('cut on a line boundary', String(narrow.text).endsWith('\n'), JSON.stringify(String(narrow.text).slice(-40)))

console.log('5. mounting')
const registered = []
const applied = []
const applyCtx = {
  logger,
  get: ctx.get,
  effect(fn, label) {
    const value = fn()
    const disposers = typeof value === 'function' ? [value] : [...(value ?? [])]
    applied.push({ label, disposers })
    return () => {}
  },
  connection: {
    fetch: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  },
}
apply(applyCtx, { allowedPaths: [repo], diagnosticsPath: path.join(FIXTURE_ROOT, 'diag', 'host.log') }, { execFile: fileRedirectExecFile })
check('three routes registered', registered.length, 3)
check('route paths', registered.map((r) => r.path).sort(), [ROUTES.diff, ROUTES.state, ROUTES.targets].sort())
checkThat('every route sits inside the /api fence', registered.every((r) => r.path.startsWith('/api/')), registered.map((r) => r.path).join())
check('every route is GET with a buffered body', registered.every((r) => r.methods.length === 1 && r.methods[0] === 'GET' && r.requestBody === 'buffered'), true)
check('registrations are effect-owned', applied.length, 1)
checkThat('the effect yields four disposers', applied[0].disposers.length === 4, JSON.stringify(applied[0].label))
checkThat(
  'no yielded value is a promise',
  applied[0].disposers.every((entry) => typeof entry === 'function'),
  JSON.stringify(applied[0].disposers.map((entry) => typeof entry)),
)

console.log('5b. the activity log')
const diagnosticsFile = path.join(FIXTURE_ROOT, 'diag', 'host.log')
await new Promise((resolve) => setTimeout(resolve, 50))
const logged = fs.existsSync(diagnosticsFile) ? fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n') : []
checkThat('the mount was recorded', logged.some((line) => line.includes('"event":"mounted"')), JSON.stringify(logged.slice(0, 2)))
await registered.find((route) => route.path === ROUTES.state).fetch(
  new Request(`http://localhost${ROUTES.state}?sessionId=s1`),
)
await new Promise((resolve) => setTimeout(resolve, 50))
const loggedAfter = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const routeLine = loggedAfter.find((entry) => entry.event === 'route' && entry.route === 'state')
checkThat('a route hit is recorded with its outcome', routeLine !== undefined && routeLine.ok === true, JSON.stringify(routeLine))
checkThat('the recorded line names the session', routeLine?.sessionId === 's1', JSON.stringify(routeLine))
checkThat('the request was timed', typeof routeLine?.ms === 'number', JSON.stringify(routeLine))

await registered.find((route) => route.path === ROUTES.targets).fetch(new Request(`http://localhost${ROUTES.targets}`))
await new Promise((resolve) => setTimeout(resolve, 50))
const withTargets = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const targetsLine = withTargets.filter((entry) => entry.route === 'targets').at(-1)
checkThat(
  'the targets route records the list it offered',
  targetsLine?.targets >= 1 && Array.isArray(targetsLine?.dirs) && targetsLine.dirs.length >= 1,
  JSON.stringify(targetsLine),
)

const silentCtx = { logger, get: () => undefined, effect: () => () => {}, connection: { fetch: { register: () => () => {} } } }
const silentPath = path.join(FIXTURE_ROOT, 'diag', 'silent.log')
apply(silentCtx, { diagnostics: false, diagnosticsPath: silentPath })
await new Promise((resolve) => setTimeout(resolve, 50))
checkThat('diagnostics:false writes nothing', !fs.existsSync(silentPath), silentPath)

const brokenDiagPath = path.join(repo, 'README.md', 'host.log')
const unwritableRoutes = createRoutes(ctx, { allowedPaths: [repo], diagnosticsPath: brokenDiagPath }, { execFile: fileRedirectExecFile })
await unwritableRoutes.diagnostics.record({ event: 'mounted' })
await new Promise((resolve) => setTimeout(resolve, 50))
const stillAnswers = await unwritableRoutes.handleTargets(new Request(`http://localhost${ROUTES.targets}`))
checkThat('an unwritable diagnostics path never breaks a route', stillAnswers.status === 200, String(stillAnswers.status))

console.log('6. route failure is contained')
const brokenCtx = { logger, get: () => undefined }
const brokenRoutes = createRoutes(brokenCtx, { gitPath: 'definitely-not-git', allowedPaths: [repo] }, { execFile: fileRedirectExecFile })
const brokenResponse = await brokenRoutes.handleState(
  new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(repo)}`),
)
const brokenBody = await brokenResponse.json()
checkThat('a missing git yields a structured refusal, not a crash', brokenBody.ok !== true, JSON.stringify(brokenBody).slice(0, 160))

console.log('6b. a directory outside any work tree says why')
const outside = await inspectWorkspace({
  run: createFixtureRunner(),
  readFile: createFileReader(),
  dir: os.tmpdir(),
  base: 'HEAD',
})
check('outside a work tree', { ok: outside.ok, reason: outside.reason }, { ok: false, reason: 'not-a-repository' })
checkThat(
  'the refusal carries git’s own words',
  typeof outside.detail === 'string' && outside.detail.includes('not a git repository'),
  String(outside.detail),
)

console.log('7. the vcs parameter (Perforce alongside git)')
// The fake p4 is a real process, so this section proves the whole chain:
// vcs selection -> p4 runner -> -ztag parsing -> mapped state answer.
// Node 24 refuses to spawn a `.cmd` without a shell (EINVAL), so the p4 cases
// use the fixture's own spawn seam — the same contract, different launcher.
const p4ExecFile = createFakeP4ExecFile()
const p4Routes = createRoutes(
  ctx,
  {
    allowedPaths: [p4Repo],
    gitPath: 'definitely-not-git',
    vcs: 'auto',
    diagnostics: false,
    p4Path: FAKE_P4_SHIM,
  },
  {
    execFile: (file, args, options, callback) =>
      file === FAKE_P4_SHIM ? p4ExecFile(file, args, options, callback) : fileRedirectExecFile(file, args, options, callback),
  },
)
const p4StateResponse = await p4Routes.handleState(
  new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(p4Repo)}&vcs=p4`),
)
const p4State = await p4StateResponse.json()
check('the p4 state route answers ok', p4State.ok, true)
check('the answer names the p4 backend', p4State.vcs, 'p4')
check('the workspace names the client and its root', [p4State.workspace?.client, p4State.workspace?.root], [
  FAKE_P4_CLIENT,
  FAKE_P4_ROOT,
])
check('options carry what the connection panel reads', {
  localEdits: p4State.options?.localEdits,
  shelved: p4State.options?.shelved,
  scanTimeoutMs: typeof p4State.options?.scanTimeoutMs === 'number',
  p4Path: p4State.options?.p4Path,
}, { localEdits: false, shelved: true, scanTimeoutMs: true, p4Path: FAKE_P4_SHIM })
checkThat('revisions report have and head', typeof p4State.revisions?.have === 'number' && typeof p4State.revisions?.head === 'number', JSON.stringify(p4State.revisions))
checkThat('changelists are grouped and user-scoped', Array.isArray(p4State.changelists) && p4State.changelists.length > 0, JSON.stringify(p4State.changelists))
checkThat(
  'every numbered changelist belongs to the workspace user',
  p4State.changelists.every((entry) => entry.isDefault || entry.user === FAKE_P4_USER),
  JSON.stringify(p4State.changelists.map((entry) => [entry.number, entry.user])),
)
checkThat(
  'files stay client-relative and carry the p4 fields',
  p4State.files.length > 0 &&
    p4State.files.every(
      (file) =>
        !file.path.startsWith('/') &&
        !file.path.includes('..') &&
        typeof file.depotPath === 'string' &&
        file.depotPath.startsWith('//') &&
        ['opened', 'local', 'shelved'].includes(file.origin),
    ),
  JSON.stringify(p4State.files.slice(0, 2)),
)
check('total equals the file count when nothing is capped', p4State.total, p4State.files.length)

const autoState = await (
  await p4Routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(p4Repo)}&vcs=auto`))
).json()
check('auto detection reaches p4 when git is unavailable', autoState.vcs, 'p4')

const forcedGit = await (
  await p4Routes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(p4Repo)}&vcs=git`))
).json()
check('forcing git on a p4-only directory refuses instead of lying', { ok: forcedGit.ok, vcs: forcedGit.vcs, reason: forcedGit.reason }, {
  ok: false,
  vcs: null,
  reason: 'not-a-repository',
})

const p4Diff = await (
  await p4Routes.handleDiff(
    new Request(
      `http://localhost/api/changelist.diff?dir=${encodeURIComponent(p4Repo)}&vcs=p4&path=${encodeURIComponent('Content/Example/style/Asset_Example_Style.json')}&depotPath=${encodeURIComponent(`//${FAKE_P4_DEPOT.replace(/^\/\//, '')}/Content/Example/style/Asset_Example_Style.json`)}&changed=1`,
    ),
  )
).json()
check('the p4 diff route answers with unified text', [p4Diff.ok, p4Diff.vcs, p4Diff.binary], [true, 'p4', false])
checkThat('the comparison carries the added line', String(p4Diff.text).includes('"b": 3'), String(p4Diff.text).slice(0, 200))

const fakeCalls = readP4Calls()
checkThat(
  'the whole-workspace enumeration never happened',
  !fakeCalls.some((line) => /(^|\s)fstat(\s|$)/.test(line) && /\/\.\.\./.test(line) && !/^-d\s/.test(line) && /\/\/fake_client\/\.\.\./.test(line)),
  JSON.stringify(fakeCalls.filter((line) => line.includes('fstat')).slice(0, 3)),
)
checkThat(
  'no writing command was issued',
  !fakeCalls.some((line) => /(^|\s)(submit|sync|edit|add|delete|shelve|changelist|revert|reconcile|clean)(\s|$)/.test(line)),
  JSON.stringify(fakeCalls),
)

console.log('7b. the connection P4V already knows')
// The Host runs p4 with a scrubbed environment, so an installation whose
// P4PORT/P4USER live only in P4V (or in the registry, where `p4 set` puts them)
// would otherwise look like "no Perforce here" and the directory would be
// reported as a plain git-less folder. This section proves the Host wires the
// discovered values into the connection: the config seam stands in for the
// machine's own ~/.p4qt, so the suite never depends on the machine running it.
const discoveredP4V = {
  port: 'p4v.example.com:1666',
  user: 'p4v-user',
  client: FAKE_P4_CLIENT,
  charset: 'utf8',
  clientRoot: null,
  sources: ['connectionmap.xml'],
}
const discoveredRoutes = createRoutes(
  ctx,
  {
    allowedPaths: [p4Repo],
    gitPath: 'definitely-not-git',
    vcs: 'auto',
    diagnostics: false,
    p4Path: FAKE_P4_SHIM,
  },
  {
    execFile: (file, args, options, callback) =>
      file === FAKE_P4_SHIM ? p4ExecFile(file, args, options, callback) : fileRedirectExecFile(file, args, options, callback),
    readP4VConfig: () => discoveredP4V,
  },
)
const discoveredState = await (
  await discoveredRoutes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(p4Repo)}&vcs=auto`))
).json()
check('no connection in config still reaches p4', discoveredState.vcs, 'p4')
const echoed = discoveredState.options?.discovered ?? {}
check(
  'the discovered connection is echoed to the panel',
  { port: echoed.port, user: echoed.user, client: echoed.client, charset: echoed.charset, from: echoed.from },
  { port: 'p4v.example.com:1666', user: 'p4v-user', client: FAKE_P4_CLIENT, charset: 'utf8', from: 'p4v' },
)
checkThat(
  'the answer says where the connection came from',
  (discoveredState.notes ?? []).some((note) => String(note).includes('P4V')),
  JSON.stringify(discoveredState.notes),
)
check('the discovered user is what scopes the answer', discoveredState.workspace?.user, 'p4v-user')

// An explicit request parameter still wins over anything discovered.
const overridden = await (
  await discoveredRoutes.handleState(
    new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(p4Repo)}&vcs=auto&p4user=${encodeURIComponent('typed-by-hand')}`),
  )
).json()
check('a typed-in user overrides the discovered one', overridden.workspace?.user, 'typed-by-hand')
check('a typed-in user also overrides it in the echoed panel values', overridden.options?.discovered?.user, 'typed-by-hand')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
