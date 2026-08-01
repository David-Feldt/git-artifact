import type { GraphPayload, SessionBandInfo, WorktreeLane, WorktreeStatus } from '../api.js'
import type { GraphRow } from '../graph/model.js'
import { assignLanes, graphWidth } from '../graph/lanes.js'

/**
 * Per-worktree views over one graph payload.
 *
 * `api.ts` used to argue that the graph cannot be partitioned by worktree, and that was
 * correct about what it was describing: within a *single* render, a commit reachable from
 * three checkouts cannot be given three lanes, so lane groups had to be abandoned in
 * favour of annotating tips. Tabs escape that because they are separate renders — shared
 * history is simply drawn again in each one, which costs nothing but pixels. The old
 * objection was about duplication inside one layout, not about duplication across views.
 *
 * So a view is a *filter*, never a partition: every tab holds the full ancestry of its
 * worktree's HEAD, and a commit both worktrees can reach appears in both. Nothing here
 * asks git anything — a view is derived from the payload already on the client, so
 * switching tabs costs no round trip and cannot disagree with the graph it came from.
 */

/** A session band as it appears in one view. */
export interface ScopedSession extends SessionBandInfo {
  /**
   * Commits this band holds that fall outside the current view, 0 when it is whole.
   *
   * A session roams across worktrees — `docs/design/session-bands.md` treats that as a
   * defining property rather than an edge case — so scoping the graph necessarily cuts
   * some bands in half. Carrying the remainder lets the header say so instead of quietly
   * reporting a smaller number than the same band shows one tab over.
   */
  elsewhere: number
}

export interface GraphView {
  /** Stable identity for tab state. `ALL_VIEW` or the worktree's path. */
  key: string
  label: string
  /** The worktree this view is scoped to, or null for the unified view. */
  worktree: WorktreeLane | null
  /** Filtered, re-laned payload. Interchangeable with the server's for every consumer. */
  graph: GraphPayload
  /** Worktree statuses in scope, so a tab only grows the WIP node it owns. */
  statuses: WorktreeStatus[]
}

export const ALL_VIEW = 'all'

/**
 * Build the unified view plus one per worktree.
 *
 * Returns a single unscoped view when there is only one checkout: a tab bar reading
 * "All / main" is furniture, and the strip it replaces hid itself on the same rule.
 */
export function buildViews(
  graph: GraphPayload,
  statuses: WorktreeStatus[],
): GraphView[] {
  /*
   * The unified view is the payload itself, not a copy of it. Its bands therefore carry no
   * `elsewhere` field, which is the correct signal rather than an omission: absent means
   * "nothing was scoped away", and a band that was never cut has no remainder to report.
   */
  const all: GraphView = {
    key: ALL_VIEW,
    label: 'All',
    worktree: null,
    graph,
    statuses,
  }
  if (graph.worktreeLanes.length < 2) return [all]

  const grafted = graftBoundary(graph.rows)
  const views = graph.worktreeLanes.map((worktree): GraphView => {
    const keep = worktree.head === null ? new Set<string>() : ancestry(graph.rows, worktree.head)
    return {
      key: worktree.path,
      label: worktree.detached ? 'detached' : (worktree.branch ?? worktree.name),
      worktree,
      graph: scope(graph, keep, worktree, grafted),
      statuses: statuses.filter((s) => s.path === worktree.path),
    }
  })

  return [all, ...views]
}

/** The view matching `key`, falling back to the unified one when a worktree disappears. */
export function selectView(views: GraphView[], key: string): GraphView {
  return views.find((v) => v.key === key) ?? views[0]!
}

/**
 * Every commit reachable from `head` that is also in the loaded window.
 *
 * Walks the payload's own parent links rather than asking git, so it inherits the window's
 * boundary for free: a parent past the `--max-count` cap is simply absent, which is the
 * same condition `assignLanes` already treats as truncation.
 */
function ancestry(rows: GraphRow[], head: string): Set<string> {
  const byId = new Map(rows.map((row) => [row.commit.sha, row.commit]))
  const seen = new Set<string>()
  const stack = [head]

  while (stack.length > 0) {
    const sha = stack.pop()!
    if (seen.has(sha)) continue
    const commit = byId.get(sha)
    if (commit === undefined) continue
    seen.add(sha)
    for (const parent of commit.parents) stack.push(parent)
  }

  return seen
}

/**
 * Commits sitting on a shallow clone's graft boundary, recovered from the server's rows.
 *
 * `assignLanes` needs this set to tell a true root from a point where history merely
 * stops, and it is not on the wire. It does not need to be: git hides a grafted commit's
 * parents, so "no parents yet still flagged truncated" identifies exactly the commits the
 * server passed in. Reconstructing beats widening `RepoInfo` for a client-only concern.
 */
function graftBoundary(rows: GraphRow[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const row of rows) {
    if (row.truncated && row.commit.parents.length === 0) out.add(row.commit.sha)
  }
  return out
}

function scope(
  graph: GraphPayload,
  keep: Set<string>,
  worktree: WorktreeLane,
  grafted: ReadonlySet<string>,
): GraphPayload {
  const kept = graph.rows.filter((row) => keep.has(row.commit.sha))
  // Re-laned from scratch, not sliced. Lanes are positions in a layout, so carrying the
  // unified view's indices across would leave a tab with a lane 5 and nothing in 1–4.
  const rows = assignLanes(kept.map((row) => row.commit), { grafted })

  const position = new Map<string, number>()
  rows.forEach((row, index) => position.set(row.commit.sha, index))

  // The tip moves column when the graph is re-laned, so the chip's swatch is re-derived
  // rather than carried over — otherwise it would key to a lane from the unified view.
  const at = worktree.head === null ? undefined : position.get(worktree.head)
  const lane = at === undefined ? null : rows[at]!.lane

  return {
    ...graph,
    rows,
    sessions: rescope(graph, keep, position),
    worktreeLanes: [{ ...worktree, lane }],
    width: graphWidth(rows),
  }
}

/**
 * Re-index session bands into the scoped row list.
 *
 * Bands index into `GraphPayload.rows`, so a filter invalidates every one of them. A band
 * whose commits all fell outside the view is dropped rather than clamped — an empty band
 * would draw a header over somebody else's commits.
 */
function rescope(
  graph: GraphPayload,
  keep: Set<string>,
  position: Map<string, number>,
): ScopedSession[] {
  const out: ScopedSession[] = []

  for (const session of graph.sessions) {
    const indices: number[] = []
    for (let i = session.startRow; i <= session.endRow; i++) {
      const sha = graph.rows[i]?.commit.sha
      if (sha !== undefined && keep.has(sha)) indices.push(position.get(sha)!)
    }
    if (indices.length === 0) continue

    out.push({
      ...session,
      startRow: indices[0]!,
      endRow: indices[indices.length - 1]!,
      commitCount: indices.length,
      elsewhere: session.commitCount - indices.length,
    })
  }

  return out
}
