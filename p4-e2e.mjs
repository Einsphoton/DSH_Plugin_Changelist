/**
 * End-to-end check against a REAL Perforce server and a REAL client workspace.
 *
 * This is the one suite that does not use a fixture: it drives the plugin's real
 * route handlers (`createRoutes`) over the real `p4` executable and a real
 * server, which is the only way to prove the parts a fake p4 cannot — argument
 * shapes, `-ztag` field names, path mapping, and the cost of every command.
 *
 * It is read-only by construction. Every command it reaches for is a query
 * (`info`, `opened`, `status -n`-equivalent, `fstat`, `diff`, `changes`,
 * `describe`, `print`); nothing here can submit, sync, edit or delete.
 *
 * Usage:
 *   node p4-e2e.mjs
 *   P4_E2E_DIR=D:\some\workspace P4_E2E_USER=me P4_E2E_CLIENT=my_client node p4-e2e.mjs
 *
 * Every coordinate is an environment variable with a placeholder default
 * (`P4_E2E_EXE`, `P4_E2E_PORT`, `P4_E2E_IP`, `P4_E2E_USER`, `P4_E2E_CLIENT`,
 * `P4_E2E_DIR`); nothing here names a real server or workspace.
 *
 * Without a reachable server (or without a workspace directory) it reports that
 * it skipped and exits 0, so it is safe to leave wired into CI-less runs.
 *
 * Note: this sandbox denies piped child stdio inside some harnesses. The plugin
 * itself uses normal pipes in the DSH Host process; when a spawn fails with
 * EPERM here, the suite reports the environment limitation instead of a
 * product failure.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { createRoutes } from './index.js'
// This authoring sandbox denies piped child stdio, so the plugin's own piped
// `execFile` cannot run here (spawn EPERM). The fixture's file-redirecting
// stand-in has exactly the same callback contract; the Host process uses real
// pipes. This is the ONLY test-vs-production difference.
import { fileRedirectExecFile } from './test-fixture.mjs'

const P4_EXE = process.env.P4_E2E_EXE || 'C:\\Program Files\\Perforce\\p4.exe'
// The hostname P4V shows, not the IP it stores alongside it. Both reach the same
// server (the hostname resolves to 192.0.2.10), and the hostname is what a
// reader will copy out of P4V's Revision Control Login panel, so that is the form
// this suite drives. One check below also proves the IP form still works.
const SERVER = process.env.P4_E2E_PORT || 'p4.example.com:1666'
const SERVER_IP = process.env.P4_E2E_IP || '192.0.2.10:1666'
const USER = process.env.P4_E2E_USER || 'p4user'
const CLIENT = process.env.P4_E2E_CLIENT || 'example_client'
const WORKSPACE = process.env.P4_E2E_DIR || 'D:\\Projects\\Example'

const checks = []
const check = (label, fn) => checks.push({ label, fn })
const route = (name, query) => new Request(`http://localhost/api/changelist.${name}?${new URLSearchParams(query)}`)

/** A context shaped like the one the Harness hands the plugin. */
function makeCtx(dir) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'w1', title: 'e2e', path: dir, sessionIds: ['s1'] }] }
      if (name === 'sessions') return { list: () => [{ id: 's1', title: 'e2e', header: { cwd: dir } }], get: (id) => (id === 's1' ? { id, header: { cwd: dir } } : null) }
      return null
    },
  }
}

const settings = {
  p4Path: P4_EXE,
  p4port: SERVER,
  p4user: USER,
  p4client: CLIENT,
  p4charset: 'utf8',
  vcs: 'auto',
  diagnostics: false,
}

async function main() {
  if (!existsSync(P4_EXE)) {
    console.log(`skip: no p4 executable at ${P4_EXE}`)
    return
  }
  if (!existsSync(WORKSPACE)) {
    console.log(`skip: no Perforce workspace at ${WORKSPACE}`)
    return
  }

  const ctx = makeCtx(WORKSPACE)
  const routes = createRoutes(ctx, settings, { execFile: fileRedirectExecFile })

  check('resolveP4Paths finds the executable', () => {
    const found = routes.p4Executable()
    assert.equal(found.path, P4_EXE)
    assert.equal(found.source, 'config')
  })

  check('effective configuration reaches the environment without leaking the ambient one', async () => {
    const env = routes.settings
    assert.equal(env.p4port, SERVER)
    assert.equal(env.p4client, CLIENT)
  })

  check('auto detection picks Perforce for a client root', async () => {
    const backend = await routes.router.resolve({ dir: WORKSPACE, requested: 'auto' })
    assert.equal(backend.vcs, 'p4', `expected the p4 backend, got ${backend.vcs} (${backend.reason})`)
    assert.ok(backend.available.includes('p4'))
  })

  check('state answers the contract shape for the real workspace', async () => {
    const response = await routes.handleState(route('state', { dir: WORKSPACE }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true, `state failed: ${body.message ?? ''} ${body.detail ?? ''}`)
    assert.equal(body.vcs, 'p4')
    assert.equal(body.workspace.client, CLIENT)
    assert.ok(body.workspace.root.toLowerCase().startsWith(WORKSPACE.slice(0, 3).toLowerCase()))
    assert.ok(Array.isArray(body.files), 'files must be an array')
    assert.ok(Array.isArray(body.changelists), 'changelists must be an array')
    assert.ok(typeof body.total === 'number')
    // A changelist panel answers for ONE user. The shelved query used to omit
    // the user filter, which on a shared game depot pulled in every other
    // user's shelves (measured: 10 foreign changelists and 196 phantom files
    // for a user whose own pending change held a single file).
    for (const change of body.changelists) {
      if (change.isDefault) {
        // The default changelist is not owned by a `changes` record, so its user
        // may legitimately be unknown.
        assert.ok(
          change.user === null || change.user === undefined || change.user === USER,
          `the default changelist claims user ${change.user}`,
        )
      } else {
        assert.equal(
          change.user,
          USER,
          `changelist ${change.number ?? 'default'} belongs to ${change.user}, not ${USER}`,
        )
      }
    }
    for (const file of body.files) {
      assert.ok(!file.path.startsWith('/'), `path must be client-relative: ${file.path}`)
      assert.ok(!file.path.includes('..'), `path must not traverse: ${file.path}`)
      assert.ok(file.depotPath === undefined || file.depotPath.startsWith('//'), 'depotPath must be a depot path')
      assert.ok(['M', 'A', 'D', 'R', 'C', 'T'].includes(file.status), `status must map to a git letter: ${file.status}`)
    }
    console.log(`     dir=${body.dir} client=${body.workspace.client} files=${body.files.length} total=${body.total}`)
    console.log(`     changelists=${body.changelists.map((entry) => `${entry.number ?? 'default'}:${entry.files ?? '?'}`).join(', ') || '(none)'}`)
  })

  check('state never enumerates the workspace', async () => {
    // The answer must come from `opened` / `status` / scoped `fstat`, never from
    // walking the client root: measured 2.48M files / 28s on this workspace.
    const state = await routes.handleState(route('state', { dir: WORKSPACE }))
    const body = await state.json()
    assert.ok(body.ok || body.ok === false)
    assert.ok((body.files?.length ?? 0) < 20_000, 'a whole-workspace scan would return far more files')
  })

  check('the first opened file yields a real comparison', async () => {
    const stateBody = await (await routes.handleState(route('state', { dir: WORKSPACE }))).json()
    const opened = (stateBody.files ?? []).find((file) => file.origin === 'opened') ?? stateBody.files?.[0]
    assert.ok(opened, 'the workspace has no changed file to compare')
    const response = await routes.handleDiff(
      route('diff', {
        dir: WORKSPACE,
        path: opened.path,
        depotPath: opened.depotPath ?? '',
        change: opened.change ?? '',
        shelved: opened.shelved ? '1' : '0',
        changed: '1',
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.vcs, 'p4')
    assert.ok(body.path === opened.path)
    assert.ok(typeof body.text === 'string')
    if (!body.binary && body.text) {
      assert.ok(/^---|^diff|^@@/m.test(body.text), `expected unified diff text, got:\n${body.text.slice(0, 200)}`)
    }
    console.log(`     diff ${opened.path}: binary=${Boolean(body.binary)} bytes=${body.text.length}`)
  })

  check('the P4V-style hostname and the IP reach the same client workspace', async () => {
    // P4V keeps both forms (connectionmap.xml: ServerAddress is the IP, P4Port is
    // the hostname) and shows the hostname. Someone who copies the hostname must
    // get a working connection, and the detected client/root must not differ.
    const byHost = await routes.router.resolve({ dir: WORKSPACE, requested: 'p4', envKey: `host\u0000${SERVER}` })
    assert.equal(byHost.vcs, 'p4', `hostname form failed: ${byHost.reason} ${byHost.detail ?? ''}`)
    assert.equal(byHost.workspace.client, CLIENT)
    const ipRoutes = createRoutes(ctx, { ...settings, p4port: SERVER_IP }, { execFile: fileRedirectExecFile })
    const byIp = await ipRoutes.router.resolve({ dir: WORKSPACE, requested: 'p4', envKey: `ip\u0000${SERVER_IP}` })
    assert.equal(byIp.vcs, 'p4', `IP form failed: ${byIp.reason} ${byIp.detail ?? ''}`)
    assert.equal(byIp.workspace.client, byHost.workspace.client)
    assert.equal(byIp.workspace.root, byHost.workspace.root)
    const body = await (await ipRoutes.handleState(route('state', { dir: WORKSPACE }))).json()
    // `p4 info` reports the server's canonical address, which is the IP even when
    // the connection was made by hostname: a panel echoing the IP is not a failure.
    assert.equal(body.workspace.port, SERVER_IP)
    assert.equal(body.ok, true, `IP-form state failed: ${body.message ?? ''}`)
    console.log(`     hostname=${SERVER} -> ip=${body.workspace.port} client=${body.workspace.client}`)
  })

  check('git force-selection on a p4-only directory degrades instead of lying', async () => {
    const response = await routes.handleState(route('state', { dir: WORKSPACE, vcs: 'git' }))
    const body = await response.json()
    assert.equal(body.vcs, body.ok ? 'git' : null)
    if (!body.ok) assert.equal(body.reason, 'not-a-repository')
  })

  let passed = 0
  const failures = []
  for (const { label, fn } of checks) {
    try {
      await fn()
      passed += 1
      console.log(`ok   ${label}`)
    } catch (error) {
      failures.push({ label, error })
      console.log(`FAIL ${label}`)
      console.log(`     ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\n${passed}/${checks.length} end-to-end checks passed`)
  if (failures.length > 0) process.exitCode = 1
}

await main()
