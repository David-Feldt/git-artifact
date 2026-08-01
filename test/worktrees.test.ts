import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GraphStore } from '../src/server/store.js'
import { openRepo } from '../src/git/repo.js'
import { builders, cleanupAll } from './fixtures/make.js'

const A = 'a'.repeat(40)

function writePushLog(commonDir: string, ref: string, sha: string, ts: number): void {
  const file = path.join(commonDir, 'logs', 'refs', 'remotes', ref)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${A} ${sha} Tester <t@example.test> ${ts} +0000\tupdate by push\n`,
  )
}

describe('worktree lanes', () => {
  afterAll(cleanupAll)

  it('gives diverged worktrees different lanes', async () => {
    const store = new GraphStore(builders.worktreesDiverged!(), { maxCount: 5000 })
    await store.init()

    const lanes = store.getGraph()!.worktreeLanes
    expect(lanes).toHaveLength(2)
    expect(lanes[0]!.isMain).toBe(true)
    expect(new Set(lanes.map((l) => l.branch))).toEqual(new Set(['main', 'side']))

    const [main, linked] = lanes
    expect(main!.lane).not.toBeNull()
    expect(linked!.lane).not.toBeNull()
    expect(main!.lane).not.toBe(linked!.lane)
  })

  it('lets worktrees share a lane when one sits on an ancestor of the other', async () => {
    // Not a bug to fix: if `main` is checked out at a commit that `side` descends from,
    // the two HEADs really are on the same rail at different points. Forcing them apart
    // would draw a branch that does not exist. Two chips of one colour is the honest
    // rendering, and each still scrolls to its own commit.
    const store = new GraphStore(builders.worktrees!(), { maxCount: 5000 })
    await store.init()

    const lanes = store.getGraph()!.worktreeLanes
    expect(lanes).toHaveLength(2)
    expect(lanes.every((l) => l.lane === 0)).toBe(true)
    expect(lanes[0]!.head).not.toBe(lanes[1]!.head)
  })

  it('does not carry mutable status fields that could go stale', async () => {
    // Dirty counts live only on the status payload. Duplicating them here would let the
    // header disagree with the WIP node, since the two payloads refresh independently.
    const store = new GraphStore(builders.worktrees!(), { maxCount: 5000 })
    await store.init()

    const lane = store.getGraph()!.worktreeLanes[0]!
    expect(lane).not.toHaveProperty('dirtyCount')
    expect(lane).not.toHaveProperty('ahead')
  })

  it('reports a lane of null when HEAD is outside the loaded window', async () => {
    const store = new GraphStore(builders.worktrees!(), { maxCount: 1 })
    await store.init()

    const graph = store.getGraph()!
    expect(graph.rows).toHaveLength(1)
    // One of the two worktrees must now be off-screen; the UI shows that rather than
    // silently pinning it to lane 0.
    expect(graph.worktreeLanes.some((l) => l.lane === null)).toBe(true)
  })

  it('excludes bare and prunable worktrees', async () => {
    const store = new GraphStore(builders.bare!(), { maxCount: 5000 })
    await store.init()
    expect(store.getGraph()!.worktreeLanes).toEqual([])
  })

  it('names a worktree by its directory basename', async () => {
    const dir = builders.worktrees!()
    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()

    for (const lane of store.getGraph()!.worktreeLanes) {
      expect(lane.name).toBe(path.basename(lane.path))
    }
  })
})

describe('push markers', () => {
  afterAll(cleanupAll)

  it('keys pushes by the commit they landed on', async () => {
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    const tip = repo.head!
    writePushLog(repo.commonDir, 'origin/main', tip, 1_700_000_000)

    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()

    const pushes = store.getGraph()!.pushes
    expect(Object.keys(pushes)).toEqual([tip])
    expect(pushes[tip]).toEqual([
      { ref: 'origin/main', at: 1_700_000_000_000, authorName: 'Tester' },
    ])
  })

  it('marks only the pushed commit, not its ancestors', async () => {
    // "A push happened here, then" is a timeline event. Whether a commit is currently
    // published is a different question, answered per-branch by ahead/behind.
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    writePushLog(repo.commonDir, 'origin/main', repo.head!, 1_700_000_000)

    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()

    const graph = store.getGraph()!
    expect(graph.rows).toHaveLength(3)
    expect(Object.keys(graph.pushes)).toHaveLength(1)
  })

  it('collects several pushes onto one commit', async () => {
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    const tip = repo.head!
    writePushLog(repo.commonDir, 'origin/main', tip, 1_700_000_000)
    writePushLog(repo.commonDir, 'fork/main', tip, 1_700_000_500)

    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()

    const refs = store.getGraph()!.pushes[tip]!.map((p) => p.ref).sort()
    expect(refs).toEqual(['fork/main', 'origin/main'])
  })

  it('is empty when nothing was ever pushed', async () => {
    const store = new GraphStore(builders.linear!(), { maxCount: 5000 })
    await store.init()
    // Reflogs expire and most repos have no remote at all; absence is normal, not an error.
    expect(store.getGraph()!.pushes).toEqual({})
  })

  it('survives an unreadable reflog tree', async () => {
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    // A file where a directory is expected: readdir fails, and the graph must still load.
    writeFileSync(path.join(repo.commonDir, 'logs', 'refs', 'remotes'), 'not a directory')

    const store = new GraphStore(dir, { maxCount: 5000 })
    await store.init()
    expect(store.getGraph()!.rows).toHaveLength(3)
    expect(store.getGraph()!.pushes).toEqual({})
  })
})
