import type { GraphRow } from '../../graph/model.js'
import type { WorktreeStatus } from '../../api.js'

/** Must match `--row-height` / `--lane-width` in theme.css. */
export const ROW_HEIGHT = 44
export const LANE_WIDTH = 22
export const GUTTER_PAD = 14

/** Hues cycle past eight. See the palette note in theme.css for why eight. */
export const LANE_COUNT = 8

export function laneColor(lane: number): string {
  return `var(--lane-${(lane % LANE_COUNT) + 1})`
}

export function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
}

/**
 * Height of the expanded commit panel.
 *
 * A constant, and scrolled internally, rather than sized to its content. The rails are an
 * SVG drawn from row indices and the cards are HTML positioned from the same arithmetic;
 * a content-sized panel could only be known after the browser had laid it out, so the SVG
 * would have to be drawn a frame late and every rail below the panel would visibly snap
 * into place. Trading an exact fit for geometry both layers can compute up front is what
 * keeps them locked together.
 */
export const DETAIL_HEIGHT = 340

/**
 * Top edge of a row, in pixels, accounting for an open detail panel above it.
 *
 * `expandedIndex` is the row whose panel is open, or null. Only one opens at a time, so
 * the shift is a single constant rather than a running sum.
 */
export function rowTop(index: number, expandedIndex: number | null = null): number {
  const shifted = expandedIndex !== null && index > expandedIndex
  return index * ROW_HEIGHT + (shifted ? DETAIL_HEIGHT : 0)
}

/** Vertical centre of a row: where its node sits and its rails meet. */
export function rowY(index: number, expandedIndex: number | null = null): number {
  return rowTop(index, expandedIndex) + ROW_HEIGHT / 2
}

/** Top edge of the panel itself, which occupies the gap opened under its row. */
export function detailTop(expandedIndex: number): number {
  return rowTop(expandedIndex) + ROW_HEIGHT
}

export function bodyHeight(rowCount: number, expandedIndex: number | null = null): number {
  return rowCount * ROW_HEIGHT + (expandedIndex === null ? 0 : DETAIL_HEIGHT)
}

export function gutterWidth(width: number): number {
  return GUTTER_PAD * 2 + Math.max(width, 1) * LANE_WIDTH
}

/**
 * A row on screen. Uncommitted work has no sha, so it cannot come from `git log`; it is
 * spliced in as its own kind of row directly above the commit its worktree is sitting on.
 */
export type DisplayRow =
  | { kind: 'commit'; row: GraphRow; index: number }
  | { kind: 'wip'; worktree: WorktreeStatus; lane: number; index: number }

/**
 * Interleave WIP pseudo-nodes into the commit rows.
 *
 * Uncommitted changes belong above their worktree's HEAD, because newer sits at the top.
 * Inserting a row shifts everything below it, but not the *lane* geometry: the spliced
 * row maps every live lane straight through at the same index, so edges crossing it stay
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
  for (const row of rows) {
    for (const worktree of byHead.get(row.commit.sha) ?? []) {
      out.push({ kind: 'wip', worktree, lane: row.lane })
      placed.add(worktree)
    }
    out.push({ kind: 'commit', row })
  }

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
