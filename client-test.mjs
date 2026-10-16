/**
 * Browser-half verification without a browser.
 *
 * Loads `client.js` the way the ModuleLoader does (capturing the registered
 * factory), runs `apply` against a stub context, then drives the real components
 * through a miniature React shim and a stubbed `fetch`: the chip populates from
 * the host routes, clicking it opens the floating summary, and Escape closes it.
 *
 *   node dsh-changelist/client-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchored to this file, not to the current directory, so the suite runs the
// same way from the package directory and from the workspace root.
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(PACKAGE_DIR, 'client.js'), 'utf8')

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

// ---------------------------------------------------------------- environment stubs
const WORKSPACE_DIR = 'C:/work/repo'
const SESSION_DIR = 'C:/work/session-repo'
const SESSION_ID = 'sess-1'

const hookQueue = []
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState(initial) {
    const seeded = hookQueue.length > 0 ? hookQueue.shift() : undefined
    return [seeded === undefined ? initial : seeded, () => {}]
  },
  useEffect(fn) {
    const cleanup = fn()
    void cleanup
    return undefined
  },
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial }
  },
}

const styleTags = []
const document = {
  head: {
    appendChild(tag) {
      styleTags.push(tag)
    },
  },
  querySelector() {
    return null
  },
  createElement() {
    return { dataset: {}, textContent: '', remove() {} }
  },
}

const requests = []
const statePayload = {
  ok: true,
  dir: SESSION_DIR,
  branch: 'main',
  base: 'origin/main',
  baseKind: 'upstream',
  ahead: 1,
  behind: 0,
  total: 3,
  truncated: false,
  notes: ['示例提示'],
  fetch: null,
  files: [
    { path: 'src/a.js', status: 'M', added: 1, deleted: 0, binary: false, untracked: false, oldPath: null },
    { path: 'src/new name.js', status: 'R', added: 0, deleted: 0, binary: false, untracked: false, oldPath: 'src/old name.js' },
    { path: 'blob.bin', status: 'A', added: null, deleted: 0, binary: true, untracked: true, oldPath: null },
  ],
}
const targetsPayload = {
  ok: true,
  targets: [
    { kind: 'workspace', id: 'w1', title: 'repo', dir: WORKSPACE_DIR, live: false, sessions: 2 },
    { kind: 'session', id: SESSION_ID, title: 'session-repo', dir: SESSION_DIR, live: true, sessions: null },
  ],
}
const diffPayload = {
  ok: true,
  path: 'src/a.js',
  base: 'origin/main',
  binary: false,
  truncated: false,
  text: [
    'diff --git a/src/a.js b/src/a.js',
    'index 4171549..6c697f4 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1,2 @@',
    ' export const a = 1',
    '+export const a2 = 3',
    '-export const removed = 0',
    '',
  ].join('\n'),
}

const fetchStub = async (url) => {
  requests.push(String(url))
  // Optional fault injection: reject the sessionId form once, as an older host
  // half would, so the client's `dir` fallback can be exercised.
  if (rejectSessionId && String(url).includes('sessionId=')) {
    return {
      ok: false,
      status: 400,
      async json() {
        return { ok: false, message: 'dir 必须是存在的绝对目录路径' }
      },
    }
  }
  if (stateFails && String(url).includes('.state')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: false,
          reason: 'not-a-repository',
          dir: WORKSPACE_DIR,
          message: '该目录不在 git 工作区内',
          detail: 'fatal: not a git repository (or any of the parent directories): .git',
        }
      },
    }
  }
  // Optional: a p4-shaped `.state` answer for the Perforce UI coverage that
  // follows. `null` (the default) keeps the original git payload in charge, so
  // every assertion above sees exactly what it saw before.
  if (p4StatePayload !== null && String(url).includes('.state')) {
    const body = p4StatePayload
    return {
      ok: true,
      status: 200,
      async json() {
        return body
      },
    }
  }
  const body = String(url).includes('.targets') ? targetsPayload : String(url).includes('.diff') ? diffPayload : statePayload
  return {
    ok: true,
    status: 200,
    async json() {
      return body
    },
  }
}
let rejectSessionId = false
let stateFails = false
let p4StatePayload = null

const localStorageStore = new Map()
const keyHandlers = new Set()
const window = {
  innerWidth: 1400,
  innerHeight: 900,
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  localStorage: {
    getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
    setItem: (key, value) => localStorageStore.set(key, value),
  },
  addEventListener(type, handler) {
    if (type === 'keydown') keyHandlers.add(handler)
  },
  removeEventListener(type, handler) {
    if (type === 'keydown') keyHandlers.delete(handler)
  },
}

let captured = null
globalThis.window = window
globalThis.document = document
globalThis.fetch = fetchStub

// ---------------------------------------------------------------- load the module
console.log('1. module contract')
const evaluate = new Function('window', 'document', 'fetch', 'URL', 'URLSearchParams', 'console', `${source}\nreturn undefined`)
evaluate(window, document, fetchStub, URL, URLSearchParams, console)
checkThat('client.js registers one factory', captured !== null && typeof captured.factory === 'function', String(captured))
check('factory id', captured.id, '@local/dsh-changelist')

const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('inject list', mod.inject, ['slots', 'locale', 'sessions'])
check('apply is a function', typeof mod.apply, 'function')

// ---------------------------------------------------------------- apply + registration
console.log('2. slot and locale registration')
const registered = []
const owners = []
const dictionaries = []
const effects = []
const ctx = {
  effect(fn, label) {
    effects.push(label)
    void fn()
  },
  // Mirrors the client session service shape the shipped sidebar reads.
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { 'sess-1': { id: 'sess-1', retainedBy: { mainView: 2 } } } }),
    },
  },
  locale: {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict })
    },
    bind(namespace) {
      return (key, values) => {
        const dict = dictionaries.find((entry) => entry.namespace === namespace)?.dict ?? {}
        const template = (dict.zh ?? {})[key] ?? key
        return String(template).replace(/\{(\w+)\}/g, (match, k) =>
          values && values[k] !== undefined ? String(values[k]) : match,
        )
      }
    },
  },
  slots: {
    inject(owner, register) {
      owners.push(owner)
      void register()
    },
    register(options, component) {
      registered.push({ ...options, component })
      return () => {}
    },
  },
}
mod.apply(ctx)

check('two surfaces registered', registered.map((entry) => entry.name), ['conversation.session.header.utilities', 'shell.overlay'])
check('chip entry id', registered[0]?.id, 'changelist.chip')
check('popover entry id', registered[1]?.id, 'changelist.popover')
check('both await their owning declaration', owners, ['conversation.session.header.utilities', 'shell.overlay'])
const chipFace = typeof registered[0]?.inject === 'function' ? registered[0].inject() : {}
checkThat('the chip registration carries the viewed-session getter', typeof chipFace.getViewedSessionId === 'function', JSON.stringify(Object.keys(chipFace)))
check('it derives the session the main view retains', chipFace.getViewedSessionId?.(), 'sess-1')
check('locale namespace', dictionaries[0]?.namespace, 'dsh-changelist')
checkThat('chinese dictionary present', typeof dictionaries[0]?.dict.zh.panel === 'string')
checkThat('english dictionary present', typeof dictionaries[0]?.dict.en.panel === 'string')
check('effects registered', effects.length, 2)
checkThat('a style tag was injected', styleTags.length === 1, String(styleTags.length))
checkThat('styles are plugin-prefixed', String(styleTags[0]?.textContent ?? '').includes('.dshCl_chip'), 'unprefixed css')
checkThat('a floating surface is positioned, not in flow', String(styleTags[0]?.textContent ?? '').includes('.dshCl_pop{position:absolute'), 'no absolute popover')

const Chip = registered[0].component
const Popover = registered[1].component
const t = ctx.locale.bind('dsh-changelist')

// ---------------------------------------------------------------- helpers
function expand(node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props }))
  const { children, ...rest } = node.props ?? {}
  return { type: node.type, props: rest, children: children === undefined ? [] : [].concat(expand(children)) }
}
function collectClasses(node, out = []) {
  if (!node || typeof node !== 'object') return out.join(' ')
  if (Array.isArray(node)) {
    node.forEach((child) => collectClasses(child, out))
    return out.join(' ')
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  ;(node.children ?? []).forEach((child) => collectClasses(child, out))
  return out.join(' ')
}
function collectText(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach((child) => collectText(child, out))
    else (node.children ?? []).forEach((child) => collectText(child, out))
  }
  return out.join(' | ')
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return null
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

// ---------------------------------------------------------------- the chip
console.log('3. the chip loads the current workspace')
requests.length = 0
let chipTree = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
await settle()
// Render again once the store has the loaded state (an empty hook queue means
// the shim seeds useState from the live store snapshot).
chipTree = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
checkThat('the chip renders its pill', collectClasses(chipTree).includes('dshCl_chip'), collectClasses(chipTree))
check('targets then state requested', requests.slice(0, 2).map((url) => url.split('?')[0]), [
  'api/changelist.targets',
  'api/changelist.state',
])
checkThat('the session is the target', requests[1].includes(`sessionId=${SESSION_ID}`), requests[1])
checkThat('requests stay document-relative', requests.every((url) => !url.startsWith('/')), requests.join())

const chipText = collectText(chipTree)
checkThat('the chip reports the file count', chipText.includes('3 个文件'), chipText)
checkThat('the chip reports added lines', chipText.includes('+1'), chipText)
checkThat('the chip reports deleted lines', chipText.includes('−0'), chipText)
checkThat('the chip shows a changed marker', collectClasses(chipTree).includes('dshCl_dot'), collectClasses(chipTree))
checkThat('the chip tooltip names branch and base', JSON.stringify(chipTree).includes('main → origin/main'), JSON.stringify(chipTree).slice(0, 300))

console.log('4. clicking the chip opens the floating summary')
const chipButton = find(chipTree, (node) => typeof node.props?.onClick === 'function' && String(node.props.className).includes('dshCl_chip'))
checkThat('the chip is a button', chipButton !== null, JSON.stringify(chipTree).slice(0, 200))
let popoverTree = expand(React.createElement(Popover, { t }))
checkThat('the summary is closed before the click', popoverTree === null, JSON.stringify(popoverTree)?.slice(0, 120))

const rect = { top: 20, bottom: 48, right: 900 }
chipButton.props.onClick({ currentTarget: { getBoundingClientRect: () => rect } })
await settle()
popoverTree = expand(React.createElement(Popover, { t }))
checkThat('the summary opens', popoverTree !== null && collectClasses(popoverTree).includes('dshCl_pop'), JSON.stringify(popoverTree)?.slice(0, 200))
check('the summary hangs under the chip', popoverTree?.props?.style, { top: '56px', right: '500px' })

const popClasses = collectClasses(popoverTree)
const popText = collectText(popoverTree)
checkThat('header rendered', popClasses.includes('dshCl_head'))
checkThat('file list rendered', popClasses.includes('dshCl_list'))
checkThat('diff pane rendered', popClasses.includes('dshCl_diffWrap'))
checkThat('added lines coloured', popClasses.includes('dshCl_addLine'))
checkThat('deleted lines coloured', popClasses.includes('dshCl_delLine'))
checkThat('hunk header coloured', popClasses.includes('dshCl_hunk'))
checkThat('a rename row shows both paths', JSON.stringify(popoverTree).includes('src/old name.js → src/new name.js'))
checkThat('the inspected directory is always on screen', collectText(popoverTree).includes(SESSION_DIR), collectText(popoverTree).slice(0, 300))
checkThat('branch and base shown', popText.includes('main') && popText.includes('origin/main'), popText.slice(0, 300))
checkThat('ahead count shown', popText.includes('↑1'), popText.slice(0, 300))
checkThat('totals shown', popText.includes('+1') && popText.includes('-0'), popText.slice(0, 300))
checkThat('the file picker appears for several targets', popClasses.includes('dshCl_select'))
checkThat('the note is rendered', popText.includes('示例提示'), popText.slice(0, 300))
checkThat('the comparison was requested', requests.some((url) => url.includes('api/changelist.diff')), requests.join())

console.log('5. Escape closes the floating summary')
const keyHandler = [...keyHandlers][0]
checkThat('an escape listener is attached while open', typeof keyHandler === 'function', String(keyHandlers.size))
if (typeof keyHandler === 'function') keyHandler({ key: 'Escape' })
popoverTree = expand(React.createElement(Popover, { t }))
checkThat('the summary closes on escape', popoverTree === null, JSON.stringify(popoverTree)?.slice(0, 120))

console.log('5b. placement')
// Too little room below the chip: the summary flips above it.
window.innerHeight = 300
chipButton.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 48, right: 1390 }) } })
await settle()
popoverTree = expand(React.createElement(Popover, { t }))
check('a short viewport flips the summary above the chip', popoverTree?.props?.style, { bottom: '288px', right: '10px' })
// No measurement available: the stylesheet's default corner stays in charge.
chipButton.props.onClick({ currentTarget: {} }) // close
chipButton.props.onClick({ currentTarget: {} }) // open, unmeasurable
popoverTree = expand(React.createElement(Popover, { t }))
checkThat('an unmeasurable chip leaves the default placement', popoverTree?.props?.style === undefined, JSON.stringify(popoverTree?.props?.style))
window.innerHeight = 900

console.log('5c. tolerating a host half that only understands dir')
rejectSessionId = true
await settle()
popoverTree = expand(React.createElement(Popover, { t }))
const refreshButton = find(
  popoverTree,
  (node) =>
    typeof node.props?.onClick === 'function' &&
    String(node.props.className).includes('dshCl_btn') &&
    collectText(node).includes('刷新'),
)
checkThat('the refresh control is rendered', refreshButton !== null, collectClasses(popoverTree))
requests.length = 0
refreshButton.props.onClick()
await settle()
checkThat('the session form is tried first', String(requests[0] ?? '').includes('sessionId='), requests.join(' | '))
checkThat(
  'a rejected session request is retried with dir',
  requests.some((url) => url.includes('changelist.state') && url.includes('dir=')),
  requests.join(' | '),
)
popoverTree = expand(React.createElement(Popover, { t }))
checkThat('the state still loads through the fallback', collectClasses(popoverTree).includes('dshCl_list'), collectClasses(popoverTree))
checkThat('the older host half is named on screen', collectText(popoverTree).includes('已改用目录方式'), collectText(popoverTree).slice(0, 300))
rejectSessionId = false

console.log('6. degraded locale surface')
const degradedRegistered = []
const degradedOwners = []
const degradedEffects = []
mod.apply({
  effect(fn, label) {
    degradedEffects.push(label)
    void fn()
  },
  locale: { register: 'not a function', bind: 'not a function' },
  slots: {
    inject(owner, register) {
      degradedOwners.push(owner)
      void register()
    },
    register(options) {
      degradedRegistered.push(options.name)
      return () => {}
    },
  },
})
check('both surfaces still register', degradedRegistered, ['conversation.session.header.utilities', 'shell.overlay'])
check('the same declarations were awaited', degradedOwners, ['conversation.session.header.utilities', 'shell.overlay'])
check('only the style effect remains', degradedEffects.length, 1)

const degradedTree = expand(React.createElement(Chip, { sessionId: SESSION_ID }))
checkThat('the chip renders without a translator', typeof degradedTree === 'object' && degradedTree !== null)
const degradedText = collectText(degradedTree)
checkThat(
  'it falls back to message keys instead of copy',
  /shortFiles|summary|clean/.test(degradedText) && !degradedText.includes('工作区改动'),
  degradedText,
)

console.log('7. the session always outranks a remembered directory')
hookQueue.length = 0
localStorageStore.set('dsh-changelist.dir.v2', WORKSPACE_DIR)
requests.length = 0
expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
await settle()
checkThat('the session is targeted, not the remembered workspace', requests.some((url) => url.includes(`sessionId=${SESSION_ID}`)), requests.join(' | '))
checkThat('the remembered directory is not used', !requests.some((url) => url.includes(`dir=${encodeURIComponent(WORKSPACE_DIR)}`)), requests.join(' | '))

console.log('7b. a session missing from the live list is still targeted')
hookQueue.length = 0
requests.length = 0
expand(React.createElement(Chip, { t, getViewedSessionId: () => 'sess-ghost' }))
await settle()
checkThat('the derived session is used even when the list lacks it', requests.some((url) => url.includes('sessionId=sess-ghost')), requests.join(' | '))

console.log('7c. a failing target keeps the picker and shows git detail')
stateFails = true
await settle()
let openTree = expand(React.createElement(Popover, { t }))
if (openTree === null) {
  const chipNow = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
  const openButton = find(
    chipNow,
    (node) => typeof node.props?.onClick === 'function' && String(node.props.className).includes('dshCl_chip'),
  )
  openButton?.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 48, right: 900 }) } })
  await settle()
  openTree = expand(React.createElement(Popover, { t }))
}
const refreshNow = find(
  openTree,
  (node) =>
    typeof node.props?.onClick === 'function' &&
    String(node.props.className).includes('dshCl_btn') &&
    collectText(node).includes('刷新'),
)
refreshNow?.props.onClick()
await settle()
const failedTree = expand(React.createElement(Popover, { t }))
checkThat('the picker survives a failing target', collectClasses(failedTree).includes('dshCl_select'), collectClasses(failedTree))
checkThat('git’s own words are shown', collectText(failedTree).includes('fatal: not a git repository'), collectText(failedTree).slice(0, 400))
checkThat(
  'the failing directory is named, not guessed at',
  collectText(failedTree).includes(WORKSPACE_DIR) && collectClasses(failedTree).includes('dshCl_dir'),
  collectText(failedTree).slice(0, 400),
)
checkThat('and the reader is told what to do', collectText(failedTree).includes('git init'), collectText(failedTree).slice(0, 400))

const noRepoChip = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
const noRepoChipButton = find(
  noRepoChip,
  (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshCl_chip'),
)
const noRepoDot = find(noRepoChip, (node) => typeof node.props?.className === 'string' && node.props.className === 'dshCl_dot')
check('a non-repo workspace reads neutral, not as an error', noRepoDot?.props?.['data-state'], 'norepo')
checkThat('and says so on the chip', collectText(noRepoChipButton).includes('非 git 工作区'), collectText(noRepoChipButton))

stateFails = false

// A genuine failure still reads as an error.
hookQueue.length = 0
await settle()
const errorChip = expand(React.createElement(Chip, { t, sessionId: 'sess-unknown', getViewedSessionId: () => 'sess-unknown' }))
const errorDot = find(errorChip, (node) => typeof node.props?.className === 'string' && node.props.className === 'dshCl_dot')
checkThat('a missing session still reads as an error', errorDot?.props?.['data-state'] !== 'norepo', JSON.stringify(errorDot?.props))

console.log('7d. the chip follows a session that appears late (the mount race)')
hookQueue.length = 0
localStorageStore.set('dsh-changelist.dir.v2', WORKSPACE_DIR)
requests.length = 0
// The session store is empty at mount, exactly as observed in the live log.
let retainedSession = null
const sessionListeners = new Set()
const lateCtx = {
  effect(fn, label) {
    void label
    void fn()
  },
  locale: ctx.locale,
  sessions: {
    list: {
      getSnapshot: () => ({ byId: retainedSession ? { [retainedSession]: { id: retainedSession, retainedBy: { mainView: 1 } } } : {} }),
      subscribe: (listener) => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
    },
  },
  slots: ctx.slots,
}
mod.apply(lateCtx)
const lateChip = registered.at(-2)
const lateFace = lateChip.inject()
checkThat('the registration exposes a session watcher', typeof lateFace.subscribeViewedSession === 'function', JSON.stringify(Object.keys(lateFace)))
expand(React.createElement(lateChip.component, { t, getViewedSessionId: lateFace.getViewedSessionId, subscribeViewedSession: lateFace.subscribeViewedSession }))
await settle()
checkThat('with no session yet it falls back to the remembered directory', requests.some((url) => url.includes('dir=')), requests.join(' | '))
// Now the session store is seeded and notifies its subscribers.
retainedSession = 'sess-late'
requests.length = 0
for (const listener of [...sessionListeners]) listener()
await settle()
checkThat('the chip re-targets once the session appears', requests.some((url) => url.includes('sessionId=sess-late')), requests.join(' | '))

// ════════════════════════════════════════════════════════════════════════════
// Perforce UI (task-4). Appended after the original suite so every assertion
// above keeps its original context; nothing here weakens or reorders them.
// The p4-shaped `.state` answers are injected through `p4StatePayload`.
// ════════════════════════════════════════════════════════════════════════════
const VCS_KEY = 'dsh-changelist.vcs.v3'
const P4_PAYLOADS = {
  // One default changelist, one numbered changelist, one local-only edit; the
  // numbered changelist holds a shelved + out-of-sync file and a plain opened one.
  group: {
    ok: true,
    vcs: 'p4',
    dir: SESSION_DIR,
    base: '//depot/main',
    total: 4,
    truncated: false,
    notes: [],
    workspace: {
      root: 'C:/work/p4',
      client: 'ws-1',
      port: 'p4:1666',
      user: 'alice',
      charset: 'none',
      stream: '//stream/main',
    },
    options: { localEdits: false, scanTimeoutMs: 30000 },
    changelists: [
      { isDefault: true, change: 0, description: '', user: 'alice' },
      { change: 1234, description: 'Fix the widget\nsecond line', user: 'bob', shelved: true },
    ],
    files: [
      {
        path: 'src/shelved.js', status: 'A', added: 3, deleted: 0, binary: false, untracked: false, oldPath: null,
        change: 1234, origin: 'shelved', shelved: true, needsSync: true, action: 'add', depotPath: '//depot/src/shelved.js',
      },
      {
        path: 'src/open.js', status: 'M', added: 1, deleted: 2, binary: false, untracked: false, oldPath: null,
        change: 1234, origin: 'opened', action: 'edit', depotPath: '//depot/src/open.js',
      },
      {
        path: 'src/default.js', status: 'M', added: 0, deleted: 0, binary: false, untracked: false, oldPath: null,
        change: 0, origin: 'opened',
      },
      {
        path: 'src/local.js', status: 'M', added: 2, deleted: 0, binary: false, untracked: true, oldPath: null,
        origin: 'local',
      },
    ],
  },
  unavailable: {
    ok: false,
    vcs: 'p4',
    dir: SESSION_DIR,
    reason: 'p4-unavailable',
    message: "Perforce unavailable: p4 not found at C:/p4/bin/ntx64/p4.exe",
  },
  notWorkspace: { ok: false, vcs: 'p4', dir: SESSION_DIR, reason: 'not-a-workspace' },
  bare: {
    ok: true,
    vcs: 'p4',
    dir: SESSION_DIR,
    base: '//depot/main',
    files: [{ path: 'src/bare.js', status: 'M', added: 1, deleted: 0, binary: false, untracked: false, oldPath: null, change: 7, origin: 'opened' }],
    changelists: [{ change: 7, description: 'bare answer', user: 'carol' }],
  },
}

function parseQuery(url) {
  return Object.fromEntries(new URL(String(url), 'http://localhost/').searchParams.entries())
}
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out))
    return out
  }
  if (predicate(node)) out.push(node)
  ;(node.children ?? []).forEach((child) => findAll(child, predicate, out))
  return out
}
function byClass(node, cls) {
  return findAll(node, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
}
function rowPath(row) {
  const pathNode = byClass(row, 'dshCl_path')[0]
  return pathNode ? collectText(pathNode) : null
}
function groupPaths(group) {
  const box = group ? byClass(group, 'dshCl_groupFiles')[0] : null
  return box ? byClass(box, 'dshCl_row').map(rowPath) : []
}
function groupByTitle(tree, needle) {
  return byClass(tree, 'dshCl_group').find((group) => {
    const title = byClass(group, 'dshCl_groupTitle')[0]
    return title ? collectText(title).includes(needle) : false
  })
}
/** Open the floating summary if the store has it closed, then hand back its tree. */
async function openedPopover() {
  hookQueue.length = 0
  let tree = expand(React.createElement(Popover, { t }))
  if (tree === null) {
    const chipTree = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
    const chipBtn = find(chipTree, (n) => typeof n.props?.onClick === 'function' && String(n.props.className).includes('dshCl_chip'))
    chipBtn?.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 48, right: 900 }) } })
    await settle()
    hookQueue.length = 0
    tree = expand(React.createElement(Popover, { t }))
  }
  return tree
}
/** Point the stub at a p4-shaped `.state` answer, reload for the session, render. */
async function reloadWith(key) {
  p4StatePayload = key === null ? null : P4_PAYLOADS[key]
  requests.length = 0
  hookQueue.length = 0
  expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
  await settle()
  return openedPopover()
}

console.log('8. the backend switcher in the popover header')
let pop = await reloadWith('group')
const head = byClass(pop, 'dshCl_head')[0]
const vcsSelect = byClass(pop, 'dshCl_vcs')[0]
checkThat(
  'the switcher lives inside the popover header',
  head !== undefined && byClass(head, 'dshCl_vcs').length === 1,
  collectClasses(pop).slice(0, 200),
)
const vcsOptions = findAll(vcsSelect, (n) => n.type === 'option')
check('the switcher offers exactly auto/git/p4', vcsOptions.map((option) => option.props.value), ['auto', 'git', 'p4'])
check('the switcher labels the three choices', vcsOptions.map((option) => collectText(option)), ['自动', 'git', 'Perforce'])
check('the switcher defaults to auto', vcsSelect.props.value, 'auto')

const firstState = parseQuery(requests.find((url) => url.includes('.state')))
check('the first state request targets the session', firstState.sessionId, SESSION_ID)
checkThat(
  'an untouched connection panel sends no p4 parameters',
  ['p4port', 'p4user', 'p4client', 'p4charset'].every((name) => !(name in firstState)),
  JSON.stringify(firstState),
)
checkThat('an untouched localEdits is omitted entirely', !('localEdits' in firstState), JSON.stringify(firstState))

requests.length = 0
vcsSelect.props.onChange({ target: { value: 'p4' } })
await settle()
check('choosing Perforce writes the v3 localStorage key', localStorageStore.get(VCS_KEY), 'p4')
const stateAfterSwitch = requests.filter((url) => url.includes('.state')).map(parseQuery)
const diffAfterSwitch = requests.filter((url) => url.includes('.diff')).map(parseQuery)
checkThat(
  'the next state request carries vcs=p4',
  stateAfterSwitch.length > 0 && stateAfterSwitch.every((query) => query.vcs === 'p4'),
  JSON.stringify(stateAfterSwitch),
)
checkThat(
  'the next diff request carries vcs=p4 too',
  diffAfterSwitch.length > 0 && diffAfterSwitch.every((query) => query.vcs === 'p4'),
  JSON.stringify(diffAfterSwitch),
)
checkThat(
  'the switcher re-targets nothing: the session is still queried',
  stateAfterSwitch.every((query) => query.sessionId === SESSION_ID && !('dir' in query)),
  JSON.stringify(stateAfterSwitch),
)
hookQueue.length = 0
let swTree = expand(React.createElement(Popover, { t }))
check('the switcher shows the stored choice', byClass(swTree, 'dshCl_vcs')[0]?.props.value, 'p4')
check('the target picker still points at the session', byClass(swTree, 'dshCl_select')[0]?.props.value, `session:${SESSION_ID}`)
requests.length = 0
byClass(swTree, 'dshCl_vcs')[0].props.onChange({ target: { value: 'auto' } })
await settle()
check('switching back to auto is remembered as auto', localStorageStore.get(VCS_KEY), 'auto')
checkThat(
  'and rides the next state request',
  requests.filter((url) => url.includes('.state')).map(parseQuery).some((query) => query.vcs === 'auto'),
  requests.join(' | '),
)

console.log('9. changelists group the changed files')
pop = await reloadWith('group')
check('the grouped container is rendered', byClass(pop, 'dshCl_groups').length, 1)
const groupNodes = byClass(pop, 'dshCl_group')
check('one header per changelist plus the separate local group', groupNodes.length, 3)
check(
  'headers name default, the change number and the local group',
  groupNodes.map((group) => collectText(byClass(group, 'dshCl_groupTitle')[0])),
  ['default', '变更 1234', '本地未 opened 改动'],
)
check(
  'the header carries the change description (first line only)',
  groupNodes.map((group) => collectText(byClass(group, 'dshCl_groupDesc')[0])),
  ['（无描述）', 'Fix the widget', '不在任何 changelist 中的本地改动'],
)
check(
  'the header carries the user and the file count',
  groupNodes.map((group) => collectText(byClass(group, 'dshCl_groupMeta')[0])),
  ['alice | 1 个文件', 'bob | 2 个文件', '1 个文件'],
)
checkThat(
  'the local group is styled apart from named changelists',
  byClass(groupNodes[2], 'dshCl_groupTitleLocal').length === 1,
  collectClasses(groupNodes[2]),
)
check('the default changelist holds its file', groupPaths(groupNodes[0]), ['src/default.js'])
check('the numbered changelist holds both of its files', groupPaths(groupNodes[1]), ['src/shelved.js', 'src/open.js'])
check('the local edit sits in its own group', groupPaths(groupNodes[2]), ['src/local.js'])
check('a local row exposes its origin', byClass(groupNodes[2], 'dshCl_row')[0].props['data-origin'], 'local')
check('every file is accounted for exactly once', groupNodes.flatMap(groupPaths).length, 4)

console.log('9b. without a changelists array the flat list is exactly as before')
pop = await reloadWith(null)
check('git renders no changelist groups', byClass(pop, 'dshCl_groups').length, 0)
check('and the rows stay flat', byClass(pop, 'dshCl_row').map(rowPath), ['src/a.js', 'src/new name.js', 'blob.bin'])
checkThat('the list surface itself is unchanged', byClass(pop, 'dshCl_list').length === 1, collectClasses(pop))

console.log('10. shelved / needs-sync badges')
pop = await reloadWith('group')
const rowOf = (tree, wanted) => byClass(tree, 'dshCl_row').find((row) => rowPath(row) === wanted)
const shelvedRow = rowOf(pop, 'src/shelved.js')
check(
  'a shelved, out-of-sync row shows action + shelved + needs-sync badges',
  byClass(shelvedRow, 'dshCl_badge').map((badge) => collectText(badge)),
  ['add', 'shelved', '需同步'],
)
checkThat('the row is tinted for shelved content', String(shelvedRow?.props.className).includes('dshCl_rowShelved'), shelvedRow?.props.className)
const openRow = rowOf(pop, 'src/open.js')
check('an opened row shows only its action badge', byClass(openRow, 'dshCl_badge').map((badge) => collectText(badge)), ['edit'])
check('a plain row shows no badges at all', byClass(rowOf(pop, 'src/default.js'), 'dshCl_badge').length, 0)
const headerOf = (group) => find(group, (n) => n.props?.className === 'dshCl_groupHead')
const shelvedHeader = groupByTitle(pop, '1234')
check('the changelist header aggregates the shelved badge', byClass(headerOf(shelvedHeader), 'dshCl_badgeShelved').length, 1)
check('a header without shelved work stays unmarked', byClass(headerOf(groupByTitle(pop, 'default')), 'dshCl_badgeShelved').length, 0)
check('needs-sync is not aggregated onto the group header', byClass(headerOf(shelvedHeader), 'dshCl_badgeSync').length, 0)

console.log('10b. the chip and the popover header carry the backend marker')
pop = await reloadWith('group')
hookQueue.length = 0
let markerChip = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
check('the chip marks the Perforce backend', collectText(find(markerChip, (n) => n.props?.className === 'dshCl_backend')), 'P4')
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('the popover header marks it too', collectText(byClass(pop, 'dshCl_backend')[0]), 'P4')
pop = await reloadWith(null)
hookQueue.length = 0
markerChip = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
check('the chip marks git when the answer carries no p4 fields', collectText(find(markerChip, (n) => n.props?.className === 'dshCl_backend')), 'git')
check('and the git header keeps its marker', collectText(byClass(pop, 'dshCl_backend')[0]), 'git')

console.log('11. group collapse lives in the store, keyed per target')
pop = await reloadWith('group')
const headButton = (tree) => find(groupByTitle(tree, '1234'), (n) => n.props?.className === 'dshCl_groupHead')
check('a group starts expanded', headButton(pop).props['aria-expanded'], 'true')
headButton(pop).props.onClick()
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('clicking the header hides its files', groupPaths(groupByTitle(pop, '1234')), [])
check('and the header reports collapsed', headButton(pop).props['aria-expanded'], 'false')
check('its sibling group keeps its files', groupPaths(groupByTitle(pop, 'default')), ['src/default.js'])
check('the local group keeps its files', groupPaths(groupByTitle(pop, '本地未 opened 改动')), ['src/local.js'])
checkThat(
  'the collapse is never written to localStorage',
  ![...localStorageStore.keys()].some((key) => /collaps|1234|change:/iu.test(key)),
  [...localStorageStore.keys()].join(' | '),
)
headButton(pop).props.onClick()
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('clicking again expands it', groupPaths(groupByTitle(pop, '1234')), ['src/shelved.js', 'src/open.js'])
headButton(pop).props.onClick()
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('the session target remembers its collapsed group', groupPaths(groupByTitle(pop, '1234')), [])
requests.length = 0
byClass(pop, 'dshCl_select')[0].props.onChange({ target: { value: `dir:${WORKSPACE_DIR}` } })
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('another target starts with every group expanded', groupPaths(groupByTitle(pop, '1234')), ['src/shelved.js', 'src/open.js'])
byClass(pop, 'dshCl_select')[0].props.onChange({ target: { value: `session:${SESSION_ID}` } })
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('coming back, the per-target collapse is still there', groupPaths(groupByTitle(pop, '1234')), [])
headButton(pop).props.onClick()
await settle()

console.log('12. the connection panel')
pop = await reloadWith('group')
const panelToggle = byClass(pop, 'dshCl_btn').find((button) => collectText(button) === '连接')
checkThat(
  'the connection toggle is a header button reporting closed',
  panelToggle !== undefined && panelToggle.props['aria-expanded'] === 'false',
  collectClasses(byClass(pop, 'dshCl_head')[0]),
)
check('no panel renders while it is closed', byClass(pop, 'dshCl_panel').length, 0)
panelToggle.props.onClick()
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('toggling opens the connection panel', byClass(pop, 'dshCl_panel').length, 1)
check('the toggle now reports it open', byClass(pop, 'dshCl_btn').find((button) => collectText(button) === '连接').props['aria-expanded'], 'true')
const panel = byClass(pop, 'dshCl_panel')[0]
check('four override boxes render', byClass(panel, 'dshCl_input').length, 4)
check('each box is labelled with its variable', byClass(panel, 'dshCl_input').map((box) => box.props['aria-label']), ['P4PORT', 'P4USER', 'P4CLIENT', 'P4CHARSET'])
check(
  'the values the host detected are shown beside them',
  byClass(panel, 'dshCl_panelDetected').map((node) => collectText(node)),
  ['p4:1666', 'alice', 'ws-1', 'none', 'C:/work/p4'],
)
checkThat(
  'the stream and the read-only promise are on screen',
  collectText(panel).includes('//stream/main') && collectText(panel).includes('只读'),
  collectText(panel).slice(0, 300),
)
checkThat('the whole-workspace scan warning is on screen', collectText(panel).includes('整工作区扫描'), collectText(panel).slice(0, 300))
const scanBox = find(panel, (n) => n.type === 'input' && n.props?.type === 'checkbox')
checkThat('the checkbox is labelled by the scanLocalEdits string', collectText(panel).includes('扫描本地未 opened 改动'), collectText(panel).slice(0, 300))
checkThat('the host scan timeout is surfaced', collectText(panel).includes('扫描超时 30 秒'), collectText(panel))
check('with nothing chosen the box is unchecked', scanBox.props.checked, false)
const boxByLabel = (label) => byClass(panel, 'dshCl_input').find((box) => box.props['aria-label'] === label)
boxByLabel('P4PORT').props.onChange({ target: { value: '192.0.2.10:1666' } })
boxByLabel('P4USER').props.onChange({ target: { value: 'alice' } })
boxByLabel('P4CLIENT').props.onChange({ target: { value: 'ws-cli' } })
boxByLabel('P4CHARSET').props.onChange({ target: { value: 'none' } })
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check(
  'typing is reflected back into the boxes',
  byClass(byClass(pop, 'dshCl_panel')[0], 'dshCl_input').map((box) => box.props.value),
  ['192.0.2.10:1666', 'alice', 'ws-cli', 'none'],
)
const applyButton = () => find(byClass(pop, 'dshCl_panel')[0], (n) => n.props?.className === 'dshCl_btn' && collectText(n) === '应用')
requests.length = 0
applyButton().props.onClick()
await settle()
let panelQuery = parseQuery(requests.find((url) => url.includes('.state')))
check(
  'apply puts all four overrides on the state request',
  { p4port: panelQuery.p4port, p4user: panelQuery.p4user, p4client: panelQuery.p4client, p4charset: panelQuery.p4charset },
  { p4port: '192.0.2.10:1666', p4user: 'alice', p4client: 'ws-cli', p4charset: 'none' },
)
check('apply keeps the session as the target', panelQuery.sessionId, SESSION_ID)
checkThat('apply still omits localEdits while the box is untouched', !('localEdits' in panelQuery), JSON.stringify(panelQuery))
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
find(byClass(pop, 'dshCl_panel')[0], (n) => n.type === 'input' && n.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check(
  'checking the box is reflected back',
  find(byClass(pop, 'dshCl_panel')[0], (n) => n.type === 'input' && n.props?.type === 'checkbox').props.checked,
  true,
)
requests.length = 0
applyButton().props.onClick()
await settle()
panelQuery = parseQuery(requests.find((url) => url.includes('.state')))
check('the checked box sends localEdits=1', panelQuery.localEdits, '1')
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
find(byClass(pop, 'dshCl_panel')[0], (n) => n.type === 'input' && n.props?.type === 'checkbox').props.onChange({ target: { checked: false } })
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check(
  'explicitly unchecking it is reflected back',
  find(byClass(pop, 'dshCl_panel')[0], (n) => n.type === 'input' && n.props?.type === 'checkbox').props.checked,
  false,
)
requests.length = 0
applyButton().props.onClick()
await settle()
panelQuery = parseQuery(requests.find((url) => url.includes('.state')))
check('an explicit uncheck sends localEdits=0', panelQuery.localEdits, '0')
// The panel is a request-time override, never a stored setting: applying it must
// not leave the connection (or the scan choice) behind in localStorage, or a
// later session would silently inherit a stranger's P4PORT.
checkThat(
  'applying the overrides writes nothing to localStorage',
  ![...localStorageStore.keys()].some((key) => /p4port|p4user|p4client|p4charset|localEdits|172\.16\.10\.20|ws-cli/iu.test(key)) &&
    ![...localStorageStore.values()].some((value) => /172\.16\.10\.20|ws-cli/iu.test(String(value))),
  [...localStorageStore.entries()].map(([key, value]) => `${key}=${value}`).join(' | '),
)

console.log('13. degraded Perforce surfaces')
pop = await reloadWith('unavailable')
checkThat('a p4-unavailable answer paints the error surface', byClass(pop, 'dshCl_error').length > 0, collectClasses(pop).slice(0, 300))
checkThat('the p4-unavailable message reaches the reader', collectText(pop).includes('p4 not found at C:/p4/bin/ntx64/p4.exe'), collectText(pop).slice(0, 400))
checkThat('and the p4-specific hint says what to do', collectText(pop).includes('找不到或无法运行 p4 可执行文件'), collectText(pop).slice(0, 400))
check('the switcher stays usable while p4 is unavailable', byClass(pop, 'dshCl_vcs').length, 1)
// Requirement: a Perforce workspace that cannot be reached asks the reader for
// the connection by itself. `unavailable` carries no workspace/options, which is
// exactly the "nothing was detected, you have to type something" case. A git
// project never opens this panel — git needs no account.
const unavailablePanel = byClass(pop, 'dshCl_panel')[0]
checkThat(
  'a Perforce answer that cannot connect opens the connection panel by itself',
  unavailablePanel !== undefined,
  collectClasses(pop).slice(0, 200),
)
checkThat(
  'and the panel says nothing could be read from P4V',
  collectText(unavailablePanel ?? []).includes('没能从 P4V 的本地配置读到连接信息'),
  collectText(unavailablePanel ?? []).slice(0, 400),
)
hookQueue.length = 0
expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
await settle()
hookQueue.length = 0
let degradedChip = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
check('the chip turns red for p4-unavailable', find(degradedChip, (n) => n.props?.className === 'dshCl_dot')?.props['data-state'], 'error')

pop = await reloadWith('notWorkspace')
hookQueue.length = 0
expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
await settle()
hookQueue.length = 0
degradedChip = expand(React.createElement(Chip, { t, sessionId: SESSION_ID }))
check('a p4 non-workspace reads neutral on the chip, not as an error', find(degradedChip, (n) => n.props?.className === 'dshCl_dot')?.props['data-state'], 'norepo')
checkThat('and the chip says which backend rejected the directory', collectText(degradedChip).includes('非 Perforce 工作区'), collectText(degradedChip))
checkThat(
  'the popover keeps the reason-specific wording instead of the git copy',
  collectText(pop).includes('该目录不是 Perforce 工作区') && !collectText(pop).includes('该目录不是 git 工作区'),
  collectText(pop).slice(0, 300),
)
checkThat('and tells the reader where to fill the connection values', collectText(pop).includes('若它应当是 Perforce 客户端'), collectText(pop).slice(0, 400))

pop = await reloadWith('bare')
// A healthy answer with no `workspace`/`options` does not need anything from the
// reader, so the panel stays closed; open it by hand, as a reader would, by
// clicking 连接 in the popover header.
let barePanel = byClass(pop, 'dshCl_panel')[0]
if (barePanel === undefined) {
  const connectionBtn = find(
    pop,
    (n) => n.type === 'button' && String(n.props?.className).includes('dshCl_btn') && collectText(n) === '连接',
  )
  checkThat('the popover offers a 连接 toggle', connectionBtn !== null, collectText(pop).slice(0, 300))
  hookQueue.length = 0
  connectionBtn?.props?.onClick?.()
  await settle()
  hookQueue.length = 0
  pop = expand(React.createElement(Popover, { t }))
  barePanel = byClass(pop, 'dshCl_panel')[0]
}
checkThat('the panel stays readable with no workspace/options', barePanel !== undefined, collectClasses(pop).slice(0, 300))
check(
  'every detected slot reads 未检测到',
  byClass(barePanel, 'dshCl_panelDetected').map((node) => collectText(node)),
  ['未检测到', '未检测到', '未检测到', '未检测到', '未检测到'],
)
checkThat('no scan timeout is claimed when the host reported none', !collectText(barePanel).includes('扫描超时'), collectText(barePanel).slice(0, 200))
check(
  'the scan checkbox stays unchecked when nothing is known',
  find(barePanel, (n) => n.type === 'input' && n.props?.type === 'checkbox').props.checked,
  false,
)
let bareThrew = null
try {
  hookQueue.length = 0
  expand(React.createElement(Popover, { t }))
} catch (cause) {
  bareThrew = cause
}
checkThat('rendering a p4 answer without workspace/options never throws', bareThrew === null, String(bareThrew && bareThrew.message))

console.log('14. a fresh instance: the session outranks memory and the remembered backend')
localStorageStore.set(VCS_KEY, 'p4')
// This section is about the legacy single-slot value (a browser that only ever
// ran the older plugin, so no per-target entry exists yet). Drop any per-target
// entry an earlier section left behind, or the per-target value correctly wins
// and the legacy fallback is never exercised.
for (const key of [...localStorageStore.keys()]) {
  if (key.startsWith(`${VCS_KEY}.`)) localStorageStore.delete(key)
}
localStorageStore.set('dsh-changelist.dir.v2', WORKSPACE_DIR)
const freshMod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
const registeredBefore = registered.length
freshMod.apply(ctx)
const freshChipEntry = registered[registeredBefore]
checkThat('the fresh instance registers its chip', typeof freshChipEntry?.component === 'function', JSON.stringify(registered.map((entry) => entry.id)))
requests.length = 0
hookQueue.length = 0
expand(React.createElement(freshChipEntry.component, { t, getViewedSessionId: () => SESSION_ID }))
await settle()
hookQueue.length = 0
expand(React.createElement(freshChipEntry.component, { t, getViewedSessionId: () => SESSION_ID }))
const freshQueries = requests.filter((url) => url.includes('.state')).map(parseQuery)
checkThat(
  'a stored directory does not displace the viewed session',
  freshQueries.length > 0 && freshQueries.every((query) => query.sessionId === SESSION_ID),
  JSON.stringify(freshQueries),
)
checkThat('and the stored directory is never queried', freshQueries.every((query) => !('dir' in query)), JSON.stringify(freshQueries))
checkThat('the remembered p4 backend rides along as a parameter only', freshQueries.every((query) => query.vcs === 'p4'), JSON.stringify(freshQueries))

console.log('14b. the backend choice is per target, not one global value')
// The regression: one window switches between a Perforce project and a git
// project. A single global `vcs` leaked "p4" into the git project, which then
// answered `not-a-workspace` until something reset it back to auto. The choice
// is now stored per target, so a target that chose `auto` keeps it even while a
// legacy single-slot value says `p4`.
//
// This runs against its own module instance. Earlier sections leave chips
// mounted and subscribed to the session store, and their background
// re-targeting would race the assertions here; a fresh instance has a fresh,
// untouched store and no other subscribers.
{
  const OTHER = 'sess-other-14b'
  const otherKey = `${VCS_KEY}.session:${OTHER}`
  for (const key of [...localStorageStore.keys()]) {
    if (key.startsWith(`${VCS_KEY}.`)) localStorageStore.delete(key)
  }
  localStorageStore.set(VCS_KEY, 'p4') // the legacy slot still says Perforce
  localStorageStore.set(otherKey, 'auto') // …but this target chose automatic

  const freshVcsMod = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const beforeFresh = registered.length
  freshVcsMod.apply(ctx)
  const freshEntries = registered.slice(beforeFresh)
  const freshChip = freshEntries.find((entry) => entry.id === 'changelist.chip')
  const freshPopover = freshEntries.find((entry) => entry.id === 'changelist.popover')
  checkThat('the fresh instance registered both surfaces', Boolean(freshChip && freshPopover), JSON.stringify(freshEntries.map((entry) => entry.id)))

  hookQueue.length = 0
  requests.length = 0
  const freshChipTree = expand(React.createElement(freshChip.component, { t, getViewedSessionId: () => OTHER }))
  await settle()
  const scopedQueries = requests
    .filter((url) => url.includes('.state'))
    .map(parseQuery)
    .filter((query) => query.sessionId === OTHER)
  checkThat(
    'a target that chose auto does not inherit the legacy p4 choice',
    scopedQueries.length > 0 && scopedQueries.every((query) => query.vcs === 'auto'),
    JSON.stringify(scopedQueries),
  )

  // Open the popover the way the suite always does: click the chip.
  const freshChipButton = find(
    freshChipTree,
    (node) => typeof node.props?.onClick === 'function' && String(node.props.className).includes('dshCl_chip'),
  )
  checkThat('the fresh chip is a button', freshChipButton !== null, JSON.stringify(freshChipTree).slice(0, 200))
  freshChipButton?.props?.onClick?.({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 48, right: 900 }) } })
  await settle()
  hookQueue.length = 0
  const popPatch = expand(React.createElement(freshPopover.component, { t }))
  const popVcs = byClass(popPatch, 'dshCl_vcs')[0]
  check('the switcher shows this target’s own choice', popVcs?.props.value, 'auto')
  checkThat('the switcher is interactive', typeof popVcs?.props?.onChange === 'function', String(typeof popVcs?.props?.onChange))
  popVcs.props.onChange({ target: { value: 'p4' } })
  await settle()
  check('the choice is written under this target’s key', localStorageStore.get(otherKey), 'p4')
  check('the legacy slot is kept in step for a downgrade', localStorageStore.get(VCS_KEY), 'p4')

  // The other project's key is still its own choice, and switching back reads it.
  check('the other target’s stored choice is untouched', localStorageStore.get(`${VCS_KEY}.session:${SESSION_ID}`), undefined)
  localStorageStore.set(`${VCS_KEY}.session:${SESSION_ID}`, 'auto')
  hookQueue.length = 0
  requests.length = 0
  expand(React.createElement(freshChip.component, { t, getViewedSessionId: () => SESSION_ID }))
  await settle()
  const backQueries = requests
    .filter((url) => url.includes('.state'))
    .map(parseQuery)
    .filter((query) => query.sessionId === SESSION_ID)
  checkThat(
    'switching back reads the other project’s own choice, not the global one',
    backQueries.length > 0 && backQueries.every((query) => query.vcs === 'auto'),
    JSON.stringify(backQueries),
  )
  for (const key of [...localStorageStore.keys()]) {
    if (key.startsWith(`${VCS_KEY}.`)) localStorageStore.delete(key)
  }
}

console.log('14c. a typed Perforce connection belongs to one project only')
// Requirement: the connection is asked for per Perforce project. A server/user
// typed for project A must never travel with a request for project B, and a git
// project must carry no Perforce parameters at all.
{
  const A = 'sess-creds-a'
  const B = 'sess-creds-b'
  for (const key of [...localStorageStore.keys()]) {
    if (key.startsWith(`${VCS_KEY}.`)) localStorageStore.delete(key)
  }
  localStorageStore.set(VCS_KEY, 'auto')
  const credsMod = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const beforeCreds = registered.length
  credsMod.apply(ctx)
  const credsEntries = registered.slice(beforeCreds)
  const credsChip = credsEntries.find((entry) => entry.id === 'changelist.chip')
  const credsPopover = credsEntries.find((entry) => entry.id === 'changelist.popover')
  checkThat(
    'the fresh instance registered both surfaces',
    Boolean(credsChip && credsPopover),
    JSON.stringify(credsEntries.map((entry) => entry.id)),
  )

  /** Render project `id`'s chip, open its popover, and return the rendered tree. */
  const openFor = async (id) => {
    hookQueue.length = 0
    const tree = expand(React.createElement(credsChip.component, { t, getViewedSessionId: () => id }))
    await settle()
    if (byClass(expand(React.createElement(credsPopover.component, { t })), 'dshCl_pop').length === 0) {
      const chipBtn = find(tree, (n) => typeof n.props?.onClick === 'function' && String(n.props.className).includes('dshCl_chip'))
      chipBtn?.props?.onClick?.({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 48, right: 900 }) } })
      await settle()
    }
    hookQueue.length = 0
    return expand(React.createElement(credsPopover.component, { t }))
  }

  // Type a connection into project A's panel.
  let credsPop = await openFor(A)
  const connectBtn = find(
    credsPop,
    (n) => n.type === 'button' && String(n.props?.className).includes('dshCl_btn') && collectText(n) === '连接',
  )
  connectBtn?.props?.onClick?.()
  await settle()
  hookQueue.length = 0
  credsPop = expand(React.createElement(credsPopover.component, { t }))
  const portInput = find(credsPop, (n) => n.type === 'input' && n.props?.['aria-label'] === 'P4PORT')
  checkThat('project A’s port box is on screen', portInput !== null, collectClasses(credsPop).slice(0, 200))
  portInput?.props?.onChange?.({ target: { value: 'p4-a.example.com:1666' } })
  const userInput = find(credsPop, (n) => n.type === 'input' && n.props?.['aria-label'] === 'P4USER')
  userInput?.props?.onChange?.({ target: { value: 'alice' } })

  // Switch to project B: nothing typed for A may travel with B's requests.
  requests.length = 0
  await openFor(B)
  const bQueries = requests
    .filter((url) => url.includes('.state'))
    .map(parseQuery)
    .filter((query) => query.sessionId === B)
  checkThat('project B is asked for', bQueries.length > 0, JSON.stringify(requests.map(parseQuery)))
  checkThat(
    'project A’s connection never travels with project B',
    bQueries.every((query) => !('p4port' in query) && !('p4user' in query)),
    JSON.stringify(bQueries),
  )
  checkThat(
    'and project B stays on automatic detection',
    bQueries.every((query) => query.vcs === 'auto'),
    JSON.stringify(bQueries),
  )

  // Back to A: what was typed there is still there and is sent for A.
  requests.length = 0
  await openFor(A)
  const aQueries = requests
    .filter((url) => url.includes('.state'))
    .map(parseQuery)
    .filter((query) => query.sessionId === A)
  checkThat(
    'project A’s own connection is sent for project A',
    aQueries.some((query) => query.p4port === 'p4-a.example.com:1666' && query.p4user === 'alice'),
    JSON.stringify(aQueries),
  )
}
// A stored value the client does not recognise must fall back to auto rather
// than being sent to the Host as a backend nobody implements.
localStorageStore.set(VCS_KEY, 'svn-from-a-future-version')
const freshAgain = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
const registeredAgain = registered.length
freshAgain.apply(ctx)
const againEntry = registered[registeredAgain]
hookQueue.length = 0
const againChip = expand(React.createElement(againEntry.component, { t, getViewedSessionId: () => SESSION_ID }))
await settle()
hookQueue.length = 0
pop = expand(React.createElement(Popover, { t }))
check('an unrecognised stored backend falls back to auto in the switcher', byClass(pop, 'dshCl_vcs')[0]?.props.value, 'auto')
// Re-applying a factory can trigger background fetches of its own, so the
// strongest available claim is about the whole run: the unknown value must never
// appear on any request, and every state request must name a known backend.
checkThat(
  'and the unknown value never reaches the Host on any request',
  requests.every((url) => !url.includes('svn-from-a-future-version')) &&
    requests.filter((url) => url.includes('.state')).every((url) => ['auto', 'git', 'p4'].includes(parseQuery(url).vcs)),
  requests.filter((url) => url.includes('.state')).join(' | '),
)
void againChip
localStorageStore.set(VCS_KEY, 'auto')

console.log('15. the injected stylesheet carries the new surfaces')
// There is no browser here to compute colours, so the class -> colour-token
// contract is pinned in the plugin's own stylesheet instead.
const pluginCss = String(styleTags[0]?.textContent ?? '')
checkThat(
  'the error surface maps to the error colour token',
  pluginCss.includes('.dshCl_error{color:var(--dsw-alias-state-error-primary,#e03131)}'),
  'dshCl_error rule missing',
)
checkThat(
  'the shelved badge maps to the warn token',
  pluginCss.includes('.dshCl_badgeShelved{color:var(--dsw-alias-state-warn-primary,#bf8700)'),
  'dshCl_badgeShelved rule missing',
)
checkThat(
  'the needs-sync badge maps to the business token',
  pluginCss.includes('.dshCl_badgeSync{color:var(--dsw-alias-state-business-primary,#4c6ef5)'),
  'dshCl_badgeSync rule missing',
)
checkThat(
  'the local group title is styled apart from named changelists',
  pluginCss.includes('.dshCl_groupTitleLocal{color:var(--dsw-alias-state-business-primary,#4c6ef5)}'),
  'dshCl_groupTitleLocal rule missing',
)
checkThat(
  'the grouped list, panel and switcher each have their own rule',
  ['.dshCl_groups{', '.dshCl_panel{', '.dshCl_vcs{', '.dshCl_groupFiles{'].every((rule) => pluginCss.includes(rule)),
  'a styling rule is missing',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
