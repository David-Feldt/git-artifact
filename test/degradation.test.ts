import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo, NotARepoError } from '../src/git/repo.js'
import { readLog } from '../src/git/log.js'
import { readStatus } from '../src/git/status.js'
import { assignLanes } from '../src/graph/lanes.js'
import { GraphStore } from '../src/server/store.js'
import { builders, cleanupAll } from './fixtures/make.js'

/**
 * Every state here is one a healthy repository passes through — a fresh `git init`, a
 * conflicted merge, a shallow CI clone. None may throw, and none may render a graph that
 * quietly lies about what is there. The plan's rule was "a clear message, not a stack
 * trace", so these assert the *state flags the UI keys off*, not just the absence of a
 * crash.
 */
describe('repository states', () => {
  afterAll(cleanupAll)

  it('reports an empty repository rather than failing', async () => {
    const dir = builders.empty!()
    const repo = await openRepo(dir)

    expect(repo.state.empty).toBe(true)
    expect(repo.head).toBeNull()
    // An unborn branch still has a name, and showing it is more useful than showing
    // nothing. What must not happen is mistaking it for a detached HEAD.
    expect(repo.currentBranch).toBe('main')
    expect(repo.state.detachedHead).toBe(false)
    // `git log` errors on a repo with no commits; that must surface as an empty graph.
    expect(await readLog(dir)).toEqual([])
  })

  it('reports a bare repository and still reads its graph', async () => {
    const dir = builders.bare!()
    const repo = await openRepo(dir)

    expect(repo.state.bare).toBe(true)
    // The graph is the whole point; only the working-tree half is unavailable.
    expect(assignLanes(await readLog(dir)).length).toBeGreaterThan(0)
  })

  it('reports a shallow clone and truncates at the graft boundary', async () => {
    const dir = builders.shallow!()
    const repo = await openRepo(dir)
    const rows = assignLanes(await readLog(dir), { grafted: repo.grafted })

    expect(repo.state.shallow).toBe(true)
    expect(rows).toHaveLength(1)
    // git withholds a grafted commit's parents entirely, so `%P` is empty and the commit
    // is textually indistinguishable from a root. Only `.git/shallow` reveals the
    // difference, and getting this wrong would claim history begins here.
    expect(rows[0]!.commit.parents).toEqual([])
    expect(repo.grafted.has(rows[0]!.commit.sha)).toBe(true)
    expect(rows[0]!.truncated).toBe(true)
  })

  it('reports a detached HEAD without calling it an empty repo', async () => {
    const repo = await openRepo(builders.detachedHead!())

    expect(repo.state.detachedHead).toBe(true)
    expect(repo.state.empty).toBe(false)
    expect(repo.currentBranch).toBeNull()
    expect(repo.head).not.toBeNull()
  })

  it('reports a rebase in progress', async () => {
    const repo = await openRepo(builders.midRebase!())
    expect(repo.state.rebaseInProgress).toBe(true)
  })

  it('reports a merge in progress', async () => {
    const repo = await openRepo(builders.midMerge!())
    expect(repo.state.mergeInProgress).toBe(true)
    // A conflicted merge leaves unmerged entries, which status must classify as such.
    const status = await readStatus(repo.root)
    expect(status.files.some((f) => f.conflicted)).toBe(true)
  })

  it('lists linked worktrees with their own HEADs', async () => {
    const repo = await openRepo(builders.worktrees!())

    expect(repo.worktrees.length).toBe(2)
    expect(repo.worktrees[0]!.isMain).toBe(true)
    const branches = repo.worktrees.map((w) => w.branch).sort()
    expect(branches).toEqual(['main', 'side'])
    // Distinct branches mean distinct HEADs; a shared one would collapse the lanes.
    expect(repo.worktrees[0]!.head).not.toBe(repo.worktrees[1]!.head)
  })

  it('refuses a directory that is not a repository', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'git-artifact-plain-'))
    await expect(openRepo(dir)).rejects.toBeInstanceOf(NotARepoError)
  })
})

describe('GraphStore', () => {
  afterAll(cleanupAll)

  it('serves a graph and a status for an ordinary repo', async () => {
    const dir = builders.branchMerge!()
    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()

    const graph = store.getGraph()!
    expect(graph.rows.length).toBe(4)
    expect(graph.capped).toBe(false)
    expect(graph.repo.name).toBe(path.basename(dir))

    const status = store.getStatus()!
    expect(status.worktrees).toHaveLength(1)
  })

  it('reports capped history when the cap is hit', async () => {
    const store = new GraphStore(builders.linear!(), { maxCount: 2 })
    await store.init()

    const graph = store.getGraph()!
    expect(graph.rows).toHaveLength(2)
    expect(graph.capped).toBe(true)
    // The oldest loaded commit's parent is outside the window, so its rail must fray.
    expect(graph.rows[1]!.truncated).toBe(true)
  })

  it('produces no worktree status for a bare repo without erroring', async () => {
    const store = new GraphStore(builders.bare!(), { maxCount: 5000 })
    await store.init()

    expect(store.getGraph()!.rows.length).toBeGreaterThan(0)
    expect(store.getStatus()!.worktrees).toEqual([])
  })

  it('picks up a new commit on refresh', async () => {
    const dir = builders.linear!()
    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()
    const before = store.getGraph()!.rows.length

    writeFileSync(path.join(dir, 'f.txt'), 'more\n', { flag: 'a' })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'later'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@t.t',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@t.t',
      },
    })

    await store.refreshGraph()
    expect(store.getGraph()!.rows.length).toBe(before + 1)
    expect(store.getGraph()!.rows[0]!.commit.subject).toBe('later')
  })
})
