import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { assignLanes } from '../src/graph/lanes.js'
import { readLog } from '../src/git/log.js'
import { builders, cleanupAll, GRAPH_FIXTURES } from './fixtures/make.js'

/**
 * `git log --graph` as a correctness oracle.
 *
 * git already solved lane assignment and ships on every machine that will run this, so we
 * get a reference implementation to diff against for free.
 *
 * Three properties, at three strengths, chosen to match how much we actually intend to
 * agree with git:
 *
 * - **Commit order** — exact, everywhere. This is the property that matters most, because
 *   it validates our topo-order handling, and a mismatch means the graph is simply wrong.
 * - **Lane index** — exact on the fixtures. None of them exercise column compaction, so
 *   agreement is achievable and makes a sharp regression guard.
 * - **Width** — never worse than git. On real history we intentionally diverge from git's
 *   compaction (see the stability test in `lanes.test.ts`), so lane indices are allowed to
 *   differ; what must not happen is the graph getting wider than git's.
 */

const SHA = /[0-9a-f]{40}/

/**
 * Extract `(sha, lane)` from `git log --graph --pretty=format:%H`.
 *
 * The naive read — take `indexOf('*')` and slice after it — silently drops rows, because
 * a commit line can look like `* | <sha>` or `*---.   <sha>` where the text after the
 * first `*` is more graph, not the sha. Anchoring on the sha instead and measuring the
 * graph prefix in front of it handles every shape git emits. Two characters per column.
 */
function parseGitGraph(output: string): Array<{ sha: string; lane: number; width: number }> {
  const rows: Array<{ sha: string; lane: number; width: number }> = []

  for (const line of output.split('\n')) {
    const match = SHA.exec(line)
    if (!match) continue // a pure link row such as `|\` or `|/`

    const prefix = line.slice(0, match.index)
    const star = prefix.indexOf('*')
    if (star === -1) continue // sha appeared without a node marker; not a commit row

    rows.push({ sha: match[0], lane: star / 2, width: Math.ceil(prefix.length / 2) })
  }

  return rows
}

function gitGraph(dir: string): string {
  return execFileSync(
    'git',
    ['--no-pager', 'log', '--graph', '--all', '--topo-order', '--pretty=format:%H', '--no-color'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
  )
}

describe('lane assignment vs `git log --graph`', () => {
  afterAll(cleanupAll)

  for (const name of GRAPH_FIXTURES) {
    it(`matches git on the ${name} fixture`, async () => {
      const dir = builders[name]!()
      const expected = parseGitGraph(gitGraph(dir))
      const rows = assignLanes(await readLog(dir))

      expect(rows.length).toBeGreaterThan(0)
      expect(rows.map((r) => ({ sha: r.commit.sha, lane: r.lane }))).toEqual(
        expected.map(({ sha, lane }) => ({ sha, lane })),
      )
    })
  }

  it('matches git on order and stays no wider, on real messy history', async () => {
    // The synthetic octopus is one clean merge; this repo has 316 commits of real history
    // with concurrent branches and repeated merges. Skipped rather than failed when
    // absent, so the suite still passes on another machine.
    const dir = `${process.env.HOME}/3E8-Robotics/3e8-ros2`
    let expected: ReturnType<typeof parseGitGraph>
    try {
      expected = parseGitGraph(gitGraph(dir))
    } catch {
      return
    }

    const rows = assignLanes(await readLog(dir))

    expect(rows.map((r) => r.commit.sha)).toEqual(expected.map((e) => e.sha))
    expect(Math.max(...rows.map((r) => r.width))).toBeLessThanOrEqual(
      Math.max(...expected.map((e) => e.width)),
    )
  })
})

describe('graph invariants', () => {
  afterAll(cleanupAll)

  for (const name of GRAPH_FIXTURES) {
    it(`holds on the ${name} fixture`, async () => {
      const commits = await readLog(builders[name]!())
      const rows = assignLanes(commits)
      const known = new Set(commits.map((c) => c.sha))
      const rowBySha = new Map(rows.map((r, i) => [r.commit.sha, i]))

      for (const [index, row] of rows.entries()) {
        // Every in-set parent must be reachable by following this row's edges downward.
        const inSetParents = row.commit.parents.filter((p) => known.has(p))
        const departing = new Set(
          row.edges.filter((e) => e.kind !== 'pass').map((e) => e.parentSha),
        )
        expect([...departing].sort()).toEqual([...new Set(inSetParents)].sort())

        // A parent always sits below its child, which is what topo order guarantees and
        // what the renderer relies on to draw edges downward only.
        for (const parent of inSetParents) {
          expect(rowBySha.get(parent)!).toBeGreaterThan(index)
        }

        // Lanes are columns: no two edges may leave the same one.
        const fromLanes = row.edges.map((e) => e.fromLane)
        expect(new Set(fromLanes).size).toBe(fromLanes.length)

        expect(row.lane).toBeLessThan(row.width)
        expect(row.truncated).toBe(inSetParents.length !== row.commit.parents.length)
      }

      // Truncation should only appear where history genuinely ends: a root commit, or the
      // boundary of a shallow clone / capped read.
      const truncatedRows = rows.filter((r) => r.truncated)
      for (const row of truncatedRows) expect(row.commit.parents.length).toBeGreaterThan(0)
    })
  }
})
