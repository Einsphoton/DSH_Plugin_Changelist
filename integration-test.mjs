/**
 * Integration test against the **real Cordis framework**: it loads the plugin
 * the way the Harness loader does (module `inject` + `apply`) and checks the
 * lifecycle contract the plugin depends on.
 *
 *   node dsh-changelist/integration-test.mjs "<path to the @deepseek-ai/cordis package>"
 *
 * Resolve that path from your installation, for example the extracted
 * `dsh/node_modules/@deepseek-ai/cordis` of `resources/app.asar`, or any DSH
 * source checkout. This suite deliberately exercises only framework wiring —
 * the git-dependent behaviour is covered by `host-test.mjs`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply, inject as pluginInject, name as pluginName, ROUTES } from './index.js'
import { buildFixture } from './test-fixture.mjs'

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const requested = process.argv[2] ?? process.env.DSH_CORDIS_DIR
if (!requested) {
  console.error(
    'usage: node dsh-changelist/integration-test.mjs "<path to @deepseek-ai/cordis package>"\n' +
      '       (or set DSH_CORDIS_DIR)',
  )
  process.exit(2)
}
const entry = fs.existsSync(path.join(requested, 'lib', 'index.js'))
  ? path.join(requested, 'lib', 'index.js')
  : requested
if (!fs.existsSync(entry)) {
  console.error(`no cordis entry at ${entry}`)
  process.exit(2)
}
const { Context } = await import(pathToFileURL(entry).href)

const repo = buildFixture().repo

console.log('1. module contract')
check('plugin name', pluginName, 'changelist')
check('hard dependency', pluginInject, ['connection'])
check('apply is a function', typeof apply, 'function')

console.log('2. the plugin waits for its injected service')
const routes = new Map()
const connection = {
  fetch: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      // The shipped fence returns an async disposer; mirror that shape.
      return async () => {
        routes.delete(route.path)
      }
    },
  },
}

const ctx = new Context()
const fiber = ctx.plugin({ inject: pluginInject, apply }, { allowedPaths: [repo] })
await settle()
check('fiber is not yet active', routes.size, 0)
check('no route exists before provide', [...routes.keys()], [])

console.log('3. providing the service activates the plugin')
ctx.provide('connection', connection)
await settle()
check('three routes registered', routes.size, 3)
check('route paths', [...routes.keys()].sort(), [ROUTES.diff, ROUTES.state, ROUTES.targets].sort())
checkThat('all routes are under /api', [...routes.keys()].every((p) => p.startsWith('/api/')), [...routes.keys()].join())
checkThat('all routes are GET+buffered', [...routes.values()].every((r) => r.methods.join() === 'GET' && r.requestBody === 'buffered'))

console.log('4. a registered route answers a real Request')
const targetsResponse = await routes.get(ROUTES.targets).fetch(new Request(`http://localhost${ROUTES.targets}`))
check('targets route status', targetsResponse.status, 200)
const targetsBody = await targetsResponse.json()
checkThat('targets route lists the fixture', targetsBody.targets?.some((t) => t.dir === repo), JSON.stringify(targetsBody).slice(0, 200))

const stateResponse = await routes.get(ROUTES.state).fetch(
  new Request(`http://localhost${ROUTES.state}?dir=${encodeURIComponent(repo)}`),
)
check('state route answers a JSON Response', stateResponse.headers.get('content-type'), 'application/json; charset=utf-8')
const stateBody = await stateResponse.json()
checkThat('state route never throws through the fence', typeof stateBody === 'object' && stateBody !== null, JSON.stringify(stateBody).slice(0, 200))
// In a restricted sandbox the production runner cannot pipe child stdio, so git
// is unavailable and the route must still answer structurally rather than throw.
checkThat(
  'git failure degrades structurally',
  stateBody.ok === true || typeof stateBody.reason === 'string' || typeof stateBody.message === 'string',
  JSON.stringify(stateBody).slice(0, 200),
)

console.log('5. unloading releases the routes')
await fiber.dispose()
await settle()
check('routes removed on dispose', routes.size, 0)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
