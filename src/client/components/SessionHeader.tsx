import type { SessionBandInfo } from '../../api.js'
import { formatTokens } from '../format.js'

interface SessionHeaderProps {
  session: SessionBandInfo
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
export function SessionHeader({ session }: SessionHeaderProps) {
  const tokens = session.inputTokens + session.outputTokens

  return (
    <div className="shead" title={sessionTooltip(session)}>
      <span className="shead__mark" aria-hidden="true" />
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
      <span className="shead__rule" />
    </div>
  )
}

function sessionTooltip(session: SessionBandInfo): string {
  const lines = [
    session.title ?? 'Untitled session',
    `Observed alongside ${session.commitCount} commit${session.commitCount === 1 ? '' : 's'}`,
    `${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}`,
    `${formatTokens(session.inputTokens)} in · ${formatTokens(session.outputTokens)} out`,
  ]
  if (session.model) lines.push(session.model)
  lines.push(`${new Date(session.startedAt).toLocaleString()} — ${duration(session)}`)
  if (session.branches.length > 0) lines.push(`Branches: ${session.branches.join(', ')}`)
  return lines.join('\n')
}


function duration(session: SessionBandInfo): string {
  const minutes = Math.round((session.endedAt - session.startedAt) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(1)} hr`
  return `${(hours / 24).toFixed(1)} days`
}
