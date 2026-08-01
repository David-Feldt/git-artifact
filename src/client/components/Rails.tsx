import type { DisplayRow } from './layout.js'
import { bodyHeight, gutterWidth, laneColor, laneX, rowCenter, rowOffsets } from './layout.js'
import { railNodes, railPaths, type RailNode } from './rail-paths.js'

interface RailsProps {
  rows: DisplayRow[]
  width: number
  /** Row with its detail panel open, whose rails must stretch across the gap. Or null. */
  expandedIndex: number | null
}

/**
 * The rails: every edge and node in one SVG behind the cards.
 *
 * SVG for the graph, HTML for the text. Text in SVG loses selection, wrapping and
 * subpixel hinting for nothing in return, and the rails need real curves that CSS borders
 * cannot draw. Keeping them in separate layers means each does what it is good at.
 *
 * Both layers read their vertical geometry from the same offsets array, which is what
 * keeps them in lockstep now that rows are neither uniform in height (session headers are
 * shorter) nor evenly spaced (an open panel injects a gap). A rail crossing the panel gap
 * stretches to span it, because the offsets already account for it — no special case here.
 *
 * The geometry itself lives in `rail-paths.ts`, shared with the SVG exporter so the file
 * you download cannot drift from the graph you are looking at.
 */
export function Rails({ rows, width, expandedIndex }: RailsProps) {
  const offsets = rowOffsets(rows, expandedIndex)
  const height = bodyHeight(offsets)
  const y = (index: number) => rowCenter(rows, offsets, index)

  return (
    <svg
      className="rails"
      width={gutterWidth(width)}
      height={height}
      viewBox={`0 0 ${gutterWidth(width)} ${height}`}
      aria-hidden="true"
    >
      {railPaths(rows, y).map((path) => (
        <path
          key={path.key}
          className={path.truncated ? 'rail rail--truncated' : 'rail'}
          stroke={laneColor(path.lane)}
          d={path.d}
        />
      ))}
      {railNodes(rows, y).map((node) => (
        <Node key={node.key} node={node} />
      ))}
    </svg>
  )
}

function Node({ node }: { node: RailNode }) {
  const { lane, y, kind } = node
  const color = laneColor(lane)
  const x = laneX(lane)

  if (kind === 'wip') {
    // Hollow and dashed: not a commit, and not pretending to be one.
    return (
      <circle
        className="node node--root"
        cx={x}
        cy={y}
        r={4}
        fill="var(--paper)"
        stroke={color}
        strokeDasharray="2 2"
      />
    )
  }

  if (kind === 'merge') {
    // Merges get a ring so the shape alone says "this joined two histories" — identity
    // that survives being read at a glance, or in greyscale.
    return (
      <>
        <circle className="node" cx={x} cy={y} r={5.5} fill={color} stroke="var(--paper)" />
        <circle cx={x} cy={y} r={2} fill="var(--paper)" />
      </>
    )
  }

  const isRoot = kind === 'root'
  return (
    <circle
      className={isRoot ? 'node node--root' : 'node'}
      cx={x}
      cy={y}
      r={4.5}
      fill={isRoot ? 'var(--paper)' : color}
      stroke={isRoot ? color : 'var(--paper)'}
    />
  )
}
