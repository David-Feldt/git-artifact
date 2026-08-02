/**
 * Renders `GraphRow[]` as terminal glyphs, for the startup banner.
 *
 * Pure, like `lanes.ts`: no git, no I/O, no clock. It consumes the same rows the browser
 * draws as SVG, so the banner and the dashboard cannot disagree about the shape of history —
 * lane assignment happened once, upstream of both.
 *
 * One line per commit, with a connector line inserted only where lanes actually move. That
 * is `git log --graph`'s own convention, and it is what makes eight lines of banner worth
 * eight commits on the linear history most repositories have near HEAD.
 */
import type { Commit, GraphRow } from './model.js'

const NODE = '●'
const RAIL = '│'
const BLANK = ' '

/** One character column. `lane` is -1 for blanks, so the caller knows what not to colour. */
export interface AsciiCell {
  glyph: string
  lane: number
}

export interface AsciiLine {
  cells: AsciiCell[]
  /** The commit this line is the node for, or null on a connector line. */
  commit: Commit | null
}

export interface AsciiOptions {
  /** Hard cap on emitted lines. Connector lines count against it, like any other. */
  maxLines: number
}

/** Lanes are two columns apart, as in git's own output: `● │` puts lane 1 at column 2. */
function col(lane: number): number {
  return lane * 2
}

function blank(width: number): AsciiCell[] {
  return Array.from({ length: Math.max(0, width) }, () => ({ glyph: BLANK, lane: -1 }))
}

function put(cells: AsciiCell[], column: number, glyph: string, lane: number): void {
  if (column < 0 || column >= cells.length) return
  cells[column] = { glyph, lane }
}

function nodeLine(row: GraphRow): AsciiLine {
  const lanes = Math.max(row.width, row.lane + 1)
  const cells = blank(lanes * 2 - 1)
  // `incoming` is exactly the set of pass-through rails, already excluding anything that
  // converges into this commit — so it needs no filtering beyond the commit's own lane.
  for (const lane of row.incoming) {
    if (lane !== row.lane) put(cells, col(lane), RAIL, lane)
  }
  put(cells, col(row.lane), NODE, row.lane)
  return { cells, commit: row.commit }
}

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

/**
 * Which glyph joins a given set of directions. Anything not listed — a single direction, or
 * nothing — falls back to a rail or a blank, so an unexpected combination degrades to a
 * plausible line rather than an empty column.
 */
const GLYPHS = new Map<number, string>([
  [UP | DOWN, '│'],
  [LEFT | RIGHT, '─'],
  [DOWN | RIGHT, '╭'],
  [DOWN | LEFT, '╮'],
  [UP | RIGHT, '╰'],
  [UP | LEFT, '╯'],
  [UP | DOWN | RIGHT, '├'],
  [UP | DOWN | LEFT, '┤'],
  [DOWN | LEFT | RIGHT, '┬'],
  [UP | LEFT | RIGHT, '┴'],
  [UP | DOWN | LEFT | RIGHT, '┼'],
])

function glyphFor(mask: number): string {
  const exact = GLYPHS.get(mask)
  if (exact) return exact
  if (mask & (UP | DOWN)) return RAIL
  if (mask & (LEFT | RIGHT)) return '─'
  return BLANK
}

/**
 * The line between a row and the next.
 *
 * Built by accumulating directions per column rather than by case analysis, because the
 * cases multiply badly: a lane can be simultaneously the end of one branch, the middle of a
 * longer run crossing it, and a rail continuing straight down. Summing directions and
 * looking up the join gets an octopus's `├─┴─┴─╯` right for free.
 *
 * The subtlety worth naming: a merge's later parent gets `fromLane` set to the lane it
 * *lands in*, not the lane the merge commit sits in, so those edges look straight. The
 * connector from the node outward has to be derived from `kind === 'merge'` instead.
 */
function connectorLine(row: GraphRow): AsciiLine | null {
  const converging = row.edges.filter((e) => e.fromLane !== e.toLane)
  const diverging = row.edges.filter((e) => e.kind === 'merge' && e.fromLane !== row.lane)
  if (converging.length === 0 && diverging.length === 0) return null

  let lanes = Math.max(row.width, row.lane + 1)
  for (const e of row.edges) lanes = Math.max(lanes, e.fromLane + 1, e.toLane + 1)

  const width = lanes * 2 - 1
  const mask = new Array<number>(width).fill(0)
  const owner = new Array<number>(width).fill(-1)

  const mark = (column: number, bits: number, lane: number) => {
    if (column < 0 || column >= width) return
    mask[column]! |= bits
    // First writer owns the colour; endpoints are marked before the runs that cross them.
    if (owner[column] === -1) owner[column] = lane
  }

  /** A horizontal run between two lanes, marking both ends and everything between. */
  const run = (from: number, to: number, lane: number) => {
    if (from === to) return
    const toward = to > from ? RIGHT : LEFT
    mark(col(from), toward, lane)
    mark(col(to), to > from ? LEFT : RIGHT, lane)
    const lo = Math.min(col(from), col(to))
    const hi = Math.max(col(from), col(to))
    for (let c = lo + 1; c < hi; c++) mark(c, LEFT | RIGHT, lane)
  }

  const onNodeLine = new Set<number>([...row.incoming, row.lane])

  for (const e of row.edges) {
    if (e.fromLane === e.toLane) {
      // A rail only comes from above if something actually occupied that lane on the node
      // line; a lane a merge just opened starts here and must not sprout an upward stem.
      mark(col(e.fromLane), DOWN | (onNodeLine.has(e.fromLane) ? UP : 0), e.fromLane)
      continue
    }
    mark(col(e.fromLane), UP, e.fromLane)
    mark(col(e.toLane), DOWN, e.toLane)
    run(e.fromLane, e.toLane, e.fromLane)
  }

  for (const e of diverging) {
    mark(col(row.lane), UP, row.lane)
    run(row.lane, e.fromLane, e.fromLane)
  }

  const cells = mask.map((bits, i) => ({ glyph: glyphFor(bits), lane: bits === 0 ? -1 : owner[i]! }))
  return { cells, commit: null }
}

export function asciiGraph(rows: GraphRow[], opts: AsciiOptions): AsciiLine[] {
  const lines: AsciiLine[] = []
  for (const row of rows) {
    if (lines.length >= opts.maxLines) break
    lines.push(nodeLine(row))
    if (lines.length >= opts.maxLines) break
    const connector = connectorLine(row)
    if (connector) lines.push(connector)
  }
  return lines
}

/** Widest line in lane columns, i.e. how much horizontal room the render needs. */
export function asciiWidth(lines: AsciiLine[]): number {
  let width = 0
  for (const line of lines) width = Math.max(width, line.cells.length)
  return width
}

export function asciiText(lines: AsciiLine[]): string[] {
  return lines.map((line) =>
    line.cells
      .map((c) => c.glyph)
      .join('')
      .trimEnd(),
  )
}
