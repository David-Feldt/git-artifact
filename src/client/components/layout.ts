import type { GraphRow } from '../../graph/model.js'
import type { WorktreeStatus } from '../../api.js'

/** Must match `--row-height` / `--lane-width` in theme.css. */
export const ROW_HEIGHT = 44
export const LANE_WIDTH = 22
export const GUTTER_PAD = 14


/**
 * Height of the expanded commit panel.
 *
 * A constant, and scrolled internally, rather than sized to its content. The rails are an
 * SVG drawn from row geometry and the cards are HTML positioned from the same arithmetic;
 * a content-sized panel could only be known after the browser had laid it out, so the SVG
 * would have to be drawn a frame late and every rail below the panel would visibly snap
 * into place. Trading an exact fit for geometry both layers can compute up front is what
 * keeps them locked together.
 */
export const DETAIL_HEIGHT = 340

/** Hues cycle past eight. See the palette note in theme.css for why eight. */
export const LANE_COUNT = 8

export function laneColor(lane: number): string {
  return `var(--lane-${(lane % LANE_COUNT) + 1})`
}

export function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
}

export function gutterWidth(width: number): number {
  return GUTTER_PAD * 2 + Math.max(width, 1) * LANE_WIDTH
}

/**
 * A row on screen.
 *
 * Only `commit` rows come from `git log`. A `wip` row is spliced in, because uncommitted
 * work has no sha to sit at.
 */
export type DisplayRow =
  | { kind: 'commit'; row: GraphRow; index: number }
  | { kind: 'wip'; worktree: WorktreeStatus; lane: number; index: number }

/**
 * Height of one display row.
 *
 * Uniform now that session headers are gone, and kept as a function rather than inlined
 * because every layer reads its geometry through this — collapsing it to a constant at the
 * call sites is how the SVG and the HTML come to disagree the next time a row kind is added.
 */
export function rowHeight(_row: DisplayRow): number {
  return ROW_HEIGHT
}

/**
 * Cumulative top offset of every row, plus a final entry for the total height.
 *
 * This is the single source of vertical geometry, and everything — the SVG rails, the HTML
 * cards, the detail panel — reads from the same array. A row is not simply at
 * `index * ROW_HEIGHT`, because an open detail panel injects a gap beneath its row.
 * Computing that separately in each layer is how the two drift apart by a few pixels and it
 * reads as a rendering bug.
 *
 * Still O(n) and exact, so phase 7 virtualisation can slice this array rather than
 * measuring the DOM.
 */
export function rowOffsets(rows: DisplayRow[], expandedIndex: number | null = null): number[] {
  const offsets = new Array<number>(rows.length + 1)
  let top = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = top
    top += rowHeight(rows[i]!)
    // The panel occupies the gap opened directly under the row it belongs to.
    if (i === expandedIndex) top += DETAIL_HEIGHT
  }
  offsets[rows.length] = top
  return offsets
}

/** Top edge of a row. */
export function rowTop(offsets: number[], index: number): number {
  return offsets[index] ?? 0
}

/** Vertical centre of a row: where its node sits and its rails meet. */
export function rowCenter(rows: DisplayRow[], offsets: number[], index: number): number {
  const top = offsets[index] ?? 0
  const row = rows[index]
  return top + (row ? rowHeight(row) : ROW_HEIGHT) / 2
}

/** Top edge of the detail panel, which sits in the gap under its row. */
export function detailTop(rows: DisplayRow[], offsets: number[], expandedIndex: number): number {
  const row = rows[expandedIndex]
  return (offsets[expandedIndex] ?? 0) + (row ? rowHeight(row) : ROW_HEIGHT)
}

/** Total height of the row body, including any open panel. */
export function bodyHeight(offsets: number[]): number {
  return offsets[offsets.length - 1] ?? 0
}

/**
 * Interleave WIP pseudo-nodes into the commit rows.
 *
 * Uncommitted changes belong above their worktree's HEAD, because newer sits at the top.
 * Inserting a row shifts everything below it, but not the *lane* geometry: a spliced row
 * maps every live lane straight through at the same index, so edges crossing it stay
 * continuous and no existing edge needs rewriting.
 *
 * A worktree with a clean tree contributes nothing — an always-present empty WIP node
 * would be noise on every branch you are not currently working in.
 */
export function buildDisplayRows(
  rows: GraphRow[],
  worktrees: WorktreeStatus[],
): DisplayRow[] {
  const dirty = worktrees.filter((w) => w.files.length > 0)

  if (dirty.length === 0) {
    return rows.map((row, index) => ({ kind: 'commit', row, index }))
  }

  const byHead = new Map<string, WorktreeStatus[]>()
  const orphans: WorktreeStatus[] = []
  for (const worktree of dirty) {
    if (worktree.head === null) {
      // An unborn branch: there is no commit to sit above, so it goes at the very top.
      orphans.push(worktree)
      continue
    }
    const list = byHead.get(worktree.head)
    if (list) list.push(worktree)
    else byHead.set(worktree.head, [worktree])
  }

  // `index` is filled in at the end, once splicing has settled the final order.
  type Unplaced = DistributiveOmit<DisplayRow, 'index'>
  const out: Unplaced[] = []

  for (const worktree of orphans) out.push({ kind: 'wip', worktree, lane: 0 })

  const placed = new Set<WorktreeStatus>()
  rows.forEach((row) => {
    for (const worktree of byHead.get(row.commit.sha) ?? []) {
      out.push({ kind: 'wip', worktree, lane: row.lane })
      placed.add(worktree)
    }
    out.push({ kind: 'commit', row })
  })

  // A worktree whose HEAD fell outside the loaded window would otherwise vanish silently.
  for (const worktree of dirty) {
    if (worktree.head !== null && !placed.has(worktree)) {
      out.unshift({ kind: 'wip', worktree, lane: 0 })
    }
  }

  return out.map((row, index) => ({ ...row, index }))
}

/**
 * `Omit` collapses a discriminated union into one object type, which would let a `wip`
 * row be built with a `row` field. Distributing over the members keeps each variant's
 * fields exclusive.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never


/**
 * A contiguous run of rows, renumbered to stand alone.
 *
 * `index` is a row's position in the list it belongs to — the rails read `y(row.index)`
 * against an offsets array built from that same list. A raw `slice` keeps the original
 * numbers and every rail in the excerpt would be drawn against the wrong row, so the
 * renumbering here is what makes a scoped export possible at all.
 */
export function sliceRows(rows: DisplayRow[], first: number, last: number): DisplayRow[] {
  return rows.slice(first, last + 1).map((row, index) => ({ ...row, index }))
}
