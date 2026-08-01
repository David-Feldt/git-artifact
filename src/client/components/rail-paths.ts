import type { DisplayRow } from './layout.js'
import { LANE_WIDTH, ROW_HEIGHT, laneX } from './layout.js'

/**
 * Rail geometry, as data.
 *
 * Split out of `Rails.tsx` because there are two renderers for the same graph: the live
 * SVG layer, which maps these to `<path>` elements with `var(--lane-n)` strokes, and the
 * exporter, which maps them to markup with literal hex. Computing the geometry twice would
 * guarantee the exported graph eventually stops matching the one on screen.
 *
 * Being free of React also makes the geometry directly testable, which it was not before —
 * `lanes.ts` is covered by the oracle suite, but nothing asserted the paths actually drawn.
 */

/** One rail stroke. `lane` selects the colour; the caller resolves it. */
export interface RailPath {
  key: string
  d: string
  lane: number
  /** A dashed stub: a WIP tail, or a commit whose parents fell outside the window. */
  truncated: boolean
}

export type NodeKind = 'commit' | 'merge' | 'root' | 'wip'

export interface RailNode {
  key: string
  lane: number
  y: number
  kind: NodeKind
}

/** Vertical centre of a row, by index. Supplied by the caller from `rowOffsets`. */
export type CenterOf = (index: number) => number

export function railPaths(rows: DisplayRow[], y: CenterOf): RailPath[] {
  return rows.flatMap((row, index) => rowPaths(row, rows[index + 1], y))
}

export function railNodes(rows: DisplayRow[], y: CenterOf): RailNode[] {
  const nodes: RailNode[] = []
  for (const row of rows) {
    const node = rowNode(row, y)
    if (node) nodes.push(node)
  }
  return nodes
}

function rowPaths(row: DisplayRow, next: DisplayRow | undefined, y: CenterOf): RailPath[] {
  const y1 = y(row.index)
  const y2 = y(row.index + 1)

  /*
   * A session header carries no graph geometry of its own. Every live lane runs straight
   * through it, exactly as it does past a WIP node — the header is an annotation sitting
   * beside the graph, not a node in it.
   */
  if (row.kind === 'session') {
    const lanes = new Set<number>()
    if (next?.kind === 'commit') {
      lanes.add(next.row.lane)
      for (const edge of next.row.edges) lanes.add(edge.fromLane)
      for (const lane of next.row.incoming) lanes.add(lane)
    }
    return [...lanes].map((lane) => ({
      key: `${row.index}:s${lane}`,
      d: straight(laneX(lane), y1, y2),
      lane,
      truncated: false,
    }))
  }

  // A WIP row has no commit edges of its own. Every lane alive around it passes straight
  // through, and its own lane runs down into the commit it is sitting on.
  if (row.kind === 'wip') {
    const lanes = new Set<number>([row.lane])
    if (next?.kind === 'commit') for (const edge of next.row.edges) lanes.add(edge.fromLane)
    return [...lanes].map((lane) => ({
      key: `${row.index}:w${lane}`,
      d: straight(laneX(lane), y1, y2),
      lane,
      truncated: lane === row.lane,
    }))
  }

  const paths: RailPath[] = []

  for (const edge of row.row.edges) {
    /*
     * One edge can need two lines drawn.
     *
     * A lane that was already carrying a rail keeps running straight down — that is the
     * rail's continuity, and breaking it makes an unrelated branch look like it ended.
     * Separately, an edge belonging to *this* commit has to physically leave this commit's
     * node, or a merge appears unconnected to the branch it absorbed.
     *
     * Usually only one applies. Both apply when a merge's second parent happens to live in
     * a lane that is already busy, and drawing only one of them is what produced a broken
     * rail on real history.
     */
    const origins = new Set<number>()
    if (row.row.incoming.includes(edge.fromLane)) origins.add(edge.fromLane)
    if (edge.kind !== 'pass') origins.add(row.row.lane)
    if (origins.size === 0) origins.add(edge.fromLane)

    const x2 = laneX(edge.toLane)
    for (const originLane of origins) {
      paths.push({
        key: `${row.index}:${originLane}-${edge.fromLane}-${edge.toLane}-${edge.parentSha}`,
        d: edgePath(laneX(originLane), y1, x2, y2),
        lane: edge.kind === 'merge' ? edge.toLane : edge.fromLane,
        truncated: false,
      })
    }
  }

  // A commit whose parents were cut off by the history cap: a short frayed stub, so a
  // boundary is visibly different from a root commit.
  if (row.row.truncated) {
    paths.push({
      key: `${row.index}:truncated`,
      d: straight(laneX(row.row.lane), y1, y1 + ROW_HEIGHT * 0.45),
      lane: row.row.lane,
      truncated: true,
    })
  }

  return paths
}

function rowNode(row: DisplayRow, y: CenterOf): RailNode | null {
  // A session header has no node — nothing on the graph happened at that row.
  if (row.kind === 'session') return null

  if (row.kind === 'wip') {
    return { key: `n${row.index}`, lane: row.lane, y: y(row.index), kind: 'wip' }
  }

  const { commit, lane } = row.row
  const kind: NodeKind =
    commit.parents.length > 1 ? 'merge' : commit.parents.length === 0 ? 'root' : 'commit'
  return { key: `n${row.index}`, lane, y: y(row.index), kind }
}

function straight(x: number, y1: number, y2: number): string {
  return `M ${x} ${y1} L ${x} ${y2}`
}

/**
 * A vertical line, or an S-curve when the lane changes.
 *
 * The control points sit on the vertical through each endpoint, so the curve leaves and
 * arrives travelling straight down — branches merge into a rail tangentially instead of
 * meeting it at a corner. The horizontal clamp keeps a jump across many lanes from bulging
 * into its neighbours, and also stops a curve crossing an open detail panel from bowing
 * halfway across the gutter.
 */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return straight(x1, y1, y2)
  const bend = Math.min((y2 - y1) * 0.5, LANE_WIDTH * 1.6)
  return `M ${x1} ${y1} C ${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`
}
