/**
 * Git plumbing behind the workspace changelist.
 *
 * Every function here is pure with respect to the environment: the caller
 * supplies `run` (execute one git command) and `readFile` (read one file). That
 * keeps the whole data layer testable outside the Harness process.
 *
 * The changelist answers one question: *what does this working tree look like
 * relative to the remote-tracking branch it would be pushed to?* It diffs the
 * base commit against the **working tree** (`git diff <base>`, not
 * `<base>...HEAD`), so committed, staged and unstaged edits all appear, and it
 * adds untracked files separately because `git diff` cannot see them.
 */

/** @typedef {{ status: number|null, stdout: Buffer|string, stderr: string }} RunResult */
/** @typedef {(args: string[], cwd: string) => Promise<RunResult>} Runner */
/** @typedef {(path: string, maxBytes: number) => Promise<Buffer>} FileReader */

export const DEFAULT_LIMITS = {
  /** Maximum changed files carried by one answer. */
  maxFiles: 500,
  /** Maximum bytes of one file comparison. */
  maxDiffBytes: 512 * 1024,
  /** Milliseconds one git command may run. */
  timeoutMs: 20_000,
  /** Context lines in a comparison. */
  contextLines: 3,
  /** Maximum bytes read from an untracked file. */
  maxScanBytes: 2 * 1024 * 1024,
}

/** Production runner: spawns git with piped stdio. */
export function createProcessRunner(options = {}) {
  const gitPath = options.gitPath ?? 'git'
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024
  return async function run(args, cwd) {
    const { execFile } = await import('node:child_process')
    return await new Promise((resolve) => {
      execFile(
        gitPath,
        args,
        { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'buffer' },
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

/** Production file reader: reads at most `maxBytes` of a file, missing file reads as empty. */
export function createFileReader() {
  return async function readFile(filePath, maxBytes) {
    const fs = await import('node:fs/promises')
    try {
      const handle = await fs.open(filePath, 'r')
      try {
        const stat = await handle.stat()
        const size = Math.min(stat.size, maxBytes)
        const buffer = Buffer.alloc(size)
        await handle.read(buffer, 0, size, 0)
        return buffer
      } finally {
        await handle.close()
      }
    } catch {
      return Buffer.alloc(0)
    }
  }
}

const text = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))

/** First output line, trimmed; empty when the command failed. */
function firstLine(result) {
  if (result.status !== 0) return ''
  return text(result.stdout).split('\n')[0].trim()
}

/**
 * Parse `git diff --name-status -M -z`.
 * Records are `STATUS\0path\0`, and a rename or copy adds two paths:
 * `R100\0oldPath\0newPath\0`.
 * @param {string} raw
 * @returns {Array<{ status: string, path: string, oldPath: string|null }>}
 */
export function parseNameStatus(raw) {
  const tokens = raw.split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') continue
    if (/^[RC]/.test(token)) {
      const oldPath = tokens[i + 1]
      const newPath = tokens[i + 2]
      if (newPath === undefined) break
      entries.push({ status: token[0], path: newPath, oldPath })
      i += 2
    } else {
      const path = tokens[i + 1]
      if (path === undefined || path === '') break
      entries.push({ status: token, path, oldPath: null })
      i += 1
    }
  }
  return entries
}

/**
 * Parse `git diff --numstat -M -z`.
 * Records are `added\tdeleted\tpath\0`; a rename or copy carries an empty path
 * field followed by the two NUL separated paths. `-` marks a binary side.
 * @param {string} raw
 * @returns {Map<string, { added: number|null, deleted: number|null }>}
 */
export function parseNumstat(raw) {
  const tokens = raw.split('\0')
  const counts = new Map()
  const toCount = (value) => (value === '-' ? null : Number(value))
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i])
    if (!match) continue
    const [, added, deleted, inline] = match
    if (inline !== '') {
      counts.set(inline, { added: toCount(added), deleted: toCount(deleted) })
    } else {
      const newPath = tokens[i + 2]
      if (newPath === undefined) break
      counts.set(newPath, { added: toCount(added), deleted: toCount(deleted) })
      i += 2
    }
  }
  return counts
}

/** Count lines and detect binary content the way git does: a NUL byte in the head. */
export function scanContent(buffer) {
  if (buffer.includes(0)) return { binary: true, lines: null }
  if (buffer.length === 0) return { binary: false, lines: 0 }
  const body = buffer.toString('utf8')
  const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n').length : body.split('\n').length
  return { binary: false, lines }
}

/**
 * Choose the commit to compare against: the current branch's upstream, else the
 * remote's default branch, else any remote-tracking branch, else HEAD.
 * @returns {Promise<{ base: string, kind: 'explicit'|'upstream'|'remote-head'|'remote-branch'|'local', remote: string|null, note: string|null }>}
 */
export async function resolveBase(run, dir, requested) {
  if (requested) {
    const verified = await run(['rev-parse', '--verify', '--quiet', `${requested}^{commit}`], dir)
    if (verified.status === 0) return { base: requested, kind: 'explicit', remote: null, note: null }
    return {
      base: 'HEAD',
      kind: 'local',
      remote: null,
      note: `未知的比较基准 ${requested}，已回退到 HEAD（仅显示未提交改动）`,
    }
  }

  const upstream = firstLine(
    await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir),
  )
  if (upstream) {
    return { base: upstream, kind: 'upstream', remote: upstream.split('/')[0] ?? null, note: null }
  }

  const remotes = text((await run(['remote'], dir)).stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (remotes.length === 0) {
    return { base: 'HEAD', kind: 'local', remote: null, note: '该仓库没有配置远端，仅显示未提交改动' }
  }
  for (const remote of remotes) {
    const head = firstLine(
      await run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], dir),
    )
    if (head) return { base: head, kind: 'remote-head', remote, note: null }
  }
  for (const remote of remotes) {
    const any = firstLine(
      await run(['for-each-ref', '--count=1', '--format=%(refname:short)', `refs/remotes/${remote}/`], dir),
    )
    if (any && !any.endsWith('/HEAD')) return { base: any, kind: 'remote-branch', remote, note: null }
  }
  return {
    base: 'HEAD',
    kind: 'local',
    remote: remotes[0],
    note: `远端 ${remotes[0]} 没有可用的远端分支引用，已回退到 HEAD（仅显示未提交改动）`,
  }
}

/**
 * Collect the changelist relative to `base`.
 * @param {{ run: Runner, readFile: FileReader, dir: string, base?: string, limits?: object }} options
 */
export async function inspectWorkspace(options) {
  const { run, readFile, dir } = options
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const base = options.base ?? 'HEAD'
  const notes = []

  const inside = await run(['rev-parse', '--is-inside-work-tree'], dir)
  if (inside.status !== 0 || firstLine(inside) !== 'true') {
    const unavailable = inside.status === -1
    return {
      ok: false,
      reason: unavailable ? 'git-unavailable' : 'not-a-repository',
      dir,
      message: unavailable ? '无法运行 git' : '该目录不在 git 工作区内',
      // git's own words, so the panel can show why instead of just that it failed.
      detail: text(inside.stderr).trim() || null,
    }
  }

  const toplevel = firstLine(await run(['rev-parse', '--show-toplevel'], dir)) || dir
  const branch = firstLine(await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir)) || 'HEAD'

  const nameStatus = parseNameStatus(
    text((await run(['diff', '--name-status', '-M', '-z', base], toplevel)).stdout),
  )
  const counts = parseNumstat(text((await run(['diff', '--numstat', '-M', '-z', base], toplevel)).stdout))
  const untracked = text(
    (await run(['ls-files', '--others', '--exclude-standard', '-z'], toplevel)).stdout,
  )
    .split('\0')
    .filter(Boolean)

  const files = new Map()
  for (const entry of nameStatus) {
    const stat = counts.get(entry.path)
    files.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      added: stat?.added ?? null,
      deleted: stat?.deleted ?? null,
      untracked: false,
      binary: stat ? stat.added === null || stat.deleted === null : false,
    })
  }

  for (const path of untracked) {
    if (files.has(path)) continue
    const buffer = await readFile(`${toplevel}/${path}`, limits.maxScanBytes)
    const scanned = scanContent(buffer)
    files.set(path, {
      path,
      oldPath: null,
      status: 'A',
      added: scanned.lines,
      deleted: 0,
      untracked: true,
      binary: scanned.binary,
    })
  }

  const all = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const limited = all.slice(0, limits.maxFiles)
  if (all.length > limited.length) {
    notes.push(`改动文件过多，只列出前 ${limits.maxFiles} 个（共 ${all.length} 个）`)
  }

  let ahead = 0
  let behind = 0
  const aheadBehind = text(
    (await run(['rev-list', '--left-right', '--count', `${base}...HEAD`], toplevel)).stdout,
  ).trim()
  if (aheadBehind) {
    const [left, right] = aheadBehind.split(/\s+/)
    behind = Number(left) || 0
    ahead = Number(right) || 0
  }

  return {
    ok: true,
    dir: toplevel,
    branch,
    base,
    ahead,
    behind,
    files: limited,
    total: all.length,
    truncated: all.length > limited.length,
    notes,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Read one file's comparison against `base` as unified diff text. An untracked
 * file is synthesised as an all-additions diff so the client has one rendering
 * path.
 * @param {{ run: Runner, readFile: FileReader, dir: string, base: string, path: string, limits?: object }} options
 */
export async function readDiff(options) {
  const { run, readFile, dir, base, path: filePath } = options
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }

  const probe = text((await run(['diff', '--numstat', '-M', base, '--', filePath], dir)).stdout)
  if (/^-\t-\t/.test(probe.trim())) return { ok: true, path: filePath, binary: true, text: '' }

  const diff = await run(
    ['diff', '--no-color', '-M', `--unified=${limits.contextLines}`, base, '--', filePath],
    dir,
  )
  const body = text(diff.stdout)
  if (body.trim() !== '') {
    const clipped = clipDiff(body, limits.maxDiffBytes)
    return { ok: true, path: filePath, binary: false, text: clipped.text, truncated: clipped.truncated }
  }

  // Not in the index: an untracked file gets the all-additions form.
  const tracked = await run(['ls-files', '--error-unmatch', '--', filePath], dir)
  if (tracked.status === 0) return { ok: true, path: filePath, binary: false, text: '', truncated: false }

  const buffer = await readFile(`${firstLine(await run(['rev-parse', '--show-toplevel'], dir)) || dir}/${filePath}`, limits.maxDiffBytes)
  if (buffer.length === 0) {
    return { ok: true, path: filePath, binary: false, text: '', truncated: false, missing: true }
  }
  const scanned = scanContent(buffer)
  if (scanned.binary) return { ok: true, path: filePath, binary: true, text: '' }
  const lines = buffer.toString('utf8').replace(/\n$/, '').split('\n')
  const synthesized = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines
    .map((line) => `+${line}`)
    .join('\n')}\n`
  const clipped = clipDiff(synthesized, limits.maxDiffBytes)
  return {
    ok: true,
    path: filePath,
    binary: false,
    text: clipped.text,
    truncated: clipped.truncated,
    untracked: true,
  }
}

/** Keep a comparison within a byte budget, cutting on a line boundary. */
export function clipDiff(body, maxBytes) {
  const buffer = Buffer.from(body, 'utf8')
  if (buffer.length <= maxBytes) return { text: body, truncated: false }
  const cut = buffer.subarray(0, maxBytes).toString('utf8')
  const lastNewline = cut.lastIndexOf('\n')
  return { text: `${lastNewline === -1 ? cut : cut.slice(0, lastNewline)}\n`, truncated: true }
}
