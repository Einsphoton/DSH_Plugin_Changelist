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

const source = fs.readFileSync(path.resolve('dsh-changelist/client.js'), 'utf8')

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

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
