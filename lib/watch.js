/**
 * Change detection: the Host half's cheap answer to "has anything in this
 * directory changed since the last time I asked?".
 *
 * The changelist routes answer *what* changed, but every answer costs process
 * spawns (`state` runs seven git commands, measured ~0.45 s, P95 1.9 s). A
 * browser that polled `state` every couple of seconds would keep the fans
 * spinning. This module is the other half of that trade: it maintains a
 * monotonic per-directory revision counter from events the Host *already*
 * produces, so a poll costs one map lookup and spawns nothing.
 *
 * Three signals, deliberately layered:
 *
 *   1. `fs/observed(target, observation, actor)` — the precise one. The
 *      instrumented filesystem emits it for every read *and* every mutation,
 *      so it cannot be treated as "a write happened": the whole point of the
 *      version check is that re-reading a file reports the same `FsVersion`
 *      (`dev:ino:size:mtimeNs:ctimeNs`) and must change nothing, while a
 *      mutation reports a new one. The first observation of a target only
 *      records a baseline, for the same reason — otherwise opening a session
 *      would bump once per file the agent reads.
 *   2. `session/event` `tool/result` for a non-read-only tool — the coarse one.
 *      `pwsh`/`bash`/scripts write files without going through the filesystem
 *      service, so `fs/observed` never fires for them. A finished tool call
 *      that is not on the read-only list is therefore evidence that the
 *      session's working directory may have changed.
 *   3. `session/event` `turn/end` for any reason — the backstop. Even a turn
 *      that changed nothing observable refreshes once when it finishes.
 *
 * Constraints, in the same spirit as `lib/attention.js`:
 *
 *   - Advisory only. A malformed event, a throwing getter, or a missing event
 *     service must never escape a listener into the Host, so every listener
 *     body is guarded and nothing here throws out of a callback.
 *   - No I/O at all: no process, no file, no version-control command, and no
 *     DSH package import. The plugin has to stay resolvable without the
 *     Host's own module graph.
 *   - Bounded forever. Both revision tables and the two bookkeeping maps have
 *     hard caps evicted least-recently-bumped first, so a Host running for
 *     weeks cannot grow this without bound.
 *
 * The revision is a single process-wide counter: entries record the sequence
 * number of their last bump, and a query returns the largest number any related
 * entry holds. Numbers are only comparable within one process, and only
 * meaningful for one directory; the browser half only ever compares "differs
 * from the last rev I applied".
 *
 * @module dsh-changelist/lib/watch
 */

/** Defaults; the plugin settings own the two user-facing switches, not these caps. */
export const DEFAULT_WATCH_LIMITS = {
  /** Maximum file entries remembered in the path table. */
  maxPaths: 4096,
  /** Maximum session working directories remembered in the directory table. */
  maxDirs: 256,
  /** Maximum targets remembered with the version they were last observed at. */
  maxTargets: 8192,
  /** Maximum in-flight tool calls remembered so a result can be judged by name. */
  maxCallIds: 512,
}

/**
 * Tools that observe the workspace without changing it.
 *
 * This is the *skip* list for the `tool/result` signal: a read tool also emits
 * `tool/result`, and treating every result as "something changed" would recreate
 * the poll-the-world problem this module exists to avoid. Anything not named
 * here counts as change-capable — a missing read-only name merely costs one
 * extra (cheap) bump, while a missing writer name would lose a real change.
 */
const READONLY_TOOLS = new Set([
  // Filesystem observation. Every one of these is also covered by
  // `fs/observed`, which reports the observation precisely.
  'read',
  'read_many',
  'read_image',
  'ls',
  'list',
  'glob',
  'grep',
  'search',
  'stat',
  'find',
  'tree',
  'cat',
  'head',
  'tail',
  'wc',
  'diff',
  'view',
  // Host/session reads.
  'list_agents',
  'list_subagent_models',
  'team_task_list',
  'team_task_get',
  'get_goal',
  'schedule_list',
  'schedule_view',
  'job_list',
  'job_output',
  'working_directory',
  // Advisory or non-filesystem effects.
  'todo_write',
  'ask_user_question',
  'skill',
  'present',
  'web_fetch',
  'web_search',
])

/**
 * Read-only name families, for tools this build of the Host adds later.
 *
 * Deliberately short. The two mistakes are not symmetric: calling a read tool
 * change-capable costs one cheap bump (and `turn/end` would have bumped anyway),
 * while calling a writer read-only *loses a real change* until the next turn
 * ends. So a family only belongs here when no writing tool plausibly starts
 * with it — `find` is absent for exactly that reason (`find_and_replace` is a
 * real edit tool), while every name in {@link READONLY_TOOLS} is matched
 * exactly regardless of this list.
 */
const READONLY_TOOL_PREFIXES = [
  'read',
  'list',
  'glob',
  'grep',
  'stat',
  'inspect',
  'describe',
  'view',
]

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** First argument that is a non-empty string, else `null`. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** A positive integer limit, falling back when the configured value is nonsense. */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Whether a tool name denotes a read-only operation.
 *
 * Namespaced names are reduced to their last `__` segment (`mcp__fs__read` →
 * `read`) so a wrapped tool is judged by what it actually does.
 *
 * @param {unknown} name - tool name as carried by a session event.
 * @returns {boolean}
 */
export function isReadOnlyTool(name) {
  const raw = firstString(name)
  if (raw === null) return false
  const tool = raw.trim().toLowerCase()
  const bare = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool
  if (READONLY_TOOLS.has(tool) || READONLY_TOOLS.has(bare)) return true
  for (const prefix of READONLY_TOOL_PREFIXES) {
    if (bare === prefix) return true
    if (bare.startsWith(`${prefix}_`) || bare.startsWith(`${prefix}-`) || bare.startsWith(`${prefix}.`)) return true
  }
  return false
}

/**
 * Normalize a path for comparison: verbatim case-folding, `/` folded to `\`, and
 * the trailing separator dropped.
 *
 * Windows is case-insensitive, and the same directory reaches this module as
 * `C:/w/Repo`, `C:\w\Repo` and `C:\w\Repo\` depending on which event carried it.
 * Folding once, on the way in, is what makes the two tables comparable.
 *
 * @param {unknown} value - a path from an event or a request.
 * @returns {string|null} the comparison key, or `null` when it is not a path.
 */
export function normalizeWatchPath(value) {
  const raw = firstString(value)
  if (raw === null) return null
  let key = raw.trim().replace(/\//g, '\\').toLowerCase()
  // A drive root (`c:\`) keeps its separator: it is the one path shape where
  // the trailing `\` is information, not padding.
  while (key.length > 1 && key.endsWith('\\') && !/^[a-z]:\\$/.test(key)) key = key.slice(0, -1)
  return key === '' ? null : key
}

/** `child` is `parent`, or lies below it. Both arguments are already normalized. */
function isUnderKey(child, parent) {
  if (child === parent) return true
  const prefix = parent.endsWith('\\') ? parent : `${parent}\\`
  return child.startsWith(prefix)
}

/**
 * Build the change watcher.
 *
 * @param {object} [options]
 * @param {((event: string, listener: Function) => Function)|null} [options.on]
 *   Event subscriber; production passes the plugin context's `ctx.on`. Absent (or
 *   not a function) means nothing is subscribed — an unwatched Host, not a crash.
 * @param {() => number} [options.now] Injected clock, epoch milliseconds.
 * @param {{ maxPaths?: number, maxDirs?: number, maxTargets?: number, maxCallIds?: number }} [options.limits]
 * @returns {{
 *   revisionFor: (dir: string) => { rev: number, at: number },
 *   dispose: () => void,
 *   get size(): number,
 * }}
 */
export function createChangeWatcher({ on = null, now = () => Date.now(), limits = {} } = {}) {
  const settings = {
    maxPaths: positiveInt(limits?.maxPaths, DEFAULT_WATCH_LIMITS.maxPaths),
    maxDirs: positiveInt(limits?.maxDirs, DEFAULT_WATCH_LIMITS.maxDirs),
    maxTargets: positiveInt(limits?.maxTargets, DEFAULT_WATCH_LIMITS.maxTargets),
    maxCallIds: positiveInt(limits?.maxCallIds, DEFAULT_WATCH_LIMITS.maxCallIds),
  }

  /** Normalized file path -> last bump. */
  const paths = new Map()
  /** Normalized session working directory -> last bump. */
  const dirs = new Map()
  /** `targetKey` -> fingerprint of the last observation seen for it. */
  const targets = new Map()
  /** Tool call id -> tool name, so a `tool/result` can be judged read-only. */
  const callTools = new Map()
  /** Disposers returned by `on`, released together by {@link dispose}. */
  const subscriptions = []
  let sequence = 0
  let disposed = false

  /** The injected clock, guarded: a broken clock must not break a bump or a read. */
  const clock = () => {
    try {
      const value = now()
      return isFiniteNumber(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** Keep a bounded map: drop the oldest entry until it fits again. */
  function enforceCap(table, cap) {
    while (table.size > cap) {
      const oldest = table.keys().next()
      if (oldest.done) return
      table.delete(oldest.value)
    }
  }

  /**
   * Record one bump in a table. Re-inserting an existing key keeps the eviction
   * order "least recently bumped" rather than "first ever seen": a file that is
   * still being written must not age out ahead of one that has been quiet for
   * hours.
   */
  function bump(table, key, cap) {
    if (typeof key !== 'string' || key === '') return 0
    sequence += 1
    if (table.has(key)) table.delete(key)
    table.set(key, { rev: sequence, at: clock() })
    enforceCap(table, cap)
    return sequence
  }

  /** Bump the path table for one absolute file (or directory) path. */
  function bumpPath(displayPath) {
    const key = normalizeWatchPath(displayPath)
    if (key === null) return 0
    return bump(paths, key, settings.maxPaths)
  }

  /** Bump the directory table for one session working directory. */
  function bumpDir(cwd) {
    const key = normalizeWatchPath(cwd)
    if (key === null) return 0
    return bump(dirs, key, settings.maxDirs)
  }

  /**
   * The fingerprint of one observation: its kind plus its version.
   *
   * Presence carries a `FsVersion`; absence carries none. Folding the kind in
   * keeps "present at v1 → absent → present at v1" a change (the file was
   * replaced), while "read twice at v1" stays quiet.
   */
  function fingerprintOf(observation) {
    if (!isObject(observation)) return null
    const kind = typeof observation.kind === 'string' ? observation.kind : 'present'
    const version = typeof observation.version === 'string' ? observation.version : ''
    if (kind === '' && version === '') return null
    return `${kind}\u0000${version}`
  }

  /** The owning path of one fs target: its display path, else its backend key. */
  function displayPathOf(target) {
    return firstString(target?.displayPath, target?.targetKey)
  }

  /**
   * `fs/observed(target, observation, actor)`.
   *
   * Only a *changed* version is evidence of a write; a repeat of the same
   * version is a read, and a first sighting is a baseline.
   */
  function observeFs(target, observation) {
    if (disposed || !isObject(target)) return
    const displayPath = displayPathOf(target)
    const key = firstString(target?.targetKey, displayPath)
    if (key === null) return
    const fingerprint = fingerprintOf(observation)
    if (fingerprint === null) return
    const previous = targets.get(key)
    // Refresh recency, then compare: the baseline map is bounded too.
    if (targets.has(key)) targets.delete(key)
    targets.set(key, fingerprint)
    enforceCap(targets, settings.maxTargets)
    if (previous === undefined) return
    if (previous === fingerprint) return
    // Ownership is the display path; the backend key is only a fallback for a
    // target that carries no display path at all.
    bumpPath(displayPath ?? key)
  }

  /** The working directory a session event belongs to, or `null`. */
  function cwdOf(session) {
    try {
      const cwd = session?.header?.cwd
      return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
    } catch {
      // A header getter that throws is a session this module cannot place.
      return null
    }
  }

  /** Remember one tool call's name so its result can be judged. */
  function rememberCall(event) {
    const data = isObject(event?.data) ? event.data : null
    const callId = firstString(data?.callId, data?.message?.source?.callId, event?.callId)
    const name = firstString(data?.name, data?.toolName, event?.name, event?.toolName)
    if (callId === null || name === null) return
    if (callTools.has(callId)) callTools.delete(callId)
    callTools.set(callId, name)
    enforceCap(callTools, settings.maxCallIds)
  }

  /** The tool name one event is about, from the payload or the remembered call. */
  function toolNameOf(event) {
    const data = isObject(event?.data) ? event.data : null
    const direct = firstString(data?.name, data?.toolName, event?.name, event?.toolName)
    if (direct !== null) return direct
    const callId = firstString(data?.callId, data?.message?.source?.callId, event?.callId)
    if (callId === null) return null
    return callTools.get(callId) ?? null
  }

  /**
   * `session/event(session, event)`: the two coarse signals.
   *
   * `turn/end` always bumps. `tool/result` bumps only when the tool is known to
   * be change-capable — an unknown name is skipped rather than guessed, because
   * guessing "changed" for a `read` would defeat the entire module; the
   * `turn/end` backstop still refreshes at the end of the turn.
   */
  function observeSession(session, event) {
    if (disposed || !isObject(event)) return
    const type = event.type
    if (type === 'tool/call') {
      rememberCall(event)
      return
    }
    if (type !== 'tool/result' && type !== 'turn/end') return
    const cwd = cwdOf(session)
    if (cwd === null) return
    if (type === 'turn/end') {
      bumpDir(cwd)
      return
    }
    const name = toolNameOf(event)
    if (name === null) return
    if (isReadOnlyTool(name)) return
    bumpDir(cwd)
  }

  /** Run one listener body: a malformed event must never reach the Host. */
  function guarded(step) {
    return (...args) => {
      try {
        step(...args)
      } catch {
        /* Change detection is advisory: a bad event must never break the Host. */
      }
    }
  }

  if (typeof on === 'function') {
    try {
      const offFs = on('fs/observed', guarded(observeFs))
      if (typeof offFs === 'function') subscriptions.push(offFs)
    } catch {
      /* No fs event service means no precise signal, not a failed plugin. */
    }
    try {
      const offSession = on('session/event', guarded(observeSession))
      if (typeof offSession === 'function') subscriptions.push(offSession)
    } catch {
      /* No session event service means no coarse signal, not a failed plugin. */
    }
  }

  /**
   * The revision for one directory: the largest number any related entry holds.
   *
   * A file entry relates when it is the directory itself or lies below it; a
   * directory entry relates when it is the directory, an ancestor of it, or a
   * descendant of it (a session may live in a subdirectory of the workspace).
   * Both tables are only a few thousand entries, so a linear scan is free
   * compared with the subprocess the caller is avoiding.
   *
   * @param {unknown} dir - absolute directory path.
   * @returns {{ rev: number, at: number }} `rev` is `0` when nothing changed.
   */
  function revisionFor(dir) {
    const key = normalizeWatchPath(dir)
    if (key === null) return { rev: 0, at: 0 }
    let bestRev = 0
    let bestAt = 0
    const consider = (entry) => {
      if (!entry || !isFiniteNumber(entry.rev) || entry.rev <= bestRev) return
      bestRev = entry.rev
      bestAt = isFiniteNumber(entry.at) ? entry.at : 0
    }
    for (const [pathKey, entry] of paths) {
      if (isUnderKey(pathKey, key)) consider(entry)
    }
    for (const [dirKey, entry] of dirs) {
      if (isUnderKey(key, dirKey) || isUnderKey(dirKey, key)) consider(entry)
    }
    return { rev: bestRev, at: bestAt }
  }

  /** Release every subscription and every table. Idempotent, never throws. */
  function dispose() {
    disposed = true
    while (subscriptions.length > 0) {
      const off = subscriptions.pop()
      try {
        if (typeof off === 'function') off()
      } catch {
        /* an unsubscribe that throws has already unsubscribed */
      }
    }
    paths.clear()
    dirs.clear()
    targets.clear()
    callTools.clear()
  }

  return {
    revisionFor,
    dispose,
    /** Live entry count across both revision tables, for tests and diagnostics. */
    get size() {
      return paths.size + dirs.size
    },
  }
}
