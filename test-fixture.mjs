/**
 * Shared test fixture: a real git repository with a real remote-tracking
 * branch, plus a git runner that works inside a sandbox forbidding piped child
 * stdio (this plugin's own production runner uses ordinary pipes).
 *
 * The fixture lives under `.changelist-test/` beside the package so the suites
 * are self-contained: run `node test-fixture.mjs` (or any suite) from the
 * workspace root and the repository is rebuilt from scratch.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Fixture root; kept one level down so extracting the Cordis framework beside it survives a rebuild. */
export const FIXTURE_ROOT = path.resolve('.changelist-test/fixture')
export const FIXTURE_REPO = path.join(FIXTURE_ROOT, 'repo')
export const FIXTURE_REMOTE = path.join(FIXTURE_ROOT, 'remote.git')

const captureOut = path.join(FIXTURE_ROOT, 'stdout.bin')
const captureErr = path.join(FIXTURE_ROOT, 'stderr.bin')

/** Run one command with stdout/stderr redirected to files, returning trimmed buffers. */
export function spawnCaptured(file, args, options = {}) {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true })
  const fo = fs.openSync(captureOut, 'w')
  const fe = fs.openSync(captureErr, 'w')
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    stdio: ['ignore', fo, fe],
    windowsHide: true,
    env: options.env,
  })
  fs.closeSync(fo)
  fs.closeSync(fe)
  return {
    status: result.error ? -1 : result.status,
    stdout: fs.readFileSync(captureOut),
    stderr: fs.readFileSync(captureErr).toString('utf8'),
    failed: Boolean(result.error),
  }
}

/** The `run(args, cwd)` shape `lib/git.js` expects. */
export function createFixtureRunner(gitPath = 'git') {
  return async function run(args, cwd) {
    const result = spawnCaptured(gitPath, args, { cwd })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
}

/** Minimal `execFile` stand-in matching Node's callback contract, for `createRoutes`. */
export function fileRedirectExecFile(file, args, options, callback) {
  const result = spawnCaptured(file, args, options)
  const error = result.status === 0 ? null : Object.assign(new Error(`exit ${result.status}`), { code: result.status })
  callback(error, result.stdout, result.stderr)
}

/**
 * Build the fixture repository.
 *
 * Local work relative to `origin/main` covers every status the plugin reports:
 * a rename, a modified file, a staged addition, a deleted file, an untracked
 * text file, and an untracked binary file.
 *
 * @returns {{ repo: string, remote: string, base: string }}
 */
export function buildFixture() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE_REPO, { recursive: true })

  const git = (args, cwd = FIXTURE_REPO) => {
    const result = spawnCaptured('git', args, { cwd })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} -> ${result.status}\n${result.stderr}`)
    return result.stdout
  }

  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'fixture@example.com'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'core.autocrlf', 'false'])

  fs.writeFileSync(path.join(FIXTURE_REPO, 'README.md'), '# fixture\n')
  fs.mkdirSync(path.join(FIXTURE_REPO, 'src'), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE_REPO, 'src/a.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(FIXTURE_REPO, 'src/old name.js'), 'export const b = 2\n')
  fs.mkdirSync(path.join(FIXTURE_REPO, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE_REPO, 'docs/keep.txt'), 'keep\n')
  git(['add', '-A'])
  git(['commit', '-m', 'initial'])

  // Publish the upstream the way a push would; `git push` itself spawns git's
  // own shell, which a restricted sandbox can refuse.
  const initial = git(['rev-parse', 'HEAD']).toString('utf8').trim()
  git(['init', '--bare', FIXTURE_REMOTE], FIXTURE_ROOT)
  git(['remote', 'add', 'origin', FIXTURE_REMOTE])
  git(['update-ref', 'refs/remotes/origin/main', initial])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(['config', 'branch.main.remote', 'origin'])
  git(['config', 'branch.main.merge', 'refs/heads/main'])

  git(['mv', 'src/old name.js', 'src/new name.js'])
  fs.appendFileSync(path.join(FIXTURE_REPO, 'src/a.js'), 'export const a2 = 3\n')
  fs.writeFileSync(path.join(FIXTURE_REPO, 'src/added.js'), 'export const c = 4\nexport const d = 5\n')
  fs.writeFileSync(path.join(FIXTURE_REPO, 'untracked.txt'), 'one\ntwo\nthree\n')
  fs.rmSync(path.join(FIXTURE_REPO, 'docs/keep.txt'))
  fs.writeFileSync(path.join(FIXTURE_REPO, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe]))
  git(['add', 'src/added.js'])
  git(['commit', '-m', 'local commit'])

  return { repo: FIXTURE_REPO, remote: FIXTURE_REMOTE, base: 'origin/main' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  const fixture = buildFixture()
  console.log('fixture ready:', fixture.repo)
  const runner = createFixtureRunner()
  const upstream = await runner(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], fixture.repo)
  console.log('upstream:', upstream.stdout.toString('utf8').trim())
}
