/**
 * The startup banner: a commit graph that draws itself, then becomes yours.
 *
 * While the daemon starts there is nothing to show, so a decorative graph animates in its
 * place. The moment startup finishes the block morphs into the repository's actual history,
 * rendered from the same `GraphRow[]` the browser draws as SVG — so the terminal and the
 * dashboard cannot disagree about the shape of history.
 *
 * It runs *concurrently* with startup rather than ahead of it, so on any repo that takes a
 * moment to open the frames cover latency that already existed instead of adding any.
 *
 * Nothing here is load-bearing. Every failure — no commits, a bare repo, a graph too wide
 * for the terminal, a snapshot that throws — falls back to the decorative art or to a static
 * block, and the daemon starts regardless.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { asciiGraph, asciiWidth, type AsciiLine } from './graph/ascii.js'
import type { GraphRow } from './graph/model.js'

/**
 * xterm-256 approximations of `src/client/theme.css`. 256-colour rather than truecolor
 * because Apple's Terminal.app still does not do the latter, and this is the one piece of
 * output guaranteed to be seen on a stock macOS install.
 */
const LANE_COLORS = [32, 166, 29, 61, 136, 168, 28, 167] // --lane-1 … --lane-8
const WIP = 172 // --heat-4 / --artifact-ready  #c9761a
const INK = 252 // --ink
const MUTED = 245 // --ink-muted

const INDENT = '  '
/** Every frame is this tall, so the cursor arithmetic holds across the morph. */
const BLOCK_LINES = 9
/** Gap between the widest graph glyph and the text column. */
const GUTTER = 2
const FRAME_MS = 45
const PULSE_MS = 130
/** Past this the repo is just slow; freeze on the last frame rather than animate forever. */
const MAX_PULSE_FRAMES = 48
/** Wider than this and the graph is not worth showing in a banner; use the decorative art. */
const MAX_GRAPH_LANES = 5

type Weight = 'dim' | 'normal' | 'bright'

interface Seg {
  text: string
  color?: number
  weight?: Weight
}

type Line = Seg[]

/** What the banner needs from the daemon, gathered once startup has finished. */
export interface RepoSnapshot {
  rows: GraphRow[]
  /** Files with uncommitted changes; 0 draws no working-tree node. */
  dirtyFiles: number
}

export interface BannerOptions {
  version: string
  repoRoot: string
  stream?: NodeJS.WriteStream
  /**
   * Called once `work` resolves, to swap the decorative graph for the real one. Returning
   * null — or throwing — keeps the decorative art, which is why this is allowed to be a
   * best-effort read rather than a checked one.
   */
  snapshot?: () => RepoSnapshot | null
  /**
   * Set false to force a static block on a terminal that would otherwise animate. The dev
   * loop passes this: `scripts/dev.mjs` inherits the real TTY and restarts the daemon on
   * every rebuild, so animating would replay the whole thing on each build.
   */
  animate?: boolean
}

function laneColor(lane: number): number {
  return LANE_COLORS[Math.abs(lane) % LANE_COLORS.length]!
}

/** Keep the tail, which is the part that identifies the repo, and prefer to cut on a
 *  separator so the result does not read as a misspelling. Snapping is skipped when it would
 *  cost more than half the available room, since a path is more useful than a tidy edge. */
export function truncatePath(path: string, max: number): string {
  if (max <= 1) return '…'
  if (path.length <= max) return path
  const tail = path.slice(-(max - 1))
  const boundary = tail.indexOf('/')
  const snapped = boundary > 0 ? tail.slice(boundary) : tail
  return `…${snapped.length * 2 >= tail.length ? snapped : tail}`
}

function truncateEnd(text: string, max: number): string {
  if (max <= 1) return text.length <= max ? text : '…'
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function style(seg: Seg, colour: boolean): string {
  if (!colour || seg.color === undefined) return seg.text
  const weight = seg.weight === 'bright' ? '\x1b[1m' : seg.weight === 'dim' ? '\x1b[2m' : ''
  return `${weight}\x1b[38;5;${seg.color}m${seg.text}\x1b[0m`
}

function renderLine(line: Line, colour: boolean): string {
  if (line.length === 0) return ''
  return (INDENT + line.map((seg) => style(seg, colour)).join('')).trimEnd()
}

function plainWidth(line: Line): number {
  let width = 0
  for (const seg of line) width += seg.text.length
  return width
}

function pad(line: Line, to: number): Line {
  const gap = to - plainWidth(line)
  return gap > 0 ? [...line, { text: ' '.repeat(gap) }] : line
}

/** Exactly `BLOCK_LINES` long, so every frame overwrites the last one cleanly. */
function fit(lines: Line[]): Line[] {
  const out = lines.slice(0, BLOCK_LINES)
  while (out.length < BLOCK_LINES) out.push([])
  return out
}

/*
 * The decorative graph, shown while there is nothing real to show. Its shape is a merge
 * whose rails split into two parents and a branch point where they converge — the same
 * vocabulary the real renderer uses, so the morph reads as a change of content rather than
 * a change of language.
 *
 * `●` and `○` are East Asian Ambiguous width, so a terminal configured for CJK may render
 * them double-width and shift the two-lane rows by a column. The box-drawing glyphs are all
 * unambiguously narrow. Worst case is cosmetic.
 */
const DECORATIVE: ReadonlyArray<ReadonlyArray<[string, number]>> = [
  [['○', WIP]],
  [['│', LANE_COLORS[0]!]],
  [['●', LANE_COLORS[0]!]],
  [
    ['├─', LANE_COLORS[0]!],
    ['╮', LANE_COLORS[1]!],
  ],
  [
    ['● ', LANE_COLORS[0]!],
    ['│', LANE_COLORS[1]!],
  ],
  [
    ['│ ', LANE_COLORS[0]!],
    ['●', LANE_COLORS[1]!],
  ],
  [
    ['● ', LANE_COLORS[0]!],
    ['│', LANE_COLORS[1]!],
  ],
  [
    ['├─', LANE_COLORS[0]!],
    ['╯', LANE_COLORS[1]!],
  ],
  [['●', LANE_COLORS[0]!]],
]

interface DecorState {
  /** Topmost revealed row; rows above render blank. */
  from: number
  /** Row drawn a shade brighter because it was revealed this frame; -1 for none. */
  leading: number
  wip: Weight
}

function decorativeFrame(state: DecorState): Line[] {
  return fit(
    DECORATIVE.map((row, i) => {
      if (i < state.from) return []
      return row.map(([text, color]) => ({
        text,
        color,
        weight: color === WIP ? state.wip : i === state.leading ? 'bright' : undefined,
      }))
    }),
  )
}

/** Branch and tag names worth showing on a row. Remotes are dropped as noise. */
function refLabels(row: GraphRow): string[] {
  return row.commit.refs
    .filter((r) => r.kind === 'branch' || r.kind === 'tag')
    .map((r) => r.name)
    .slice(0, 2)
}

function graphCells(line: AsciiLine, width: number, weight: Weight | undefined): Line {
  const segs: Line = line.cells.map((cell) => ({
    text: cell.glyph,
    color: cell.lane >= 0 ? laneColor(cell.lane) : undefined,
    weight,
  }))
  return pad(segs, width)
}

/**
 * The real repository, or null when there is nothing worth drawing — an empty repo, or a
 * graph wider than a banner should try to represent.
 */
function repoFrame(snap: RepoSnapshot, columns: number, weight?: Weight): Line[] | null {
  if (snap.rows.length === 0) return null

  const headLane = snap.rows[0]!.lane
  const wip = snap.dirtyFiles > 0
  const budget = BLOCK_LINES - (wip ? 2 : 0)
  const graph = asciiGraph(snap.rows, { maxLines: budget })
  if (graph.length === 0) return null

  const glyphWidth = Math.max(asciiWidth(graph), wip ? headLane * 2 + 1 : 0)
  if (glyphWidth > MAX_GRAPH_LANES * 2 - 1) return null

  const textCol = INDENT.length + glyphWidth + GUTTER
  const room = columns - textCol - 1
  if (room < 12) return null

  const lines: Line[] = []

  if (wip) {
    const stem = (glyph: string): Line =>
      pad(
        [
          { text: ' '.repeat(headLane * 2) },
          { text: glyph, color: WIP, weight: weight ?? 'normal' },
        ],
        glyphWidth,
      )
    const count = `${snap.dirtyFiles} file${snap.dirtyFiles === 1 ? '' : 's'} changed`
    lines.push([...stem('○'), { text: ' '.repeat(GUTTER) }, { text: count, color: WIP, weight }])
    lines.push(stem('│'))
  }

  for (const line of graph) {
    const cells = graphCells(line, glyphWidth, weight)
    if (!line.commit) {
      lines.push(cells)
      continue
    }

    const label: Line = [{ text: ' '.repeat(GUTTER) }]
    let used = 0
    const sha = line.commit.sha.slice(0, 7)
    label.push({ text: sha, color: MUTED, weight })
    used += sha.length

    const row = snap.rows.find((r) => r.commit.sha === line.commit!.sha)
    for (const ref of row ? refLabels(row) : []) {
      if (used + ref.length + 2 > room) break
      label.push({ text: '  ' }, { text: ref, color: laneColor(row!.lane), weight: weight ?? 'bright' })
      used += ref.length + 2
    }

    const subject = truncateEnd(line.commit.subject, Math.max(0, room - used - 2))
    if (subject.length > 0) {
      label.push({ text: '  ' }, { text: subject, color: INK, weight })
    }
    lines.push([...cells, ...label])
  }

  return fit(lines)
}

function isInteractive(stream: NodeJS.WriteStream): boolean {
  return (
    stream.isTTY === true &&
    !process.env.NO_COLOR &&
    !process.env.CI &&
    process.env.TERM !== 'dumb' &&
    // Narrower than this and the block wraps, which would break the cursor arithmetic.
    (stream.columns ?? 0) >= 32
  )
}

function headerLine(opts: BannerOptions, columns: number): string {
  const prefix = `git-artifact ${opts.version}`
  const room = columns - INDENT.length - prefix.length - 4
  const path = truncatePath(opts.repoRoot, Math.max(8, room))
  return renderLine(
    [
      { text: prefix, color: INK, weight: 'bright' },
      { text: '  ·  ', color: MUTED },
      { text: path, color: MUTED },
    ],
    false,
  )
}

/** The banner with no escape sequences, for non-interactive stdout and for tests. */
export function bannerLines(opts: BannerOptions, columns = 80): string[] {
  const snap = readSnapshot(opts)
  const block = (snap && repoFrame(snap, columns)) ?? decorativeFrame({ from: 0, leading: -1, wip: 'normal' })
  return [headerLine(opts, columns), ...block.map((line) => renderLine(line, false))]
}

/** Tier B by nature: a snapshot that throws must cost the decorative art, not the daemon. */
function readSnapshot(opts: BannerOptions): RepoSnapshot | null {
  try {
    return opts.snapshot?.() ?? null
  } catch {
    return null
  }
}

/**
 * Draw the banner while `work` runs, then return whatever `work` returned.
 *
 * The animation never outlives the work: once `work` settles the block morphs to the real
 * graph and stops. If `work` rejects, the banner is torn down cleanly and the rejection
 * propagates.
 */
export async function withBanner<T>(work: Promise<T>, opts: BannerOptions): Promise<T> {
  const stream = opts.stream ?? process.stdout
  const columns = stream.columns ?? 80

  if (opts.animate === false || !isInteractive(stream)) {
    const result = await work
    stream.write(`\n${bannerLines(opts, columns).join('\n')}\n`)
    return result
  }

  // Attaching handlers here — rather than awaiting — lets the animation observe completion
  // without swallowing the result. Both branches are handled, so this never becomes an
  // unhandled rejection; the caller still sees the original promise below.
  let settled = false
  void work.then(
    () => (settled = true),
    () => (settled = true),
  )

  const restore = () => stream.write('\x1b[?25h')
  const onSigint = () => {
    restore()
    process.exit(130)
  }

  let painted = false
  const draw = (lines: Line[]) => {
    if (painted) stream.write(`\x1b[${BLOCK_LINES}A`)
    stream.write('\x1b[0J')
    for (const line of fit(lines)) stream.write(`${renderLine(line, true)}\n`)
    painted = true
  }

  stream.write(`\n${headerLine(opts, columns)}\n`)
  stream.write('\x1b[?25l')
  process.once('SIGINT', onSigint)

  try {
    // Rails grow upward, one row per frame, oldest commit first.
    for (let f = 0; f < BLOCK_LINES; f++) {
      const at = BLOCK_LINES - 1 - f
      draw(decorativeFrame({ from: at, leading: at, wip: 'dim' }))
      await sleep(FRAME_MS)
    }
    // Then the working-tree node breathes for as long as startup is still going.
    const pulse: Weight[] = ['normal', 'bright', 'normal', 'dim']
    for (let f = 0; f < MAX_PULSE_FRAMES && !settled; f++) {
      draw(decorativeFrame({ from: 0, leading: -1, wip: pulse[f % pulse.length]! }))
      await sleep(PULSE_MS)
    }

    // And once there is something real to show, it replaces the placeholder.
    if (settled) {
      const snap = readSnapshot(opts)
      const real = snap && repoFrame(snap, columns, 'dim')
      if (real && snap) {
        draw(real)
        await sleep(FRAME_MS * 2)
        draw(repoFrame(snap, columns) ?? real)
      } else {
        draw(decorativeFrame({ from: 0, leading: -1, wip: 'normal' }))
      }
    } else {
      draw(decorativeFrame({ from: 0, leading: -1, wip: 'normal' }))
    }
  } finally {
    process.off('SIGINT', onSigint)
    restore()
  }

  return work
}
