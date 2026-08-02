/**
 * The startup banner: a small commit graph that draws itself.
 *
 * Two things make this cheap enough to justify. It runs *concurrently* with the real startup
 * work rather than before it, so on any repo that takes a moment to open the frames cover
 * latency that already existed instead of adding any. And it degrades to a single static
 * block the moment stdout is not an interactive terminal, so piping to a file or a CI log
 * yields plain text with no escape sequences in it.
 *
 * Nothing here is load-bearing: every failure mode is "print the static block".
 */
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * xterm-256 approximations of `src/client/theme.css`. 256-colour rather than truecolor
 * because Apple's Terminal.app still does not do the latter, and this is the one piece of
 * output guaranteed to be seen on a stock macOS install.
 */
const LANE_A = 32 // --lane-1  #2a78d6
const LANE_B = 166 // --lane-2  #c9501f
const WIP = 172 // --heat-4 / --artifact-ready  #c9761a
const INK = 252 // --ink
const MUTED = 245 // --ink-muted

const INDENT = '  '
/** Wide enough for the widest graph row (`├─╮`) plus a gutter before the text column. */
const GRAPH_COL = 6
/** Column the banner's text sits at, so the caller can line later output up with it. */
export const TEXT_COL = INDENT.length + GRAPH_COL
const FRAME_MS = 45
const PULSE_MS = 130
/** Past this the repo is just slow; freeze on the last frame rather than animate forever. */
const MAX_PULSE_FRAMES = 48

type Weight = 'dim' | 'normal' | 'bright'

interface Seg {
  text: string
  color?: number
  weight?: Weight
}

interface Row {
  graph: Seg[]
  text?: Seg[]
}

export interface BannerOptions {
  version: string
  repoRoot: string
  stream?: NodeJS.WriteStream
  /**
   * Set false to force the static block on a terminal that would otherwise animate. The dev
   * loop passes this: `scripts/dev.mjs` inherits the real TTY and restarts the daemon on
   * every rebuild, so animating would replay the whole thing on each keystroke-triggered
   * build.
   */
  animate?: boolean
}

/**
 * The art, newest commit first, exactly as `git log --graph` would order it: a merge whose
 * rails split downward into two parents, and a branch point where they converge again.
 *
 * `●` and `○` are East Asian Ambiguous width, so a terminal configured for CJK may render
 * them double-width and shift the two-lane rows by a column. The box-drawing glyphs are all
 * unambiguously narrow. Worst case is cosmetic, which is why it is not worth dropping to
 * ASCII over.
 */
function buildRows(version: string, repoRoot: string): Row[] {
  const a = (text: string): Seg => ({ text, color: LANE_A })
  const b = (text: string): Seg => ({ text, color: LANE_B })
  const gap: Seg = { text: ' ' }
  return [
    { graph: [{ text: '○', color: WIP }] },
    { graph: [a('│')] },
    {
      graph: [a('●')],
      text: [
        { text: 'git-artifact', color: INK, weight: 'bright' },
        { text: `  ${version}`, color: MUTED },
      ],
    },
    { graph: [a('├─'), b('╮')] },
    { graph: [a('●'), gap, b('│')], text: [{ text: repoRoot, color: MUTED }] },
    { graph: [a('│'), gap, b('●')] },
    { graph: [a('├─'), b('╯')] },
    { graph: [a('●')] },
  ]
}

/**
 * Keep the tail, which is the part that identifies the repo, and prefer to cut on a path
 * separator so the result does not read as a misspelling. Snapping is skipped when it would
 * cost more than half the available room, since a path is more useful than a tidy edge.
 */
export function truncatePath(path: string, max: number): string {
  if (max <= 1) return '…'
  if (path.length <= max) return path
  const tail = path.slice(-(max - 1))
  const boundary = tail.indexOf('/')
  const snapped = boundary > 0 ? tail.slice(boundary) : tail
  return `…${snapped.length * 2 >= tail.length ? snapped : tail}`
}

function style(seg: Seg, colour: boolean): string {
  if (!colour || seg.color === undefined) return seg.text
  const weight = seg.weight === 'bright' ? '\x1b[1m' : seg.weight === 'dim' ? '\x1b[2m' : ''
  return `${weight}\x1b[38;5;${seg.color}m${seg.text}\x1b[0m`
}

function plainWidth(segs: Seg[]): number {
  let width = 0
  for (const seg of segs) width += seg.text.length
  return width
}

interface FrameState {
  /** Index of the topmost revealed row; rows above it render as blank lines. */
  from: number
  /** Row drawn a shade brighter because it was revealed this frame; -1 for none. */
  leading: number
  text: 'hidden' | 'dim' | 'shown'
  wip: Weight
}

function paint(rows: Row[], state: FrameState, colour: boolean): string[] {
  return rows.map((row, i) => {
    if (i < state.from) return ''

    const graph = row.graph.map((seg) => {
      // The WIP node carries the pulse; every other glyph brightens only as it is revealed.
      const weight = seg.color === WIP ? state.wip : i === state.leading ? 'bright' : undefined
      return style({ ...seg, weight }, colour)
    })

    if (!row.text || state.text === 'hidden') return (INDENT + graph.join('')).trimEnd()

    const pad = ' '.repeat(Math.max(1, GRAPH_COL - plainWidth(row.graph)))
    const text = row.text.map((seg) =>
      style(state.text === 'dim' ? { ...seg, color: MUTED, weight: 'dim' } : seg, colour),
    )
    return (INDENT + graph.join('') + pad + text.join('')).trimEnd()
  })
}

/** The banner with no escape sequences, for non-interactive stdout and for tests. */
export function bannerLines(opts: BannerOptions, columns = 80): string[] {
  const room = Math.max(8, columns - INDENT.length - GRAPH_COL - 1)
  const rows = buildRows(opts.version, truncatePath(opts.repoRoot, room))
  return paint(rows, { from: 0, leading: -1, text: 'shown', wip: 'normal' }, false)
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

/**
 * Draw the banner while `work` runs, then return whatever `work` returned.
 *
 * The animation never outlives the work: once `work` settles the pulse stops on the next
 * frame. If `work` rejects, the banner is torn down cleanly and the rejection propagates.
 */
export async function withBanner<T>(work: Promise<T>, opts: BannerOptions): Promise<T> {
  const stream = opts.stream ?? process.stdout

  // Attaching handlers here — rather than awaiting — lets the animation observe completion
  // without swallowing the result. Both branches are handled, so this never becomes an
  // unhandled rejection; the caller still sees the original promise below.
  let settled = false
  void work.then(
    () => (settled = true),
    () => (settled = true),
  )

  if (opts.animate === false || !isInteractive(stream)) {
    stream.write(`\n${bannerLines(opts, stream.columns ?? 80).join('\n')}\n`)
    return work
  }

  const room = Math.max(8, (stream.columns ?? 80) - INDENT.length - GRAPH_COL - 1)
  const rows = buildRows(opts.version, truncatePath(opts.repoRoot, room))

  const restore = () => stream.write('\x1b[?25h')
  const onSigint = () => {
    restore()
    process.exit(130)
  }

  let painted = false
  const draw = (state: FrameState) => {
    if (painted) stream.write(`\x1b[${rows.length}A`)
    stream.write('\x1b[0J')
    for (const line of paint(rows, state, true)) stream.write(`${line}\n`)
    painted = true
  }

  stream.write('\n')
  stream.write('\x1b[?25l')
  process.once('SIGINT', onSigint)

  try {
    // Rails grow upward, one row per frame, oldest commit first.
    for (let f = 0; f < rows.length; f++) {
      draw({ from: rows.length - 1 - f, leading: rows.length - 1 - f, text: 'hidden', wip: 'dim' })
      await sleep(FRAME_MS)
    }
    // Then the wordmark resolves out of the muted colour.
    for (const text of ['dim', 'shown'] as const) {
      draw({ from: 0, leading: -1, text, wip: 'normal' })
      await sleep(FRAME_MS)
    }
    // And the WIP node breathes for as long as startup is still going.
    const pulse: Weight[] = ['normal', 'bright', 'normal', 'dim']
    for (let f = 0; f < MAX_PULSE_FRAMES && !settled; f++) {
      draw({ from: 0, leading: -1, text: 'shown', wip: pulse[f % pulse.length]! })
      await sleep(PULSE_MS)
    }
    draw({ from: 0, leading: -1, text: 'shown', wip: 'normal' })
  } finally {
    process.off('SIGINT', onSigint)
    restore()
  }

  return work
}
