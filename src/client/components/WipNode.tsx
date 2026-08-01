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
      title={`${file.path} · ${describeStatus(file)}${describeLines(file)}`}
    >
      <span className="wip__status">{file.status.trim() || '·'}</span>
      {/* The name is the only part allowed to shrink. It was a bare text node, which meant
          the chip truncated from its right edge and ate the counts first — the numbers are
          the point of the chip, and a name is still recognisable half-elided. */}
      <span className="wip__name">{basename(file.path)}</span>
      <FileLines file={file} />
    </span>
  )
}

/**
 * How much of the file changed, as `+n −n`.
 *
 * Each side is dropped when it is zero rather than printed as `+0`, so a pure addition
 * reads as one number instead of two — half the chips in a working tree are one-sided, and
 * a column of `+12 −0` is noise pretending to be data.
 *
 * A null count is not zero: it means nobody could count, which is the case for a binary
 * file and for an untracked file too large to scan. Those render nothing at all, because a
 * number that is not known should not be shown as one that is.
 */
function FileLines({ file }: { file: DirtyFile }) {
  const added = file.added ?? 0
  const deleted = file.deleted ?? 0
  if (file.added === null && file.deleted === null) return null
  if (added === 0 && deleted === 0) return null

  return (
    <span className="wip__lines">
      {added > 0 && <span className="wip__added">+{added}</span>}
      {/* U+2212 minus, not a hyphen: it matches the plus in width and weight, so the two
          columns line up instead of the minus reading as a dash in the filename. */}
      {deleted > 0 && <span className="wip__deleted">−{deleted}</span>}
    </span>
  )
}

function describeLines(file: DirtyFile): string {
  if (file.added === null && file.deleted === null) return ''
  return ` · +${file.added ?? 0} −${file.deleted ?? 0}`
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
