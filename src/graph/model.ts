/** Shared types for the commit graph. Kept dependency-free so both the daemon and the
 *  client can import them, and so `lanes.ts` stays a pure, testable function. */

/** A decoration on a commit, parsed out of `%D`. */
export interface RefDecoration {
  /** Full ref name as git reported it, e.g. `origin/main`, `HEAD -> main`, `v1.2.0`. */
  raw: string
  /** Display name with any `HEAD -> ` prefix and `tag: ` marker stripped. */
  name: string
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'other'
  /** True when this is the ref HEAD currently points at (`HEAD -> main`). */
  isHead: boolean
}

export interface Commit {
  sha: string
  /** Parent shas in git's order. `parents[0]` is the first parent. Empty for roots. */
  parents: string[]
  authorName: string
  authorEmail: string
  /** Author time, unix seconds. */
  authorDate: number
  /** Committer time, unix seconds. Used for reflog/session correlation, not display. */
  commitDate: number
  subject: string
  refs: RefDecoration[]
}

/**
 * An edge leaving a row, drawn downward toward the parent's row.
 *
 * `fromLane` is the lane the edge departs from on this row; `toLane` is the lane it
 * occupies from the next row onward. When they differ the renderer draws a curve.
 */
export interface GraphEdge {
  fromLane: number
  toLane: number
  /** Sha of the parent this edge is heading toward. */
  parentSha: string
  /**
   * `first` — first-parent edge, the mainline continuation.
   * `merge` — a second-or-later parent of a merge commit.
   * `pass`  — an unrelated lane passing straight through this row.
   */
  kind: 'first' | 'merge' | 'pass'
}

export interface GraphRow {
  commit: Commit
  /** Lane (column) this commit's node is drawn in. */
  lane: number
  /** Edges leaving this row toward the next. Includes pass-through lanes. */
  edges: GraphEdge[]
  /**
   * Lanes already carrying a rail as this row is entered, excluding any that converge
   * into this commit.
   *
   * The renderer needs this to tell two situations apart that produce identical edges. A
   * merge's second parent may land in a brand-new lane, in which case the only line to
   * draw runs from the merge node outward — or it may land in a lane that is already busy
   * carrying an unrelated rail, in which case that rail must keep running straight down
   * *and* a connector is drawn from the node. Without this field the second case loses
   * either the rail or the connector.
   */
  incoming: number[]
  /**
   * Total lane slots in use across this row, i.e. the row's width. The maximum over all
   * rows gives the graph's overall width.
   */
  width: number
  /**
   * True when this commit's parent is not present in the loaded set — because history was
   * capped, or because the clone is shallow. The renderer draws a frayed edge.
   */
  truncated: boolean
}

export type GraphRows = GraphRow[]
