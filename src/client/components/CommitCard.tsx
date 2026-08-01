import type { PushMarker } from '../../api.js'
import type { RefDecoration } from '../../graph/model.js'
import type { GraphRow } from '../../graph/model.js'
import { laneColor } from './layout.js'
import { relativeTime } from '../format.js'
import { CHART_NETWORK_PATHS, ICON_STROKE, ICON_VIEWBOX } from '../icons.js'

interface CommitCardProps {
  row: GraphRow
  /** Epoch millis, passed in so every row on a render agrees on "now". */
  now: number
  /** Pushes that landed on this exact commit, if any. */
  pushes?: PushMarker[]
  expanded: boolean
  onToggle: () => void
  /** Where this commit's generated page lives. Absent when generation is unavailable. */
  artifactHref?: string
}

export function CommitCard({
  row,
  now,
  pushes,
  expanded,
  onToggle,
  artifactHref,
}: CommitCardProps) {
  const { commit } = row
  const isHead = commit.refs.some((ref) => ref.isHead)

  const classes = ['card']
  if (isHead) classes.push('card--head')
  if (expanded) classes.push('card--expanded')

  return (
    /*
     * Two siblings, not a wrapper. The row is already the flex container these want to sit
     * in, and the link cannot go *inside* the button: interactive content nested in a button
     * is invalid, and browsers disagree about which of the two a click lands on.
     *
     * A button rather than a div with a click handler: this has to be reachable by keyboard
     * and announce its expanded state, and a native button brings both plus Enter/Space
     * handling without reimplementing any of it.
     */
    <>
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

      {artifactHref !== undefined && (
        /*
         * Icon only, revealed on hover or focus. This sits on every row now, and a labelled
         * control repeated the whole way down would out-shout the commits it is attached to
         * — the rails and the subjects are what the view is for.
         *
         * `target` is named per sha, so asking twice focuses the tab already open on that
         * commit rather than stacking a second. Deliberately no `rel="noopener"`: it forces
         * a fresh context and defeats that reuse, and this is our own page on our own origin.
         */
        <a
          className="card__artifact"
          href={artifactHref}
          target={`git-artifact-${commit.sha}`}
          style={{ ['--artifact-accent' as string]: laneColor(row.lane) }}
          title="Generate artifact — a page explaining this commit, in a new tab"
          aria-label={`Generate artifact for commit ${commit.sha.slice(0, 7)}`}
        >
          <svg
            viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={ICON_STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {CHART_NETWORK_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        </a>
      )}
    </>
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

