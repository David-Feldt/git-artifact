import { describe, expect, it } from 'vitest'
import { assignLanes } from '../src/graph/lanes.js'
import type { Commit, GraphRow } from '../src/graph/model.js'
import { buildDisplayRows, ROW_HEIGHT, laneX, type DisplayRow } from '../src/client/components/layout.js'
import { edgePath, railNodes, railPaths } from '../src/client/components/rail-paths.js'
import type { WorktreeStatus } from '../src/api.js'

/**
 * Rail geometry, tested without React.
 *
 * `lanes.test.ts` covers which lane a commit lands in and the oracle suite compares those
 * indices against `git log --graph`, but until the geometry was split out of `Rails.tsx`
 * nothing asserted the paths actually drawn — the one part of the graph a reader looks at
 * directly.
 */

function c(sha: string, ...parents: string[]): Commit {
  return {
    sha,
    parents,
    authorName: 'Test',
    authorEmail: 'test@example.test',
    authorDate: 0,
    commitDate: 0,
    subject: sha,
    refs: [],
  }
}

/** Uniform rows, which is what `rowOffsets` produces with no panel open. */
const y = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2

const display = (commits: Commit[], worktrees: WorktreeStatus[] = []) =>
  buildDisplayRows(assignLanes(commits), worktrees)

/** The same, with one session band over the given inclusive row range. */
const withBand = (commits: Commit[], startRow: number, endRow: number) =>
  buildDisplayRows(assignLanes(commits), [], [
    {
      sessionId: 's1',
      title: 'A session',
      startRow,
      endRow,
      commitCount: endRow - startRow + 1,
      promptCount: 3,
      inputTokens: 1000,
      outputTokens: 100,
      model: 'claude',
      startedAt: 0,
      endedAt: 60_000,
      branches: ['main'],
      live: null,
    },
  ])

describe('railPaths', () => {
  it('draws a straight vertical rail down a linear history', () => {
    const rows = display([c('c', 'b'), c('b', 'a'), c('a')])
    const paths = railPaths(rows, y)

    // Two edges: c→b and b→a. The root has none.
    expect(paths).toHaveLength(2)
    expect(paths.every((p) => p.lane === 0)).toBe(true)
    expect(paths[0]!.d).toBe(`M ${laneX(0)} ${y(0)} L ${laneX(0)} ${y(1)}`)
    expect(paths.every((p) => p.truncated)).toBe(false)
  })

  it('gives a root commit no outgoing rail', () => {
    expect(railPaths(display([c('a')]), y)).toEqual([])
  })

  it('curves when an edge changes lane, and stays straight when it does not', () => {
    expect(edgePath(10, 0, 10, 44)).toBe('M 10 0 L 10 44')
    expect(edgePath(10, 0, 32, 44)).toContain('C')
  })

  it('clamps the bend so a jump across many lanes does not bulge into its neighbours', () => {
    // A 200px-tall gap would bend 100px on the unclamped half-height rule.
    expect(edgePath(10, 0, 120, 200)).toBe('M 10 0 C 10 35.2 120 164.8 120 200')
  })

  it('draws two lines for one edge when a merge parent lands in a busy lane', () => {
    /*
     * The case `Rails.tsx` called out by hand and the reason `incoming` exists. Lane 1 is
     * already carrying an unrelated rail, and this merge's second parent also lives there:
     * the rail has to keep running straight down *and* a connector has to leave the node,
     * or the graph loses either the passing branch or the merge.
     */
    const row: GraphRow = {
      commit: c('m', 'p1', 'p2'),
      lane: 0,
      edges: [
        { fromLane: 0, toLane: 0, parentSha: 'p1', kind: 'first' },
        { fromLane: 1, toLane: 1, parentSha: 'p2', kind: 'merge' },
      ],
      incoming: [1],
      width: 2,
      truncated: false,
    }
    const paths = railPaths([{ kind: 'commit', row, index: 0 }], y)

    const forSecondParent = paths.filter((p) => p.d.includes(`${laneX(1)} ${y(1)}`))
    expect(forSecondParent).toHaveLength(2)
    // One continues lane 1 straight down; one leaves the merge node in lane 0.
    expect(forSecondParent.some((p) => p.d.startsWith(`M ${laneX(1)}`))).toBe(true)
    expect(forSecondParent.some((p) => p.d.startsWith(`M ${laneX(0)}`))).toBe(true)
    // A merge edge takes the colour of the lane it lands in, not the one it leaves.
    expect(forSecondParent.every((p) => p.lane === 1)).toBe(true)
  })

  it('draws a pass-through lane once, from the lane it was already in', () => {
    const row: GraphRow = {
      commit: c('x', 'p1'),
      lane: 0,
      edges: [
        { fromLane: 0, toLane: 0, parentSha: 'p1', kind: 'first' },
        { fromLane: 1, toLane: 1, parentSha: 'other', kind: 'pass' },
      ],
      incoming: [1],
      width: 2,
      truncated: false,
    }
    const paths = railPaths([{ kind: 'commit', row, index: 0 }], y)
    expect(paths.filter((p) => p.d.startsWith(`M ${laneX(1)}`))).toHaveLength(1)
  })

  it('marks a truncated commit with a stub shorter than a row', () => {
    const row: GraphRow = {
      commit: c('t', 'gone'),
      lane: 0,
      edges: [],
      incoming: [],
      width: 1,
      truncated: true,
    }
    const paths = railPaths([{ kind: 'commit', row, index: 0 }], y)
    expect(paths).toHaveLength(1)
    expect(paths[0]!.truncated).toBe(true)
    expect(paths[0]!.d).toBe(
      `M ${laneX(0)} ${y(0)} L ${laneX(0)} ${y(0) + ROW_HEIGHT * 0.45}`,
    )
  })

  it('runs every live lane straight through a WIP row', () => {
    const worktree: WorktreeStatus = {
      path: '/tmp/repo',
      branch: 'main',
      head: 'b',
      detached: false,
      ahead: null,
      behind: null,
      upstream: null,
      files: [{ path: 'a.ts', status: ' M', staged: false, unstaged: true, untracked: false, conflicted: false, mtimeMs: 0, heat: 1 }],
      peakHeat: 1,
    }
    const rows = display([c('b', 'a'), c('a')], [worktree])
    expect(rows[0]!.kind).toBe('wip')

    const fromWip = railPaths(rows, y).filter((p) => p.key.startsWith('0:'))
    expect(fromWip).toHaveLength(1)
    // Dashed: the tail above a WIP node is not history.
    expect(fromWip[0]!.truncated).toBe(true)
  })
})

describe('railNodes', () => {
  it('distinguishes root, ordinary and merge commits by kind', () => {
    const rows = display([c('m', 'a', 'b'), c('a', 'r'), c('b', 'r'), c('r')])
    const kinds = railNodes(rows, y).map((n) => n.kind)
    expect(kinds[0]).toBe('merge')
    expect(kinds[1]).toBe('commit')
    expect(kinds[kinds.length - 1]).toBe('root')
  })

  it('gives a session header no node, because nothing happened on the graph there', () => {
    const rows = withBand([c('b', 'a'), c('a')], 0, 1)

    expect(rows[0]!.kind).toBe('session')
    expect(railNodes(rows, y)).toHaveLength(2)
  })

  it('runs a live lane straight through a session header', () => {
    // A header mid-history: the rail above it continues past, or the branch it belongs to
    // would look like it ended at an annotation.
    const rows = withBand([c('c', 'b'), c('b', 'a'), c('a')], 1, 2)

    expect(rows[1]!.kind).toBe('session')
    const through = railPaths(rows, y).filter((p) => p.key.startsWith('1:s'))
    expect(through).toHaveLength(1)
    expect(through[0]!.d).toBe(`M ${laneX(0)} ${y(1)} L ${laneX(0)} ${y(2)}`)
  })

  it('draws nothing above the newest commit when a band opens the graph', () => {
    // Nothing arrives from above the first row, so a header there has no rail to continue.
    // Drawing one would put a stub over the newest commit pointing at history that is not
    // in the window and, at the tip of a branch, does not exist at all.
    const rows = withBand([c('b', 'a'), c('a')], 0, 1)
    expect(railPaths(rows, y).filter((p) => p.key.startsWith('0:s'))).toEqual([])
  })

  it('leaves no rail above a merge in the lane that merge opens', () => {
    /*
     * The regression this file exists to catch now.
     *
     * A merge's edge list names the lane it opens for the branch it absorbed. That lane has
     * no history above the merge — it begins there and runs downward — so an annotation row
     * above it must not continue it. Deriving the through-lanes from the row below made
     * exactly that mistake, hanging a stub of rail over every merge with a band on it.
     */
    const merge = [c('tip', 'm'), c('m', 'main1', 'side1'), c('side1', 'main1'), c('main1')]
    const rows = withBand(merge, 1, 3)

    const mergeRow = rows.find((r) => r.kind === 'commit' && r.row.commit.sha === 'm')!
    const opened = (mergeRow as Extract<DisplayRow, { kind: 'commit' }>).row.edges
      .find((e) => e.kind === 'merge')!.toLane
    expect(opened).toBe(1)

    // Every rail drawn above the merge row belongs to a lane that existed above it.
    const aboveMerge = railPaths(rows, y).filter((p) => p.d.includes(`${y(1)} L`))
    expect(aboveMerge.map((p) => p.lane)).toEqual([0])
  })

  it('keys nodes uniquely across the whole graph', () => {
    const rows = display([c('c', 'b'), c('b', 'a'), c('a')])
    const keys = [...railPaths(rows, y), ...railNodes(rows, y)].map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
