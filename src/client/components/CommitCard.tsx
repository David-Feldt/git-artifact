import type { CommitStat, PushMarker } from '../../api.js'
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
  /** How much this commit changed. Absent when the counts could not be read. */
  stat?: CommitStat
  expanded: boolean
  onToggle: () => void
  /** Where this commit's generated page lives. Absent when generation is unavailable. */
  artifactHref?: string
  /**
   * Whether a page for this commit already exists on disk.
   *
   * Only ever "there is something to read", never "it is current" — see `GraphPayload`.
   * The distinction is why the two states are two colours rather than a present/absent
   * mark: both are live links, and one of them costs tokens to follow.
   */
  artifactReady?: boolean
}

export function CommitCard({
  row,
  now,
  pushes,
  stat,
  expanded,
  onToggle,
  artifactHref,
  artifactReady = false,
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
        {stat !== undefined && <Delta stat={stat} />}
        <span className="card__author" title={commit.authorEmail}>
          {commit.authorName}
        </span>
        <span className="card__when" title={new Date(commit.authorDate * 1000).toLocaleString()}>
          {relativeTime(commit.authorDate * 1000, now)}
        </span>
      </button>

      {artifactHref !== undefined && (
        /*
         * Icon only, and always visible. It was revealed on hover, which made the one thing
         * worth knowing at a glance — which commits already have a page — impossible to see
         * without moving the mouse down every row in turn. Standing weight is the cost of
         * that; the icon is small, muted until you approach it, and carries no label.
         *
         * Two states, two colours, both of them links. Blue is "nothing here yet, following
         * this spends tokens"; orange is "already written, following this is free". Present
         * versus absent would have been the obvious encoding and is the wrong one — an
         * absent mark reads as "you cannot do this here", when in fact that is the case
         * where there is most to do.
         *
         * `target` is named per sha, so asking twice focuses the tab already open on that
         * commit rather than stacking a second. Deliberately no `rel="noopener"`: it forces
         * a fresh context and defeats that reuse, and this is our own page on our own origin.
         */
        <a
          className={`card__artifact ${artifactReady ? 'card__artifact--ready' : ''}`}
          href={artifactHref}
          target={`git-artifact-${commit.sha}`}
          title={
            artifactReady
              ? 'Read the page explaining this commit — already generated, opens in a new tab'
              : 'Generate artifact — a page explaining this commit, in a new tab'
          }
          aria-label={
            artifactReady
              ? `Read the generated page for commit ${commit.sha.slice(0, 7)}`
              : `Generate artifact for commit ${commit.sha.slice(0, 7)}`
          }
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
 * How much this commit changed: files touched, then lines added and removed.
 *
 * Rendered only when the counts actually arrived — see `GraphPayload.stats`. An empty
 * commit does arrive, as 0/0/0, and says so; that is a fact about the commit rather than a
 * gap in the read, and the two must not look alike.
 *
 * Zero sides are dropped rather than printed as `+0`, the same rule the WIP node's chips
 * follow. A commit that only adds files reads as one number instead of two, and the strip
 * stays right-aligned so the counts still form a column down the graph.
 */
function Delta({ stat }: { stat: CommitStat }) {
  return (
    <span
      className="card__delta"
      title={`${stat.files} file${stat.files === 1 ? '' : 's'} changed, ${stat.additions} insertion${stat.additions === 1 ? '' : 's'}(+), ${stat.deletions} deletion${stat.deletions === 1 ? '' : 's'}(-)`}
    >
      <span className="card__files">
        {stat.files} file{stat.files === 1 ? '' : 's'}
      </span>
      <span className="card__lines">
        {stat.additions > 0 && <span className="card__added">+{stat.additions}</span>}
        {/* U+2212 minus, not a hyphen: it matches the plus in width and weight, so the
            two numbers line up instead of the minus reading as a dash. */}
        {stat.deletions > 0 && <span className="card__deleted">−{stat.deletions}</span>}
      </span>
    </span>
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

