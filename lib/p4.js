/**
 * Perforce plumbing behind the workspace changelist.
 *
 * Mirrors lib/git.js: everything here is pure with respect to the environment.
 * The caller injects `run` (execute one p4 command) and, when a local file has
 * to be read, `readFile`; nothing imports the Harness. That keeps the whole
 * data layer testable without a server and reusable from a plain node script.
 *
 * Three rules shape this module:
 *
 *  1. Only `-ztag` output is parsed (`... key value` lines). One documented
 *     exception exists: older servers answer `p4 status` in the human
 *     "<local> - reconcile to add <depot>#<rev>" form, so parseStatus accepts
 *     both shapes while the production path always asks for the tagged one.
 *  2. The workspace is never enumerated. `p4 fstat //client/...` walks 2.48M
 *     files in 28 s on the real workspace and a whole-workspace reconcile
 *     exceeded 10 minutes, so opened files come from `p4 opened`, local edits
 *     come from a `p4 status` scan scoped to the session subdirectory and
 *     bounded by scanTimeoutMs, and `p4 fstat` is only a capped per-file
 *     optimisation whose failure always degrades.
 *  3. Nothing here throws: a server, auth, timeout or parse failure becomes
 *     `{ ok:false, reason, dir, message, detail }` with the reasons
 *     `p4-unavailable` | `not-a-workspace` | `p4-error`.
 *
 * Every path handed back to a caller is client-workspace-relative and
 * '/'-separated, even when the session directory is a subdirectory of the
 * client root (measured: the session sits at
 * `Content\Example\style` inside `D:\Projects\Example`).
 *
 * @module dsh-changelist/lib/p4
 */
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'

import { clipDiff, scanContent } from './git.js'

/** @typedef {{ status: number|null, stdout: Buffer|string, stderr?: string, timedOut?: boolean }} RunResult */
/** @typedef {(args: string[], cwd?: string, options?: { timeoutMs?: number }) => Promise<RunResult>} P4Runner */
/** @typedef {(filePath: string, maxBytes: number) => Promise<Buffer>} FileReader */
/** @typedef {{ change: number|'default', status: string, user: string|null, client: string|null, description: string, date: string|null, files: number, shelved: boolean, isDefault: boolean }} Change */
/** @typedef {{ path: string, oldPath: string|null, status: 'M'|'A'|'D'|'R'|'C'|'T', added: number|null, deleted: number|null, untracked: boolean, binary: boolean, depotPath: string, action: string|null, change: number|'default', shelved: boolean, origin: 'opened'|'local'|'shelved', haveRev: number|null, headRev: number|null, needsSync: boolean, p4Type: string|null }} FileEntry */
/** @typedef {{ depotFile: string, clientFile: string|null, path: string|null, rev: number|null, haveRev: number|null, action: string, change: number|'default'|null, type: string|null, user: string|null, client: string|null, movedFile: string|null }} OpenedEntry */
/** @typedef {{ path: string, localPath: string, depotPath: string|null, rev: number|null, action: string, change: number|'default'|null, origin: 'opened'|'local' }} LocalEntry */

/** Bounds shared with the git data layer; the keys are part of the frozen contract. */
export const P4_DEFAULT_LIMITS = {
  /** Maximum changed files carried by one answer. */
  maxFiles: 500,
  /** Maximum bytes of one file comparison. */
  maxDiffBytes: 512 * 1024,
  /** Milliseconds one p4 command may run. */
  timeoutMs: 20_000,
  /** Milliseconds the scoped local-edit scan may run. */
  scanTimeoutMs: 120_000,
  /** Context lines in a comparison. */
  contextLines: 3,
  /** Maximum bytes read from a local (unopened) file. */
  maxScanBytes: 2 * 1024 * 1024,
}

/**
 * Bounds that belong to this module rather than the contract: they keep the
 * per-request cost predictable on a workspace with millions of files.
 */
const P4_INTERNAL = {
  /** Changelists carried by one answer (`changes -m`). */
  maxChangelists: 10,
  /** Changelists whose file list is fetched with one extra `describe`. */
  maxChangelistDetails: 6,
  /** Depot files handed to the single optimising `fstat -m` call. */
  maxFstatFiles: 100,
}

/** Environment names a p4 child keeps. Everything else is dropped. */
const ENV_KEEP = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]

/** Perforce settings that survive scrubbing, so an authenticated session still works. */
const ENV_P4 = [
  'P4PORT',
  'P4USER',
  'P4CLIENT',
  'P4CHARSET',
  'P4CONFIG',
  'P4TRUST',
  'P4PASSWD',
  'P4TICKETS',
  'P4IGNORE',
]

/** Friendly override names accepted by p4Environment. */
const ENV_OVERRIDE_ALIASES = {
  port: 'P4PORT',
  user: 'P4USER',
  client: 'P4CLIENT',
  charset: 'P4CHARSET',
  config: 'P4CONFIG',
  trust: 'P4TRUST',
  passwd: 'P4PASSWD',
  tickets: 'P4TICKETS',
  ignore: 'P4IGNORE',
}

/** Candidate install locations, tried in order when nothing explicit is configured. */
const P4_CANDIDATES = [
  'C:\\Program Files\\Perforce\\p4.exe',
  'C:\\Program Files (x86)\\Perforce\\p4.exe',
  '/usr/bin/p4',
  '/usr/local/bin/p4',
  '/opt/homebrew/bin/p4',
  '/opt/perforce/bin/p4',
]

const text = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))

/** First non-empty line, trimmed. */
function firstLine(value) {
  const lines = text(value).split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** A finite positive number, or null. */
function positiveNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/** Integer, or null. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** `default` and `new` both mean the default changelist. */
function parseChange(value) {
  if (value === null || value === undefined || value === '') return null
  const raw = String(value).trim()
  if (raw === '') return null
  if (raw.toLowerCase() === 'default' || raw.toLowerCase() === 'new') return 'default'
  const number = toNumber(raw)
  return number === null ? null : number
}

/** Accept `true`, 1, '1', 'true', 'yes', 'on' as true. */
function asBool(value) {
  if (value === true) return true
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

/** One run result with a Buffer stdout, whatever the runner handed back. */
function normalizeRunResult(value) {
  const result = value ?? {}
  let status = result.status
  if (typeof status !== 'number') status = status === null || status === undefined ? -1 : Number(status)
  if (!Number.isFinite(status)) status = -1
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8')
  const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr ? String(result.stderr) : ''
  return { status, stdout, stderr, timedOut: result.timedOut === true }
}

/** Run the injected runner, turning a throw into a failed result. */
async function runSafely(run, args, cwd, callOptions) {
  try {
    return await run(args, cwd, callOptions)
  } catch (error) {
    return { status: -1, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** Split one shell-free command line into tokens (used only for diagnostics). */
function commandLine(args) {
  return ['p4', ...args].join(' ')
}

/* -------------------------------------------------------------------------- */
/* ztag parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Split `-ztag` output into records keyed by lower-cased tag name.
 *
 * A record starts at any key listed in `startKeys`. Lines that do not begin
 * with `... ` continue the previous value: p4 emits multi-line descriptions
 * verbatim, so `desc` can own physical lines that carry no tag prefix.
 *
 * @param {Buffer|string} raw
 * @param {string[]} startKeys
 * @returns {Array<Record<string, string>>}
 */
function splitRecords(raw, startKeys) {
  const starts = new Set(startKeys.map((key) => key.toLowerCase()))
  const records = []
  let current = null
  let lastKey = null
  for (const line of text(raw).split(/\r?\n/)) {
    if (line.startsWith('... ')) {
      const body = line.slice(4)
      const space = body.indexOf(' ')
      const key = (space === -1 ? body : body.slice(0, space)).trim().toLowerCase()
      const value = space === -1 ? '' : body.slice(space + 1)
      if (current === null || starts.has(key)) {
        current = {}
        records.push(current)
      }
      if (current[key] === undefined) current[key] = value.trim()
      lastKey = key
      continue
    }
    if (current === null || lastKey === null) continue
    const existing = current[lastKey] ?? ''
    const continuation = line.trimEnd()
    current[lastKey] = existing === '' ? continuation : `${existing}\n${continuation}`
  }
  // p4 separates tags and records with blank lines, and a blank line after a tag
  // arrives here as a continuation. `/^...$/` style checks and type comparisons
  // must not see that trailing newline; internal blank lines (a multi-paragraph
  // description) survive because only the tail is trimmed.
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') record[key] = value.trimEnd()
    }
  }
  return records
}

/** Case-insensitive tag lookup; null when the tag is absent. */
function tagValue(record, name) {
  if (!record) return null
  const value = record[String(name).toLowerCase()]
  return value === undefined ? null : value
}

/** True when the tag is present at all (a valueless flag still counts). */
function hasTag(record, name) {
  return Boolean(record) && Object.prototype.hasOwnProperty.call(record, String(name).toLowerCase())
}

/** Indexed `keyN` tags grouped by N, e.g. `depotFile0`/`action0`/`type0`. */
function collectIndexedFiles(record) {
  const byIndex = new Map()
  for (const [key, value] of Object.entries(record ?? {})) {
    const match = /^([a-z][a-z0-9]*?)(\d+)$/.exec(key)
    if (!match) continue
    const index = Number(match[2])
    const entry = byIndex.get(index) ?? {}
    entry[match[1]] = value
    byIndex.set(index, entry)
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entry]) => ({ index, ...entry }))
}

/** `/`-separated, no surrounding spaces. */
function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** Last `#<rev>` of a depot path, split off as a number. */
function splitRevision(spec) {
  const match = /#([^#\s]+)\s*$/.exec(spec)
  if (!match) return { path: spec, rev: null }
  return { path: spec.slice(0, match.index), rev: toNumber(match[1]) }
}

/** Client-relative path out of `//<client>/<rel>`; null when it is not one. */
function clientPathFromClientFile(clientFile) {
  const value = normalizeSlashes(clientFile)
  if (!value.startsWith('//')) return null
  const segments = value.slice(2).split('/').filter((segment) => segment !== '')
  if (segments.length <= 1) return null
  return safeRelative(segments.slice(1).join('/'))
}

/** Client-relative base out of `//<client>[/<rel>]`; '' for the client root. */
function clientBaseFromClientPath(clientPath) {
  const value = normalizeSlashes(clientPath).replace(/\/+$/, '')
  if (!value.startsWith('//')) return null
  const segments = value.slice(2).split('/').filter((segment) => segment !== '')
  if (segments.length <= 1) return ''
  const rel = segments.slice(1).join('/')
  return rel === '' ? '' : safeRelative(rel)
}

/** Reject anything that could leave the client root. */
function safeRelative(value) {
  if (typeof value !== 'string') return null
  const normalized = normalizeSlashes(value).trim()
  if (normalized === '') return null
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

/** Join a client-relative base with the remainder of a depot path. */
function joinRelative(base, rest) {
  const tail = normalizeSlashes(rest).replace(/^\/+/, '')
  if (!base) return tail
  if (!tail) return base
  return `${base}/${tail}`
}

/* -------------------------------------------------------------------------- */
/* environment and executable discovery                                       */
/* -------------------------------------------------------------------------- */

/**
 * Environment handed to p4: the ambient Perforce settings plus, when the panel
 * supplies them, explicit overrides. Credential-shaped and unrelated variables
 * are dropped, configuration-file discovery stays off unless asked for, and no
 * interactive prompt is possible (stdin is closed by the runner).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, string|undefined|null>} [overrides]
 * @returns {Record<string,string>}
 */
export function p4Environment(env = process.env, overrides = {}) {
  const result = {}
  for (const key of ENV_KEEP) {
    if (env?.[key] !== undefined && env[key] !== '') result[key] = String(env[key])
  }
  for (const key of ENV_P4) {
    if (env?.[key] !== undefined && env[key] !== '') result[key] = String(env[key])
  }
  for (const [rawKey, rawValue] of Object.entries(overrides ?? {})) {
    // `undefined` means "not mentioned"; `null` means "clear it". The Host uses
    // the second form to keep a stray ambient `.p4config` from switching port or
    // client mid-session, so it must not be skipped like an absent value.
    if (rawValue === undefined) continue
    const upper = String(rawKey).toUpperCase()
    const name = upper.startsWith('P4') ? upper : ENV_OVERRIDE_ALIASES[String(rawKey).toLowerCase()]
    if (!name) continue
    if (rawValue === null || rawValue === '') {
      result[name] = ''
      continue
    }
    result[name] = String(rawValue)
  }
  // A stray `.p4config` in a scanned directory would silently switch port or
  // client mid-session, so discovery is disabled unless the caller named one.
  if (result.P4CONFIG === undefined) result.P4CONFIG = ''
  return result
}

/** Search PATH for one executable name, honouring PATHEXT on Windows. */
function searchPath(name, env, existsSyncFn) {
  const pathValue = env?.PATH ?? env?.Path ?? ''
  if (typeof pathValue !== 'string' || pathValue === '') return null
  const extensions =
    process.platform === 'win32'
      ? String(env?.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue
    const candidates = [path.join(dir, name), ...extensions.map((ext) => path.join(dir, `${name}${ext}`))]
    for (const candidate of candidates) {
      try {
        if (existsSyncFn(candidate)) return candidate
      } catch {
        /* an unreadable PATH entry is skipped */
      }
    }
  }
  return null
}

/**
 * Locate the p4 executable: an explicit path wins, then `P4EXECUTABLE`, then the
 * well-known install locations, then PATH.
 *
 * @param {{ explicit?: string|null, env?: NodeJS.ProcessEnv, existsSyncFn?: (path: string) => boolean }} [options]
 * @returns {string|null}
 */
export function findP4Executable(options = {}) {
  const settings = typeof options === 'string' ? { explicit: options } : options ?? {}
  const env = settings.env ?? process.env
  const existsSyncFn = settings.existsSyncFn ?? fsExistsSync
  const exists = (candidate) => {
    try {
      return existsSyncFn(candidate)
    } catch {
      return false
    }
  }

  const explicit = typeof settings.explicit === 'string' ? settings.explicit.trim() : ''
  if (explicit !== '') {
    if (/[\\/]/.test(explicit)) return exists(explicit) ? explicit : null
    return searchPath(explicit, env, exists) ?? explicit
  }

  const fromEnv = typeof env?.P4EXECUTABLE === 'string' ? env.P4EXECUTABLE.trim() : ''
  if (fromEnv !== '' && exists(fromEnv)) return fromEnv

  for (const candidate of P4_CANDIDATES) {
    if (exists(candidate)) return candidate
  }
  return searchPath('p4', env, exists)
}

/** First capture group of the first match, trimmed; null when absent. */
function firstTag(xml, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml)
  return match ? match[1].trim() || null : null
}

/**
 * Raw (untrimmed) content of a P4V settings entry. P4V writes these as
 * `<StringList varName="Name">…</StringList>`, not `<Name>…</Name>`. The word
 * boundaries matter: without them the `String` alternative matches the
 * `String` inside `<StringList` and leaves `List` unconsumed.
 */
function p4vSettingBlock(xml, name) {
  const match = new RegExp(
    `<(StringList|String|Bool|Int)\\b[^>]*\\bvarName="${name}"[^>]*>([\\s\\S]*?)</\\1>`,
    'i',
  ).exec(xml)
  return match ? match[2] : null
}

/**
 * Text of the first nested `<String>` entry of a list block. The caller may
 * already have trimmed the block, which can drop a trailing `>`, so the closing
 * bracket is optional here; the word boundary keeps `<StringList>` from being
 * mistaken for a bare `<String>`.
 */
function p4vListEntry(block) {
  // `<StringList>` must not be mistaken for a bare `<String>`, hence `\b`.
  const match = /<String\b[^>]*>([\s\S]*?)<\/String>/i.exec(block)
  return match ? match[1].trim() || null : null
}

/** Home directory, or null when the platform cannot supply one. */
function safeHomedir() {
  try {
    const home = osHomedir()
    return typeof home === 'string' && home.trim() !== '' ? home : null
  } catch {
    return null
  }
}

/**
 * Connection settings P4V already knows, read from its own files.
 *
 * This matters because the Host runs p4 with a deliberately scrubbed
 * environment: it keeps only an allow-list plus a few P4 variables, so an
 * installation whose P4PORT/P4USER live in the Windows registry (where `p4 set`
 * puts them) or only in P4V would otherwise answer "no server configured" and
 * the directory would be reported as a plain git-less folder. Reading P4V's own
 * configuration makes the panel show the connection the user already logs in
 * with, instead of an empty form.
 *
 * Read-only and best-effort: every failure yields nulls, and explicit caller
 * configuration still wins over anything discovered here.
 *
 * @param {{ home?: string, p4qtDir?: string, readFileSyncFn?: (path: string) => string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ port: string|null, user: string|null, client: string|null, charset: string|null, clientRoot: string|null, sources: string[] }}
 */
export function readP4VConfig(options = {}) {
  const env = options.env ?? process.env
  const readFileSyncFn = options.readFileSyncFn ?? fsReadFileSync
  // An explicitly supplied environment is authoritative: when it names no home,
  // there is none, and the reader must not reach for the real one instead.
  const explicit = typeof options.home === 'string' && options.home.trim() !== ''
  const explicitDir = typeof options.p4qtDir === 'string' && options.p4qtDir.trim() !== ''
  const fromEnv = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)
  const home =
    (explicit ? options.home.trim() : null) ??
    fromEnv(env?.USERPROFILE) ??
    fromEnv(env?.HOME) ??
    (options.env === undefined ? safeHomedir() : null)
  const found = { port: null, user: null, client: null, charset: null, clientRoot: null, sources: [] }
  const qtDir = explicitDir ? options.p4qtDir.trim() : home ? path.join(home, '.p4qt') : null
  if (!qtDir) return found
  const read = (file) => {
    try {
      const raw = readFileSyncFn(path.join(qtDir, file))
      // The injected reader may legitimately hand back a Buffer.
      return raw === null || raw === undefined ? null : String(raw)
    } catch {
      return null
    }
  }

  // connectionmap.xml records every connection P4V has used. `P4Port` is the
  // address shown in the UI; `ServerAddress` is the same server by IP. The last
  // entry is the most recent one.
  const map = read('connectionmap.xml')
  if (map) {
    const ports = [...map.matchAll(/<P4Port>([^<]*)<\/P4Port>/gi)].map((match) => match[1].trim()).filter(Boolean)
    const users = [...map.matchAll(/<User>([^<]*)<\/User>/gi)].map((match) => match[1].trim()).filter(Boolean)
    if (ports.length > 0) {
      found.port = ports[ports.length - 1]
      found.sources.push('connectionmap.xml')
    }
    if (users.length > 0) found.user = users[users.length - 1]
  }

  // ApplicationSettings.xml carries the default charset and the workspace P4V
  // last opened, as the comma-joined triple "port, user, workspace".
  const app = read('ApplicationSettings.xml')
  if (app) {
    const charset = p4vSettingBlock(app, 'DefaultCharset')
    if (charset) found.charset = charset.trim() || null
    const opened = p4vSettingBlock(app, 'OpenWorkspaces')
    if (opened) {
      const entry = p4vListEntry(opened)
      if (entry) {
        // "port, user, workspace" — a workspace name may legitimately contain a
        // comma, so only the first two fields are split off. Interior spaces are
        // preserved; only the ends are trimmed, because the workspace name is
        // the component of this triple.
        const parts = entry.split(',')
        if (parts.length >= 3) {
          found.client = parts.slice(2).join(',').trim() || null
          const port = (parts[0] ?? '').trim()
          const user = (parts[1] ?? '').trim()
          if (!found.port && port) found.port = port
          if (!found.user && user) found.user = user
        }
      }
    }
    if (found.charset || found.client) found.sources.push('ApplicationSettings.xml')
  }

  return found
}

/**
 * Production runner: spawns p4 with piped stdio, a scrubbed environment and a
 * per-command deadline.
 *
 * stdin is closed (`ignore`) so an unauthenticated server can never turn a read
 * into a hanging password prompt; the command then fails fast and the panel can
 * say so. `callOptions.timeoutMs` overrides the runner default for one command
 * (the local-edit scan uses scanTimeoutMs).
 *
 * @param {{ p4Path?: string, timeoutMs?: number, maxBuffer?: number, env?: Record<string,string>, execFileFn?: Function }} [options]
 * @returns {P4Runner}
 */
export function createProcessRunner(options = {}) {
  const p4Path = options.p4Path ?? 'p4'
  const timeoutMs = options.timeoutMs ?? P4_DEFAULT_LIMITS.timeoutMs
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024
  const execFileFn = options.execFileFn ?? null
  const env = options.env ?? p4Environment()
  return async function run(args, cwd, callOptions = {}) {
    const { execFile } = execFileFn ? { execFile: execFileFn } : await import('node:child_process')
    const timeout = positiveNumber(callOptions?.timeoutMs) ?? timeoutMs
    return await new Promise((resolve) => {
      execFile(
        p4Path,
        args,
        {
          cwd,
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: 'buffer',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        (error, stdout, stderr) => {
          const status = error && typeof error.code === 'number' ? error.code : error ? -1 : 0
          const timedOut = Boolean(error && (error.killed === true || error.code === 'ETIMEDOUT'))
          resolve({
            status,
            stdout: stdout ?? Buffer.alloc(0),
            stderr: stderr ? stderr.toString('utf8') : error ? String(error.message) : '',
            timedOut,
          })
        },
      )
    })
  }
}

/* -------------------------------------------------------------------------- */
/* workspace probe                                                            */
/* -------------------------------------------------------------------------- */

/** Client workspace fields out of one `p4 -ztag info` record. */
function workspaceFromInfo(raw) {
  const record = splitRecords(raw, ['username'])[0] ?? splitRecords(raw, ['clientname'])[0] ?? null
  const tags = record ?? {}
  return {
    client: tagValue(tags, 'clientname') || null,
    root: tagValue(tags, 'clientroot') || null,
    port: tagValue(tags, 'serveraddress') || tagValue(tags, 'clientaddress') || null,
    user: tagValue(tags, 'username') || null,
    stream: tagValue(tags, 'clientstream') || null,
    charset: tagValue(tags, 'charset') || null,
  }
}

/** Perforce's own words decide between "cannot run" and "ran and failed". */
function classifyFailure(result) {
  if (result.status === -1 || result.timedOut === true) return 'p4-unavailable'
  const detail = text(result.stderr)
  if (/connect to server failed|tcp connect|connection refused|failed to connect|no such host|timed out|WSA/i.test(detail)) {
    return 'p4-unavailable'
  }
  return 'p4-error'
}

/**
 * Build a cheap directory probe: one `p4 -ztag info` in `dir`, then a check that
 * `dir` really sits inside the reported client root.
 *
 * @param {{ run: P4Runner, probeTimeoutMs?: number, charset?: string|null }} options
 * @returns {(dir: string) => Promise<{ ok: boolean, client: string|null, root: string|null, port: string|null, user: string|null, charset: string|null, stream: string|null, reason: string|null, detail: string|null }>}
 */
export function createWorkspaceProbe(options = {}) {
  const run = options.run
  const probeTimeoutMs = positiveNumber(options.probeTimeoutMs) ?? P4_DEFAULT_LIMITS.timeoutMs
  const charset = options.charset ?? null
  const empty = {
    ok: false,
    client: null,
    root: null,
    port: null,
    user: null,
    charset,
    stream: null,
    reason: null,
    detail: null,
  }
  return async function probe(dir) {
    if (typeof run !== 'function') {
      return { ...empty, reason: 'p4-unavailable', detail: 'no p4 runner' }
    }
    try {
      const result = normalizeRunResult(await runSafely(run, ['-ztag', 'info'], dir, { timeoutMs: probeTimeoutMs }))
      if (result.status !== 0) {
        return {
          ...empty,
          reason: classifyFailure(result),
          detail: firstLine(result.stderr) || `p4 -ztag info exited with ${result.status}`,
        }
      }
      const info = workspaceFromInfo(text(result.stdout))
      if (!info.client || !info.root) {
        return { ...empty, reason: 'p4-error', detail: 'p4 -ztag info did not report clientName/clientRoot' }
      }
      if (clientRelative(info.root, dir) === null) {
        return {
          ...empty,
          client: info.client,
          root: info.root,
          reason: 'not-a-workspace',
          detail: `directory is outside the client root ${info.root}`,
        }
      }
      return {
        ok: true,
        client: info.client,
        root: info.root,
        port: info.port,
        user: info.user,
        charset: info.charset ?? charset,
        stream: info.stream,
        reason: null,
        detail: null,
      }
    } catch (error) {
      return {
        ...empty,
        reason: 'p4-unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* path mapping                                                               */
/* -------------------------------------------------------------------------- */

/** Directory `dir` relative to `root`, '' for the root itself, null when outside. */
function clientRelative(root, dir) {
  const base = normalizeSlashes(root).replace(/\/+$/, '').toLowerCase()
  const target = normalizeSlashes(dir).replace(/\/+$/, '')
  const lowered = target.toLowerCase()
  if (lowered === base) return ''
  if (lowered.startsWith(`${base}/`)) return target.slice(base.length + 1)
  return null
}

/**
 * One `p4 -ztag where` answer becomes depot-prefix -> client-base rows. Both a
 * `...` pattern row and an exact single-file row are understood.
 */
function whereMapping(raw) {
  const rows = []
  for (const record of splitRecords(raw, ['depotfile'])) {
    const depotFile = tagValue(record, 'depotfile')
    const clientFile = tagValue(record, 'clientfile')
    if (!depotFile || !clientFile) continue
    const depot = normalizeSlashes(depotFile)
    const client = normalizeSlashes(clientFile)
    const wildcard = depot.endsWith('/...') && client.endsWith('/...')
    const depotPrefix = wildcard ? `${depot.slice(0, -4)}/` : depot
    const clientBase = clientBaseFromClientPath(wildcard ? client.slice(0, -4) : client)
    if (clientBase === null) continue
    rows.push({ depotPrefix, clientBase, wildcard })
  }
  return rows
}

/** Map a depot path through a `where` mapping; longest match wins. */
function mapDepotPath(depotPath, mapping) {
  const value = normalizeSlashes(depotPath)
  if (!Array.isArray(mapping) || mapping.length === 0) return null
  for (const caseInsensitive of [false, true]) {
    const needle = caseInsensitive ? value.toLowerCase() : value
    let best = null
    for (const row of mapping) {
      const prefix = caseInsensitive ? String(row.depotPrefix).toLowerCase() : row.depotPrefix
      if (row.wildcard) {
        if (!needle.startsWith(prefix)) continue
        const rest = value.slice(row.depotPrefix.length)
        if (rest === '') continue
        const candidate = { score: row.depotPrefix.length, rel: joinRelative(row.clientBase, rest) }
        if (!best || candidate.score > best.score) best = candidate
      } else if (needle === prefix) {
        const candidate = { score: row.depotPrefix.length, rel: row.clientBase }
        if (!best || candidate.score > best.score) best = candidate
      }
    }
    if (best) return safeRelative(best.rel)
  }
  return null
}

/** Normalise whatever the caller passed as a client root into a lookup context. */
function normalizeRoot(root) {
  const context = { root: null, client: null, stream: null, mapping: [] }
  const merge = (value) => {
    if (!value || typeof value !== 'object') return
    if (!context.root && typeof value.root === 'string' && value.root.trim() !== '') context.root = value.root.trim()
    if (!context.root && typeof value.path === 'string' && value.path.trim() !== '') context.root = value.path.trim()
    if (!context.client && typeof value.client === 'string' && value.client.trim() !== '') context.client = value.client.trim()
    if (!context.stream && typeof value.stream === 'string' && value.stream.trim() !== '') context.stream = value.stream.trim()
    if (context.mapping.length === 0) {
      if (typeof value.where === 'string' && value.where.trim() !== '') context.mapping = whereMapping(value.where)
      else if (Array.isArray(value.mapping)) context.mapping = value.mapping.filter((row) => row && row.depotPrefix)
    }
    if (value.workspace) merge(value.workspace)
  }
  if (typeof root === 'string') {
    if (root.trim() !== '') context.root = root.trim()
    return context
  }
  merge(root)
  return context
}

/**
 * Map a depot path, a client path or a local path back to a
 * client-workspace-relative '/'-separated path.
 *
 * The second argument may be a client root string, or a context object
 * `{ root, client, stream, where | mapping, workspace }`. A `where` result
 * (raw `p4 -ztag where` text) is the authoritative mapping; without one the
 * caller's stream or client prefix is used, and a bare `//<name>/...` path falls
 * back to substituting that first segment away.
 *
 * @param {string} depotOrLocal
 * @param {string|object|null} root
 * @returns {string|null}
 */
export function toClientPath(depotOrLocal, root) {
  if (typeof depotOrLocal !== 'string') return null
  const value = depotOrLocal.trim()
  if (value === '') return null
  const context = normalizeRoot(root)

  if (value.startsWith('\\\\')) {
    return context.root ? safeRelative(relativeToRoot(context.root, value)) : null
  }

  if (value.startsWith('//')) {
    const normalized = normalizeSlashes(value)
    const segments = normalized.slice(2).split('/').filter((segment) => segment !== '')
    if (segments.length === 0) return null
    if (segments.some((segment) => segment === '..')) return null
    if (context.client && segments[0].toLowerCase() === context.client.toLowerCase()) {
      return safeRelative(segments.slice(1).join('/'))
    }
    const mapped = mapDepotPath(normalized, context.mapping)
    if (mapped !== null) return mapped
    if (context.mapping.length > 0) return null
    // No view information: substitute the leading depot (or client) name away.
    return safeRelative(segments.slice(1).join('/'))
  }

  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) {
    return context.root ? safeRelative(relativeToRoot(context.root, value)) : null
  }

  return safeRelative(value)
}

/** Local absolute path relative to a client root; null when it is outside. */
function relativeToRoot(root, localPath) {
  const base = normalizeSlashes(root).replace(/\/+$/, '').toLowerCase()
  const target = normalizeSlashes(localPath).replace(/\/+$/, '')
  const lowered = target.toLowerCase()
  if (lowered === base) return ''
  if (!lowered.startsWith(`${base}/`)) return null
  return target.slice(base.length + 1)
}

/* -------------------------------------------------------------------------- */
/* parsers                                                                    */
/* -------------------------------------------------------------------------- */

/** `opened`/`move/add` style verbs kept verbatim; unknown verbs pass through. */
function normalizeAction(value) {
  const action = String(value ?? '').trim().toLowerCase()
  return action === '' ? 'edit' : action
}

/** A p4 open action as the git status letter the panel already understands. */
function actionStatus(action) {
  switch (String(action ?? '').toLowerCase()) {
    case 'add':
    case 'branch':
    case 'import':
      return 'A'
    case 'delete':
    case 'purge':
    case 'archive':
    case 'move/delete':
      return 'D'
    case 'move/add':
      return 'R'
    case 'edit/type':
    case 'type':
      return 'T'
    default:
      return 'M'
  }
}

/**
 * Decide binary from the p4 file type: a `binary` base type, an `apple` or
 * `resource` container, or the `+F` modifier (whole-file storage, whose diff is
 * a full dump rather than a comparison). `+x` is only the executable bit of a
 * text file, which p4 diffs normally, so it does not make a file binary.
 */
function isBinaryType(type) {
  if (typeof type !== 'string' || type.trim() === '') return false
  const parts = type.trim().split('+')
  const base = (parts[0] ?? '').toLowerCase()
  // Modifiers are compared as a list, not by substring: `+Sx` is two modifiers
  // and must not be read as a single one matching "x".
  const modifiers = parts.slice(1).map((modifier) => modifier.trim().toLowerCase())
  if (base.startsWith('binary') || base === 'apple' || base === 'resource') return true
  return modifiers.some((modifier) => modifier === 'f')
}

/**
 * Parse `p4 -ztag opened`.
 * @param {Buffer|string} raw
 * @returns {OpenedEntry[]}
 */
export function parseOpened(raw) {
  const entries = []
  for (const record of splitRecords(raw, ['depotfile'])) {
    const depotFile = tagValue(record, 'depotfile')
    if (!depotFile) continue
    const clientFile = tagValue(record, 'clientfile')
    entries.push({
      depotFile,
      clientFile: clientFile ?? null,
      path: clientPathFromClientFile(clientFile),
      rev: toNumber(tagValue(record, 'rev')),
      haveRev: toNumber(tagValue(record, 'haverev')) ?? toNumber(tagValue(record, 'rev')),
      action: normalizeAction(tagValue(record, 'action')),
      change: parseChange(tagValue(record, 'change')),
      type: tagValue(record, 'type')?.trim() || null,
      user: tagValue(record, 'user') || null,
      client: tagValue(record, 'client') || null,
      movedFile: tagValue(record, 'movedfile') || tagValue(record, 'fromfile') || null,
    })
  }
  return entries
}

/** Client-relative path from a tagged-status record. */
function localEntryPath(localFile, clientFile, depotFile, root) {
  const local = typeof localFile === 'string' && localFile.trim() !== '' ? localFile.trim() : null
  if (local) {
    const mapped = toClientPath(local, root)
    if (mapped) return { path: mapped, localPath: local }
  }
  if (clientFile) {
    const mapped = toClientPath(clientFile, root) ?? clientPathFromClientFile(clientFile)
    if (mapped) return { path: mapped, localPath: clientFile }
  }
  if (depotFile) {
    const mapped = toClientPath(depotFile, root)
    if (mapped) return { path: mapped, localPath: mapped }
  }
  return null
}

/**
 * Parse `p4 status`: the tagged form (`p4 -ztag status`, the production path)
 * and the human form an older server answers
 * (`<local> - reconcile to add //depot/file#1`) both land in the same shape.
 *
 * `root` is the client root the printed local paths are relative to.
 *
 * @param {Buffer|string} raw
 * @param {string|object|null} [root]
 * @returns {LocalEntry[]}
 */
export function parseStatus(raw, root = null) {
  const body = text(raw)
  const entries = []

  if (/^\.\.\. /m.test(body)) {
    for (const record of splitRecords(body, ['depotfile'])) {
      const depotFile = tagValue(record, 'depotfile')
      const localFile = tagValue(record, 'localfile')
      const change = parseChange(tagValue(record, 'change'))
      const located = localEntryPath(localFile, tagValue(record, 'clientfile'), depotFile, root)
      if (!located) continue
      entries.push({
        path: located.path,
        localPath: located.localPath,
        depotPath: depotFile ?? null,
        rev: toNumber(tagValue(record, 'workrev')) ?? toNumber(tagValue(record, 'haverev')),
        action: normalizeAction(tagValue(record, 'action')),
        change,
        origin: change === null ? 'local' : 'opened',
      })
    }
    return entries
  }

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = /^(.*?) - (?:submit change (\S+) to |reconcile to )([A-Za-z][A-Za-z/]*?) (\/\/.+)$/.exec(trimmed)
    if (!match) continue
    const [, localLine, submittedChange, action, depotSpec] = match
    const { path: depotPath, rev } = splitRevision(depotSpec)
    const located = localEntryPath(localLine, null, depotPath, root)
    if (!located) continue
    const change = submittedChange === undefined ? null : parseChange(submittedChange)
    entries.push({
      path: located.path,
      localPath: localLine,
      depotPath,
      rev,
      action: normalizeAction(action),
      change,
      origin: submittedChange === undefined ? 'local' : 'opened',
    })
  }
  return entries
}

/** One parsed changelist record as the contract's Change shape. */
function recordToChange(record) {
  const change = parseChange(tagValue(record, 'change'))
  if (change === null) return null
  const shelved = hasTag(record, 'shelved')
  const rawStatus = String(tagValue(record, 'status') ?? '').trim().toLowerCase()
  const status = shelved ? 'shelved' : rawStatus === '' || rawStatus === 'new' ? 'pending' : rawStatus
  // `change -o` sends the placeholder as the description, and the blank line
  // after it arrives as a trailing newline: trim before comparing, or `$` never
  // matches the end of the value.
  const description = String(tagValue(record, 'description') ?? tagValue(record, 'desc') ?? '')
    .replace(/\r/g, '')
    .trim()
    .replace(/^<enter description here>$/i, '')
    .trim()
  const time = toNumber(tagValue(record, 'time'))
  const rawDate = tagValue(record, 'date')
  const date = time !== null && time > 0 ? new Date(time * 1000).toISOString() : rawDate ? rawDate.trim() : null
  const files = collectIndexedFiles(record).filter((entry) => entry.depotfile).length
  return {
    change,
    // `number` is the same value under the name the browser half reads.
    number: change,
    status,
    user: tagValue(record, 'user') || null,
    client: tagValue(record, 'client') || null,
    description,
    date,
    files,
    shelved,
    isDefault: change === 'default',
  }
}

/**
 * Parse `p4 -ztag changes` / `p4 -ztag change -o` / `p4 -ztag describe`.
 *
 * `describe` carries the file list as indexed tags, so `files` is the number of
 * `depotFileN` entries the answer contained; `changes` carries none and reports
 * 0.
 *
 * @param {Buffer|string} raw
 * @returns {Change[]}
 */
export function parseChangelistSpec(raw) {
  return splitRecords(raw, ['change'])
    .map(recordToChange)
    .filter((entry) => entry !== null)
}

/** Changelists plus their indexed file lists, used while composing a state answer. */
function parseChangeRecords(raw) {
  return splitRecords(raw, ['change']).map((record) => ({
    change: recordToChange(record),
    files: collectIndexedFiles(record)
      .filter((entry) => entry.depotfile)
      .map((entry) => ({
        depotFile: entry.depotfile,
        action: normalizeAction(entry.action ?? entry.action0),
        type: entry.type ?? null,
        rev: toNumber(entry.rev),
        fromFile: entry.fromfile ?? null,
      })),
  }))
}

/**
 * Parse `p4 -ztag fstat` into a map keyed by depot path. A batch fstat reports
 * some files on stderr ("no such file(s)") while still listing the rest, so
 * whatever stdout held is returned.
 *
 * @param {Buffer|string} raw
 * @returns {Map<string, { depotFile: string, clientFile: string|null, path: string|null, haveRev: number|null, headRev: number|null, headType: string|null, type: string|null, action: string, isMapped: boolean }>}
 */
export function parseFileMeta(raw) {
  const meta = new Map()
  for (const record of splitRecords(raw, ['depotfile'])) {
    const depotFile = tagValue(record, 'depotfile')
    if (!depotFile) continue
    meta.set(depotFile, {
      depotFile,
      clientFile: tagValue(record, 'clientfile') || null,
      path: clientPathFromClientFile(tagValue(record, 'clientfile')),
      haveRev: toNumber(tagValue(record, 'haverev')),
      headRev: toNumber(tagValue(record, 'headrev')),
      headType: tagValue(record, 'headtype') || null,
      type: tagValue(record, 'type') || null,
      action: normalizeAction(tagValue(record, 'action')),
      isMapped: hasTag(record, 'ismapped'),
    })
  }
  return meta
}

/* -------------------------------------------------------------------------- */
/* state                                                                      */
/* -------------------------------------------------------------------------- */

const REASON_MESSAGES = {
  'p4-unavailable': '无法运行 p4：未找到可执行文件，或无法连接 Perforce 服务器',
  'not-a-workspace': '该目录不在 Perforce 客户端工作区内',
  'p4-error': 'Perforce 命令失败',
}

const failed = (reason, dir, message, detail) => ({ ok: false, reason, dir, message, detail })

/** One opened entry as a contract file record; null when it cannot be located. */
function openedFileRecord(entry, path) {
  if (!path) return null
  const p4Type = entry.type ?? null
  return {
    path,
    oldPath: null,
    status: actionStatus(entry.action),
    added: null,
    deleted: null,
    untracked: false,
    binary: isBinaryType(p4Type),
    depotPath: entry.depotFile,
    action: entry.action,
    change: entry.change ?? 'default',
    shelved: false,
    origin: 'opened',
    haveRev: entry.haveRev ?? null,
    headRev: null,
    needsSync: false,
    p4Type,
  }
}

/** One local-entry record; `added`/`deleted` are filled by the caller. */
function localFileRecord(entry, depotPath) {
  const p4Type = entry.type ?? null
  return {
    path: entry.path,
    oldPath: null,
    status: actionStatus(entry.action),
    added: null,
    deleted: null,
    untracked: true,
    binary: isBinaryType(p4Type),
    depotPath,
    action: entry.action,
    change: entry.change ?? 'default',
    shelved: false,
    origin: 'local',
    haveRev: entry.haveRev ?? null,
    headRev: null,
    needsSync: false,
    p4Type,
  }
}

/** One shelved entry as a contract file record. */
function shelvedFileRecord(file, change, path) {
  const p4Type = file.type ?? null
  return {
    path,
    oldPath: null,
    status: actionStatus(file.action),
    added: null,
    deleted: null,
    untracked: false,
    binary: isBinaryType(p4Type),
    depotPath: file.depotFile,
    action: file.action,
    change: change.change,
    shelved: true,
    origin: 'shelved',
    haveRev: null,
    headRev: null,
    needsSync: false,
    p4Type,
  }
}

/**
 * Compose the whole Perforce answer for one session directory.
 *
 * Options:
 *   run            P4Runner (required) — the only command source.
 *   readFile       FileReader — used to count lines in local (unopened) files.
 *   dir            absolute session directory (required).
 *   workspace      optional probe result from createWorkspaceProbe, reused
 *                  instead of probing again.
 *   where          optional raw `p4 -ztag where` text, reused for path mapping.
 *   limits         overrides over P4_DEFAULT_LIMITS.
 *   localEdits     scan the session subdirectory with `p4 status` (default false).
 *   shelved        list shelved changelists and their files (default false).
 *   allowRootScan  permit the local-edit scan when the session directory *is*
 *                  the client root (default false: that scan is unbounded).
 *   p4Path         echoed in `options` for the panel.
 *   scanTimeoutMs  bound for the local-edit scan.
 *   maxChangelists / maxChangelistDetails  override the internal bounds.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function readWorkspace(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir.trim() : null
  const limits = { ...P4_DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const localEdits = asBool(options.localEdits)
  const shelved = asBool(options.shelved)
  const scanTimeoutMs = positiveNumber(options.scanTimeoutMs) ?? limits.scanTimeoutMs
  const maxChangelists = positiveNumber(options.maxChangelists) ?? P4_INTERNAL.maxChangelists
  const detailBudget = { left: positiveNumber(options.maxChangelistDetails) ?? P4_INTERNAL.maxChangelistDetails }
  const notes = []
  const optionsEcho = {
    localEdits,
    shelved,
    p4Path: typeof options.p4Path === 'string' && options.p4Path !== '' ? options.p4Path : null,
    scanTimeoutMs,
  }

  if (!dir) return failed('p4-error', '', '缺少会话目录 dir', null)
  const run = options.run
  if (typeof run !== 'function') return failed('p4-unavailable', dir, REASON_MESSAGES['p4-unavailable'], 'no p4 runner')

  try {
    /* ---- 1. which client owns this directory ---------------------------- */
    // The caller's `workspace` option is echoed and takes precedence; a probe
    // fills whatever it left out. The probe is skipped when the caller already
    // named the client and root and carried at least one connection detail.
    const provided = options.workspace && typeof options.workspace === 'object' ? options.workspace : null
    const providedText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
    let workspace = {
      client: providedText(provided?.client),
      root: providedText(provided?.root),
      port: provided?.port ?? null,
      user: provided?.user ?? null,
      charset: providedText(provided?.charset) ?? providedText(options.charset),
      stream: provided?.stream ?? null,
    }
    const identified = Boolean(workspace.client && workspace.root)
    const detailed = Boolean(workspace.port || workspace.user || workspace.stream)
    if (!identified || !detailed) {
      const probe = createWorkspaceProbe({ run, probeTimeoutMs: limits.timeoutMs, charset: workspace.charset })
      const probed = await probe(dir)
      if (!probed.ok && !identified) {
        const reason = probed.reason ?? 'p4-error'
        return failed(reason, dir, REASON_MESSAGES[reason] ?? REASON_MESSAGES['p4-error'], probed.detail ?? null)
      }
      workspace = {
        client: workspace.client ?? probed.client ?? null,
        root: workspace.root ?? probed.root ?? null,
        port: workspace.port ?? probed.port ?? null,
        user: workspace.user ?? probed.user ?? null,
        charset: workspace.charset ?? probed.charset ?? null,
        stream: workspace.stream ?? probed.stream ?? null,
      }
    }
    if (!workspace.client || !workspace.root) {
      return failed('p4-error', dir, REASON_MESSAGES['p4-error'], 'p4 info did not name a client and root')
    }

    const client = workspace.client
    const clientRoot = workspace.root
    const relative = clientRelative(clientRoot, dir)
    if (relative === null) {
      return failed('not-a-workspace', dir, REASON_MESSAGES['not-a-workspace'], `client root is ${clientRoot}`)
    }

    const call = async (args, cwd, callOptions) =>
      normalizeRunResult(await runSafely(run, args, cwd, callOptions))

    /* ---- 2. depot <-> client path mapping ------------------------------- */
    // The cheap mapping is the caller's `where` result plus the stream identity
    // from `p4 info`. A single `p4 -ztag where` is fetched only when some depot
    // path needs it (a client view can import another depot, measured as
    // `//ProjectW/main/Engine/...`), so the common answer costs no extra spawn.
    const mapping = []
    let whereAttempted = false
    if (typeof options.where === 'string' && options.where.trim() !== '') {
      mapping.push(...whereMapping(options.where))
      whereAttempted = true
    }
    if (workspace.stream) {
      mapping.push({ depotPrefix: `${normalizeSlashes(workspace.stream)}/`, clientBase: '', wildcard: true })
    }
    const ensureWhereMapping = async () => {
      if (whereAttempted) return
      whereAttempted = true
      const whereResult = await call(['-ztag', 'where', `//${client}/...`], clientRoot, {
        timeoutMs: limits.timeoutMs,
      })
      if (whereResult.status === 0) mapping.push(...whereMapping(text(whereResult.stdout)))
    }
    const resolveDepot = async (depotPath) => {
      let mapped = mapDepotPath(depotPath, mapping)
      if (mapped === null && !whereAttempted) {
        await ensureWhereMapping()
        mapped = mapDepotPath(depotPath, mapping)
      }
      return mapped
    }
    const rootContext = { root: clientRoot, client, stream: workspace.stream, mapping }

    /* ---- 3. opened files: the primary source ---------------------------- */
    const openedResult = await call(['-ztag', 'opened', `//${client}/...`], clientRoot, {
      timeoutMs: limits.timeoutMs,
    })
    const openedRaw = text(openedResult.stdout)
    if (openedResult.status !== 0 && openedRaw.trim() === '') {
      return failed(
        'p4-error',
        dir,
        REASON_MESSAGES['p4-error'],
        firstLine(openedResult.stderr) || `p4 -ztag opened exited with ${openedResult.status}`,
      )
    }
    const openedEntries = parseOpened(openedRaw)

    const byPath = new Map()
    const byDepot = new Map()
    const indexRecord = (record) => {
      if (byPath.has(record.path)) return false
      byPath.set(record.path, record)
      if (record.depotPath) byDepot.set(record.depotPath, record)
      return true
    }

    let unmapped = 0
    const moveTargets = []
    const moveSources = new Map()
    for (const entry of openedEntries) {
      const clientPath = entry.path ?? (await resolveDepot(entry.depotFile))
      const record = openedFileRecord(entry, clientPath)
      if (!record) {
        unmapped += 1
        continue
      }
      if (!indexRecord(record)) continue
      if (record.action === 'move/delete') moveSources.set(record.depotPath, record)
      if (record.action === 'move/add') moveTargets.push({ record, source: entry.movedFile })
    }

    // A p4 move shows up as two opened files; the panel wants one rename row,
    // so pair them (explicit movedFile tag first, then a unique same-basename
    // delete side) and report the pair once with oldPath set.
    const dropped = new Set()
    for (const target of moveTargets) {
      let source = target.source ? byDepot.get(target.source) : null
      if (!source) {
        const base = target.record.path.split('/').pop()?.toLowerCase() ?? ''
        const matches = [...moveSources.values()].filter(
          (record) => !dropped.has(record) && (record.path.split('/').pop()?.toLowerCase() ?? '') === base,
        )
        if (matches.length === 1) source = matches[0]
      }
      if (!source) continue
      target.record.oldPath = source.path
      target.record.status = 'R'
      dropped.add(source)
    }

    /* ---- 4. fstat as a capped optimisation ------------------------------ */
    const depotTargets = [...byDepot.keys()]
    if (depotTargets.length > 0) {
      const capped = depotTargets.slice(0, P4_INTERNAL.maxFstatFiles)
      const fstatResult = await call(
        [
          '-ztag',
          'fstat',
          '-m',
          String(capped.length),
          '-T',
          'depotFile,clientFile,haveRev,headRev,headType,type,action',
          ...capped,
        ],
        clientRoot,
        { timeoutMs: limits.timeoutMs },
      )
      const meta = parseFileMeta(text(fstatResult.stdout))
      for (const [depotPath, entry] of meta) {
        const record = byDepot.get(depotPath)
        if (!record) continue
        if (entry.headRev !== null) record.headRev = entry.headRev
        if (entry.haveRev !== null) record.haveRev = entry.haveRev
        const type = entry.type ?? entry.headType
        if (type) {
          record.p4Type = type
          if (!record.shelved) record.binary = isBinaryType(type)
        }
        if (record.action === 'edit' && entry.headType && record.p4Type && record.p4Type !== entry.headType) {
          record.status = 'T'
        }
        if (record.haveRev !== null && record.headRev !== null) record.needsSync = record.haveRev !== record.headRev
      }
    }

    /* ---- 5. local edits: scoped, bounded, opt-in ------------------------ */
    if (localEdits) {
      if (relative === '' && options.allowRootScan !== true) {
        notes.push('会话目录就是 p4 客户端根目录，已跳过整工作区的本地改动扫描（整工作区扫描可能耗时数分钟）')
      } else {
        const target = relative === '' ? `//${client}/...` : `${relative}/...`
        const statusResult = await call(['-ztag', 'status', target], clientRoot, { timeoutMs: scanTimeoutMs })
        const statusRaw = text(statusResult.stdout)
        if (statusResult.timedOut === true) {
          notes.push(`本地改动扫描超时（上限 ${Math.round(scanTimeoutMs / 1000)} 秒），结果可能不完整`)
        } else if (statusResult.status !== 0 && statusRaw.trim() === '') {
          notes.push(`本地改动扫描失败：${firstLine(statusResult.stderr) || `p4 status exited with ${statusResult.status}`}`)
        } else if (statusResult.status !== 0) {
          notes.push(`本地改动扫描返回了警告：${firstLine(statusResult.stderr) || '未知'}`)
        }
        for (const entry of parseStatus(statusRaw, rootContext)) {
          if (entry.depotPath && byDepot.has(entry.depotPath)) continue
          const record =
            entry.origin === 'opened'
              ? openedFileRecord(
                  {
                    depotFile: entry.depotPath,
                    clientFile: null,
                    path: entry.path,
                    rev: entry.rev,
                    haveRev: entry.rev,
                    action: entry.action,
                    change: entry.change,
                    type: entry.type ?? null,
                  },
                  entry.path,
                )
              : localFileRecord(entry, entry.depotPath)
          if (!record || !indexRecord(record)) continue
          if (record.origin !== 'local' || entry.action !== 'add') continue
          // A local addition has no depot revision to compare with, so count it
          // the way an untracked file is counted in the git data layer.
          if (typeof options.readFile !== 'function') continue
          try {
            const buffer = await options.readFile(`${clientRoot.replace(/[\\/]+$/, '')}/${record.path}`, limits.maxScanBytes)
            const scanned = scanContent(buffer)
            record.binary = scanned.binary
            record.added = scanned.binary ? null : scanned.lines
            record.deleted = scanned.binary ? null : 0
          } catch {
            /* an unreadable file keeps added/deleted null */
          }
        }
      }
    }

    /* ---- 6. changelists ------------------------------------------------- */
    const changeKeyOf = (value) =>
      value === 'default' || value === null || value === undefined ? 'default' : String(value)
    const changeEntries = new Map()
    /** A group exists for every change that owns a file, plus every listed change. */
    const ensureChange = (key) => {
      if (changeEntries.has(key)) return changeEntries.get(key)
      const isDefault = key === 'default'
      const value = isDefault ? 'default' : Number(key)
      const entry = {
        change: value,
        number: value,
        isDefault,
        status: 'pending',
        shelved: false,
        user: isDefault ? workspace.user ?? null : null,
        client: isDefault ? client : null,
        description: '',
        date: null,
        files: 0,
      }
      changeEntries.set(key, entry)
      return entry
    }
    const mergeChange = (entry, change) => {
      entry.status = change.shelved ? 'shelved' : change.status
      entry.shelved = change.shelved
      entry.user = change.user ?? entry.user
      entry.client = change.client ?? entry.client
      entry.description = change.description || entry.description
      entry.date = change.date ?? entry.date
    }

    const countByChange = new Map()
    for (const record of byPath.values()) {
      if (dropped.has(record) || record.origin === 'local') continue
      const key = changeKeyOf(record.change)
      countByChange.set(key, (countByChange.get(key) ?? 0) + 1)
    }
    for (const [key, count] of countByChange) ensureChange(key).files = count

    const describeChange = async (change) => {
      if (detailBudget.left <= 0 || change === null || change === 'default') return null
      detailBudget.left -= 1
      const result = await call(['-ztag', 'describe', '-S', '-s', String(change)], clientRoot, {
        timeoutMs: limits.timeoutMs,
      })
      if (result.status !== 0) return null
      return parseChangeRecords(text(result.stdout))[0] ?? null
    }

    if (workspace.user) {
      const result = await call(
        ['-ztag', 'changes', '-u', workspace.user, '-s', 'pending', '-l', '-m', String(maxChangelists + 1)],
        clientRoot,
        { timeoutMs: limits.timeoutMs },
      )
      if (result.status === 0) {
        let changes = parseChangelistSpec(text(result.stdout)).filter((entry) => !entry.isDefault)
        if (changes.length > maxChangelists) {
          changes = changes.slice(0, maxChangelists)
          notes.push(`待提交 changelist 过多，只列出前 ${maxChangelists} 个`)
        }
        for (const change of changes) {
          const entry = ensureChange(String(change.change))
          mergeChange(entry, change)
          if (entry.files === 0) {
            const described = await describeChange(change.change)
            if (described) entry.files = described.files.length
          }
        }
      } else if (text(result.stdout).trim() === '') {
        notes.push(`未能读取待提交 changelist：${firstLine(result.stderr) || `p4 changes exited with ${result.status}`}`)
      }
    }

    // A shelf belongs to one user, and this server hosts a shared project: an
    // unscoped `changes -s shelved` returns every other user's work (measured:
    // 10 foreign changelists and 196 files for a user with a single opened
    // file), so the query is always scoped to the workspace user as well as to
    // this client's stream.
    const shelvedKeys = new Set()
    if (shelved && !workspace.user) {
      notes.push('未能确定当前 Perforce 用户名，已跳过 shelved changelist 查询（避免列出其他用户的 shelf）')
    }
    if (shelved && workspace.user) {
      const scope = workspace.stream ? `${normalizeSlashes(workspace.stream)}/...` : `//${client}/...`
      const result = await call(
        ['-ztag', 'changes', '-s', 'shelved', '-u', workspace.user, '-l', '-m', String(maxChangelists + 1), scope],
        clientRoot,
        { timeoutMs: limits.timeoutMs },
      )
      if (result.status === 0) {
        let changes = parseChangelistSpec(text(result.stdout))
        if (changes.length > maxChangelists) {
          changes = changes.slice(0, maxChangelists)
          notes.push(`shelved changelist 过多，只列出前 ${maxChangelists} 个`)
        }
        let unmappedShelved = 0
        let missingDetails = 0
        for (const change of changes) {
          const key = String(change.change)
          shelvedKeys.add(key)
          const entry = ensureChange(key)
          mergeChange(entry, change)
          const detail = await describeChange(change.change)
          if (detail) entry.files = detail.files.length
          else missingDetails += 1
          for (const file of detail?.files ?? []) {
            const existing = byDepot.get(file.depotFile)
            if (existing) {
              existing.shelved = true
              continue
            }
            const mapped = await resolveDepot(file.depotFile)
            if (!mapped) {
              unmappedShelved += 1
              continue
            }
            const record = shelvedFileRecord(file, change, mapped)
            const previous = byPath.get(record.path)
            if (!previous) indexRecord(record)
            else previous.shelved = true
          }
        }
        if (unmappedShelved > 0) notes.push(`有 ${unmappedShelved} 个 shelved 文件不在该客户端视图内，已跳过`)
        if (missingDetails > 0) notes.push(`有 ${missingDetails} 个 shelved changelist 未能读取文件列表`)
      } else if (text(result.stdout).trim() === '') {
        notes.push(`未能读取 shelved changelist：${firstLine(result.stderr) || `p4 changes exited with ${result.status}`}`)
      }
    }

    /* ---- 7. assemble ---------------------------------------------------- */
    if (unmapped > 0) notes.push(`有 ${unmapped} 个已打开的文件无法映射到客户端路径，已跳过`)

    const all = [...byPath.values()]
      .filter((record) => !dropped.has(record))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const limited = all.slice(0, limits.maxFiles)
    if (all.length > limited.length) notes.push(`改动文件过多，只列出前 ${limits.maxFiles} 个（共 ${all.length} 个）`)

    // `files` counts every file the answer carries per change; local-only edits
    // stay out of the changelist groups because the panel shows them separately.
    const countInList = new Map()
    for (const record of all) {
      if (record.origin === 'local') continue
      const key = changeKeyOf(record.change)
      countInList.set(key, (countInList.get(key) ?? 0) + 1)
    }
    for (const [key, entry] of changeEntries) {
      if (entry.files === 0) entry.files = countInList.get(key) ?? 0
    }
    const changelists = []
    const defaultEntry = changeEntries.get('default')
    if (defaultEntry) changelists.push(defaultEntry)
    const numbered = [...changeEntries.entries()]
      .filter(([key]) => key !== 'default')
      .filter(([key]) => {
        // A group the panel cannot show any row for leaves nothing behind, for
        // two distinct reasons: a shelved change whose files all stayed outside
        // this client's view, and a pending change that belongs to another
        // client (the pending query is user-scoped, not client-scoped).
        if (shelvedKeys.has(key)) return (countInList.get(key) ?? 0) > 0
        const entry = changeEntries.get(key)
        if (entry?.client && client && entry.client !== client) return false
        return (countInList.get(key) ?? 0) > 0
      })
      .sort((a, b) => Number(b[0]) - Number(a[0]))
    for (const [, entry] of numbered) changelists.push(entry)

    let have = null
    let head = null
    for (const record of limited) {
      if (record.haveRev !== null) have = have === null ? record.haveRev : Math.max(have, record.haveRev)
      if (record.headRev !== null) head = head === null ? record.headRev : Math.max(head, record.headRev)
    }

    return {
      ok: true,
      dir,
      vcs: 'p4',
      branch: workspace.stream ?? client,
      base: workspace.stream ?? `//${client}`,
      baseKind: workspace.stream ? 'stream' : 'client',
      remote: workspace.port ?? null,
      ahead: null,
      behind: null,
      files: limited,
      total: all.length,
      truncated: all.length > limited.length,
      notes,
      generatedAt: new Date().toISOString(),
      workspace: {
        client,
        root: clientRoot,
        port: workspace.port ?? null,
        user: workspace.user ?? null,
        charset: workspace.charset ?? null,
        stream: workspace.stream ?? null,
      },
      revisions: have === null && head === null ? null : { have, head },
      changelists,
      options: optionsEcho,
    }
  } catch (error) {
    return failed(
      'p4-error',
      dir,
      REASON_MESSAGES['p4-error'],
      error instanceof Error ? `${error.message}` : String(error),
    )
  }
}

/* -------------------------------------------------------------------------- */
/* one file comparison                                                        */
/* -------------------------------------------------------------------------- */

/** The origin a diff request is really about. */
function diffOrigin(options) {
  const explicit = typeof options.origin === 'string' ? options.origin.trim().toLowerCase() : ''
  if (explicit === 'shelved' || explicit === 'local' || explicit === 'opened') return explicit
  if (asBool(options.shelved)) return 'shelved'
  if (asBool(options.local) || asBool(options.untracked)) return 'local'
  return 'opened'
}

/** `#rev` (or a bare number) out of the caller's base hint. */
function baseRevision(options) {
  if (typeof options.baseRev === 'number' && Number.isFinite(options.baseRev)) return Math.trunc(options.baseRev)
  if (typeof options.base === 'string') {
    const match = /^#?(\d+)$/.exec(options.base.trim())
    if (match) return Number(match[1])
  }
  return null
}

/** An all-additions comparison, the way lib/git.js renders an untracked file. */
function allAdditionsDiff(buffer, label) {
  const lines = buffer.toString('utf8').replace(/\n$/, '').split('\n')
  return `--- /dev/null\n+++ b/${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
}

/** An all-deletions comparison for a file that is gone from the workspace. */
function allDeletionsDiff(buffer, label) {
  const lines = buffer.toString('utf8').replace(/\n$/, '').split('\n')
  return `--- a/${label}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}\n`
}

/**
 * Read one file's comparison.
 *
 * Origin `opened` and `local` run `p4 diff -du -f`; `shelved` compares the
 * shelved revision with `@=<change>` (falling back to `diff2` when the local
 * file is not present and the caller supplied the base revision). When p4
 * returns nothing, the two sides are read individually so a deleted file
 * becomes an all-deletions comparison and a file that does not exist in the
 * depot becomes an all-additions one, mirroring lib/git.js.
 *
 * @param {object} options
 * @param {P4Runner} options.run
 * @param {FileReader} [options.readFile] needed to synthesise an unopened file
 * @param {string} [options.dir] session directory (command cwd, root fallback)
 * @param {string} [options.path] client-relative '/'-separated path
 * @param {string} [options.depotPath] depot path, when the caller already knows it
 * @param {'opened'|'local'|'shelved'} [options.origin]
 * @param {number|'default'|string} [options.change] changelist of a shelved file
 * @param {boolean|string} [options.shelved]
 * @param {string|null} [options.p4Type] p4 file type; binary is decided from it
 * @param {string|object} [options.clientRoot] client root, probe result or `where` context
 * @param {object} [options.limits]
 * @returns {Promise<{ ok: boolean, path: string|null, binary: boolean, text: string, truncated?: boolean, origin?: string, depotPath?: string|null, change?: number|'default'|null, message?: string, detail?: string|null }>}
 */
export async function readDiff(options = {}) {
  const limits = { ...P4_DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const run = options.run
  const changedPath =
    typeof options.path === 'string' && options.path.trim() !== '' ? normalizeSlashes(options.path).trim() : null
  const depotPath =
    typeof options.depotPath === 'string' && options.depotPath.trim().startsWith('//')
      ? options.depotPath.trim()
      : changedPath && changedPath.startsWith('//')
        ? changedPath
        : null
  const rootContext = normalizeRoot(options.clientRoot ?? options.root ?? options.workspace ?? null)
  const origin = diffOrigin(options)
  const change = parseChange(options.change)
  const p4Type = options.p4Type ?? options.type ?? null
  const contextLines = positiveNumber(limits.contextLines) ?? 3
  const unifiedFlag = Math.trunc(contextLines) === 3 ? '-du' : `-du${Math.trunc(contextLines)}`
  const cwd = typeof options.dir === 'string' && options.dir !== '' ? options.dir : rootContext.root ?? undefined

  if (typeof run !== 'function') {
    return { ok: false, path: changedPath, binary: false, text: '', message: '没有可用的 p4 执行器', detail: null }
  }
  const call = async (args, callOptions) => normalizeRunResult(await runSafely(run, args, cwd, callOptions))

  let knownRoot = rootContext.root
  const localPathFor = async () => {
    if (!changedPath || changedPath.startsWith('//')) return null
    if (!knownRoot) {
      // The caller may only know the session directory; ask p4 where the client
      // root is rather than joining a client-relative path onto a subdirectory.
      const result = await call(['-ztag', 'info'], { timeoutMs: limits.timeoutMs })
      if (result.status === 0) knownRoot = workspaceFromInfo(text(result.stdout)).root
    }
    if (!knownRoot) return null
    return `${normalizeSlashes(knownRoot).replace(/\/+$/, '')}/${changedPath}`
  }

  const finish = (body, extra = {}) => {
    const value = text(body)
    if (value.includes('\u0000') || /^(Binary files .* differ|Files .* differ)\s*$/m.test(value)) {
      return {
        ok: true,
        path: changedPath,
        binary: true,
        text: '',
        truncated: false,
        origin,
        depotPath,
        change,
        ...extra,
      }
    }
    const clipped = clipDiff(value, limits.maxDiffBytes)
    return {
      ok: true,
      path: changedPath,
      binary: false,
      text: clipped.text,
      truncated: clipped.truncated,
      origin,
      depotPath,
      change,
      ...extra,
    }
  }

  const binaryResult = (extra = {}) => ({
    ok: true,
    path: changedPath,
    binary: true,
    text: '',
    truncated: false,
    origin,
    depotPath,
    change,
    ...extra,
  })
  const identicalResult = (extra = {}) => ({
    ok: true,
    path: changedPath,
    binary: false,
    text: '',
    truncated: false,
    origin,
    depotPath,
    change,
    ...extra,
  })
  const failureResult = (message, detail) => ({
    ok: false,
    path: changedPath,
    binary: false,
    text: '',
    message,
    detail: detail ?? null,
  })

  /** A binary file is announced on stderr, never on stdout. */
  const looksBinary = (value) => /not text|binary file|files differ/i.test(text(value))

  /** Read the workspace side through the injected seam; null without a reader. */
  const readLocal = async () => {
    if (typeof options.readFile !== 'function') return null
    const localPath = await localPathFor()
    if (!localPath) return null
    try {
      return await options.readFile(localPath, limits.maxDiffBytes)
    } catch {
      return null
    }
  }

  /** The depot side of the comparison (`p4 print -q`), null when absent. */
  const readDepot = async () => {
    if (!depotPath) return null
    const result = await call(['print', '-q', depotPath], { timeoutMs: limits.timeoutMs })
    if (result.status !== 0 && result.stdout.length === 0) return null
    // `print` has no line bound of its own, so hold it to the scan budget.
    let buffer = result.stdout.subarray(0, limits.maxScanBytes)
    // `-q` suppresses the info line; drop it when a server sent one anyway.
    const breakIndex = buffer.indexOf(0x0a)
    if (breakIndex > 0 && /^\/\/[^\n]*#\d+ - /.test(buffer.subarray(0, breakIndex).toString('utf8'))) {
      buffer = buffer.subarray(breakIndex + 1)
    }
    return buffer
  }

  /** Ask p4 for the file type when no other answer proved the file binary. */
  const detectBinary = async () => {
    if (!depotPath) return false
    const result = await call(['-ztag', 'fstat', '-m', '1', '-T', 'depotFile,headType,type', depotPath], {
      timeoutMs: limits.timeoutMs,
    })
    if (result.status !== 0 && text(result.stdout).trim() === '') return false
    for (const entry of parseFileMeta(text(result.stdout)).values()) {
      if (isBinaryType(entry.type) || isBinaryType(entry.headType)) return true
    }
    return false
  }

  try {
    if (isBinaryType(p4Type)) return binaryResult()

    if (origin === 'shelved' && depotPath && change !== null && change !== 'default') {
      const spec = `${depotPath}@=${change}`
      const primary = await call(['diff', unifiedFlag, '-f', spec], { timeoutMs: limits.timeoutMs })
      const body = text(primary.stdout)
      if (body.trim() !== '') return finish(body)
      if (looksBinary(primary.stderr)) return binaryResult()
      const baseRev = baseRevision(options)
      if (baseRev !== null) {
        const fallback = await call(['diff2', '-u', `${depotPath}#${baseRev}`, spec], { timeoutMs: limits.timeoutMs })
        const fallbackBody = text(fallback.stdout)
        if (fallbackBody.trim() !== '') return finish(fallbackBody)
        if (looksBinary(fallback.stderr)) return binaryResult()
      }
      if (await detectBinary()) return binaryResult()
      if (primary.status !== 0) {
        return failureResult(
          firstLine(primary.stderr) || '无法读取 shelved 版本的内容',
          commandLine(['diff', unifiedFlag, '-f', spec]),
        )
      }
      return identicalResult()
    }

    const target = depotPath ?? (await localPathFor())
    const result = target ? await call(['diff', unifiedFlag, '-f', target], { timeoutMs: limits.timeoutMs }) : null
    if (result) {
      const body = text(result.stdout)
      if (body.trim() !== '') return finish(body)
      if (looksBinary(result.stderr)) return binaryResult()
    }
    const forced = asBool(options.changed)
    if (result && result.status === 0 && !forced) return identicalResult()

    // p4 produced no comparison. Decide from the two sides themselves: this is
    // what tells a deleted file (no workspace copy) from a brand-new local file
    // and from a binary p4 refused to diff. The workspace side costs no spawn.
    const local = await readLocal()
    if (local && local.length > 0 && scanContent(local).binary) return binaryResult()
    const depot = await readDepot()
    if (depot && scanContent(depot).binary) return binaryResult()
    if (depot && depot.length > 0 && (!local || local.length === 0)) {
      return finish(allDeletionsDiff(depot, changedPath ?? depotPath ?? ''), { deleted: true })
    }
    if ((!depot || depot.length === 0) && local && local.length > 0) {
      return finish(allAdditionsDiff(local, changedPath ?? ''), { untracked: true })
    }
    // Both sides exist, yet p4 rendered nothing: ask for the file type last.
    if (await detectBinary()) return binaryResult()
    if (result && result.status === 0) return identicalResult()
    return failureResult(
      result ? firstLine(result.stderr) || '无法比较该文件' : '缺少可比较的路径（path 或 depotPath）',
      result && target ? commandLine(['diff', unifiedFlag, '-f', target]) : null,
    )
  } catch (error) {
    return failureResult(error instanceof Error ? error.message : String(error), null)
  }
}