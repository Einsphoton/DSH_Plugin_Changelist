/**
 * Host half of the workspace-changelist plugin.
 *
 * It answers three read-only routes for the browser half, registered inside the
 * Connection fetch fence so they inherit browser authentication and the
 * Host/Origin policy:
 *
 *   GET /api/changelist.targets
 *   GET /api/changelist.state?dir=<abs>[&base=<ref>][&fetch=1][&remote=origin]
 *   GET /api/changelist.diff?dir=<abs>&path=<repo-relative>[&base=<ref>]
 *
 * Every directory is validated against the directories the Harness itself knows
 * (registered workspaces and live session working directories) before any git
 * command runs. Git runs read-only with a scrubbed environment and a wall-clock
 * deadline; `fetch=1` is the only command that touches the network, and it never
 * prompts for credentials.
 *
 * @module @local/dsh-changelist
 */
import { realpathSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile as readTextFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  createFileReader,
  inspectWorkspace,
  readDiff,
  resolveBase,
} from './lib/git.js'

export const name = 'changelist'

/** The plugin needs the Connection fetch fence to publish its routes. */
export const inject = ['connection']

export const ROUTES = {
  targets: '/api/changelist.targets',
  state: '/api/changelist.state',
  diff: '/api/changelist.diff',
}

export const DEFAULTS = {
  /** Git executable name or absolute path. */
  gitPath: 'git',
  /** Milliseconds one git command may run. */
  timeoutMs: DEFAULT_LIMITS.timeoutMs,
  /** Milliseconds a `fetch=1` refresh may run. */
  fetchTimeoutMs: 120_000,
  /** Maximum changed files carried by one answer. */
  maxFiles: DEFAULT_LIMITS.maxFiles,
  /** Maximum bytes of one file comparison. */
  maxDiffBytes: DEFAULT_LIMITS.maxDiffBytes,
  /** Context lines in a comparison. */
  contextLines: DEFAULT_LIMITS.contextLines,
  /** Compare against this ref instead of the branch upstream. */
  base: null,
  /** Extra directories the routes may inspect, beyond registered workspaces and sessions. */
  allowedPaths: [],
  /**
   * Append a bounded activity log next to the plugin (mount, unload, one line
   * per route request). This deployment exposes no Host log and the browser
   * console is out of reach, so this file is the only way to tell "the client
   * never called" apart from "the client called and git failed". Set `false` to
   * silence it; writes never affect a response.
   */
  diagnostics: true,
  /** Override the diagnostics file path; `null` uses `<plugin dir>/.diagnostics/host.log`. */
  diagnosticsPath: null,
  /** Truncate the diagnostics file to its last entries beyond this size. */
  diagnosticsMaxBytes: 262_144,
}

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIAGNOSTICS_PATH = path.join(PLUGIN_DIR, '.diagnostics', 'host.log')

/**
 * A bounded append-only activity log. Every failure is swallowed: diagnostics
 * must never change what a route answers.
 * @returns {{ record: (entry: object) => Promise<void>, path: string|null }}
 */
export function createDiagnostics(settings) {
  if (settings.diagnostics === false) return { record: async () => {}, path: null }
  const file = settings.diagnosticsPath ?? DEFAULT_DIAGNOSTICS_PATH
  const maxBytes = settings.diagnosticsMaxBytes ?? DEFAULTS.diagnosticsMaxBytes
  return {
    path: file,
    async record(entry) {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`)
        const size = (await stat(file)).size
        if (size > maxBytes) {
          const lines = (await readTextFile(file, 'utf8')).trimEnd().split('\n').slice(-200)
          await writeFile(file, `${lines.join('\n')}\n`)
        }
      } catch {
        /* diagnostics are best-effort by contract */
      }
    },
  }
}

/**
 * Environment handed to git: no ambient credentials, no interactive prompts.
 * `ctx.subprocess` scrubs credential-shaped names for its own children; this
 * runner spawns git directly, so it does the same job here.
 */
export function gitEnvironment(env = process.env) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  const scrubbed = {}
  for (const key of keep) if (env[key] !== undefined) scrubbed[key] = env[key]
  scrubbed.GIT_CONFIG_COUNT = '0'
  scrubbed.GIT_TERMINAL_PROMPT = '0'
  scrubbed.GIT_OPTIONAL_LOCKS = '0'
  scrubbed.GIT_ASKPASS = ''
  scrubbed.SSH_ASKPASS = ''
  scrubbed.LC_ALL = 'C'
  return scrubbed
}

/** A git runner with the scrubbed environment and per-command deadlines. */
export function createRunner(settings, spawn = null) {
  return async function run(args, cwd) {
    const { execFile } = spawn ? { execFile: spawn } : await import('node:child_process')
    const timeout = args[0] === 'fetch' ? settings.fetchTimeoutMs : settings.timeoutMs
    return await new Promise((resolve) => {
      execFile(
        settings.gitPath,
        args,
        {
          cwd,
          timeout,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer',
          env: gitEnvironment(),
        },
        (error, stdout, stderr) => {
          const status = error && typeof error.code === 'number' ? error.code : error ? -1 : 0
          resolve({
            status,
            stdout: stdout ?? Buffer.alloc(0),
            stderr: stderr ? stderr.toString('utf8') : error ? String(error.message) : '',
          })
        },
      )
    })
  }
}

/** Resolve one existing absolute directory, following links. */
export function normalizeDir(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const resolved = path.resolve(value)
  if (!path.isAbsolute(resolved)) return null
  try {
    if (!statSync(resolved).isDirectory()) return null
    return realpathSync.native(resolved)
  } catch {
    return null
  }
}

const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * Reject a file path that could leave the repository: absolute, drive-relative,
 * or carrying a `..` segment.
 */
export function safeRepoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) return null
  return value
}

/**
 * Collect every directory the Harness knows about: registered workspaces first,
 * then live session working directories, then configured extras. Services are
 * read defensively; a missing service degrades that source, not the route.
 */
export function collectTargets(ctx, settings) {
  const targets = []
  const push = (entry) => {
    const dir = normalizeDir(entry.dir)
    if (!dir) return
    const key = dir.toLowerCase()
    const existing = targets.find((target) => target.dir.toLowerCase() === key)
    if (existing) {
      if (entry.live) existing.live = true
      if (existing.sessions === null && entry.sessions !== null && entry.sessions !== undefined) {
        existing.sessions = entry.sessions
      }
      return
    }
    targets.push({
      kind: entry.kind,
      id: String(entry.id ?? dir),
      title: entry.title ? String(entry.title) : path.basename(dir),
      dir,
      live: entry.live === true,
      sessions: entry.sessions ?? null,
    })
  }

  const registry = ctx.get?.('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    // A service that answers oddly degrades this source, never the whole route.
    for (const workspace of listSafely(registry)) {
      push({
        kind: 'workspace',
        id: workspace?.id,
        title: workspace?.title,
        dir: workspace?.path,
        sessions: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : null,
      })
    }
  }

  const sessions = ctx.get?.('sessions')
  if (sessions && typeof sessions.list === 'function') {
    for (const session of listSafely(sessions)) {
      push({
        kind: 'session',
        id: session?.id,
        title: session?.title,
        dir: session?.header?.cwd,
        live: true,
      })
    }
  }

  // Last-resort source: the Host's own workspace root, so a deployment without
  // the workspace or session services still has one real directory to show.
  const root = workspaceRootOf(ctx)
  if (typeof root === 'string' && root !== '') {
    push({ kind: 'workspace-root', id: root, title: path.basename(root), dir: root })
  }

  for (const extra of settings.allowedPaths ?? []) {
    push({ kind: 'configured', id: extra, dir: extra })
  }

  return targets
}

/** Read the sandbox policy's workspace root, tolerating a property or a getter of any shape. */
function workspaceRootOf(ctx) {
  try {
    const policy = ctx.get?.('sandboxPolicy')
    if (!policy) return null
    const value = policy.workspaceRoot
    if (typeof value === 'string') return value
    if (typeof value === 'function') {
      const called = policy.workspaceRoot()
      return typeof called === 'string' ? called : null
    }
    return null
  } catch {
    return null
  }
}

/** Read a `list()`-shaped source, tolerating a throw or a non-array answer. */
function listSafely(source) {
  try {
    const value = source.list()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/**
 * Build the three route handlers against one context and configuration.
 * @param {object} ctx - plugin context; only `get` is required for target discovery.
 * @param {object} [config] - plugin configuration merged over {@link DEFAULTS}.
 * @param {{ execFile?: Function }} [deps] - test seam; production uses `node:child_process`.
 */
export function createRoutes(ctx, config = {}, deps = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const limits = {
    maxFiles: settings.maxFiles,
    maxDiffBytes: settings.maxDiffBytes,
    contextLines: settings.contextLines,
    timeoutMs: settings.timeoutMs,
  }
  const run = createRunner(settings, deps.execFile ?? null)
  const readFile = createFileReader()
  const diagnostics = createDiagnostics(settings)

  /** Resolve and authorize the `dir` query parameter. */
  function authorize(query) {
    const requested = normalizeDir(query.get('dir'))
    if (!requested) {
      return { error: json({ ok: false, message: 'dir 必须是存在的绝对目录路径' }, 400) }
    }
    const targets = collectTargets(ctx, settings)
    const match = targets.find((target) => sameDir(target.dir, requested))
    if (!match) {
      return {
        error: json(
          {
            ok: false,
            message: '该目录不是已注册的工作区，也不是任何会话的工作目录。可在插件配置的 allowedPaths 中加入它。',
            allowed: targets.map((target) => target.dir),
          },
          403,
        ),
      }
    }
    return { dir: match.dir, target: match }
  }

  /**
   * Resolve the request target: a Session id (its working directory comes from
   * the Host, so it needs no allow-list check) or an explicit authorized `dir`.
   */
  function resolveTarget(query) {
    const sessionId = query.get('sessionId')
    if (sessionId) {
      let cwd = null
      try {
        cwd = ctx.get?.('sessions')?.get?.(sessionId)?.header?.cwd ?? null
      } catch {
        cwd = null
      }
      const dir = normalizeDir(cwd)
      if (!dir) {
        return { error: json({ ok: false, message: '找不到该会话的工作目录，或它不是在文件系统上的目录' }, 404) }
      }
      return {
        dir,
        target: { kind: 'session', id: sessionId, dir, title: path.basename(dir), live: true, sessions: null },
      }
    }
    return authorize(query)
  }

  async function handleTargets() {
    return json({ ok: true, targets: collectTargets(ctx, settings) })
  }

  async function handleState(request) {
    const query = new URL(request.url).searchParams
    const authorized = resolveTarget(query)
    if (authorized.error) return authorized.error
    const { dir } = authorized

    let fetch = null
    if (query.get('fetch') === '1') {
      const remote = query.get('remote') || 'origin'
      const result = await run(['fetch', '--quiet', remote], dir)
      fetch = { remote, ok: result.status === 0, message: result.status === 0 ? null : result.stderr.trim() }
    }

    const resolved = await resolveBase(run, dir, query.get('base') || settings.base)
    const state = await inspectWorkspace({ run, readFile, dir, base: resolved.base, limits })
    const notes = [...(resolved.note ? [resolved.note] : []), ...(state.notes ?? [])]
    return json({
      ...state,
      notes,
      baseKind: resolved.kind,
      remote: resolved.remote,
      fetch,
      target: authorized.target,
      config: { gitPath: settings.gitPath, contextLines: settings.contextLines },
    })
  }

  async function handleDiff(request) {
    const query = new URL(request.url).searchParams
    const authorized = resolveTarget(query)
    if (authorized.error) return authorized.error
    const filePath = safeRepoPath(query.get('path'))
    if (!filePath) return json({ ok: false, message: 'path 必须是仓库内的相对路径' }, 400)

    const resolved = await resolveBase(run, authorized.dir, query.get('base') || settings.base)
    const diff = await readDiff({
      run,
      readFile,
      dir: authorized.dir,
      base: resolved.base,
      path: filePath,
      limits,
    })
    return json({ ...diff, base: resolved.base })
  }

  return { settings, limits, run, readFile, diagnostics, handleTargets, handleState, handleDiff }
}

/**
 * Mount the routes on the Connection fetch fence. Each registration is yielded
 * into one effect so unloading the plugin (or replacing the service) removes it.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin configuration.
 * @param {{ execFile?: Function }} [deps] - test seam; production uses `node:child_process`.
 */
export function apply(ctx, config = {}, deps = {}) {
  const routes = createRoutes(ctx, config, deps)
  const { record } = routes.diagnostics

  /** Wrap one route so every answer (and every failure) lands in the activity log. */
  const guard = (name, handler) => async (request) => {
    const started = Date.now()
    let query = null
    try {
      query = new URL(request.url).searchParams
    } catch {
      query = null
    }
    try {
      const response = await handler(request)
      let detail = {}
      try {
        const body = await response.clone().json()
        detail = {
          ok: body.ok,
          files: Array.isArray(body.files) ? body.files.length : undefined,
          base: body.base,
          reason: body.reason,
          gitDetail: body.detail ?? undefined,
          targets: Array.isArray(body.targets) ? body.targets.length : undefined,
          dirs: Array.isArray(body.targets) ? body.targets.slice(0, 6).map((entry) => entry.dir) : undefined,
        }
      } catch {
        detail = {}
      }
      await record({
        event: 'route',
        route: name,
        status: response.status,
        ms: Date.now() - started,
        sessionId: query?.get('sessionId') ?? undefined,
        dir: query?.get('dir') ?? undefined,
        ...detail,
      })
      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('changelist: route failed: %s', message)
      await record({ event: 'route', route: name, status: 500, ms: Date.now() - started, error: message })
      return json({ ok: false, message }, 500)
    }
  }

  ctx.effect(function* mountChangelist() {
    // Fire-and-forget: only disposers may be yielded into an effect.
    void record({ event: 'mounted', plugin: name, routes: Object.values(ROUTES), diagnostics: routes.diagnostics.path })
    yield () => {
      void record({ event: 'unmounted', plugin: name })
    }
    yield ctx.connection.fetch.register({
      path: ROUTES.targets,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard('targets', routes.handleTargets),
    })
    yield ctx.connection.fetch.register({
      path: ROUTES.state,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard('state', routes.handleState),
    })
    yield ctx.connection.fetch.register({
      path: ROUTES.diff,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard('diff', routes.handleDiff),
    })
    ctx.logger?.info?.('changelist: registered %s', Object.values(ROUTES).join(', '))
  }, 'changelist: fetch routes')
}
