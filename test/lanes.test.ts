import { describe, expect, it } from 'vitest'
import { assignLanes, graphWidth } from '../src/graph/lanes.js'
import type { Commit } from '../src/graph/model.js'

/**
 * Pure unit tests for lane assignment. No git, no filesystem, no clock — every graph here
 * is written by hand so the expected output can be reasoned about directly.
 *
 * `commits` must be given in topological order, children before parents, which is what
 * `git log --topo-order` guarantees and what the algorithm requires.
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

const lanesOf = (commits: Commit[]) =>
  Object.fromEntries(assignLanes(commits).map((r) => [r.commit.sha, r.lane]))

describe('assignLanes', () => {
  it('puts a linear history in a single lane', () => {
    const rows = assignLanes([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(graphWidth(rows)).toBe(1)
  })

  it('handles an empty history', () => {
    expect(assignLanes([])).toEqual([])
  })

  it('gives a root commit no outgoing edges', () => {
    const rows = assignLanes([c('a')])
    expect(rows[0]!.edges).toEqual([])
    expect(rows[0]!.truncated).toBe(false)
  })

  it('opens a second lane for a merge and closes it at the branch point', () => {
    //   m       merge
    //   |\
    //   | f     feature
    //   b |     base-side
    //   |/
    //   r       root
    const rows = assignLanes([c('m', 'b', 'f'), c('f', 'r'), c('b', 'r'), c('r')])
    expect(lanesOf([c('m', 'b', 'f'), c('f', 'r'), c('b', 'r'), c('r')])).toEqual({
      m: 0,
      f: 1,
      b: 0,
      r: 0,
    })
    // The merge's first parent continues in its own lane; the second opens lane 1.
    expect(rows[0]!.edges).toEqual([
      { fromLane: 0, toLane: 0, parentSha: 'b', kind: 'first' },
      { fromLane: 1, toLane: 1, parentSha: 'f', kind: 'merge' },
    ])
    expect(graphWidth(rows)).toBe(2)
  })

  it('routes every parent of an octopus merge', () => {
    const commits = [
      c('o', 'p1', 'p2', 'p3'),
      c('p3', 'r'),
      c('p2', 'r'),
      c('p1', 'r'),
      c('r'),
    ]
    const rows = assignLanes(commits)
    expect(rows[0]!.edges.filter((e) => e.kind === 'merge')).toHaveLength(2)
    expect(rows[0]!.edges.filter((e) => e.kind === 'first')).toHaveLength(1)
    expect(rows[0]!.edges.map((e) => e.parentSha).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(graphWidth(rows)).toBe(3)
  })

  it('keeps interleaved unrelated roots in separate lanes', () => {
    const rows = assignLanes([c('a2', 'a1'), c('b2', 'b1'), c('a1'), c('b1')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1])
  })

  it('reuses a lane once an unrelated history has fully ended', () => {
    // Both roots are drawn in one column because the first is finished before the second
    // begins. Holding a column open for a dead history would widen the graph for nothing.
    const rows = assignLanes([c('a2', 'a1'), c('a1'), c('b2', 'b1'), c('b1')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0])
    expect(graphWidth(rows)).toBe(1)
  })

  it('converges several branches onto one shared parent', () => {
    // Two tips descend from the same commit; it is drawn once, in the leftmost lane.
    const rows = assignLanes([c('x', 'base'), c('y', 'base'), c('base')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0])
    // Lane 1's edge curves into lane 0 where `base` actually sits.
    expect(rows[1]!.edges).toContainEqual({
      fromLane: 1,
      toLane: 0,
      parentSha: 'base',
      kind: 'first',
    })
  })

  it('flags a commit whose parent is outside the loaded set', () => {
    // What a shallow clone or a --max-count cap looks like from in here.
    const rows = assignLanes([c('tip', 'missing')])
    expect(rows[0]!.truncated).toBe(true)
    // The lane is released rather than left waiting for a sha that never arrives.
    expect(rows[0]!.edges).toEqual([])
    expect(graphWidth(rows)).toBe(1)
  })

  it('keeps a merge lane when only one of two parents is missing', () => {
    const rows = assignLanes([c('m', 'present', 'missing'), c('present')])
    expect(rows[0]!.truncated).toBe(true)
    expect(rows[0]!.edges).toEqual([
      { fromLane: 0, toLane: 0, parentSha: 'present', kind: 'first' },
    ])
  })

  /**
   * We deliberately differ from `git log --graph` here, and this test pins the decision.
   *
   * git compacts columns: when a lane closes, every lane to its right slides left. That is
   * ideal for a one-shot terminal dump, but this graph re-renders live, and sliding would
   * make unrelated branches jump sideways every time some other branch got merged.
   *
   * So lanes keep their column for life and freed slots are reused leftmost-first. The
   * cost is a transient empty column; measured against a real 316-commit repo the maximum
   * graph width came out *narrower* than git's (4 vs 5), so nothing is lost in practice.
   */
  it('keeps lane indices stable instead of compacting, when a middle lane closes', () => {
    const commits = [
      c('x', 'a'), // lane 0
      c('y', 'a'), // lane 1
      c('z', 'b'), // lane 2 — long-running, must not move
      c('a', 'b'), // x and y converge here; lane 1 frees
      c('w', 'b'), // a fresh tip: takes the freed lane 1, not a new lane 3
      c('b'),
    ]
    const rows = assignLanes(commits)

    expect(lanesOf(commits)).toEqual({ x: 0, y: 1, z: 2, a: 0, w: 1, b: 0 })
    // The long-running lane never moved, which is the whole point.
    expect(rows.find((r) => r.commit.sha === 'z')!.lane).toBe(2)
    expect(graphWidth(rows)).toBe(3)
  })

  it('never lets two edges leave the same lane', () => {
    const commits = [
      c('m', 'a', 'b', 'c'),
      c('c', 'r'),
      c('b', 'r'),
      c('a', 'r'),
      c('r'),
    ]
    for (const row of assignLanes(commits)) {
      const from = row.edges.map((e) => e.fromLane)
      expect(new Set(from).size).toBe(from.length)
    }
  })

  it('reports a width that covers every lane the row touches', () => {
    const commits = [c('m', 'a', 'b'), c('b', 'r'), c('a', 'r'), c('r')]
    for (const row of assignLanes(commits)) {
      expect(row.lane).toBeLessThan(row.width)
      for (const edge of row.edges) {
        expect(edge.fromLane).toBeLessThan(row.width)
        expect(edge.toLane).toBeLessThan(row.width)
      }
    }
  })
})
