import type { GraphPayload, SessionBandInfo } from '../../api.js'
import type { DisplayRow } from '../components/layout.js'
import {
  ROW_HEIGHT,
  gutterWidth,
  laneX,
  rowCenter,
  rowHeight,
  rowOffsets,
  rowTop,
} from '../components/layout.js'
import { railNodes, railPaths } from '../components/rail-paths.js'
import { basename, formatTokens, heatBucket, relativeTime } from '../format.js'
import {
  CARD,
  INK,
  INK_MUTED,
  INK_SECONDARY,
  PAPER,
  RULE,
  RULE_STRONG,
  heatHex,
  laneHex,
  mix,
} from './palette.js'

/**
 * Render the graph as a standalone SVG.
 *
 * Not a screenshot of the dashboard. The live view is tuned for glancing at a second
 * monitor while you work — it updates, it has hover targets and focus rings, and it assumes
 * you know what you were just doing. This file is read later, by someone who was not there.
 * So it shares geometry (`layout.ts`, `rail-paths.ts`) and palette with the dashboard, and
 * shares no components with it: the text layer on screen is HTML, which a standalone SVG
 * cannot contain.
 *
 * Deliberately free of DOM access, so it runs under test with a stub measurer. The only
 * thing it needs from a browser is text measurement, which arrives as `options.measure`.
 * See docs/design/export.md.
 */

export interface Font {
  readonly family: 'ui' | 'mono'
  readonly size: number
  readonly weight: number
}

/** Width of `text` in CSS pixels when set in `font`. */
export type Measure = (text: string, font: Font) => number

export interface ExportInput {
  graph: GraphPayload
  rows: DisplayRow[]
  /** Epoch millis the export was taken, for the relative timestamps. */
  now: number
}

export interface ExportOptions {
  measure: Measure
  /** Width of the text column beside the rails. */
  cardWidth?: number
}

/*
 * Concrete font stacks, not the stylesheet's.
 *
 * `--font-ui` leads with `ui-sans-serif`, which no standalone rasteriser resolves. Naming
 * real families first means a converter has something to find before it falls back to its
 * own default. Substitution still happens, so nothing here is positioned by fitting text to
 * a box: everything is anchored at one end, and truncation leaves a margin of error.
 */
export const UI_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"
export const MONO_STACK = "'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace"

const FONT = {
  sha: { family: 'mono', size: 11, weight: 400 },
  subject: { family: 'ui', size: 13, weight: 400 },
  meta: { family: 'ui', size: 11.5, weight: 400 },
  ref: { family: 'mono', size: 10.5, weight: 400 },
  refHead: { family: 'mono', size: 10.5, weight: 700 },
  push: { family: 'ui', size: 10.5, weight: 400 },
  sessionTitle: { family: 'ui', size: 13, weight: 620 },
  sessionMeta: { family: 'mono', size: 10, weight: 400 },
  smallChip: { family: 'ui', size: 10, weight: 400 },
  wipLabel: { family: 'ui', size: 11.5, weight: 600 },
  file: { family: 'mono', size: 10.5, weight: 400 },
  headerName: { family: 'ui', size: 15, weight: 600 },
  headerMeta: { family: 'ui', size: 11.5, weight: 400 },
  footer: { family: 'ui', size: 10.5, weight: 400 },
} satisfies Record<string, Font>

const DEFAULT_CARD_WIDTH = 820
const HEADER_HEIGHT = 48
const FOOTER_HEIGHT = 34
/** Right margin holding the session extent rails, mirroring `.sband`. */
const BAND_MARGIN = 16
const CARD_INSET = 4
const PAD = 10
const GAP = 8
/** Below this there is no room for a legible ref name, so the chip is dropped entirely. */
const MIN_REF_WIDTH = 34
/** Shortest run of session-header rule worth drawing, reserved before the meta is fitted. */
const MIN_RULE = 40
/**
 * Slack on chip text, absorbing the gap between the font measured and the font drawn.
 *
 * Measurement happens against the browser's resolved font; a standalone rasteriser without
 * that family substitutes another, and the substitute is usually wider. Six per cent covers
 * the monospace substitutions seen in practice (librsvg falling back to DejaVu Sans Mono
 * runs about nine per cent over a stub estimate, and well under that over a real one). The
 * cost when measurement is exact is a slightly roomier chip, which is the cheap direction to
 * be wrong in — the expensive one is a branch name printed over a commit subject.
 */
const CHIP_SLACK = 1.06
/** How many file chips a WIP row shows before the rest collapse into a count. */
const VISIBLE_FILES = 5

export function renderGraphSvg(input: ExportInput, options: ExportOptions): string {
  const { graph, rows, now } = input
  const measure = options.measure
  const cardWidth = options.cardWidth ?? DEFAULT_CARD_WIDTH

  const gutter = gutterWidth(graph.width)
  const width = gutter + cardWidth + BAND_MARGIN
  // No expanded panel: a detail panel is an interaction, and there is nothing to interact
  // with in a file.
  const offsets = rowOffsets(rows, null)
  const bodyHeight = offsets[offsets.length - 1] ?? 0
  const height = HEADER_HEIGHT + bodyHeight + FOOTER_HEIGHT

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" ` +
      `viewBox="0 0 ${round(width)} ${round(height)}" font-family="${escapeXml(UI_STACK)}">`,
  )
  out.push(`<title>${escapeXml(graph.repo.name)} — commit graph</title>`)
  const commitCount = `${graph.rows.length} commit${graph.rows.length === 1 ? '' : 's'}`
  out.push(
    `<desc>${escapeXml(
      `${commitCount}, exported from git-artifact ${new Date(graph.generatedAt).toISOString()}`,
    )}</desc>`,
  )
  out.push(`<rect width="${round(width)}" height="${round(height)}" fill="${PAPER}"/>`)

  out.push(...renderHeader(graph, width, measure))

  out.push(`<g transform="translate(0 ${HEADER_HEIGHT})">`)
  out.push(...renderBands(graph, rows, offsets, width))
  out.push(...renderRails(rows, offsets))
  for (const row of rows) {
    out.push(...renderRow(row, { graph, rows, offsets, gutter, cardWidth, now, measure }))
  }
  out.push('</g>')

  out.push(...renderFooter(graph, width, height, measure))
  out.push('</svg>')

  return out.join('\n')
}

interface RowContext {
  graph: GraphPayload
  rows: DisplayRow[]
  offsets: number[]
  gutter: number
  cardWidth: number
  now: number
  measure: Measure
}

function renderHeader(graph: GraphPayload, width: number, measure: Measure): string[] {
  const out: string[] = []
  const baseline = 28
  let x = 16

  out.push(text(x, baseline, graph.repo.name, FONT.headerName, INK))
  x += measure(graph.repo.name, FONT.headerName) + GAP + 2

  const branch = graph.repo.currentBranch ?? (graph.repo.state.detachedHead ? 'detached HEAD' : null)
  if (branch) {
    const chip = chipAt(x, baseline - 9, branch, FONT.sessionMeta, measure, {
      fill: mix(INK_MUTED, CARD, 0.1),
      stroke: RULE_STRONG,
      ink: INK_SECONDARY,
    })
    out.push(chip.svg)
    x += chip.width + GAP
  }

  const count = `${graph.rows.length} commit${graph.rows.length === 1 ? '' : 's'}`
  out.push(text(x, baseline, count, FONT.headerMeta, INK_MUTED))

  // Right-anchored, so a substituted font cannot push it off the edge.
  const stamp = `as of ${new Date(graph.generatedAt).toLocaleString()}`
  out.push(text(width - 16, baseline, stamp, FONT.headerMeta, INK_MUTED, 'end'))

  out.push(line(0, HEADER_HEIGHT - 1, width, HEADER_HEIGHT - 1, RULE))
  return out
}

function renderFooter(graph: GraphPayload, width: number, height: number, measure: Measure): string[] {
  const top = height - FOOTER_HEIGHT
  const baseline = top + 21
  const out: string[] = [line(0, top, width, top, RULE)]

  out.push(text(16, baseline, 'git-artifact · static snapshot', FONT.footer, INK_MUTED))

  /*
   * The qualifier has to survive into the file.
   *
   * On screen, "observed alongside" sits next to a band the reader can hover for the full
   * wording. An exported artifact is read with none of that context and is the version most
   * likely to be forwarded, so the claim it makes about attribution has to be legible on
   * its face — nothing records that a session *caused* a commit.
   */
  if (graph.sessions.length > 0) {
    const note = 'Session bands are observed alongside these commits, not authored by them.'
    out.push(text(width - 16, baseline, note, FONT.footer, INK_MUTED, 'end'))
  } else if (graph.capped) {
    const note = `History capped at ${graph.maxCount} commits.`
    out.push(text(width - 16, baseline, note, FONT.footer, INK_MUTED, 'end'))
  }
  void measure
  return out
}

/** Session extent rails in the right margin, mirroring `.sband`. */
function renderBands(
  graph: GraphPayload,
  rows: DisplayRow[],
  offsets: number[],
  width: number,
): string[] {
  const out: string[] = []
  for (const session of graph.sessions) {
    const span = bandSpan(graph, rows, session)
    if (!span) continue
    const top = rowTop(offsets, span.first)
    const bottom = rowTop(offsets, span.last) + rowHeight(rows[span.last]!)
    out.push(
      `<rect x="${round(width - 10)}" y="${round(top)}" width="3" height="${round(bottom - top)}" ` +
        `rx="1.5" fill="${RULE_STRONG}"/>`,
    )
  }
  return out
}

/**
 * Display-row range a band covers.
 *
 * `SessionBandInfo` indexes into `graph.rows`, but WIP nodes and headers are spliced into
 * the display list, so the two index spaces diverge the moment anything is interleaved.
 * Resolving through the sha is what keeps the rail aligned with the rows it describes.
 */
function bandSpan(
  graph: GraphPayload,
  rows: DisplayRow[],
  session: SessionBandInfo,
): { first: number; last: number } | null {
  const first = rows.findIndex(
    (r) => r.kind === 'session' && r.session.sessionId === session.sessionId,
  )
  const endSha = graph.rows[session.endRow]?.commit.sha
  const last = rows.findIndex((r) => r.kind === 'commit' && r.row.commit.sha === endSha)
  if (first === -1 || last === -1) return null
  return { first, last }
}

function renderRails(rows: DisplayRow[], offsets: number[]): string[] {
  const y = (index: number) => rowCenter(rows, offsets, index)
  const out: string[] = []

  for (const path of railPaths(rows, y)) {
    const dash = path.truncated ? ' stroke-dasharray="2 3" opacity="0.55"' : ''
    out.push(
      `<path d="${path.d}" fill="none" stroke="${laneHex(path.lane)}" stroke-width="2" ` +
        `stroke-linecap="round"${dash}/>`,
    )
  }

  for (const node of railNodes(rows, y)) {
    const x = laneX(node.lane)
    const color = laneHex(node.lane)
    if (node.kind === 'wip') {
      out.push(
        `<circle cx="${round(x)}" cy="${round(node.y)}" r="4" fill="${PAPER}" stroke="${color}" ` +
          `stroke-width="2.5" stroke-dasharray="2 2"/>`,
      )
    } else if (node.kind === 'merge') {
      out.push(
        `<circle cx="${round(x)}" cy="${round(node.y)}" r="5.5" fill="${color}" stroke="${PAPER}" stroke-width="2"/>`,
      )
      out.push(`<circle cx="${round(x)}" cy="${round(node.y)}" r="2" fill="${PAPER}"/>`)
    } else if (node.kind === 'root') {
      out.push(
        `<circle cx="${round(x)}" cy="${round(node.y)}" r="4.5" fill="${PAPER}" stroke="${color}" stroke-width="2.5"/>`,
      )
    } else {
      out.push(
        `<circle cx="${round(x)}" cy="${round(node.y)}" r="4.5" fill="${color}" stroke="${PAPER}" stroke-width="2.5"/>`,
      )
    }
  }

  return out
}

function renderRow(row: DisplayRow, ctx: RowContext): string[] {
  switch (row.kind) {
    case 'commit':
      return renderCommitRow(row, ctx)
    case 'wip':
      return renderWipRow(row, ctx)
    case 'session':
      return renderSessionRow(row, ctx)
  }
}

function renderCommitRow(
  row: Extract<DisplayRow, { kind: 'commit' }>,
  ctx: RowContext,
): string[] {
  const { measure, gutter, cardWidth, now, graph } = ctx
  const { commit, lane } = row.row
  const top = rowTop(ctx.offsets, row.index)
  const mid = top + ROW_HEIGHT / 2
  const left = gutter + CARD_INSET
  const right = left + cardWidth - CARD_INSET * 2

  const out: string[] = [card(left, top, right - left, commit.refs.some((r) => r.isHead))]

  // Right group first: it is anchored to the right edge and decides how much room the
  // subject has left.
  const when = relativeTime(commit.authorDate * 1000, now)
  const whenWidth = measure(when, FONT.meta)
  out.push(text(right - PAD, mid, when, FONT.meta, INK_MUTED, 'end'))

  const authorRight = right - PAD - whenWidth - GAP
  const author = fit(commit.authorName, 120, FONT.meta, measure)
  out.push(text(authorRight, mid, author.text, FONT.meta, INK_SECONDARY, 'end'))

  let x = left + PAD
  const sha = commit.sha.slice(0, 7)
  out.push(text(x, mid, sha, FONT.sha, INK_MUTED))
  x += measure(sha, FONT.sha) + GAP

  const pushes = graph.pushes[commit.sha]
  if (pushes && pushes.length > 0) {
    const newest = [...pushes].sort((a, b) => b.at - a.at)[0]!
    const label = `↑ pushed ${relativeTime(newest.at, now)}`
    const chip = chipAt(x, mid - 8, label, FONT.push, measure, {
      fill: mix(INK_MUTED, CARD, 0.1),
      stroke: mix(INK_MUTED, PAPER, 0.22),
      ink: INK_SECONDARY,
    })
    out.push(chip.svg)
    x += chip.width + GAP
  }

  /*
   * Refs get a hard budget rather than whatever they ask for.
   *
   * On screen the flex row absorbs a long branch name by squeezing the subject. Here every
   * position is computed up front, so an unbudgeted ref chip runs straight through the
   * subject beside it — and because a rasteriser may substitute a wider font than the one
   * measured, "it fitted when I measured it" is not sufficient. Truncating inside a fixed
   * budget degrades to a shortened name instead of overlapping text.
   */
  const refBudget = x + (right - left) * 0.4
  for (const ref of commit.refs) {
    const room = refBudget - x
    if (room < MIN_REF_WIDTH) break
    const font = ref.isHead ? FONT.refHead : FONT.ref
    const raw = ref.kind === 'tag' ? `⌗ ${ref.name}` : ref.name
    const label = fit(raw, room - 12, font, measure).text
    if (!label) break
    const chip = chipAt(x, mid - 8, label, font, measure, {
      fill: mix(laneHex(lane), CARD, ref.isHead ? 0.22 : 0.12),
      stroke: ref.isHead ? laneHex(lane) : mix(laneHex(lane), PAPER, 0.4),
      ink: INK,
      dashed: ref.kind === 'tag',
      opacity: ref.kind === 'remote' ? 0.75 : undefined,
    })
    out.push(chip.svg)
    x += chip.width + 4
  }

  const subjectRoom = authorRight - measure(author.text, FONT.meta) - GAP - x
  const subject = fit(commit.subject || '(no message)', subjectRoom, FONT.subject, measure)
  out.push(text(x, mid, subject.text, FONT.subject, INK))

  return out
}

function renderWipRow(row: Extract<DisplayRow, { kind: 'wip' }>, ctx: RowContext): string[] {
  const { measure, gutter, cardWidth } = ctx
  const worktree = row.worktree
  const top = rowTop(ctx.offsets, row.index)
  const mid = top + ROW_HEIGHT / 2
  const left = gutter + CARD_INSET
  const right = left + cardWidth - CARD_INSET * 2

  const out: string[] = [card(left, top, right - left, false, true)]

  const total = worktree.files.length
  const countLabel = `${total} file${total === 1 ? '' : 's'}`
  out.push(text(right - PAD, mid, countLabel, FONT.meta, INK_MUTED, 'end'))
  const countWidth = measure(countLabel, FONT.meta)

  let x = left + PAD
  out.push(text(x, mid, 'wip', FONT.wipLabel, INK_SECONDARY))
  x += measure('wip', FONT.wipLabel) + GAP

  if (worktree.branch !== null) {
    out.push(text(x, mid, worktree.branch, FONT.sessionMeta, INK_MUTED))
    x += measure(worktree.branch, FONT.sessionMeta) + GAP
  }

  // Ranked by heat, so the files being edited right now are the ones that make the cut.
  const ranked = [...worktree.files].sort((a, b) => b.heat - a.heat)
  const shown = ranked.slice(0, VISIBLE_FILES)
  const limit = right - PAD - countWidth - GAP

  let hiddenFrom = shown.length
  for (const [index, file] of shown.entries()) {
    const label = `${file.status.trim() || '·'} ${basename(file.path)}`
    const chipWidth = measure(label, FONT.file) + 12
    if (x + chipWidth > limit) {
      hiddenFrom = index
      break
    }
    const chip = chipAt(x, mid - 8, label, FONT.file, measure, {
      fill: heatHex(heatBucket(file.heat)),
      stroke: mix(heatHex(heatBucket(file.heat)), INK, 0.85),
      ink: INK,
    })
    out.push(chip.svg)
    x += chip.width + 4
  }

  const hidden = ranked.length - hiddenFrom
  if (hidden > 0) {
    const label = `+${hidden} more`
    if (x + measure(label, FONT.smallChip) <= limit) {
      out.push(text(x, mid, label, FONT.smallChip, INK_MUTED))
    }
  }

  return out
}

function renderSessionRow(
  row: Extract<DisplayRow, { kind: 'session' }>,
  ctx: RowContext,
): string[] {
  const { measure, gutter, cardWidth } = ctx
  const session = row.session
  const top = rowTop(ctx.offsets, row.index)
  const mid = top + rowHeight(row) / 2
  const left = gutter + CARD_INSET
  const right = left + cardWidth - CARD_INSET * 2

  const out: string[] = []

  // No lane hue and no warm tint: hue means lane identity and value belongs to activity
  // heat, so a band gets weight and position only.
  out.push(
    `<rect x="${round(left)}" y="${round(mid - 7.5)}" width="3" height="15" rx="1.5" fill="${INK_SECONDARY}"/>`,
  )

  let x = left + 9
  const title = fit(session.title ?? 'Untitled session', 320, FONT.sessionTitle, measure)
  out.push(text(x, mid, title.text, FONT.sessionTitle, INK))
  x += measure(title.text, FONT.sessionTitle) + GAP

  const tokens = session.inputTokens + session.outputTokens
  const parts = [
    `${session.commitCount} commit${session.commitCount === 1 ? '' : 's'}`,
    `${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}`,
  ]
  if (tokens > 0) parts.push(formatTokens(tokens))

  /*
   * Roughly a fifth of sessions touch more than one branch, and saying so beats leaving the
   * reader to notice a band straddling two lanes. Its width is reserved before the meta is
   * laid out, so a long token count shortens itself rather than running under the chip.
   */
  const multi = session.branches.length > 1 ? `${session.branches.length} branches` : null
  const multiWidth = multi === null ? 0 : measure(multi, FONT.smallChip) + 12 + GAP

  const meta = fit(parts.join(' · '), right - x - multiWidth - MIN_RULE, FONT.sessionMeta, measure)
  out.push(text(x, mid, meta.text, FONT.sessionMeta, INK_MUTED))
  x += measure(meta.text, FONT.sessionMeta) + GAP

  if (multi !== null) {
    const chip = chipAt(x, mid - 7, multi, FONT.smallChip, measure, {
      fill: PAPER,
      stroke: RULE_STRONG,
      ink: INK_SECONDARY,
    })
    out.push(chip.svg)
    x += chip.width + GAP
  }

  if (x < right) out.push(line(x, mid, right, mid, RULE))
  return out
}

/* ---------- primitives ---------- */

function card(x: number, top: number, width: number, isHead: boolean, dashed = false): string {
  const dash = dashed ? ' stroke-dasharray="3 3"' : ''
  return (
    `<rect x="${round(x)}" y="${round(top + 4)}" width="${round(width)}" height="${ROW_HEIGHT - 8}" ` +
    `rx="5" fill="${CARD}" stroke="${isHead ? RULE_STRONG : RULE}"${dash}/>`
  )
}

interface ChipStyle {
  fill: string
  stroke: string
  ink: string
  dashed?: boolean
  opacity?: number
}

/** A rounded label. Returns its markup and its total width, so callers can advance. */
function chipAt(
  x: number,
  top: number,
  label: string,
  font: Font,
  measure: Measure,
  style: ChipStyle,
): { svg: string; width: number } {
  const inner = measure(label, font) * CHIP_SLACK
  const width = inner + 12
  const height = 16
  const opacity = style.opacity === undefined ? '' : ` opacity="${style.opacity}"`
  const dash = style.dashed ? ' stroke-dasharray="3 2"' : ''
  const svg =
    `<g${opacity}>` +
    `<rect x="${round(x)}" y="${round(top)}" width="${round(width)}" height="${height}" rx="4" ` +
    `fill="${style.fill}" stroke="${style.stroke}"${dash}/>` +
    text(x + 6, top + height / 2, label, font, style.ink) +
    `</g>`
  return { svg, width }
}

/**
 * A line of text, vertically centred on `centerY`.
 *
 * The baseline is computed rather than delegated to `dominant-baseline`, whose support in
 * standalone rasterisers is inconsistent enough that text drifts vertically on the way to
 * PNG. 0.355em below centre is the usual cap-height compromise.
 */
function text(
  x: number,
  centerY: number,
  content: string,
  font: Font,
  fill: string,
  anchor: 'start' | 'end' = 'start',
): string {
  const family = font.family === 'mono' ? MONO_STACK : UI_STACK
  const weight = font.weight === 400 ? '' : ` font-weight="${font.weight}"`
  const align = anchor === 'end' ? ' text-anchor="end"' : ''
  return (
    `<text x="${round(x)}" y="${round(centerY + font.size * 0.355)}" ` +
    `font-family="${escapeXml(family)}" font-size="${font.size}"${weight}${align} ` +
    `fill="${fill}">${escapeXml(content)}</text>`
  )
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string): string {
  return `<path d="M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}" stroke="${stroke}" stroke-width="1"/>`
}

/**
 * Truncate to fit, with an ellipsis.
 *
 * Binary search rather than a per-character estimate, because the measurer is exact and a
 * proportional font makes "how many characters fit" unanswerable arithmetically.
 */
export function fit(
  content: string,
  maxWidth: number,
  font: Font,
  measure: Measure,
): { text: string; truncated: boolean } {
  if (maxWidth <= 0) return { text: '', truncated: content.length > 0 }
  if (measure(content, font) <= maxWidth) return { text: content, truncated: false }

  let low = 0
  let high = content.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(`${content.slice(0, mid)}…`, font) <= maxWidth) low = mid
    else high = mid - 1
  }
  return { text: low > 0 ? `${content.slice(0, low)}…` : '', truncated: true }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Two decimals is well below a device pixel and keeps the file from doubling in size. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
