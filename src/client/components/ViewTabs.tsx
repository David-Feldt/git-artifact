import type { WorktreeLane, WorktreeStatus } from '../../api.js'
import type { GraphView } from '../views.js'
import { laneColor } from './layout.js'

/**
 * What is checked out in a worktree, as secondary text beside its name.
 *
 * Null when there is nothing useful to say — an unborn branch has no name yet, and
 * inventing one would be worse than the tab simply showing the worktree alone.
 */
function checkedOut(worktree: WorktreeLane): string | null {
  if (worktree.detached) return '(detached)'
  return worktree.branch
}

interface ViewTabsProps {
  views: GraphView[]
  active: string
  /** From the status payload; joined here on `path` rather than duplicated server-side. */
  statuses: WorktreeStatus[]
  onSelect: (key: string) => void
}

/**
 * One tab per checkout, plus the unified graph.
 *
 * This replaces the worktree strip, which could only ever scroll you to a tip inside a
 * graph holding every other checkout's history at the same time. A worktree is a place
 * you are working, and the thing you want from it is usually *its* history without four
 * other branches interleaved — so it gets its own render.
 *
 * "All" stays first and stays the default. A session band roams across worktrees, and
 * scoping the graph cuts those bands up; the unified view is where one reads whole. Losing
 * it would trade one distortion for another.
 *
 * Hidden entirely when there is only the main worktree, on the same reasoning the strip
 * used: a tab bar reading "All / main" is furniture rather than information.
 */
export function ViewTabs({ views, active, statuses, onSelect }: ViewTabsProps) {
  if (views.length < 2) return null

  const byPath = new Map(statuses.map((s) => [s.path, s]))

  return (
    <div className="vtabs" role="tablist" aria-label="Worktrees">
      {views.map((view) => {
        const worktree = view.worktree
        const status = worktree === null ? undefined : byPath.get(worktree.path)
        const dirty = status?.files.length ?? 0
        /*
         * The unified tab takes the ink colour, not a lane hue. It is not sitting in a
         * lane — it contains all of them — and giving it one would claim a rail it has no
         * relationship to.
         */
        const colour =
          worktree === null || worktree.lane === null
            ? 'var(--ink-muted)'
            : laneColor(worktree.lane)

        return (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={view.key === active}
            className={`vtab${view.key === active ? ' vtab--on' : ''}`}
            style={{ ['--wt-color' as string]: colour }}
            onClick={() => onSelect(view.key)}
            title={worktree?.path ?? 'Every checkout in one graph'}
          >
            <span className="vtab__swatch" />
            <span className="vtab__name">{view.label}</span>
            {worktree === null ? (
              <span className="vtab__count">{view.graph.rows.length}</span>
            ) : (
              <>
                {checkedOut(worktree) && (
                  <span className="vtab__branch">{checkedOut(worktree)}</span>
                )}
                {worktree.isMain && <span className="vtab__tag">main</span>}
                {dirty > 0 && <span className="vtab__dirty">{dirty} dirty</span>}
                {status?.ahead ? <span className="vtab__ab">↑{status.ahead}</span> : null}
                {status?.behind ? <span className="vtab__ab">↓{status.behind}</span> : null}
                {/*
                 * An off-screen tip means the cap cut this worktree's history out of the
                 * window entirely, so its tab renders empty. Saying which of "no commits"
                 * and "not loaded" you are looking at costs one word.
                 */}
                {worktree.head !== null && worktree.lane === null && (
                  <span className="vtab__off">off-screen</span>
                )}
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
