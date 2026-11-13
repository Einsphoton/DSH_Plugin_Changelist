/**
 * Cross-project attention: a read-only, derived view of *every* session's agent
 * state.
 *
 * The changelist routes answer "what changed in the directory I am looking at".
 * They say nothing about the other sessions in other workspace folders: a
 * finished turn, a failed turn, or an agent blocked on an approval sitting in an
 * unopened session is invisible until the reader happens to click into that
 * session. This module folds the Host's own `session/event` stream into one
 * small per-session record so a single GET can answer "is anything waiting for
 * me?" across every session the Host knows about.
 *
 * Three constraints shape the code:
 *
 *   1. Advisory only. Attention is a convenience surface, never a source of
 *      truth. A malformed event, a getter that throws, or a session service that
 *      is not mounted yet must leave the Host and the route untouched, so every
 *      listener body and every lookup is guarded and nothing here ever throws
 *      out of a callback.
 *   2. No I/O at all. This module spawns no process, opens no file and runs no
 *      version-control command. It only re-reads events the Host already
 *      produced.
 *   3. A cache, not a log. A record with no new evidence for `retentionMs` is
 *      dropped, and the map is capped, so a Host running for weeks cannot grow
 *      this without bound.
 *
 * The state machine, in one line: a turn making progress is `running`; a turn
 * that ends completed is `done`; a turn that ends failed is `error`; a turn that
 * is waiting on a human (blocked, or an approval question) is `waiting`; a turn
 * that was aborted or ended in an unknown way is `idle`.
 *
 * @module dsh-changelist/lib/attention
 */

/** Version of the shape the route publishes. Bump only on a breaking change. */
export const ATTENTION_SCHEMA_VERSION = 1

/** Every state a session can be in, worst first: this is also sort order. */
export const ATTENTION_STATES = ['waiting', 'error', 'done', 'running', 'idle']

/** Worst first: the order the browser renders rows in. */
const STATE_RANK = { waiting: 0, error: 1, done: 2, running: 3, idle: 4 }

/** Event types that mean "the agent is working on this turn right now". */
const ACTIVITY_TYPES = new Set(['step/start', 'tool/call', 'assistant/message', 'tool/result'])

/** Defaults; the plugin settings mirror these so behaviour is configured, not hidden. */
export const DEFAULT_ATTENTION_LIMITS = {
  /** Maximum sessions one answer carries. */
  maxSessions: 50,
  /** Milliseconds a record survives without new evidence. */
  retentionMs: 86_400_000,
  /** Hard cap on the internal record map, whatever the retention window says. */
  maxEntries: 200,
  /** Longest human-readable `detail` carried by an error/blocked answer. */
  detailMaxChars: 160,
}

/** A zeroed counts object. Always all five keys, so the browser can index freely. */
export function emptyAttentionCounts() {
  return { waiting: 0, error: 0, done: 0, running: 0, idle: 0 }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** First argument that is a non-empty string; `null` when none is. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * The trailing path segment of an absolute directory, platform-independently:
 * a Host on POSIX can still be handed a Windows path by a session header, and
 * `path.basename` would then keep the whole string.
 */
function basenameOf(dir) {
  const cleaned = String(dir ?? '').replace(/[\\/]+$/, '')
  if (cleaned === '') return ''
  const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return index >= 0 ? cleaned.slice(index + 1) : cleaned
}

/** A bounded, single-line human string; `null` when there is nothing to say. */
function shortText(value, maxChars) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned === '') return null
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`
}

/** A positive integer limit, falling back when the configured value is nonsense. */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Build the attention registry.
 *
 * @param {object} [options]
 * @param {((event: string, listener: Function) => Function)|null} [options.on]
 *   Event subscriber; production passes the plugin context's `ctx.on`. Injectable
 *   so the verification suite needs no real Cordis. When absent (or not a
 *   function) the registry is simply never updated: an empty view, not a crash.
 * @param {{ get?: (id: string) => any }|null} [options.sessions]
 *   Optional Host session store, used only to complete a stub session handed to
 *   the listener (a session object with an id but no header). Duck-typed: only
 *   `get(id)` is used, and nothing is required.
 * @param {() => number} [options.now]
 *   Injected clock, in epoch milliseconds.
 * @param {{ maxSessions?: number, retentionMs?: number, maxEntries?: number, detailMaxChars?: number }} [options.limits]
 * @returns {{ snapshot: () => { generatedAt: number, sessions: object[], counts: object },
 *   dispose: () => void, get size(): number }}
 */
export function createAttentionRegistry({ on = null, sessions = null, now = () => Date.now(), limits = {} } = {}) {
  const settings = {
    maxSessions: positiveInt(limits?.maxSessions, DEFAULT_ATTENTION_LIMITS.maxSessions),
    retentionMs: positiveInt(limits?.retentionMs, DEFAULT_ATTENTION_LIMITS.retentionMs),
    maxEntries: positiveInt(limits?.maxEntries, DEFAULT_ATTENTION_LIMITS.maxEntries),
    detailMaxChars: positiveInt(limits?.detailMaxChars, DEFAULT_ATTENTION_LIMITS.detailMaxChars),
  }

  /** Session id -> record. Insertion order is irrelevant: every read sorts. */
  const records = new Map()
  /** Disposers returned by `on`, released together by {@link dispose}. */
  const subscriptions = []
  let disposed = false

  /** The injected clock, guarded: a broken clock must not break a read or a listener. */
  const clock = () => {
    try {
      const value = now()
      return isFiniteNumber(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** The Host session store, read defensively: services arrive and leave. */
  function storedSession(id) {
    if (!sessions) return null
    try {
      if (typeof sessions.get !== 'function') return null
      const found = sessions.get(id)
      return isObject(found) ? found : null
    } catch {
      return null
    }
  }

  /**
   * Resolve one event's subject from the session object handed to the listener.
   * Returns `null` for anything that cannot be attributed to a workspace — a
   * subagent/child session with no `cwd` has nothing to show in this panel.
   */
  function identityOf(session) {
    if (!isObject(session)) return null
    const sessionId = session.id
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const stored = storedSession(sessionId)
    const header = isObject(session.header) ? session.header : isObject(stored?.header) ? stored.header : null
    // `session.header` is the authoritative location; a stub may only know the
    // id, and then the store is the fallback.
    const dir = firstString(header?.cwd, stored?.header?.cwd)
    if (!dir) return null
    const title = firstString(header?.title, stored?.header?.title, session.title, stored?.title) ?? basenameOf(dir) ?? sessionId
    return { sessionId, dir, title }
  }

  /** Unwrap one `session/event` envelope. `null` for anything unrecognisable. */
  function evidenceOf(event) {
    if (!isObject(event)) return null
    const type = event.type
    if (typeof type !== 'string' || type === '') return null
    // Real events put the body in `data`; the shape is read tolerantly so a
    // direct `{ type, turn, reason }` (as an in-process emitter might send) works.
    const payload = isObject(event.data) ? event.data : event
    return { type, payload, time: isFiniteNumber(event.time) ? event.time : null }
  }

  /** The turn number an event is about, or the record's existing one. */
  function turnOf(payload, fallback = null) {
    const value = payload?.turn
    if (isFiniteNumber(value)) return Math.floor(value)
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
    return fallback
  }

  /** The `turn/end` reason object (or its bare string form) from one payload. */
  function endReasonOf(payload) {
    const reason = payload?.reason
    if (typeof reason === 'string') return { kind: reason }
    return isObject(reason) ? reason : null
  }

  /**
   * The short "why" of a failed turn: the LLM failure's message, else its stable
   * code. Never a stack or a whole provider body.
   */
  function describeFailure(error) {
    if (typeof error === 'string') return shortText(error, settings.detailMaxChars)
    if (!isObject(error)) return null
    return (
      shortText(error.message, settings.detailMaxChars) ??
      shortText(error.code, settings.detailMaxChars) ??
      null
    )
  }

  /**
   * The next state one tracked event implies, or `null` when the event is not
   * one this panel cares about.
   *
   * @returns {{ state: string, reason: string, turn?: number|null, running: boolean,
   *   detail: string|null, forceSince?: boolean }|null}
   */
  function nextState(record, evidence) {
    const { type, payload } = evidence

    if (type === 'turn/start') {
      // A new turn begins: `since` restarts with it, whatever ran before.
      return {
        state: 'running',
        reason: 'turn-start',
        turn: turnOf(payload, record.turn),
        running: true,
        detail: null,
        forceSince: true,
      }
    }

    if (ACTIVITY_TYPES.has(type)) {
      // Progress inside the current turn. The state began at `turn/start`, so
      // `since` is only restarted if this evidence promotes a non-running record
      // (which the Host does not normally emit, but an imported log can).
      return {
        state: 'running',
        reason: 'activity',
        turn: turnOf(payload, record.turn),
        running: true,
        detail: null,
      }
    }

    if (type === 'turn/end') {
      const reason = endReasonOf(payload)
      const kind = typeof reason?.kind === 'string' ? reason.kind : null
      // Every ending closes the turn, so `since` restarts in each branch.
      if (kind === 'completed') {
        return { state: 'done', reason: 'turn-end', turn: turnOf(payload, record.turn), running: false, detail: null, forceSince: true }
      }
      if (kind === 'error') {
        return {
          state: 'error',
          reason: 'turn-error',
          turn: turnOf(payload, record.turn),
          running: false,
          detail: describeFailure(reason?.error ?? payload?.error),
          forceSince: true,
        }
      }
      if (kind === 'blocked') {
        // A blocked turn is alive but stopped: it stays "running" in the sense
        // that the agent has not finished, and it is waiting on a human.
        return {
          state: 'waiting',
          reason: 'blocked',
          turn: turnOf(payload, record.turn),
          running: true,
          detail: shortText(reason?.detail ?? reason?.message ?? payload?.detail, settings.detailMaxChars),
          forceSince: true,
        }
      }
      // 'aborted' and anything a newer Host adds: the turn is over, nothing is
      // waiting, nothing failed. `idle` is the honest answer.
      return { state: 'idle', reason: 'turn-end', turn: turnOf(payload, record.turn), running: false, detail: null, forceSince: true }
    }

    if (type === 'approval/asked') {
      // An approval question is the canonical "blocked waiting for a human".
      return {
        state: 'waiting',
        reason: 'approval',
        turn: turnOf(payload, record.turn),
        running: true,
        detail: null,
        forceSince: true,
      }
    }

    if (type === 'approval/decided') {
      // The turn resumes once the question is answered. Ignore a decision for a
      // record that was never asking (an unrelated audit event).
      if (record.state !== 'waiting') return null
      return { state: 'running', reason: 'activity', turn: record.turn, running: true, detail: null, forceSince: true }
    }

    return null
  }

  /** A fresh record for a session this registry has not seen before. */
  function createRecord(identity) {
    return {
      sessionId: identity.sessionId,
      title: identity.title,
      dir: identity.dir,
      workspace: basenameOf(identity.dir),
      state: 'idle',
      reason: 'turn-end',
      turn: null,
      since: 0,
      at: 0,
      running: false,
      detail: null,
    }
  }

  /** Keep the record map bounded by dropping the least recently active entries. */
  function enforceEntryCap() {
    if (records.size <= settings.maxEntries) return
    const oldestFirst = [...records.values()].sort((left, right) => left.at - right.at)
    for (const record of oldestFirst) {
      if (records.size <= settings.maxEntries) break
      records.delete(record.sessionId)
    }
  }

  /** Fold one event into the records. Every read of the event is inside the caller's guard. */
  function observe(session, event) {
    if (disposed) return
    const identity = identityOf(session)
    if (!identity) return
    const evidence = evidenceOf(event)
    if (!evidence) return

    const at = evidence.time ?? clock()
    const existing = records.get(identity.sessionId)
    const record = existing ?? createRecord(identity)

    // Identity is refreshed from every event so a rename, or a session moved to
    // another directory, shows up without waiting for the next state change.
    record.title = identity.title
    record.dir = identity.dir
    record.workspace = basenameOf(identity.dir)

    if (evidence.type === 'session/title') {
      // The Host keeps a session's title in a log-only event, not in the header.
      const title = shortText(evidence.payload?.title, 400)
      if (title) record.title = title
    } else {
      const next = nextState(record, evidence)
      if (next) {
        const stateChanged = next.state !== record.state
        record.state = next.state
        record.reason = next.reason
        if (next.turn !== undefined) record.turn = next.turn
        record.running = next.running
        record.detail = next.detail ?? null
        // `since` is the moment the *current* state began: a turn start, a turn
        // end, a new record, or a promotion out of another state. Plain activity
        // inside a running turn keeps the original `since`.
        if (next.forceSince === true || stateChanged || existing === undefined) record.since = Math.max(0, at)
      }
    }

    // `at` is the latest evidence, so an out-of-order replay never moves it back.
    record.at = Math.max(record.at, at)
    if (record.since === 0) record.since = record.at
    records.set(record.sessionId, record)
    enforceEntryCap()
  }

  /** The listener body handed to the Host: a malformed event never escapes it. */
  const listener = (session, event) => {
    try {
      observe(session, event)
    } catch {
      /* Attention is advisory: a bad event must never break the Host. */
    }
  }

  if (typeof on === 'function') {
    try {
      const off = on('session/event', listener)
      if (typeof off === 'function') subscriptions.push(off)
    } catch {
      /* No event service means an empty view, not a failed plugin. */
    }
  }

  /** One record as the wire shape; `detail` stays an error/blocked affordance. */
  function toWire(record) {
    const wire = {
      sessionId: record.sessionId,
      title: record.title,
      dir: record.dir,
      workspace: record.workspace,
      state: record.state,
      reason: record.reason,
      turn: record.turn,
      since: record.since,
      at: record.at,
      running: record.running,
    }
    if (record.detail && (record.state === 'error' || record.state === 'waiting')) {
      wire.detail = record.detail
    }
    return wire
  }

  /**
   * A point-in-time view: retention is enforced here (there is no timer to leak),
   * then worst-first / newest-first, then the configured session cap. `counts`
   * always describes exactly the returned list, so the browser can never render
   * a badge that disagrees with its rows.
   */
  function snapshot() {
    const generatedAt = clock()
    const cutoff = generatedAt - settings.retentionMs
    for (const [sessionId, record] of records) {
      if (record.at < cutoff) records.delete(sessionId)
    }
    const ordered = [...records.values()].sort(
      (left, right) =>
        (STATE_RANK[left.state] ?? ATTENTION_STATES.length) - (STATE_RANK[right.state] ?? ATTENTION_STATES.length) ||
        right.at - left.at,
    )
    const sessions = ordered.slice(0, settings.maxSessions).map(toWire)
    const counts = emptyAttentionCounts()
    for (const session of sessions) counts[session.state] += 1
    return { generatedAt, sessions, counts }
  }

  /** Release every subscription and every record. Idempotent, never throws. */
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
    records.clear()
  }

  return {
    snapshot,
    dispose,
    /** Live record count, for tests and diagnostics. */
    get size() {
      return records.size
    },
  }
}
