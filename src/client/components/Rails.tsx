import { Fragment } from 'react'
import type { DisplayRow } from './layout.js'
import { LANE_WIDTH, ROW_HEIGHT, gutterWidth, laneColor, laneX, rowY } from './layout.js'

interface RailsProps {
  rows: DisplayRow[]
  width: number
}

/**
 * The rails: every edge and node in one SVG behind the cards.
 *
 * SVG for the graph, HTML for the text. Text in SVG loses selection, wrapping and
 * subpixel hinting for nothing in return, and the rails need real curves that CSS borders
 * cannot draw. Keeping them in separate layers means each does what it is good at, and
 * the fixed row height keeps the two in lockstep.
 */
export function Rails({ rows, width }: RailsProps) {
  const height = rows.length * ROW_HEIGHT

  return (
    <svg
      className="rails"
      width={gutterWidth(width)}
      height={height}
      viewBox={`0 0 ${gutterWidth(width)} ${height}`}
      aria-hidden="true"
    >
      {rows.map((row, index) => (
        <Fragment key={index}>{renderEdges(row, rows[index + 1])}</Fragment>
      ))}
      {rows.map((row, index) => (
        <Fragment key={`n${index}`}>{renderNode(row)}</Fragment>
      ))}
    </svg>
  )
}

function renderEdges(row: DisplayRow, next: DisplayRow | undefined) {
  const y1 = rowY(row.index)
  const y2 = rowY(row.index + 1)

  // A WIP row has no commit edges of its own. Every lane alive around it passes straight
  // through, and its own lane runs down into the commit it is sitting on.
  if (row.kind === 'wip') {
    const lanes = new Set<number>([row.lane])
    if (next?.kind === 'commit') for (const edge of next.row.edges) lanes.add(edge.fromLane)
    return (
      <>
        {[...lanes].map((lane) => (
          <path
            key={lane}
            className={lane === row.lane ? 'rail rail--truncated' : 'rail'}
            stroke={laneColor(lane)}
            d={`M ${laneX(lane)} ${y1} L ${laneX(lane)} ${y2}`}
          />
        ))}
      </>
    )
  }

  return (
    <>
      {row.row.edges.flatMap((edge) => {
        /*
         * One edge can need two lines drawn.
         *
         * A lane that was already carrying a rail keeps running straight down — that is
         * the rail's continuity, and breaking it makes an unrelated branch look like it
         * ended. Separately, an edge belonging to *this* commit has to physically leave
         * this commit's node, or a merge appears unconnected to the branch it absorbed.
         *
         * Usually only one applies. Both apply when a merge's second parent happens to
         * live in a lane that is already busy, and drawing only one of them is what
         * produced a broken rail on real history.
         */
        const origins = new Set<number>()
        if (row.row.incoming.includes(edge.fromLane)) origins.add(edge.fromLane)
        if (edge.kind !== 'pass') origins.add(row.row.lane)
        if (origins.size === 0) origins.add(edge.fromLane)

        const x2 = laneX(edge.toLane)
        return [...origins].map((originLane) => (
          <path
            key={`${originLane}-${edge.fromLane}-${edge.toLane}-${edge.parentSha}`}
            className="rail"
            stroke={laneColor(edge.kind === 'merge' ? edge.toLane : edge.fromLane)}
            d={edgePath(laneX(originLane), y1, x2, y2)}
          />
        ))
      })}
      {/* A commit whose parents were cut off by the history cap: a short frayed stub so a
          boundary is visibly different from a root commit. */}
      {row.row.truncated && (
        <path
          className="rail rail--truncated"
          stroke={laneColor(row.row.lane)}
          d={`M ${laneX(row.row.lane)} ${y1} L ${laneX(row.row.lane)} ${y1 + ROW_HEIGHT * 0.45}`}
        />
      )}
    </>
  )
}

/**
 * A vertical line, or an S-curve when the lane changes.
 *
 * The control points sit on the vertical through each endpoint, so the curve leaves and
 * arrives travelling straight down — branches merge into a rail tangentially instead of
 * meeting it at a corner. The horizontal clamp keeps a jump across many lanes from
 * bulging into its neighbours.
 */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const bend = Math.min((y2 - y1) * 0.5, LANE_WIDTH * 1.6)
  return `M ${x1} ${y1} C ${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`
}

function renderNode(row: DisplayRow) {
  const y = rowY(row.index)

  if (row.kind === 'wip') {
    // Hollow and dashed: not a commit, and not pretending to be one.
    return (
      <circle
        className="node node--root"
        cx={laneX(row.lane)}
        cy={y}
        r={4}
        fill="var(--paper)"
        stroke={laneColor(row.lane)}
        strokeDasharray="2 2"
      />
    )
  }

  const { commit, lane } = row.row
  const isMerge = commit.parents.length > 1
  const isRoot = commit.parents.length === 0
  const color = laneColor(lane)

  if (isMerge) {
    // Merges get a ring so the shape alone says "this joined two histories" — identity
    // that survives being read at a glance, or in greyscale.
    return (
      <>
        <circle className="node" cx={laneX(lane)} cy={y} r={5.5} fill={color} stroke="var(--paper)" />
        <circle cx={laneX(lane)} cy={y} r={2} fill="var(--paper)" />
      </>
    )
  }

  return (
    <circle
      className={isRoot ? 'node node--root' : 'node'}
      cx={laneX(lane)}
      cy={y}
      r={4.5}
      fill={isRoot ? 'var(--paper)' : color}
      stroke={isRoot ? color : 'var(--paper)'}
    />
  )
}
