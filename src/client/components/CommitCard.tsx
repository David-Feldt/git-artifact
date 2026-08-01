import type { PushMarker } from '../../api.js'
import type { RefDecoration } from '../../graph/model.js'
import type { GraphRow } from '../../graph/model.js'
import { laneColor } from './layout.js'

interface CommitCardProps {
  row: GraphRow
  /** Epoch millis, passed in so every row on a render agrees on "now". */
  now: number
  /** Pushes that landed on this exact commit, if any. */
  pushes?: PushMarker[]
}

export function CommitCard({ row, now, pushes }: CommitCardProps) {
  const { commit } = row
  const isHead = commit.refs.some((ref) => ref.isHead)

  return (
    <div className={isHead ? 'card card--head' : 'card'}>
      <span className="card__sha">{commit.sha.slice(0, 7)}</span>
      {pushes && pushes.length > 0 && <Push pushes={pushes} now={now} />}
      {commit.refs.length > 0 && (
        <span className="refs">
          {commit.refs.map((ref) => (
            <Ref key={ref.raw} decoration={ref} lane={row.lane} />
          ))}
        </span>
      )}
      <span className="card__subject" title={commit.subject}>
        {commit.subject || <em>(no message)</em>}
      </span>
      <span className="card__author" title={commit.authorEmail}>
        {commit.authorName}
      </span>
      <span className="card__when" title={new Date(commit.authorDate * 1000).toLocaleString()}>
        {relativeTime(commit.authorDate * 1000, now)}
      </span>
    </div>
  )
}

/**
 * The moment this commit left the machine.
 *
 * Only the exact commit a push landed on is marked, not everything behind it. That makes
 * it an event on a timeline — "work was published here, then" — which is information the
 * graph does not otherwise carry. Whether a given commit is *currently* published is a
 * different question, and the ahead/behind counts already answer it per branch.
 */
function Push({ pushes, now }: { pushes: PushMarker[]; now: number }) {
  // Newest first; a commit re-pushed to several remotes gets one chip per ref.
  const sorted = [...pushes].sort((a, b) => b.at - a.at)
  const label = sorted.map((p) => `${p.ref} · ${new Date(p.at).toLocaleString()}`).join('\n')

  return (
    <span className="push" title={label}>
      <span className="push__icon" aria-hidden="true">
        ↑
      </span>
      pushed {relativeTime(sorted[0]!.at, now)}
    </span>
  )
}

function Ref({ decoration, lane }: { decoration: RefDecoration; lane: number }) {
  const classes = ['ref']
  if (decoration.isHead) classes.push('ref--head')
  if (decoration.kind === 'tag') classes.push('ref--tag')
  if (decoration.kind === 'remote') classes.push('ref--remote')

  return (
    <span
      className={classes.join(' ')}
      style={{ ['--ref-color' as string]: laneColor(lane) }}
      title={decoration.raw}
    >
      {decoration.kind === 'tag' ? `⌗ ${decoration.name}` : decoration.name}
    </span>
  )
}

/**
 * Compact relative time.
 *
 * Deliberately terse — this is meant to be read at a glance from across a desk, where
 * "2h" lands and "2 hours ago" is a sentence. Future timestamps are possible after a
 * rebase or with clock skew and are clamped rather than rendered as negative.
 */
export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.round(months / 12)}y`
}
