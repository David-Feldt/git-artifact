import type { SessionBandInfo } from '../../api.js'
import { formatTokens, relativeTime, sessionEnded } from '../format.js'
import { ICON_STROKE, ICON_VIEWBOX, MONITOR_PATHS, X_PATHS } from '../icons.js'

interface SessionHeaderProps {
  /**
   * `elsewhere` is set by `views.ts` when a worktree tab holds only part of a band. The
   * prop is widened rather than `SessionBandInfo` itself, because it is a property of the
   * view rather than of the session — the wire type stays a description of what happened.
   */
  session: SessionBandInfo & { elsewhere?: number }
  /**
   * Epoch millis, shared by every row on a render so they agree on "now".
   *
   * Whether a session has ended is a property of the clock rather than of the payload, so
   * it is decided here and not on the wire. `App.tsx` re-ticks this every 20 s, which is
   * what lets the mark appear on a session that goes quiet without a commit to trigger a
   * refresh — nothing watches the transcript directory.
   */
  now: number
  /** Save this band alone, or absent while the graph is still settling. */
  onExport?: () => void
}

/**
 * The label at the top of a session band.
 *
 * Deliberately quiet: no lane hue, because hue means lane identity, and no warm tint,
 * because the value channel belongs to activity heat. A band gets weight and position
 * only. See docs/design/session-bands.md.
 *
 * The wording matters as much as the geometry. Attribution is inferred from timing —
 * nothing records that a session *caused* a commit — so this says the commits below were
 * observed alongside the session, and never that the session wrote them.
 */
export function SessionHeader({ session, now, onExport }: SessionHeaderProps) {
  const tokens = session.inputTokens + session.outputTokens
  const ended = sessionEnded(session.endedAt, now)

  return (
    <div className="shead" title={sessionTooltip(session, now)}>
      {/*
       * Hidden from the accessibility tree: the title beside it already says what the row
       * is, so announcing an icon here would only repeat it.
       */}
      <Mark paths={MONITOR_PATHS} className="shead__mark" />
      {ended && (
        /*
         * Labelled where the monitor is not. The monitor is decoration for a row whose
         * title already names it; this one carries a fact that appears nowhere else in the
         * row, so it has to survive being read rather than seen.
         */
        <Mark
          paths={X_PATHS}
          className="shead__mark shead__mark--ended"
          label={`Ended — no activity for ${relativeTime(session.endedAt, now)}`}
        />
      )}
      <span className="shead__title">{session.title ?? 'Untitled session'}</span>
      <span className="shead__meta">
        {session.commitCount} commit{session.commitCount === 1 ? '' : 's'}
        {' · '}
        {session.promptCount} prompt{session.promptCount === 1 ? '' : 's'}
        {tokens > 0 && ` · ${formatTokens(tokens)}`}
      </span>
      {session.branches.length > 1 && (
        // Roughly a fifth of sessions touch more than one branch. Saying so beats leaving
        // the reader to notice that the band straddles two lanes.
        <span className="shead__multi">{session.branches.length} branches</span>
      )}
      {session.elsewhere !== undefined && session.elsewhere > 0 && (
        /*
         * The count to the left is scoped to this tab, and the same band one tab over will
         * report a different one. Without this the two look like a contradiction; with it
         * they read as two views of one session, which is what they are.
         */
        <span className="shead__elsewhere" title={`${session.elsewhere} more in another worktree`}>
          +{session.elsewhere} elsewhere
        </span>
      )}
      <span className="shead__rule" />
      {onExport && (
        /*
         * Hidden until the row is hovered or the button is focused. A band is a label, and
         * a control sitting permanently on every one of them would turn a quiet annotation
         * into a toolbar. Focus is in the condition as well as hover so it stays reachable
         * from the keyboard.
         */
        <button
          className="shead__export"
          type="button"
          onClick={onExport}
          title={`Save these ${session.commitCount} commit${session.commitCount === 1 ? '' : 's'} as an SVG`}
        >
          export
        </button>
      )}
    </div>
  )
}

/**
 * One icon from `icons.ts`, at the size `.shead__mark` sets.
 *
 * `currentColor` on the stroke and nothing on `fill`, so a single `color` declaration in
 * the CSS governs the whole glyph. A `label` promotes the icon from decoration to content:
 * without one it is hidden from the accessibility tree entirely, rather than announced as
 * an unnamed graphic.
 */
function Mark({
  paths,
  className,
  label,
}: {
  paths: readonly string[]
  className: string
  label?: string
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : 'img'}
      aria-hidden={label === undefined ? true : undefined}
    >
      {/* Names the icon for a screen reader and doubles as its hover tooltip, which is
          more specific than the row-wide one it sits inside. */}
      {label !== undefined && <title>{label}</title>}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

function sessionTooltip(session: SessionBandInfo, now: number): string {
  const lines = [
    session.title ?? 'Untitled session',
    `Observed alongside ${session.commitCount} commit${session.commitCount === 1 ? '' : 's'}`,
    `${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}`,
    `${formatTokens(session.inputTokens)} in · ${formatTokens(session.outputTokens)} out`,
  ]
  if (session.model) lines.push(session.model)
  lines.push(`${new Date(session.startedAt).toLocaleString()} — ${duration(session)}`)
  if (session.branches.length > 0) lines.push(`Branches: ${session.branches.join(', ')}`)
  /*
   * Says what was measured, not just the verdict. The mark is an inference from a silent
   * transcript, so the row it qualifies should show the reader the evidence and let them
   * disagree with it.
   */
  lines.push(
    sessionEnded(session.endedAt, now)
      ? `Ended — no activity for ${relativeTime(session.endedAt, now)}`
      : `Active — last activity ${relativeTime(session.endedAt, now)}`,
  )
  return lines.join('\n')
}


function duration(session: SessionBandInfo): string {
  const minutes = Math.round((session.endedAt - session.startedAt) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(1)} hr`
  return `${(hours / 24).toFixed(1)} days`
}
