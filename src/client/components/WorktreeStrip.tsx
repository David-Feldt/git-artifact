import type { WorktreeLane, WorktreeStatus } from '../../api.js'
import { laneColor } from './layout.js'

interface WorktreeStripProps {
  lanes: WorktreeLane[]
  /** From the status payload; joined here on `path` rather than duplicated server-side. */
  statuses: WorktreeStatus[]
  onSelect: (sha: string) => void
}

/**
 * The worktree band: one chip per checkout, colour-keyed to the lane its HEAD sits in.
 *
 * This is what "lane groups" turned into. Partitioning the graph by worktree is not
 * possible in a way that means anything — a commit is usually reachable from every
 * checkout, so it belongs to all of them — but a worktree's *tip* is unambiguous. Each
 * chip carries the colour of the lane it is sitting in, which is what ties it to the
 * rail without the graph itself having to be carved up.
 *
 * Hidden entirely when there is only the main worktree, since a strip that always says
 * "you have one checkout" is furniture rather than information.
 */
export function WorktreeStrip({ lanes, statuses, onSelect }: WorktreeStripProps) {
  if (lanes.length < 2) return null

  const byPath = new Map(statuses.map((s) => [s.path, s]))

  return (
    <div className="wtstrip">
      <span className="wtstrip__label">{lanes.length} worktrees</span>
      {lanes.map((lane) => {
        const status = byPath.get(lane.path)
        const dirty = status?.files.length ?? 0
        const colour = lane.lane === null ? 'var(--ink-muted)' : laneColor(lane.lane)

        return (
          <button
            key={lane.path}
            type="button"
            className="wtchip"
            style={{ ['--wt-color' as string]: colour }}
            // Off-screen HEADs cannot be scrolled to, so the chip stops being a control.
            disabled={lane.head === null || lane.lane === null}
            onClick={() => lane.head && onSelect(lane.head)}
            title={lane.path}
          >
            <span className="wtchip__swatch" />
            <span className="wtchip__name">
              {lane.detached ? 'detached' : (lane.branch ?? lane.name)}
            </span>
            {lane.isMain && <span className="wtchip__tag">main</span>}
            {dirty > 0 && <span className="wtchip__dirty">{dirty} dirty</span>}
            {status?.ahead ? <span className="wtchip__ab">↑{status.ahead}</span> : null}
            {status?.behind ? <span className="wtchip__ab">↓{status.behind}</span> : null}
            {lane.lane === null && <span className="wtchip__off">off-screen</span>}
          </button>
        )
      })}
    </div>
  )
}
