import type { PushMarker } from '../../api.js'
import type { RefDecoration } from '../../graph/model.js'
import type { GraphRow } from '../../graph/model.js'
import { laneColor } from './layout.js'
import { relativeTime } from '../format.js'

interface CommitCardProps {
  row: GraphRow
  /** Epoch millis, passed in so every row on a render agrees on "now". */
  now: number
  /** Pushes that landed on this exact commit, if any. */
  pushes?: PushMarker[]
  expanded: boolean
  onToggle: () => void
}

export function CommitCard({ row, now, pushes, expanded, onToggle }: CommitCardProps) {
  const { commit } = row
  const isHead = commit.refs.some((ref) => ref.isHead)

  const classes = ['card']
  if (isHead) classes.push('card--head')
  if (expanded) classes.push('card--expanded')

  return (
    /*
     * A button rather than a div with a click handler: this has to be reachable by keyboard
     * and announce its expanded state, and a native button brings both plus Enter/Space
     * handling without reimplementing any of it.
     */
    <button
      className={classes.join(' ')}
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? 'Hide the diff' : 'Show the diff'}
      type="button"
    >
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
    </button>
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

