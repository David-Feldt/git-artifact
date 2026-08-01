import type { SessionBandInfo } from '../../api.js'
import { formatTokens, relativeTime } from '../format.js'
import { GIT_BRANCH_PATHS, ICON_STROKE, ICON_VIEWBOX } from '../icons.js'

/**
 * Sessions, as cards, above the graph.
 *
 * Deliberately not connected to the commits below, and that is the point. Attribution of a
 * commit to a session is inferred from timing, and measured on this repository it is wrong
 * often enough to matter: sessions run in parallel, so "whichever was active most recently"
 * is close to a coin flip between two live ones. Bands also could not represent the overlap
 * at all — one commit gets exactly one owner, so the picture came out tidier than the truth.
 *
 * Everything on a card is read from a transcript rather than deduced. Branches come from the
 * `gitBranch` stamped on every record, so "this session worked on `export`" is a fact. That
 * makes the strip honest by construction, with no "observed alongside" caveat to carry,
 * because nothing is being claimed.
 *
 * See docs/design/session-bands.md.
 */

interface SessionStripProps {
  sessions: SessionBandInfo[]
  /** Epoch millis, shared with the rest of the render so every row agrees on "now". */
  now: number
}

export interface SessionCard {
  sessionId: string
  title: string | null
  branches: string[]
  promptCount: number
  inputTokens: number
  outputTokens: number
  startedAt: number
  endedAt: number
  live: SessionBandInfo['live']
}

/**
 * One card per session, newest first.
 *
 * `graph.sessions` carries one entry per *band*, and a session splits into several bands
 * whenever another session's commits interleave with its own — measured here, 8 bands for 5
 * sessions. Cards are about sessions, so the bands are collapsed back.
 *
 * The session-level fields are identical across a session's bands, so merging only has to
 * union the branches and take the outer bounds of the timestamps.
 */
export function toCards(sessions: SessionBandInfo[]): SessionCard[] {
  const merged = new Map<string, SessionCard>()

  for (const band of sessions) {
    const existing = merged.get(band.sessionId)
    if (!existing) {
      merged.set(band.sessionId, {
        sessionId: band.sessionId,
        title: band.title,
        branches: [...band.branches],
        promptCount: band.promptCount,
        inputTokens: band.inputTokens,
        outputTokens: band.outputTokens,
        startedAt: band.startedAt,
        endedAt: band.endedAt,
        live: band.live,
      })
      continue
    }
    for (const branch of band.branches) {
      if (!existing.branches.includes(branch)) existing.branches.push(branch)
    }
    existing.startedAt = Math.min(existing.startedAt, band.startedAt)
    existing.endedAt = Math.max(existing.endedAt, band.endedAt)
    // A session is live or it is not; any band saying so is enough.
    existing.live = existing.live ?? band.live
  }

  // Newest last-activity first: the session you were just in is the one you want to see.
  return [...merged.values()].sort((a, b) => b.endedAt - a.endedAt)
}

export function SessionStrip({ sessions, now }: SessionStripProps) {
  const cards = toCards(sessions)
  if (cards.length === 0) return null

  return (
    <div className="sstrip">
      <span className="sstrip__label">
        {cards.length} session{cards.length === 1 ? '' : 's'}
      </span>
      <div className="sstrip__cards">
        {cards.map((card) => (
          <Card key={card.sessionId} card={card} now={now} />
        ))}
      </div>
    </div>
  )
}

function Card({ card, now }: { card: SessionCard; now: number }) {
  const live = card.live !== null
  return (
    <article className={live ? 'scard scard--live' : 'scard'} title={tooltip(card, now)}>
      <div className="scard__top">
        {live && <span className="scard__dot" aria-hidden="true" />}
        <span className="scard__title">{card.title ?? 'Untitled session'}</span>
        <span className="scard__when">
          {live ? (card.live?.status ?? 'live') : relativeTime(card.endedAt, now)}
        </span>
      </div>

      {card.branches.length > 0 && (
        <div className="scard__branches">
          {card.branches.map((branch) => (
            <span className="scard__branch" key={branch}>
              {/* Hidden from the accessibility tree: the branch name beside it already
                  says what this is, so announcing the icon would only repeat it. */}
              <svg
                viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={ICON_STROKE}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {GIT_BRANCH_PATHS.map((d) => (
                  <path key={d} d={d} />
                ))}
              </svg>
              <span className="scard__branch-name">{branch}</span>
            </span>
          ))}
        </div>
      )}

      <div className="scard__meta">
        <span>
          {card.promptCount} prompt{card.promptCount === 1 ? '' : 's'}
        </span>
        {card.outputTokens > 0 && <span>{formatTokens(card.outputTokens)} out</span>}
        {card.inputTokens > 0 && <span>{formatTokens(card.inputTokens)} in</span>}
      </div>
    </article>
  )
}

function tooltip(card: SessionCard, now: number): string {
  const lines = [
    card.title ?? 'Untitled session',
    `${card.promptCount} prompt${card.promptCount === 1 ? '' : 's'}`,
    `${formatTokens(card.inputTokens)} in · ${formatTokens(card.outputTokens)} out`,
    `${new Date(card.startedAt).toLocaleString()} — ${duration(card)}`,
  ]
  if (card.branches.length > 0) lines.push(`Branches: ${card.branches.join(', ')}`)
  lines.push(
    card.live !== null
      ? `Running now${card.live.status ? ` · ${card.live.status}` : ''}`
      : `Last active ${relativeTime(card.endedAt, now)} ago`,
  )
  // No commit counts here on purpose: which commits a session produced is not recorded.
  return lines.join('\n')
}

function duration(card: SessionCard): string {
  const minutes = Math.round((card.endedAt - card.startedAt) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(1)} hr`
  return `${(hours / 24).toFixed(1)} days`
}
