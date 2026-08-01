import type { GraphRow } from '../../graph/model.js'
import type { SessionBandInfo, WorktreeStatus } from '../../api.js'

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

/** Height of one display row. Session headers are shorter; everything else is a full row. */
export function rowHeight(row: DisplayRow): number {
  return row.kind === 'session' ? SESSION_HEADER_HEIGHT : ROW_HEIGHT
}

/**
 * Cumulative top offset of every row, plus a final entry for the total height.
 *
 * Rows used to be a uniform height, so a position was just `index * ROW_HEIGHT`. Session
 * headers broke that. Computing the offsets once and passing them down keeps the SVG rails
 * and the HTML cards reading from a single source — the failure mode otherwise is the two
 * layers drifting apart by a few pixels per header, which looks like a rendering bug
 * rather than a layout one.
 *
 * Still O(n) and still exact, so phase 7 virtualisation can slice this array rather than
 * re-measuring the DOM.
 */
export function rowOffsets(rows: DisplayRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1)
  let top = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = top
    top += rowHeight(rows[i]!)
  }
  offsets[rows.length] = top
  return offsets
}

/** Vertical centre of a row, for placing a node or an edge endpoint. */
export function rowCenter(rows: DisplayRow[], offsets: number[], index: number): number {
  const top = offsets[index] ?? 0
  const row = rows[index]
  return top + (row ? rowHeight(row) : ROW_HEIGHT) / 2
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
  | { kind: 'session'; session: SessionBandInfo; index: number }

/**
 * Height of a session header row. Shorter than a commit row — it is a label, not an
 * entry, and giving it full height would make sessions look like graph nodes.
 */
export const SESSION_HEADER_HEIGHT = 30

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
  sessions: SessionBandInfo[] = [],
): DisplayRow[] {
  const dirty = worktrees.filter((w) => w.files.length > 0)

  // Session headers are keyed by the *graph* row they precede, which is why this is built
  // from `startRow` before any splicing happens — once WIP rows are interleaved the
  // display indices no longer line up with the graph indices the server sent.
  const headerBefore = new Map<number, SessionBandInfo[]>()
  for (const session of sessions) {
    const list = headerBefore.get(session.startRow)
    if (list) list.push(session)
    else headerBefore.set(session.startRow, [session])
  }

  if (dirty.length === 0 && sessions.length === 0) {
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
  rows.forEach((row, graphIndex) => {
    // The session header goes above its band's first commit, but *below* any WIP node for
    // that commit — uncommitted work is newer than the session that produced the commit
    // beneath it, and the header would otherwise separate a WIP node from its own tip.
    for (const worktree of byHead.get(row.commit.sha) ?? []) {
      out.push({ kind: 'wip', worktree, lane: row.lane })
      placed.add(worktree)
    }
    for (const session of headerBefore.get(graphIndex) ?? []) {
      out.push({ kind: 'session', session })
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
