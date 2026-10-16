/**
 * Which version-control system answers for one directory.
 *
 * The changelist question is the same everywhere — *what changed in this
 * workspace?* — but git and Perforce answer it through different plumbing. This
 * module owns that decision and nothing else: it picks a backend per directory,
 * caches the answer briefly (a probe costs one process spawn), and reports why
 * it picked nothing so the panel can say which folder it looked at.
 *
 * Order of precedence:
 *   1. an explicit `vcs` request (`git` / `p4`), which must still verify;
 *   2. a directory that is both a git work tree and a Perforce client root —
 *      both answers are advertised so the panel can offer a switch;
 *   3. git, when the directory is inside a work tree;
 *   4. Perforce, when the directory is inside a client root.
 *
 * @module dsh-changelist/lib/vcs
 */

/** How long one directory's probe result is reused. */
export const DEFAULT_DETECT_TTL_MS = 60_000

/**
 * A tiny TTL cache keyed by normalised directory. Unbounded growth is not a
 * concern (a session list is small), but entries are replaced in place.
 */
export function createDetectCache({ ttlMs = DEFAULT_DETECT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map()
  return {
    get(key) {
      const hit = entries.get(key)
      if (!hit) return null
      if (now() - hit.at > ttlMs) {
        entries.delete(key)
        return null
      }
      return hit.value
    },
    set(key, value) {
      entries.set(key, { at: now(), value })
      return value
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

const lc = (value) => String(value ?? '').toLowerCase()

/**
 * Build the backend router.
 *
 * @param {object} options
 * @param {() => Promise<boolean>} options.isGitWorkTree
 *   Resolves true when the directory is inside a git work tree.
 * @param {(dir: string) => Promise<{ ok: boolean, client?: string, root?: string, reason?: string, detail?: string }>} options.probeP4
 *   Resolves the Perforce client workspace covering the directory.
 * @param {object} [options.cache] TTL cache from {@link createDetectCache}.
 * @param {(dir: string) => Promise<boolean>} [options.isP4Workspace]
 *   Legacy seam: a plain predicate instead of a probe. Kept so tests and older
 *   call sites can stay declarative.
 */
export function createBackendRouter(options = {}) {
  const cache = options.cache ?? createDetectCache()
  const isGitWorkTree = options.isGitWorkTree ?? (async () => false)
  const probeP4 =
    options.probeP4 ??
    (options.isP4Workspace
      ? async (dir) => {
          const ok = await options.isP4Workspace(dir)
          return { ok, client: null, root: null, reason: ok ? null : 'not-a-workspace', detail: null }
        }
      : async () => ({ ok: false, reason: 'not-a-workspace', detail: null }))

  /** Run both probes, tolerating either one throwing. */
  async function detect(dir, probe = probeP4) {
    let git = false
    try {
      git = await isGitWorkTree(dir)
    } catch {
      git = false
    }
    let p4 = { ok: false, reason: 'not-a-workspace', detail: null }
    try {
      // A git work tree can still sit inside a Perforce client root, and the
      // panel wants to offer both, so the probe always runs.
      p4 = await probe(dir)
    } catch (error) {
      p4 = {
        ok: false,
        reason: 'p4-unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    return { git, p4 }
  }

  /**
   * Pick the backend for one directory.
   * @param {{ dir: string, requested?: string|null, ttlMs?: number,
   *   probeP4?: (dir: string) => Promise<object>, envKey?: string }} request
   *   `probeP4` overrides the router's own probe for this call (the Host passes
   *   one bound to the connection the user actually asked for), and `envKey`
   *   distinguishes cache entries that belong to different connections.
   * @returns {Promise<{ vcs: 'git'|'p4'|null, reason: string|null, detail: string|null,
   *   available: string[], workspace: object|null, skipped: string|null }>}
   */
  async function resolve(request) {
    const dir = request?.dir
    // Normalise once: the cache key is case-insensitive, so the comparisons
    // below must be too, or `vcs=P4` would be cached under the `p4` key while
    // actually being treated as `auto`.
    const requested = lc(request?.requested) || null
    if (requested && !['auto', 'git', 'p4'].includes(requested)) {
      // An unrecognised value is not a backend anyone implements; fall back to
      // what the directory actually is instead of refusing.
      request = { ...request, requested: 'auto' }
    }
    if (!dir) {
      return {
        vcs: null,
        reason: 'not-a-repository',
        detail: null,
        available: [],
        workspace: null,
        skipped: null,
      }
    }

    const probe = typeof request?.probeP4 === 'function' ? request.probeP4 : probeP4
    const cacheKey = `${requested ?? 'auto'}\u0000${lc(request.envKey ?? '')}\u0000${lc(dir)}`
    const cached = cache.get(cacheKey)
    if (cached) return cached

    const detected = await detect(dir, probe)
    const available = []
    if (detected.git) available.push('git')
    if (detected.p4?.ok) available.push('p4')

    const p4Workspace = detected.p4?.ok
      ? {
          client: detected.p4.client ?? null,
          root: detected.p4.root ?? null,
          port: detected.p4.port ?? null,
          user: detected.p4.user ?? null,
          charset: detected.p4.charset ?? null,
          stream: detected.p4.stream ?? null,
        }
      : null

    let result
    if (requested === 'p4') {
      result = detected.p4?.ok
        ? { vcs: 'p4', reason: null, detail: null, available, workspace: p4Workspace, skipped: null }
        : {
            vcs: null,
            reason: detected.p4?.reason ?? 'not-a-workspace',
            detail: detected.p4?.detail ?? null,
            available,
            workspace: null,
            skipped: null,
          }
    } else if (requested === 'git') {
      result = detected.git
        ? { vcs: 'git', reason: null, detail: null, available, workspace: null, skipped: null }
        : {
            vcs: null,
            reason: 'not-a-repository',
            detail: null,
            available,
            workspace: null,
            skipped: null,
          }
    } else if (detected.git) {
      result = {
        vcs: 'git',
        reason: null,
        detail: null,
        available,
        workspace: null,
        skipped: detected.p4?.ok ? 'p4' : null,
      }
    } else if (detected.p4?.ok) {
      result = { vcs: 'p4', reason: null, detail: null, available, workspace: p4Workspace, skipped: null }
    } else {
      // Nothing owns this directory. Prefer Perforce's own words when its probe
      // got far enough to have some (a server, client or auth failure), because
      // that is more actionable than "not a repository".
      const p4Reason = detected.p4?.reason ?? 'not-a-workspace'
      result = {
        vcs: null,
        reason: p4Reason === 'p4-unavailable' || p4Reason === 'p4-error' ? p4Reason : 'not-a-repository',
        detail: detected.p4?.detail ?? null,
        available,
        workspace: null,
        skipped: null,
      }
    }

    return cache.set(cacheKey, result)
  }

  return { resolve, cache }
}
