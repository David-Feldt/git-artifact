import type { DirtyFile, WorktreeStatus } from '../../api.js'
import { basename, heatBucket } from '../format.js'

/** How many file chips fit before the rest collapse into a count. */
const VISIBLE_FILES = 5

interface WipNodeProps {
  worktree: WorktreeStatus
}

/**
 * Uncommitted work, shown as a pseudo-node at the tip of its worktree's lane.
 *
 * Files are ranked by heat rather than alphabetically, so the ones being edited right now
 * are the ones on screen. That ordering is the whole point of the node — a list sorted by
 * name would put whatever starts with "a" in front of what you are actually doing.
 */
export function WipNode({ worktree }: WipNodeProps) {
  const ranked = [...worktree.files].sort((a, b) => b.heat - a.heat)
  const shown = ranked.slice(0, VISIBLE_FILES)
  const hidden = ranked.length - shown.length

  return (
    <div className="card">
      <span className="wip__label">wip</span>
      {worktree.branch !== null && <span className="wip__count">{worktree.branch}</span>}
      <span className="wip__files">
        {shown.map((file) => (
          <FileChip key={file.path} file={file} />
        ))}
      </span>
      {hidden > 0 && <span className="wip__more">+{hidden} more</span>}
      <span className="wip__count">
        {ranked.length} file{ranked.length === 1 ? '' : 's'}
      </span>
    </div>
  )
}

function FileChip({ file }: { file: DirtyFile }) {
  return (
    <span
      className="wip__file"
      style={{ ['--heat-bg' as string]: heatColor(file.heat) }}
      title={`${file.path} · ${describeStatus(file)}`}
    >
      <span className="wip__status">{file.status.trim() || '·'}</span>
      {basename(file.path)}
    </span>
  )
}

/** The ramp itself is `--heat-0` … `--heat-4`; the thresholds live in format.ts. */
export function heatColor(heat: number): string {
  return `var(--heat-${heatBucket(heat)})`
}

function describeStatus(file: DirtyFile): string {
  if (file.conflicted) return 'conflicted'
  if (file.untracked) return 'untracked'
  const parts: string[] = []
  if (file.staged) parts.push('staged')
  if (file.unstaged) parts.push('unstaged')
  return parts.join(' + ') || 'changed'
}
