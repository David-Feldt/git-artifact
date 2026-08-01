import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { git, gitOrNull, GitError } from './exec.js'

/** A checkout attached to the repo. The main worktree is always first. */
export interface Worktree {
  /** Absolute path to the worktree root. Absent for a bare repo's "main" entry. */
  path: string
  /** Resolved HEAD sha, or null when the worktree is on an unborn branch. */
  head: string | null
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null
  detached: boolean
  bare: boolean
  /** True for a worktree whose directory has gone missing. */
  prunable: boolean
  isMain: boolean
}

/**
 * Conditions that change what we can show. Each one has to produce a clear message in the
 * UI rather than an exception, because every one of them is a normal state a real repo
 * passes through.
 */
export interface RepoState {
  /** No commits yet — `git init` with nothing committed. */
  empty: boolean
  /** No working tree. Tier A liveness is unavailable; the graph still renders. */
  bare: boolean
  /** History is cut off at a graft boundary. */
  shallow: boolean
  detachedHead: boolean
  rebaseInProgress: boolean
  mergeInProgress: boolean
  cherryPickInProgress: boolean
  bisectInProgress: boolean
}

export interface Repo {
  /** The path git commands are run from. Fixed for the session. */
  path: string
  /** Absolute path to the working-tree root (or the git dir itself, when bare). */
  root: string
  /** Absolute path to the `.git` directory (resolved through worktree/submodule files). */
  gitDir: string
  /** Absolute path to the shared git dir — differs from `gitDir` inside a linked worktree. */
  commonDir: string
  /** Fixed for the session; also mirrored into `state` for the client. */
  bare: boolean
  shallow: boolean
  state: RepoState
  worktrees: Worktree[]
  /**
   * Short branch name of HEAD. Present even on an unborn branch in an empty repo — you
   * really are on `main`, it simply has no commits yet.
   */
  currentBranch: string | null
  head: string | null
  /** Commits whose parents a shallow clone has withheld. See `readShallowBoundary`. */
  grafted: Set<string>
}

export class NotARepoError extends Error {
  constructor(readonly startPath: string) {
    super(`not a git repository: ${startPath}`)
    this.name = 'NotARepoError'
  }
}

/**
 * Resolve everything we need to know about a repo in one shot.
 *
 * Uses a single `rev-parse` for the paths so we make one process spawn rather than five,
 * then probes the in-progress states from the filesystem — those are directory-existence
 * checks that git has no cheaper porcelain for.
 */
export async function openRepo(startPath: string): Promise<Repo> {
  const abs = path.resolve(startPath)
  if (!existsSync(abs)) throw new NotARepoError(abs)

  let out: string
  try {
    // `--show-toplevel` is deliberately NOT in this call. In a bare repository it fails
    // with "this operation must be run in a work tree", and because rev-parse aborts the
    // whole invocation, asking for it here made every bare repo throw instead of
    // degrading. It is queried separately below, where failure is expected and harmless.
    out = await git(abs, [
      'rev-parse',
      '--absolute-git-dir',
      '--path-format=absolute',
      '--git-common-dir',
      '--is-bare-repository',
      '--is-shallow-repository',
    ])
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.stderr)) {
      throw new NotARepoError(abs)
    }
    throw err
  }

  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const [gitDirRaw, commonDirRaw, bareRaw, shallowRaw] = lines
  const gitDir = path.resolve(gitDirRaw ?? '')
  const commonDir = path.resolve(commonDirRaw ?? gitDir)
  const bare = bareRaw === 'true'
  const shallow = shallowRaw === 'true'

  const toplevel = bare ? null : await gitOrNull(abs, ['rev-parse', '--show-toplevel'])
  const root = toplevel?.trim() ? path.resolve(toplevel.trim()) : gitDir

  const volatile = await readVolatile(abs, gitDir, commonDir, { bare, shallow })

  return {
    path: abs,
    root,
    gitDir,
    commonDir,
    bare,
    shallow,
    grafted: readShallowBoundary(commonDir),
    ...volatile,
  }
}

/**
 * Re-read only what can change while the daemon runs.
 *
 * Process spawns dominate refresh latency — each one costs tens of milliseconds, and a
 * full `openRepo` makes five. But the paths, the bare flag and the graft boundary are
 * fixed for the life of a session, so refreshing them on every commit was pure overhead.
 * This reads the volatile half in two spawns: HEAD and its symbolic name together, then
 * the worktree list. The in-progress flags are directory-existence checks and cost
 * nothing.
 */
export async function refreshRepo(repo: Repo): Promise<Repo> {
  const volatile = await readVolatile(repo.path, repo.gitDir, repo.commonDir, {
    bare: repo.bare,
    shallow: repo.shallow,
  })
  return { ...repo, ...volatile }
}

interface VolatileState {
  state: RepoState
  worktrees: Worktree[]
  currentBranch: string | null
  head: string | null
}

async function readVolatile(
  cwd: string,
  gitDir: string,
  commonDir: string,
  fixed: { bare: boolean; shallow: boolean },
): Promise<VolatileState> {
  // One spawn for both: rev-parse accepts the same revision twice under different
  // formats, so HEAD's sha and its symbolic name come back as two lines.
  const headInfo = await gitOrNull(cwd, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'])
  const [shaLine, refLine] = (headInfo ?? '').split('\n').map((l) => l.trim())

  const head = shaLine && /^[0-9a-f]{40}$/.test(shaLine) ? shaLine : null
  const empty = head === null
  const currentBranch = refLine?.startsWith('refs/heads/')
    ? refLine.slice('refs/heads/'.length)
    : await symbolicRefFallback(cwd)

  return {
    head,
    currentBranch,
    worktrees: await listWorktrees(cwd),
    state: {
      empty,
      bare: fixed.bare,
      shallow: fixed.shallow,
      // Detached only counts once there is a commit to be detached at. An unborn branch
      // also fails to resolve, but it is a different situation and has a branch name.
      detachedHead: !empty && currentBranch === null,
      rebaseInProgress:
        existsSync(path.join(gitDir, 'rebase-merge')) ||
        existsSync(path.join(gitDir, 'rebase-apply')),
      mergeInProgress: existsSync(path.join(gitDir, 'MERGE_HEAD')),
      cherryPickInProgress: existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD')),
      bisectInProgress: existsSync(path.join(commonDir, 'BISECT_LOG')),
    },
  }
}

/**
 * An empty repo has no HEAD to resolve, so the combined `rev-parse` above returns
 * nothing — but the branch still has a name, and showing it beats showing nothing.
 */
async function symbolicRefFallback(cwd: string): Promise<string | null> {
  const raw = await gitOrNull(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return raw?.trim() || null
}

/**
 * Shas at a shallow clone's graft boundary, read from `.git/shallow`.
 *
 * These need special handling because git *hides* a grafted commit's parents: `%P` comes
 * back empty, so the commit is indistinguishable from a genuine root. Left alone, a
 * `--depth=1` clone renders as though its one commit were the start of history, which is
 * exactly the wrong thing to tell someone. Knowing the boundary lets the renderer fray
 * the rail instead.
 */
function readShallowBoundary(commonDir: string): Set<string> {
  try {
    const raw = readFileSync(path.join(commonDir, 'shallow'), 'utf8')
    return new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean))
  } catch {
    return new Set() // Not a shallow clone; the common case.
  }
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated; each is a
 * `worktree <path>` line followed by optional attribute lines.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const out = await gitOrNull(cwd, ['worktree', 'list', '--porcelain'])
  if (out === null) return []

  const worktrees: Worktree[] = []
  let current: Partial<Worktree> | null = null

  const flush = () => {
    if (current?.path === undefined) return
    worktrees.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      prunable: current.prunable ?? false,
      isMain: worktrees.length === 0,
    })
    current = null
  }

  for (const line of out.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    const sep = line.indexOf(' ')
    const key = sep === -1 ? line : line.slice(0, sep)
    const value = sep === -1 ? '' : line.slice(sep + 1)

    switch (key) {
      case 'worktree':
        flush()
        current = { path: path.resolve(value) }
        break
      case 'HEAD':
        if (current) current.head = value
        break
      case 'branch':
        // Reported as a full ref, e.g. `refs/heads/feat/server`.
        if (current) current.branch = value.replace(/^refs\/heads\//, '')
        break
      case 'detached':
        if (current) current.detached = true
        break
      case 'bare':
        if (current) current.bare = true
        break
      case 'prunable':
        if (current) current.prunable = true
        break
    }
  }
  flush()

  return worktrees
}
