import type { DirtyFile, WorktreeStatus } from '../../api.js'

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

/**
 * Map heat onto the sequential amber ramp.
 *
 * Stepped rather than interpolated: five discrete buckets read as distinct at a glance,
 * where a continuous gradient turns into mush at chip size. Thresholds are spaced by the
 * decay curve, so the top bucket means "within the last few minutes".
 */
export function heatColor(heat: number): string {
  if (heat >= 0.75) return 'var(--heat-4)'
  if (heat >= 0.45) return 'var(--heat-3)'
  if (heat >= 0.2) return 'var(--heat-2)'
  if (heat >= 0.05) return 'var(--heat-1)'
  return 'var(--heat-0)'
}

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}

function describeStatus(file: DirtyFile): string {
  if (file.conflicted) return 'conflicted'
  if (file.untracked) return 'untracked'
  const parts: string[] = []
  if (file.staged) parts.push('staged')
  if (file.unstaged) parts.push('unstaged')
  return parts.join(' + ') || 'changed'
}
