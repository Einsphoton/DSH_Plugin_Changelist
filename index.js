/**
 * Host half of the workspace-changelist plugin.
 *
 * It answers three read-only routes for the browser half, registered inside the
 * Connection fetch fence so they inherit browser authentication and the
 * Host/Origin policy:
 *
 *   GET /api/changelist.targets
 *   GET /api/changelist.state?dir=<abs>[&vcs=auto|git|p4][&base=<ref>][&fetch=1][&remote=origin]
 *   GET /api/changelist.diff?dir=<abs>&path=<repo-relative>[&vcs=auto|git|p4][&base=<ref>]
 *
 * Every directory is validated against the directories the Harness itself knows
 * (registered workspaces and live session working directories) before any
 * version-control command runs. Commands run read-only with a scrubbed
 * environment and a wall-clock deadline; `fetch=1` (git) is the only command
 * that touches the network, and it never prompts for credentials.
 *
 * Two backends answer the same question. `vcs=auto` (the default) picks the one
 * that owns the directory — git for a work tree, Perforce for a client root —
 * and reports both when the directory is under both. `vcs=git` / `vcs=p4` force
 * one, but only after it verifies.
 *
 * @module @local/dsh-changelist
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
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
import {
  P4_DEFAULT_LIMITS,
  createProcessRunner as createP4ProcessRunner,
  createWorkspaceProbe,
  findP4Executable,
  p4Environment,
  readDiff as readP4Diff,
  readP4VConfig,
  readWorkspace as readP4Workspace,
} from './lib/p4.js'
import { createBackendRouter } from './lib/vcs.js'

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
  /** Which backend answers: `auto` picks what owns the directory. */
  vcs: 'auto',
  /**
   * Perforce executable. `null` means "find it": an explicit `p4Path`, else the
   * environment's, else PATH, else the two standard Windows install locations.
   */
  p4Path: null,
  /** Perforce connection overrides; `null` follows the ambient p4 configuration. */
  p4port: null,
  p4user: null,
  p4client: null,
  p4charset: null,
  /**
   * The `.p4qt` directory holding P4V's configuration, when it is not the
   * running user's home. Only needed for a Host whose home differs from P4V's.
   */
  p4vHome: null,
  /** Milliseconds one p4 command may run. */
  p4TimeoutMs: P4_DEFAULT_LIMITS.timeoutMs,
  /**
   * Scan for edits made outside Perforce (files changed but never `p4 edit`ed).
   * Off by default: a whole-workspace walk measured over ten minutes on a game
   * workspace, while the scoped per-subdirectory scan measured 243 ms. Only
   * ever run bounded by `p4ScanTimeoutMs`.
   */
  p4LocalEdits: false,
  /** Milliseconds the bounded local-edit scan may run before it degrades. */
  p4ScanTimeoutMs: P4_DEFAULT_LIMITS.scanTimeoutMs,
  /** Include shelved changelists in the answer. */
  p4Shelved: true,
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

/** Locations a Perforce installation hides in when it is not on PATH. */
export const P4_PATH_PATTERNS = [
  'C:\\Program Files\\Perforce\\p4.exe',
  'C:\\Program Files (x86)\\Perforce\\p4.exe',
  'C:\\Program Files\\Perforce\\p4',
  '/usr/local/bin/p4',
  '/usr/bin/p4',
]

const text = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))

/**
 * Find the Perforce executable: an explicit setting, then the environment,
 * then PATH, then the standard install locations. Never runs anything, so a
 * deployment without Perforce is detected without paying for a spawn.
 * @returns {{ path: string|null, source: string }}
 */
export function resolveP4Paths({ explicit = null, env = {}, patterns = P4_PATH_PATTERNS, exists = existsSync } = {}) {
  if (explicit) {
    return exists(explicit) ? { path: explicit, source: 'config' } : { path: null, source: 'config-missing' }
  }
  if (env.P4BIN) {
    const named = path.join(env.P4BIN, process.platform === 'win32' ? 'p4.exe' : 'p4')
    if (exists(named)) return { path: named, source: 'P4BIN' }
  }
  if (env.P4EXECUTABLE && exists(env.P4EXECUTABLE)) return { path: env.P4EXECUTABLE, source: 'P4EXECUTABLE' }
  // `p4` resolves through PATH when spawned, so an unqualified name is correct
  // here; existence is only provable by trying.
  for (const candidate of patterns) {
    if (exists(candidate)) return { path: candidate, source: 'install' }
  }
  return { path: 'p4', source: 'path' }
}

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

  // ── Perforce plumbing ───────────────────────────────────────────────────
  // The executable is resolved once, lazily: a deployment with no Perforce
  // installed must not pay for (or fail on) the lookup.
  let p4Paths = null
  function p4Executable() {
    if (p4Paths === null) {
      p4Paths = resolveP4Paths({
        explicit: settings.p4Path,
        env: process.env,
        patterns: P4_PATH_PATTERNS,
      })
    }
    return p4Paths
  }

  /**
   * Connection settings discovered from P4V's own files, read once. The Host
   * runs p4 with a scrubbed environment, so an installation whose P4PORT/P4USER
   * live in the Windows registry (`p4 set`) or only in P4V would otherwise look
   * like "no Perforce here" and the directory would be reported as a plain
   * git-less folder. Explicit configuration still wins over this.
   */
  let p4vConfig = null
  function discoveredP4() {
    // `deps.readP4VConfig` is the test seam, exactly like `deps.execFile`: the
    // Host test must be able to prove the discovered values are wired into the
    // connection without depending on the machine running the suite.
    if (p4vConfig === null) {
      const read = deps.readP4VConfig ?? readP4VConfig
      p4vConfig = read({ env: process.env, ...(settings.p4vHome ? { p4qtDir: settings.p4vHome } : {}) })
    }
    return p4vConfig
  }

  /** The connection environment for one request: query, then config, then P4V. */
  function p4EnvFor(query) {
    const known = discoveredP4()
    const overrides = {
      P4PORT: query?.get('p4port') || settings.p4port || known.port,
      P4USER: query?.get('p4user') || settings.p4user || known.user,
      P4CLIENT: query?.get('p4client') || settings.p4client || known.client,
      P4CHARSET: query?.get('p4charset') || settings.p4charset || known.charset,
    }
    const cleaned = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value))
    return p4Environment(process.env, { ...cleaned, P4CONFIG: null, P4OPTIONS: null })
  }

  /** A p4 runner for one request's resolved connection. */
  const makeP4Run = (query, timeoutKey) => {
    const found = p4Executable()
    if (!found.path) return null
    return createP4ProcessRunner({
      p4Path: found.path,
      timeoutMs: timeoutKey === 'scan' ? (settings.p4ScanTimeoutMs ?? settings.p4TimeoutMs) : settings.p4TimeoutMs,
      env: p4EnvFor(query),
      execFileFn: deps.execFile ?? null,
    })
  }

  const p4Limits = () => ({
    // Every p4 call passes `limits.timeoutMs` explicitly, so the configured
    // per-command deadline has to travel here or `p4TimeoutMs` would be ignored.
    timeoutMs: settings.p4TimeoutMs,
    maxFiles: settings.maxFiles,
    maxDiffBytes: settings.maxDiffBytes,
    contextLines: settings.contextLines,
    maxScanBytes: P4_DEFAULT_LIMITS.maxScanBytes,
  })

  // Detection runs against the connection a request actually asked for, so the
  // panel's "detected" column describes the connection in use rather than the
  // configured default. Results are cached per directory AND per connection.
  const detectCache = deps.detectCache ?? null
  const probeFor = (query) => {
    const p4run = makeP4Run(query, 'command')
    if (!p4run) return () => Promise.resolve({ ok: false, reason: 'p4-unavailable', detail: '找不到 p4 可执行文件' })
    // The probe is a p4 spawn like any other, so it gets the same deadline the
    // rest of the connection uses instead of the layer's default.
    const probe = createWorkspaceProbe({ run: p4run, probeTimeoutMs: settings.p4TimeoutMs })
    return (dir) => probe(dir)
  }
  const connectionKey = (query) => {
    const known = discoveredP4()
    return [
      query?.get('p4port') || settings.p4port || known.port || '',
      query?.get('p4user') || settings.p4user || known.user || '',
      query?.get('p4client') || settings.p4client || known.client || '',
      query?.get('p4charset') || settings.p4charset || known.charset || '',
    ]
      .join('\u0001')
      .toLowerCase()
  }

  const router = (deps.backendRouter ?? createBackendRouter)({
    ...(detectCache ? { cache: detectCache } : {}),
    isGitWorkTree: async (dir) => {
      const result = await run(['rev-parse', '--is-inside-work-tree'], dir)
      return result.status === 0 && text(result.stdout).trim() === 'true'
    },
    probeP4: (dir) => probeFor(null)(dir),
  })

  /** Resolve the backend for one request, honouring its connection overrides. */
  const resolveBackend = (query, dir) =>
    router.resolve({
      dir,
      requested: query?.get('vcs') || settings.vcs,
      probeP4: probeFor(query),
      envKey: connectionKey(query),
    })

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

    const backend = await resolveBackend(query, dir)
    if (backend.vcs === 'p4') return handleP4State(query, dir, authorized.target, backend)
    if (backend.vcs === 'git') return handleGitState(query, dir, authorized.target, backend)

    return json({
      ok: false,
      vcs: null,
      dir,
      reason: backend.reason ?? 'not-a-repository',
      message: backend.reason === 'p4-error' || backend.reason === 'p4-unavailable' ? 'Perforce 侧读取失败' : '该目录既不是 git 工作区，也不是 Perforce 工作区',
      detail: backend.detail ?? null,
      available: backend.available,
      target: authorized.target,
    })
  }

  /** Build the git answer plus the shared backend metadata. */
  async function handleGitState(query, dir, target, backend) {
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
      vcs: state.vcs ?? 'git',
      notes,
      baseKind: resolved.kind,
      remote: resolved.remote,
      fetch,
      target,
      available: backend.available,
      changedByBackend: backend.skipped ?? null,
      config: { gitPath: settings.gitPath, contextLines: settings.contextLines },
    })
  }

  /** Build the Perforce answer, including the connection summary the panel shows. */
  async function handleP4State(query, dir, target, backend) {
    const known = discoveredP4()
    // What the panel pre-fills: an explicit request, then plugin config, then what
    // P4V itself is already logged in with. The panel renders these inside the
    // same fields, marked as detected, so an empty form never looks like a
    // missing feature.
    const discovered = {
      port: query.get('p4port') || settings.p4port || known.port || null,
      user: query.get('p4user') || settings.p4user || known.user || null,
      client: query.get('p4client') || settings.p4client || known.client || null,
      charset: query.get('p4charset') || settings.p4charset || known.charset || null,
      from: known.sources.length > 0 ? 'p4v' : null,
    }
    const p4run = makeP4Run(query, 'command')
    if (!p4run) {
      return json({
        ok: false,
        vcs: 'p4',
        dir,
        reason: 'p4-unavailable',
        message: '找不到 p4 可执行文件（可在插件配置的 p4Path 中指定，或安装 Perforce CLI）',
        detail: null,
        available: backend.available,
        target,
        options: { localEdits: false, shelved: settings.p4Shelved !== false, p4Path: null, scanTimeoutMs: settings.p4ScanTimeoutMs, discovered },
      })
    }
    const scanRun = makeP4Run(query, 'scan')
    const wantLocalEdits = query.get('localEdits') === '1' || (query.get('localEdits') !== '0' && settings.p4LocalEdits)
    const wantShelved = query.get('shelved') === '0' ? false : settings.p4Shelved !== false
    // `p4 -ztag info` never reports the charset (only `unicode enabled`), so the
    // effective value comes from the connection environment the runner uses:
    // query override, then config, then P4V, then the ambient p4 setting.
    const connectionCharset = p4EnvFor(query).P4CHARSET ?? null
    const effectiveUser = discovered.user ?? backend.workspace?.user ?? null
    const effectiveWorkspace = backend.workspace
      ? {
          ...backend.workspace,
          user: effectiveUser,
          charset: connectionCharset,
        }
      : null

    const state = await readP4Workspace({
      run: p4run,
      scanRun: scanRun ?? p4run,
      readFile,
      dir,
      limits: p4Limits(),
      // The user on the connection is authoritative: it is what scopes the
      // pending/shelved queries, and what the panel labels "P4USER".
      workspace: effectiveWorkspace,
      p4Path: p4Executable().path,
      charset: connectionCharset,
      localEdits: wantLocalEdits,
      shelved: wantShelved,
      scanTimeoutMs: settings.p4ScanTimeoutMs,
    })
    const notes = Array.isArray(state.notes) ? [...state.notes] : []
    if (backend.changedByBackend === 'p4') notes.push('该目录同时是 git 与 Perforce 工作区；当前按 Perforce 显示')
    if (known.sources.length > 0 && !query.get('p4port') && !settings.p4port) {
      notes.push(`连接信息来自 P4V 的本地配置（${known.sources.join(' + ')}）`)
    }
    return json({
      ...state,
      vcs: state.vcs ?? 'p4',
      notes,
      options: { ...(state.options ?? {}), discovered },
      baseKind: state.baseKind ?? null,
      remote: null,
      fetch: null,
      target,
      available: backend.available,
      config: { p4Path: p4Executable().path, contextLines: settings.contextLines },
    })
  }

  async function handleDiff(request) {
    const query = new URL(request.url).searchParams
    const authorized = resolveTarget(query)
    if (authorized.error) return authorized.error
    const filePath = safeRepoPath(query.get('path'))
    if (!filePath) return json({ ok: false, message: 'path 必须是仓库内的相对路径' }, 400)

    const backend = await resolveBackend(query, authorized.dir)

    if (backend.vcs === 'p4') {
      const p4run = makeP4Run(query, 'command')
      if (!p4run) {
        return json({ ok: false, vcs: 'p4', path: filePath, message: '找不到 p4 可执行文件' }, 200)
      }
      // The client sends the depot path it was shown, but a request is not
      // trusted: only a `//depot/...` spec is accepted, so a malformed or
      // relative value can never be handed to `p4 print`/`p4 diff`. A
      // well-formed spec outside this client's view is still governed by the
      // Perforce user's own ACLs.
      const depotPath = query.get('depotPath')
      if (depotPath !== null && !/^\/\/[^/]+\/.+/.test(depotPath)) {
        return json({ ok: false, vcs: 'p4', path: filePath, message: 'depotPath 必须是 //depot/... 形式的路径' }, 400)
      }
      const diff = await readP4Diff({
        run: p4run,
        readFile,
        dir: authorized.dir,
        clientRoot: backend.workspace?.root ?? null,
        path: filePath,
        depotPath: depotPath || null,
        change: query.get('change') || null,
        shelved: query.get('shelved') === '1',
        changed: query.get('changed') === '1',
        limits: p4Limits(),
      })
      return json({ ...diff, vcs: 'p4', base: diff.base ?? 'depot head' })
    }

    if (backend.vcs === null) {
      return json(
        {
          ok: false,
          vcs: null,
          path: filePath,
          reason: backend.reason ?? 'not-a-repository',
          message: '无法确定该目录的版本控制系统',
          detail: backend.detail ?? null,
        },
        200,
      )
    }

    const resolved = await resolveBase(run, authorized.dir, query.get('base') || settings.base)
    const diff = await readDiff({
      run,
      readFile,
      dir: authorized.dir,
      base: resolved.base,
      path: filePath,
      limits,
    })
    return json({ ...diff, vcs: 'git', base: resolved.base })
  }

  return { settings, limits, run, readFile, diagnostics, router, p4Executable, handleTargets, handleState, handleDiff }
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
        const fromTarget = typeof body.target?.dir === 'string' && body.target.dir !== '' ? body.target.dir : undefined
        detail = {
          ok: body.ok,
          vcs: body.vcs,
          files: Array.isArray(body.files) ? body.files.length : undefined,
          base: body.base,
          reason: body.reason,
          gitDetail: body.detail ?? undefined,
          targets: Array.isArray(body.targets) ? body.targets.length : undefined,
          dirs: Array.isArray(body.targets) ? body.targets.slice(0, 6).map((entry) => entry.dir) : undefined,
          // The directory the answer is actually about. A `sessionId` request
          // carries no `dir` in the URL, so without body.dir a switch between
          // projects is indistinguishable in the log — which is exactly the
          // question when the panel seems not to follow the session.
          resolved: typeof body.dir === 'string' ? body.dir : fromTarget,
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
