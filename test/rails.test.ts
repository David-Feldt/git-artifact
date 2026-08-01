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


describe('railPaths', () => {



  it('keys nodes uniquely across the whole graph', () => {
    const rows = display([c('c', 'b'), c('b', 'a'), c('a')])
    const keys = [...railPaths(rows, y), ...railNodes(rows, y)].map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
