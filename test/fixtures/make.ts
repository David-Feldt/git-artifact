import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Deterministic throwaway repos for the graph tests.
 *
 * Everything is pinned — author, committer, and both timestamps — so shas are stable
 * across machines and runs. That matters more than it looks: without pinning, the oracle
 * comparison against `git log --graph` would drift whenever commits landed in the same
 * second and git broke the tie differently.
 *
 * These write only into a fresh temp directory. The read-only guarantee is about the
 * user's repos, not about test scaffolding.
 */

const BASE_TIME = 1_700_000_000 // 2023-11-14T22:13:20Z, arbitrary but fixed

export interface Fixture {
  name: string
  dir: string
  cleanup: () => void
}

/**
 * Every directory any builder has created, including the intermediate source repos that
 * `bare` and `shallow` clone from and the sibling directory `worktrees` adds. Tests call
 * {@link cleanupAll} once at the end rather than trying to track these individually.
 */
const created: string[] = []

function track(dir: string): string {
  created.push(dir)
  return dir
}

export function cleanupAll(): void {
  // Remove deepest paths first so a linked worktree goes before its parent.
  for (const dir of created.sort((a, b) => b.length - a.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
  created.length = 0
}

function run(dir: string, args: string[], timeOffset = 0): string {
  const stamp = `${BASE_TIME + timeOffset} +0000`
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.test',
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Per-repo logical clock. Reset on every `initRepo` so a fixture's shas depend only on
 * its own build steps, never on which other fixtures happened to run first.
 */
let tick = 0

function initRepo(name: string): string {
  const dir = track(mkdtempSync(path.join(tmpdir(), `git-artifact-${name}-`)))
  tick = 0
  run(dir, ['init', '--quiet', '--initial-branch=main'])
  run(dir, ['config', 'user.name', 'Fixture Author'])
  run(dir, ['config', 'user.email', 'author@example.test'])
  return dir
}

function commit(dir: string, message: string, file = 'f.txt'): void {
  tick += 60
  writeFileSync(path.join(dir, file), `${message}\n`, { flag: 'a' })
  run(dir, ['add', '-A'], tick)
  run(dir, ['commit', '--quiet', '-m', message], tick)
}

/** Every fixture builder, keyed by name. Each returns a ready-to-read directory. */
export const builders: Record<string, () => string> = {
  /** Three commits in a line. The degenerate case; one lane, no edges crossing. */
  linear() {
    const dir = initRepo('linear')
    commit(dir, 'first')
    commit(dir, 'second')
    commit(dir, 'third')
    return dir
  },

  /** A branch off main, merged back. Two lanes that open and close. */
  branchMerge() {
    const dir = initRepo('branch-merge')
    commit(dir, 'base')
    run(dir, ['checkout', '--quiet', '-b', 'feature'])
    commit(dir, 'feature work', 'feature.txt')
    run(dir, ['checkout', '--quiet', 'main'])
    commit(dir, 'main work', 'main.txt')
    tick += 60
    run(dir, ['merge', '--quiet', '--no-ff', '-m', 'merge feature', 'feature'], tick)
    return dir
  },

  /** A merge with three parents. The case that breaks two-parent assumptions. */
  octopus() {
    const dir = initRepo('octopus')
    commit(dir, 'base')
    for (const branch of ['a', 'b', 'c']) {
      run(dir, ['checkout', '--quiet', '-b', branch, 'main'])
      commit(dir, `work on ${branch}`, `${branch}.txt`)
    }
    run(dir, ['checkout', '--quiet', 'main'])
    tick += 60
    run(dir, ['merge', '--quiet', '--no-ff', '-m', 'octopus merge', 'a', 'b', 'c'], tick)
    return dir
  },

  /** Two unrelated root commits, then a merge joining the histories. */
  twoRoots() {
    const dir = initRepo('two-roots')
    commit(dir, 'root one')
    run(dir, ['checkout', '--quiet', '--orphan', 'second-root'])
    run(dir, ['rm', '-rf', '--quiet', '--cached', '.'])
    commit(dir, 'root two', 'other.txt')
    run(dir, ['checkout', '--quiet', 'main'])
    tick += 60
    run(
      dir,
      ['merge', '--quiet', '--no-ff', '--allow-unrelated-histories', '-m', 'join roots', 'second-root'],
      tick,
    )
    return dir
  },

  /** HEAD detached at an older commit. */
  detachedHead() {
    const dir = initRepo('detached')
    commit(dir, 'one')
    commit(dir, 'two')
    commit(dir, 'three')
    const first = run(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim()
    run(dir, ['checkout', '--quiet', first])
    return dir
  },

  /** Stopped mid-rebase with a conflict. `.git/rebase-merge` exists. */
  midRebase() {
    const dir = initRepo('mid-rebase')
    commit(dir, 'base', 'shared.txt')
    run(dir, ['checkout', '--quiet', '-b', 'topic'])
    writeFileSync(path.join(dir, 'shared.txt'), 'topic version\n')
    run(dir, ['add', '-A'], (tick += 60))
    run(dir, ['commit', '--quiet', '-m', 'topic edit'], tick)
    run(dir, ['checkout', '--quiet', 'main'])
    writeFileSync(path.join(dir, 'shared.txt'), 'main version\n')
    run(dir, ['add', '-A'], (tick += 60))
    run(dir, ['commit', '--quiet', '-m', 'main edit'], tick)
    try {
      run(dir, ['rebase', 'main', 'topic'], (tick += 60))
    } catch {
      // Expected: the rebase stops on the conflict, which is the state we want.
    }
    return dir
  },

  /** Stopped mid-merge with a conflict. `.git/MERGE_HEAD` exists. */
  midMerge() {
    const dir = initRepo('mid-merge')
    commit(dir, 'base', 'shared.txt')
    run(dir, ['checkout', '--quiet', '-b', 'other'])
    writeFileSync(path.join(dir, 'shared.txt'), 'other version\n')
    run(dir, ['add', '-A'], (tick += 60))
    run(dir, ['commit', '--quiet', '-m', 'other edit'], tick)
    run(dir, ['checkout', '--quiet', 'main'])
    writeFileSync(path.join(dir, 'shared.txt'), 'main version\n')
    run(dir, ['add', '-A'], (tick += 60))
    run(dir, ['commit', '--quiet', '-m', 'main edit'], tick)
    try {
      run(dir, ['merge', 'other'], (tick += 60))
    } catch {
      // Expected: the merge stops on the conflict.
    }
    return dir
  },

  /** `git init` and nothing else. No HEAD, no refs. */
  empty() {
    return initRepo('empty')
  },

  /** A bare clone: no working tree, so Tier A liveness must degrade rather than crash. */
  bare() {
    const source = builders.branchMerge!()
    // mkdtemp leaves the directory empty, which is what `clone` requires.
    const dir = track(mkdtempSync(path.join(tmpdir(), 'git-artifact-bare-')))
    run(tmpdir(), ['clone', '--quiet', '--bare', source, dir])
    return dir
  },

  /** A depth-1 clone: history is cut at a graft boundary. */
  shallow() {
    const source = builders.linear!()
    const dir = track(mkdtempSync(path.join(tmpdir(), 'git-artifact-shallow-')))
    // `--depth` is ignored for plain local clones, so go through the file:// transport.
    run(tmpdir(), ['clone', '--quiet', '--depth=1', `file://${source}`, dir])
    return dir
  },

  /**
   * Two linked worktrees on branches that have genuinely diverged, so their HEADs land in
   * different lanes.
   *
   * Distinct from `worktrees`, where the main checkout sits on an *ancestor* of the other
   * branch and both HEADs legitimately share one rail. Both shapes are real and the
   * worktree strip has to handle each.
   */
  worktreesDiverged() {
    const dir = initRepo('worktrees-diverged')
    commit(dir, 'base')
    run(dir, ['checkout', '--quiet', '-b', 'side'])
    commit(dir, 'side work', 'side.txt')
    run(dir, ['checkout', '--quiet', 'main'])
    commit(dir, 'main work', 'main.txt')
    const linked = track(`${dir}-wt`)
    run(dir, ['worktree', 'add', '--quiet', linked, 'side'])
    return dir
  },

  /** A second linked worktree, for the WIP-node and lane-group work. */
  worktrees() {
    const dir = initRepo('worktrees')
    commit(dir, 'base')
    run(dir, ['checkout', '--quiet', '-b', 'side'])
    commit(dir, 'side work', 'side.txt')
    run(dir, ['checkout', '--quiet', 'main'])
    const linked = track(`${dir}-wt`)
    run(dir, ['worktree', 'add', '--quiet', linked, 'side'])
    return dir
  },
}

export function makeFixture(name: keyof typeof builders): Fixture {
  const build = builders[name]
  if (!build) throw new Error(`unknown fixture: ${name}`)
  const dir = build()
  return { name: String(name), dir, cleanup: cleanupAll }
}

/** Names of fixtures that contain at least one commit, i.e. have a graph to compare. */
export const GRAPH_FIXTURES = [
  'linear',
  'branchMerge',
  'octopus',
  'twoRoots',
  'detachedHead',
  'midRebase',
  'midMerge',
  'bare',
  'shallow',
  'worktrees',
] as const
