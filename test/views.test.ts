import { describe, expect, it } from 'vitest'
import { assignLanes } from '../src/graph/lanes.js'
import type { Commit } from '../src/graph/model.js'
import type { GraphPayload, SessionBandInfo, WorktreeLane, WorktreeStatus } from '../src/api.js'
import { ALL_VIEW, buildViews, selectView, type ScopedSession } from '../src/client/views.js'

/**
 * Views are a *filter*, never a partition. Every assertion here is ultimately about that
 * one property: shared history appears in every tab that can reach it, and nothing is
 * assigned to a single owner. The tests that matter most are the ones about what happens
 * to a session band when the graph underneath it is cut — bands index into rows, so a
 * filter invalidates every one of them at once.
 */

function c(sha: string, subject: string, ...parents: string[]): Commit {
  return {
    sha,
    parents,
    authorName: 'A',
    authorEmail: 'a@example.com',
    authorDate: 1_700_000_000,
    commitDate: 1_700_000_000,
    subject,
    refs: [],
  }
}

function worktree(over: Partial<WorktreeLane> & { path: string }): WorktreeLane {
  return {
    name: over.path.split('/').pop()!,
    branch: null,
    head: null,
    detached: false,
    isMain: false,
    lane: null,
    ...over,
  }
}

function payload(commits: Commit[], lanes: WorktreeLane[], sessions: SessionBandInfo[] = []) {
  const rows = assignLanes(commits)
  return {
    repo: {
      root: '/repo',
      name: 'repo',
      state: {} as GraphPayload['repo']['state'],
      currentBranch: 'main',
      head: commits[0]?.sha ?? null,
      worktrees: [],
      remotes: [],
    },
    rows,
    pushes: {},
    worktreeLanes: lanes,
    sessions,
    width: 1,
    capped: false,
    maxCount: 5000,
    generatedAt: 0,
  } satisfies GraphPayload
}

function session(over: Partial<SessionBandInfo> = {}): SessionBandInfo {
  return {
    sessionId: 's1',
    title: 'Build the thing',
    startRow: 0,
    endRow: 1,
    commitCount: 2,
    promptCount: 4,
    inputTokens: 1000,
    outputTokens: 100,
    model: 'claude',
    startedAt: 0,
    endedAt: 1,
    branches: ['main'],
    ...over,
  }
}

/*
 *   feat   main
 *     \     |
 *      f1   m1
 *       \   /
 *         base
 *          |
 *         root
 */
const DIVERGED = [
  c('f1', 'on feat', 'base'),
  c('m1', 'on main', 'base'),
  c('base', 'shared', 'root'),
  c('root', 'first'),
]

const LANES = [
  worktree({ path: '/repo', branch: 'main', head: 'm1', isMain: true }),
  worktree({ path: '/repo/wt', branch: 'feat', head: 'f1' }),
]

describe('buildViews', () => {
  it('leaves a single-worktree repo with one unscoped view', () => {
    const graph = payload(DIVERGED, [LANES[0]!])
    const views = buildViews(graph, [])

    // A tab bar reading "All / main" is furniture; ViewTabs hides itself on this length.
    expect(views).toHaveLength(1)
    expect(views[0]!.key).toBe(ALL_VIEW)
    expect(views[0]!.graph).toBe(graph)
  })

  it('gives every worktree a tab alongside the unified graph', () => {
    const views = buildViews(payload(DIVERGED, LANES), [])

    expect(views.map((v) => v.key)).toEqual([ALL_VIEW, '/repo', '/repo/wt'])
    // Labelled by directory, not by the branch checked out there. `/repo/wt` holds
    // `feat`, and labelling it `feat` is what made a worktree unfindable on screen.
    expect(views.map((v) => v.label)).toEqual(['All', 'repo', 'wt'])
  })

  it('labels a detached worktree by name, since it has no branch to borrow', () => {
    /*
     * The case the old scheme could not express at all: every detached worktree rendered
     * the literal string "detached", so two of them were indistinguishable.
     */
    const lanes = [
      LANES[0]!,
      worktree({ path: '/repo/one', head: 'base', detached: true }),
      worktree({ path: '/repo/two', head: 'root', detached: true }),
    ]
    const views = buildViews(payload(DIVERGED, lanes), [])

    expect(views.map((v) => v.label)).toEqual(['All', 'repo', 'one', 'two'])
  })

  it('draws shared history in every tab that can reach it', () => {
    /*
     * The property the old `api.ts` comment said was impossible, and the reason it is not:
     * these are separate renders, so `base` and `root` are simply drawn twice rather than
     * having to be assigned to one worktree or the other.
     */
    const [, main, feat] = buildViews(payload(DIVERGED, LANES), [])

    expect(main!.graph.rows.map((r) => r.commit.sha)).toEqual(['m1', 'base', 'root'])
    expect(feat!.graph.rows.map((r) => r.commit.sha)).toEqual(['f1', 'base', 'root'])
  })

  it('re-lanes each tab from zero rather than inheriting the unified columns', () => {
    const all = payload(DIVERGED, LANES)
    const [, , feat] = buildViews(all, [])

    // `f1` sits in a second lane in the unified graph, because `m1` holds lane 0 there.
    expect(all.rows.find((r) => r.commit.sha === 'f1')!.lane).toBe(0)
    expect(all.rows.find((r) => r.commit.sha === 'm1')!.lane).toBe(1)
    // Alone in its own view it is the only thing on screen, so it takes lane 0 and the
    // graph is one column wide. Carrying lane 1 across would leave an empty gutter.
    expect(feat!.graph.rows.every((r) => r.lane === 0)).toBe(true)
    expect(feat!.graph.width).toBe(1)
  })

  it('re-derives the tip lane so the tab swatch matches its own rails', () => {
    const [, , feat] = buildViews(payload(DIVERGED, LANES), [])
    expect(feat!.graph.worktreeLanes).toHaveLength(1)
    expect(feat!.graph.worktreeLanes[0]!.lane).toBe(0)
  })

  it('scopes worktree statuses so a tab only grows its own WIP node', () => {
    const statuses = [
      { path: '/repo', files: [{}] } as unknown as WorktreeStatus,
      { path: '/repo/wt', files: [{}] } as unknown as WorktreeStatus,
    ]
    const [all, main] = buildViews(payload(DIVERGED, LANES), statuses)

    expect(all!.statuses).toHaveLength(2)
    expect(main!.statuses.map((s) => s.path)).toEqual(['/repo'])
  })

  it('renders an empty tab rather than throwing when a tip is outside the window', () => {
    const lanes = [LANES[0]!, worktree({ path: '/repo/gone', branch: 'old', head: 'nope' })]
    const [, , gone] = buildViews(payload(DIVERGED, lanes), [])

    expect(gone!.graph.rows).toEqual([])
    expect(gone!.graph.worktreeLanes[0]!.lane).toBeNull()
  })
})

describe('session bands under scoping', () => {
  it('re-indexes a band into the filtered rows', () => {
    // Covers rows 1-2 of the unified graph: `m1` and `base`.
    const band = session({ startRow: 1, endRow: 2, commitCount: 2 })
    const [, main] = buildViews(payload(DIVERGED, LANES, [band]), [])

    // Both survive in main's view, but they sit at rows 0-1 there, not 1-2. A band left
    // pointing at the old indices would draw its header over the wrong commit.
    expect(main!.graph.sessions[0]!.startRow).toBe(0)
    expect(main!.graph.sessions[0]!.endRow).toBe(1)
    expect(main!.graph.sessions[0]!.commitCount).toBe(2)
  })

  it('reports the commits a scoped band lost to another worktree', () => {
    /*
     * The case that made "worktree tabs" a product decision rather than a refactor: a real
     * session in this repo spanned the main checkout and `.claude/worktrees/infra`, so
     * scoping necessarily cuts it. Carrying the remainder is what stops the same band
     * reporting two different counts in two tabs with no explanation.
     */
    const band = session({ startRow: 0, endRow: 2, commitCount: 3, branches: ['main', 'feat'] })
    const [all, main, feat] = buildViews(payload(DIVERGED, LANES, [band]), [])

    // The unified view is the payload itself, so its bands carry no `elsewhere` at all —
    // absent means "not scoped", which is exactly what the header needs to stay silent.
    expect(all!.graph.sessions[0]!.commitCount).toBe(3)
    expect(all!.graph.sessions[0]).not.toHaveProperty('elsewhere')

    // main sees m1 + base, not f1.
    expect(main!.graph.sessions[0]!.commitCount).toBe(2)
    expect((main!.graph.sessions[0] as ScopedSession).elsewhere).toBe(1)

    // feat sees f1 + base, not m1.
    expect(feat!.graph.sessions[0]!.commitCount).toBe(2)
    expect((feat!.graph.sessions[0] as ScopedSession).elsewhere).toBe(1)
  })

  it('drops a band entirely when none of its commits survive', () => {
    // `f1` alone, which main cannot reach. Clamping instead of dropping would leave a
    // header floating above commits that belong to nobody.
    const band = session({ startRow: 0, endRow: 0, commitCount: 1 })
    const [, main] = buildViews(payload(DIVERGED, LANES, [band]), [])

    expect(main!.graph.sessions).toEqual([])
  })

  it('keeps bands ordered and non-overlapping after scoping', () => {
    const graph = payload(DIVERGED, LANES, [
      session({ sessionId: 'a', startRow: 0, endRow: 1, commitCount: 2 }),
      session({ sessionId: 'b', startRow: 2, endRow: 3, commitCount: 2 }),
    ])
    const [, main] = buildViews(graph, [])
    const bands = main!.graph.sessions

    // `buildDisplayRows` keys headers off `startRow` and assumes the guarantee the wire
    // type makes, so a filter that broke the ordering would misplace headers silently.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.startRow).toBeGreaterThan(bands[i - 1]!.endRow)
    }
  })
})

describe('selectView', () => {
  it('falls back to the unified view when the active worktree disappears', () => {
    const views = buildViews(payload(DIVERGED, LANES), [])
    // Deleting the worktree you are looking at should drop you to "All", not to a blank
    // graph — the payload arrives without it on the very next SSE frame.
    expect(selectView(views, '/repo/removed').key).toBe(ALL_VIEW)
    expect(selectView(views, '/repo/wt').key).toBe('/repo/wt')
  })
})
