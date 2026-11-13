/**
 * Host-half verification: drives the real route handlers against the real git
 * fixture, and checks that `apply` mounts exactly the four fenced routes.
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
import { createAttentionRegistry, emptyAttentionCounts, ATTENTION_SCHEMA_VERSION } from './lib/attention.js'
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
apply(applyCtx, { allowedPaths: [repo], diagnosticsPath: path.join(FIXTURE_ROOT, 'diag', 'host.log') }, { execFile: fileRedirectExecFile, on: () => () => {} })
// Four routes now: the three changelist reads plus the cross-session attention
// read. The route list is derived from ROUTES, so it cannot disagree with the
// contract even if a fifth route is added later.
const MOUNTED_ROUTES = Object.values(ROUTES)
check('three changelist routes plus attention', registered.length, 4)
check('route paths', registered.map((r) => r.path).sort(), MOUNTED_ROUTES.sort())
checkThat('every route sits inside the /api fence', registered.every((r) => r.path.startsWith('/api/')), registered.map((r) => r.path).join())
check('every route is GET with a buffered body', registered.every((r) => r.methods.length === 1 && r.methods[0] === 'GET' && r.requestBody === 'buffered'), true)
check('registrations are effect-owned', applied.length, 1)
// One disposer each for the unmount log and the four routes, plus the attention
// registry's `session/event` subscription: unload must release all six.
checkThat('the effect yields six disposers', applied[0].disposers.length === 6, JSON.stringify(applied[0].disposers.length))
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

console.log('7c. a forced backend never probes the other tool')
// Forcing git on a git work tree must not spawn p4 at all: an unreachable
// Perforce server used to add seconds to a plain git read.
resetP4Calls()
const probeRoutes = createRoutes(
  ctx,
  { allowedPaths: [repo], p4Path: FAKE_P4_SHIM, diagnostics: false },
  {
    execFile: (file, args, options, callback) =>
      file === FAKE_P4_SHIM ? p4ExecFile(file, args, options, callback) : fileRedirectExecFile(file, args, options, callback),
  },
)
const forcedGitOnGit = await (
  await probeRoutes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(repo)}&vcs=git`))
).json()
check('forcing git on a git work tree answers from git', forcedGitOnGit.vcs, 'git')
check('and spawns no p4 process at all', readP4Calls().length, 0)

resetP4Calls()
const autoOnGit = await (
  await probeRoutes.handleState(new Request(`http://localhost/api/changelist.state?dir=${encodeURIComponent(repo)}&vcs=auto`))
).json()
check('auto detection still prefers git', autoOnGit.vcs, 'git')
checkThat(
  'auto still asks Perforce whether it also covers the directory',
  readP4Calls().length > 0,
  JSON.stringify(readP4Calls().slice(0, 2)),
)

console.log('7d. concurrent identical reads share one answer')
// Four identical state reads used to run at once, each spawning its own git
// commands. Mounted routes now coalesce them into one read.
const coalesced = []
const coalesceLog = path.join(FIXTURE_ROOT, 'diag', 'coalesce.log')
fs.rmSync(coalesceLog, { force: true })
const coalesceCtx = {
  logger,
  get: ctx.get,
  effect(fn) {
    const value = fn()
    const disposers = typeof value === 'function' ? [value] : [...(value ?? [])]
    void disposers
    return () => {}
  },
  connection: {
    fetch: {
      register(route) {
        coalesced.push(route)
        return () => {}
      },
    },
  },
}
apply(coalesceCtx, { allowedPaths: [repo], diagnosticsPath: coalesceLog }, { execFile: fileRedirectExecFile })
const coalesceRoute = coalesced.find((route) => route.path === ROUTES.state)
checkThat('the state route is mounted for the coalescing test', Boolean(coalesceRoute), JSON.stringify(coalesced.map((route) => route.path)))
const coalesceUrl = `http://localhost${ROUTES.state}?sessionId=s1`
const [firstAnswer, secondAnswer] = await Promise.all([
  coalesceRoute.fetch(new Request(coalesceUrl)),
  coalesceRoute.fetch(new Request(coalesceUrl)),
])
const [firstBody, secondBody] = await Promise.all([firstAnswer.json(), secondAnswer.json()])
check('both concurrent callers get an answer', [firstAnswer.status, secondAnswer.status], [200, 200])
const dottedRepo = repo.replace(/\\/g, '/')
check(
  'both answers describe the same read',
  [firstBody.dir, firstBody.total, secondBody.dir, secondBody.total],
  [dottedRepo, 6, dottedRepo, 6],
)
await new Promise((resolve) => setTimeout(resolve, 150))
const routeLines = fs
  .readFileSync(coalesceLog, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.event === 'route' && entry.route === 'state')
check('two requests were answered by one read', routeLines.length, 1)

console.log('8. cross-project attention: the registry folds session events')
// The attention route answers "is any session, in any workspace, waiting for
// me". Its only input is the Host's own `session/event` stream, so the registry
// takes `on` and `now` as seams: the whole state machine is exercised here
// without a Cordis context, a real clock, or any subprocess.
const attentionLog = path.join(FIXTURE_ROOT, 'diag', 'attention.log')

/** A fake `ctx.on` that records listeners, exactly like the Cordis event service. */
function captureListeners() {
  const listeners = []
  const subscription = (eventName, listener) => {
    listeners.push({ eventName, listener, live: true })
    return () => {
      const entry = listeners.find((candidate) => candidate.listener === listener)
      if (entry) entry.live = false
    }
  }
  Object.defineProperty(subscription, 'live', {
    get: () => listeners.filter((entry) => entry.live).length,
  })
  subscription.listeners = listeners
  return subscription
}
/** Emit to every live listener, exactly like the Host would. */
function emitAll(on, session, event) {
  for (const entry of on.listeners) if (entry.live) entry.listener(session, event)
}
const sessionIn = (id, dir, title) => ({ id, header: { cwd: dir, ...(title ? { title } : {}) } })
// A real Host event carries its own `time`; leaving it out is how these cases
// pin the injected clock instead, so `since`/`at` are deterministic.
const event = (type, data, time) => ({ type, ...(time === undefined ? {} : { time }), data })

// 8a. a turn starts, then completes: running -> done, and `since` advances.
const clockA = { t: 1_000_000 }
const onA = captureListeners()
const regA = createAttentionRegistry({ on: onA, now: () => clockA.t })
check('the session/event listener is subscribed once', onA.listeners.map((entry) => entry.eventName), ['session/event'])
checkThat('the registry starts empty', regA.size === 0 && regA.snapshot().sessions.length === 0)
emitAll(onA, sessionIn('s1', 'C:/work/Alpha', 'Alpha 会话'), event('turn/start', { turn: 3 }))
const runningA = regA.snapshot()
check('turn/start makes the session running', [runningA.sessions[0]?.state, runningA.sessions[0]?.reason, runningA.sessions[0]?.running], [
  'running',
  'turn-start',
  true,
])
check('turn/start records the turn and its start time', [runningA.sessions[0]?.turn, runningA.sessions[0]?.since], [3, 1_000_000])
clockA.t = 1_004_000
emitAll(onA, sessionIn('s1', 'C:/work/Alpha', 'Alpha 会话'), event('turn/end', { turn: 3, reason: { kind: 'completed' } }))
const doneA = regA.snapshot()
check('a completed turn moves the session to done', [doneA.sessions[0]?.state, doneA.sessions[0]?.reason, doneA.sessions[0]?.running], [
  'done',
  'turn-end',
  false,
])
check('done restarts `since` and moves `at`', [doneA.sessions[0]?.since, doneA.sessions[0]?.at], [1_004_000, 1_004_000])
check('counts always carry all five states', Object.keys(doneA.counts).sort(), ['done', 'error', 'idle', 'running', 'waiting'])
check('the counts describe the returned list', doneA.counts.done, 1)
regA.dispose()

// 8b. an error carries the provider's own words, bounded.
const clockB = { t: 2_000_000 }
const onB = captureListeners()
const regB = createAttentionRegistry({ on: onB, now: () => clockB.t })
emitAll(onB, sessionIn('s2', '/home/u/Beta'), event('turn/start', { turn: 1 }))
clockB.t = 2_001_000
const longMessage = 'provider exploded: '.repeat(40)
emitAll(onB, sessionIn('s2', '/home/u/Beta'), event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: longMessage, code: 'OVERLOADED' } } }))
const errorB = regB.snapshot()
check('a failed turn is an error', [errorB.sessions[0]?.state, errorB.sessions[0]?.reason, errorB.sessions[0]?.running], [
  'error',
  'turn-error',
  false,
])
checkThat('the error detail is truncated', errorB.sessions[0]?.detail.length <= 160, String(errorB.sessions[0]?.detail.length))
checkThat('the error detail keeps the provider message', String(errorB.sessions[0]?.detail).startsWith('provider exploded'), errorB.sessions[0]?.detail)
// A failure with no message still reports its stable code.
emitAll(onB, sessionIn('s3', '/home/u/Beta'), event('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'RATE_LIMITED' } } }))
const errorCode = regB.snapshot().sessions.find((entry) => entry.sessionId === 's3')
check('a codeless failure falls back to the code', [errorCode?.state, errorCode?.detail], ['error', 'RATE_LIMITED'])
regB.dispose()

// 8c. blocked waits for a human; aborted and unknown are idle.
const clockC = { t: 3_000_000 }
const onC = captureListeners()
const regC = createAttentionRegistry({ on: onC, now: () => clockC.t })
emitAll(onC, sessionIn('s4', 'D:/work/Alpha'), event('turn/start', { turn: 7 }))
emitAll(onC, sessionIn('s4', 'D:/work/Alpha'), event('turn/end', { turn: 7, reason: { kind: 'blocked', detail: '等待审批：写入工作区' } }))
const blockedC = regC.snapshot().sessions[0]
check('a blocked turn waits for a human', [blockedC?.state, blockedC?.reason, blockedC?.running], ['waiting', 'blocked', true])
checkThat('the blocked detail survives', blockedC?.detail === '等待审批：写入工作区', String(blockedC?.detail))
emitAll(onC, sessionIn('s5', 'D:/work/Beta'), event('turn/start', { turn: 1 }))
clockC.t = 3_001_000
emitAll(onC, sessionIn('s5', 'D:/work/Beta'), event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
check('an aborted turn is idle', [regC.snapshot().sessions.find((entry) => entry.sessionId === 's5')?.state], ['idle'])
emitAll(onC, sessionIn('s6', 'D:/work/Gamma'), event('turn/end', { turn: 1, reason: { kind: 'something-new' } }))
check('an unknown end reason is idle, not an error', [regC.snapshot().sessions.find((entry) => entry.sessionId === 's6')?.state], ['idle'])
// A turn that never started and has no end reason at all is idle too.
emitAll(onC, sessionIn('s7', 'D:/work/Gamma'), event('turn/end', { turn: 1 }))
check('a turn/end with no reason is idle', [regC.snapshot().sessions.find((entry) => entry.sessionId === 's7')?.state], ['idle'])
regC.dispose()

// 8d. activity keeps a running turn running without restarting `since`.
const clockD = { t: 4_000_000 }
const onD = captureListeners()
const regD = createAttentionRegistry({ on: onD, now: () => clockD.t })
emitAll(onD, sessionIn('s8', 'E:/work/Alpha'), event('turn/start', { turn: 2 }))
clockD.t = 4_005_000
for (const type of ['step/start', 'tool/call', 'tool/result', 'assistant/message']) {
  emitAll(onD, sessionIn('s8', 'E:/work/Alpha'), event(type, { turn: 2, step: 1 }))
}
const activityD = regD.snapshot()
check('activity keeps the turn running', [activityD.sessions[0]?.state, activityD.sessions[0]?.reason], ['running', 'activity'])
check('activity moves `at` but keeps `since`', [activityD.sessions[0]?.since, activityD.sessions[0]?.at], [4_000_000, 4_005_000])
// An approval question is the canonical "waiting", and answering it resumes.
emitAll(onD, sessionIn('s9', 'E:/work/Beta'), event('turn/start', { turn: 1 }))
emitAll(onD, sessionIn('s9', 'E:/work/Beta'), event('approval/asked', { id: 'a1', toolName: 'Bash' }))
check('an approval question waits for a human', [regD.snapshot().sessions.find((s) => s.sessionId === 's9')?.state, regD.snapshot().sessions.find((s) => s.sessionId === 's9')?.reason], ['waiting', 'approval'])
emitAll(onD, sessionIn('s9', 'E:/work/Beta'), event('approval/decided', { id: 'a1', outcome: 'allowed-once' }))
check('answering it resumes the turn', [regD.snapshot().sessions.find((s) => s.sessionId === 's9')?.state], ['running'])
regD.dispose()

// 8e. ordering: worst state first, newest evidence first inside a state.
const clockE = { t: 5_000_000 }
const onE = captureListeners()
const regE = createAttentionRegistry({ on: onE, now: () => clockE.t })
const seed = (id, dir, state) => {
  clockE.t += 1_000
  if (state === 'waiting') emitAll(onE, sessionIn(id, dir), event('turn/end', { turn: 1, reason: { kind: 'blocked' } }))
  else if (state === 'error') emitAll(onE, sessionIn(id, dir), event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x' } } }))
  else if (state === 'done') emitAll(onE, sessionIn(id, dir), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  else if (state === 'running') emitAll(onE, sessionIn(id, dir), event('turn/start', { turn: 1 }))
  else emitAll(onE, sessionIn(id, dir), event('turn/end', { turn: 1, reason: { kind: 'aborted' } }))
  return clockE.t
}
seed('idle-1', 'F:/w/Idle', 'idle')
seed('running-1', 'F:/w/Running', 'running')
const doneOlder = seed('done-old', 'F:/w/Done', 'done')
seed('error-1', 'F:/w/Error', 'error')
seed('waiting-1', 'F:/w/Wait', 'waiting')
const doneNewer = seed('done-new', 'F:/w/Done', 'done')
const ordered = regE.snapshot().sessions
check('states sort waiting, error, done, running, idle', ordered.map((entry) => entry.state), [
  'waiting',
  'error',
  'done',
  'done',
  'running',
  'idle',
])
check('newest evidence sorts first inside a state', ordered.filter((entry) => entry.state === 'done').map((entry) => entry.sessionId), [
  'done-new',
  'done-old',
])
checkThat('that is newest-first, not insertion order', doneNewer > doneOlder)
regE.dispose()

// 8f. the session cap and the retention window.
const clockF = { t: 6_000_000 }
const onF = captureListeners()
const regF = createAttentionRegistry({ on: onF, now: () => clockF.t, limits: { maxSessions: 3, retentionMs: 10_000 } })
for (let index = 0; index < 6; index++) {
  clockF.t += 500
  emitAll(onF, sessionIn(`cap-${index}`, `G:/w/Cap${index}`), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
}
const capSnapshot = regF.snapshot()
check('attentionMaxSessions caps the answer', capSnapshot.sessions.length, 3)
check('the cap keeps the newest sessions', capSnapshot.sessions.map((entry) => entry.sessionId), ['cap-5', 'cap-4', 'cap-3'])
check('the counts describe the capped list, not the map', [capSnapshot.counts.done, regF.size], [3, 6])
// Retention: everything older than 10 s of evidence disappears on the next read.
clockF.t += 20_000
emitAll(onF, sessionIn('fresh-1', 'G:/w/Fresh'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
const pruned = regF.snapshot()
check('retention prunes records with no recent evidence', pruned.sessions.map((entry) => entry.sessionId), ['fresh-1'])
check('pruning shrinks the map too', regF.size, 1)
regF.dispose()

// 8g. a malformed event never breaks the Host or the registry.
const clockG = { t: 7_000_000 }
const onG = captureListeners()
const regG = createAttentionRegistry({ on: onG, now: () => clockG.t })
emitAll(onG, sessionIn('good-1', 'H:/w/Good'), event('turn/start', { turn: 1 }))
const hostile = { get type() { throw new Error('type exploded') } }
const hostileData = { type: 'turn/end', time: 7_000_000, data: { get reason() { throw new Error('reason exploded') } } }
for (const [session, badEvent] of [
  [null, event('turn/start', { turn: 1 })],
  [undefined, null],
  [{}, event('turn/start', { turn: 1 })],
  [{ id: 'no-cwd' }, event('turn/start', { turn: 1 })],
  [{ id: '' }, event('turn/start', { turn: 1 })],
  ['not a session', event('turn/start', { turn: 1 })],
  [sessionIn('good-1', 'H:/w/Good'), null],
  [sessionIn('good-1', 'H:/w/Good'), 'not an event'],
  [sessionIn('good-1', 'H:/w/Good'), {}],
  [sessionIn('good-1', 'H:/w/Good'), hostile],
  [sessionIn('good-1', 'H:/w/Good'), hostileData],
]) {
  emitAll(onG, session, badEvent)
}
// A session whose header getter throws is skipped, not fatal.
emitAll(onG, { id: 'bad-header', get header() { throw new Error('header exploded') } }, event('turn/start', { turn: 1 }))
const survived = regG.snapshot()
checkThat('the registry survives every malformed event', Array.isArray(survived.sessions))
check('a session with no cwd is skipped, not tracked', survived.sessions.some((entry) => entry.sessionId === 'no-cwd'), false)
checkThat('the good session is still tracked after the poison', survived.sessions.some((entry) => entry.sessionId === 'good-1'))
// A session store that throws must degrade, not propagate.
const onH = captureListeners()
const regH = createAttentionRegistry({
  on: onH,
  now: () => clockG.t,
  sessions: {
    get() {
      throw new Error('store exploded')
    },
  },
})
emitAll(onH, { id: 'stub-1', header: { cwd: 'I:/w/Stub' } }, event('turn/start', { turn: 1 }))
check('a throwing session store still tracks the event', regH.snapshot().sessions.map((entry) => entry.sessionId), ['stub-1'])
regH.dispose()
// No `on` at all: an empty view, never a crash — the route must still answer.
const regNoOn = createAttentionRegistry({})
check('a registry with no event source is empty but valid', [regNoOn.snapshot().sessions.length, regNoOn.snapshot().counts], [0, emptyAttentionCounts()])
regNoOn.dispose()
regG.dispose()

// 8h. dispose() releases the subscription.
const onI = captureListeners()
const regI = createAttentionRegistry({ on: onI, now: () => 8_000_000 })
emitAll(onI, sessionIn('dispose-1', 'J:/w/Dispose'), event('turn/start', { turn: 1 }))
check('one live listener before dispose', onI.live, 1)
regI.dispose()
check('dispose removes the subscription', onI.live, 0)
// A disposed registry ignores late events instead of resurrecting records.
emitAll(onI, sessionIn('dispose-1', 'J:/w/Dispose'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
check('a disposed registry ignores late events', regI.snapshot().sessions.length, 0)
regI.dispose()
check('dispose is idempotent', onI.live, 0)

console.log('9. the attention route')
const attentionRegistered = []
const attentionApplied = []
const attentionRouteCtx = {
  logger,
  get: ctx.get,
  on(eventName, listener) {
    void eventName
    void listener
    return () => {}
  },
  effect(fn) {
    const value = fn()
    const disposers = typeof value === 'function' ? [value] : [...(value ?? [])]
    attentionApplied.push(disposers)
    return () => {}
  },
  connection: {
    fetch: {
      register(route) {
        attentionRegistered.push(route)
        return () => {}
      },
    },
  },
}
apply(attentionRouteCtx, { allowedPaths: [repo], diagnostics: false, diagnosticsPath: attentionLog }, { execFile: fileRedirectExecFile })
const attentionRoute = attentionRegistered.find((route) => route.path === ROUTES.attention)
checkThat('the attention route is mounted with the other three', Boolean(attentionRoute), JSON.stringify(attentionRegistered.map((route) => route.path)))
check('the mount is still four routes', attentionRegistered.length, 4)
check('the attention route is GET+buffered and fenced', {
  path: attentionRoute?.path,
  methods: attentionRoute?.methods,
  requestBody: attentionRoute?.requestBody,
}, { path: '/api/changelist.attention', methods: ['GET'], requestBody: 'buffered' })
checkThat('unloading releases the attention subscription too', attentionApplied[0].length === 6, JSON.stringify(attentionApplied[0].length))

const attentionResponse = await attentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}`))
check('the attention route answers 200', attentionResponse.status, 200)
check('its content type is JSON', attentionResponse.headers.get('content-type'), 'application/json; charset=utf-8')
const attentionBody = await attentionResponse.json()
check('the attention answer is ok', attentionBody.ok, true)
check('it carries the schema version', attentionBody.schemaVersion, ATTENTION_SCHEMA_VERSION)
checkThat('generatedAt is an epoch-ms number, not a string', typeof attentionBody.generatedAt === 'number' && attentionBody.generatedAt > 1_600_000_000_000, String(attentionBody.generatedAt))
check('it carries all five counts as numbers', attentionBody.counts, { waiting: 0, error: 0, done: 0, running: 0, idle: 0 })
checkThat('it carries a sessions array', Array.isArray(attentionBody.sessions))
// Authority is never widened: `dir` and `sessionId` are not inputs at all.
const widened = await attentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}?dir=${encodeURIComponent('C:/Windows')}&sessionId=somebody-else`))
const widenedBody = await widened.json()
check('a dir/sessionId query widens nothing', [widened.status, widenedBody.ok, widenedBody.sessions.length], [200, true, 0])
checkThat('and it is not an error surface', widenedBody.ok === true && widenedBody.message === undefined, JSON.stringify(widenedBody).slice(0, 160))
const garbage = await attentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}?nonsense=1&dir=`))
check('unknown query parameters are ignored, not 400', garbage.status, 200)

// The registry wired into the route is the one the events reach: `apply()` hands
// its `ctx.on` subscription to the same registry its handler reads from, so
// emitting into the captured listener and then hitting the route proves the
// whole path end to end with no fakes in between.
const liveListeners = []
const liveRoutes = []
let unloadPlugin = null
const liveCtx = {
  logger,
  get: ctx.get,
  on(eventName, listener) {
    liveListeners.push({ eventName, listener })
    return () => {
      const index = liveListeners.findIndex((entry) => entry.listener === listener)
      if (index >= 0) liveListeners.splice(index, 1)
    }
  },
  effect(fn) {
    // Genuine generator effect: run every step, keep every yielded disposer, and
    // hand back a function that unloads the plugin exactly like Cordis would.
    const generator = fn()
    const disposers = []
    for (let step = generator.next(); !step.done; step = generator.next()) disposers.push(step.value)
    unloadPlugin = () => {
      for (const disposer of disposers) if (typeof disposer === 'function') disposer()
    }
    return () => {}
  },
  connection: { fetch: { register: (route) => (liveRoutes.push(route), () => {}) } },
}
apply(liveCtx, { allowedPaths: [repo], diagnostics: false }, { execFile: fileRedirectExecFile })
check('the plugin subscribed to session/event', liveListeners.filter((entry) => entry.eventName === 'session/event').length, 1)
check('the plugin mounted four routes', liveRoutes.length, 4)
const liveAttentionRoute = liveRoutes.find((route) => route.path === ROUTES.attention)
const beforeEvent = await (await liveAttentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}`))).json()
check('a quiet Host reports an empty list, not an error', [beforeEvent.sessions.length, beforeEvent.counts.waiting], [0, 0])
for (const entry of liveListeners.filter((candidate) => candidate.eventName === 'session/event')) {
  entry.listener(sessionIn('live-1', 'K:/w/Live', '实时会话'), event('turn/start', { turn: 1 }))
}
const afterEvent = await (await liveAttentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}`))).json()
check('an emitted event reaches the route answer', afterEvent.sessions.map((session) => [session.sessionId, session.state]), [
  ['live-1', 'running'],
])
check('the row carries the workspace basename and the full dir', [afterEvent.sessions[0]?.workspace, afterEvent.sessions[0]?.dir], [
  'Live',
  'K:/w/Live',
])
check('and the title from the session header', afterEvent.sessions[0]?.title, '实时会话')
check('and all timestamps are epoch-ms numbers', [typeof afterEvent.sessions[0]?.since, typeof afterEvent.sessions[0]?.at, typeof afterEvent.generatedAt], [
  'number',
  'number',
  'number',
])
// Unloading the plugin must release the subscription: the Host keeps no listener.
checkThat('the effect handed back an unloader', typeof unloadPlugin === 'function')
unloadPlugin()
check('unloading releases the plugin subscription', liveListeners.filter((entry) => entry.eventName === 'session/event').length, 0)
const readOnlyAfterUnload = await (await liveAttentionRoute.fetch(new Request(`http://localhost${ROUTES.attention}`))).json()
check('a disposed registry answers empty, still ok', [readOnlyAfterUnload.ok, readOnlyAfterUnload.sessions.length], [true, 0])

// 9b. attentionEnabled:false short-circuits, and the shape stays identical.
const disabledRegistered = []
const disabledApplied = []
const disabledCtx = {
  logger,
  get: ctx.get,
  on: () => () => {},
  effect(fn) {
    // The effect body is a generator: draining it is what performs the mounts.
    const value = fn()
    disabledApplied.push(typeof value === 'function' ? [value] : [...(value ?? [])])
    return () => {}
  },
  connection: { fetch: { register: (route) => (disabledRegistered.push(route), () => {}) } },
}
apply(disabledCtx, { allowedPaths: [repo], diagnostics: false, attentionEnabled: false }, { execFile: fileRedirectExecFile })
check('the disabled mount still owns every disposer', disabledApplied[0].length, 6)
const disabledRoute = disabledRegistered.find((route) => route.path === ROUTES.attention)
const disabledBody = await (await disabledRoute.fetch(new Request(`http://localhost${ROUTES.attention}`))).json()
check('attentionEnabled:false says so', [disabledBody.ok, disabledBody.enabled], [true, false])
check('and still carries no sessions', disabledBody.sessions, [])
check('and still carries all five zeroed counts', disabledBody.counts, { waiting: 0, error: 0, done: 0, running: 0, idle: 0 })
check('and still carries the schema version', disabledBody.schemaVersion, ATTENTION_SCHEMA_VERSION)
check('the disabled route is still mounted', disabledRegistered.length, 4)

// 9c. a broken subsystem still answers ok:true.
const brokenAttentionRoutes = createRoutes(
  { logger, get: () => undefined },
  { allowedPaths: [repo], diagnostics: false },
  { execFile: fileRedirectExecFile, on: () => () => {} },
)
const missingService = await (await brokenAttentionRoutes.handleAttention()).json()
check('a missing sessions service answers ok:true with nothing', [missingService.ok, missingService.sessions.length], [true, 0])
check('and zeroed counts', missingService.counts, emptyAttentionCounts())
checkThat('an unroutable clock still answers a number', typeof missingService.generatedAt === 'number')
// A registry whose snapshot throws must not escape as a 500.
const throwingRoutes = createRoutes(
  { logger, get: ctx.get },
  { allowedPaths: [repo], diagnostics: false },
  { execFile: fileRedirectExecFile, on: () => () => {} },
)
throwingRoutes.attention.snapshot = () => {
  throw new Error('snapshot exploded')
}
const survivedThrow = await (await throwingRoutes.handleAttention()).json()
check('a throwing snapshot degrades to an empty answer', [survivedThrow.ok, survivedThrow.sessions.length, survivedThrow.counts], [
  true,
  0,
  emptyAttentionCounts(),
])


console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
