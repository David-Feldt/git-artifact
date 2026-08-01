import { useEffect, useRef, useState } from 'react'
import type { SessionDetail, SessionPromptInfo } from '../../api.js'
import { formatDuration, formatTokens, relativeTime } from '../format.js'
import type { SessionDetailState } from '../hooks/useSessionDetail.js'

/**
 * A session's prompts, dropped down over the graph.
 *
 * The card in the strip above answers "what was this session" in six words. This answers
 * "what did I actually ask it", which is the question the card kept provoking and could not
 * hold — prompts are unbounded text and there are dozens of them, so they need a surface
 * that scrolls and can be dismissed rather than a slot on a 190px card.
 *
 * Two rules carry through from the strip. Everything here is *read* from the transcript,
 * never inferred, so there is no "observed alongside" caveat to carry. And every failure is
 * silent: no transcript means an empty panel, not a banner.
 *
 * Prompt text is untrusted — it is whatever was pasted into a terminal, and it reaches this
 * component unsanitised. It is rendered as a text node and must stay that way.
 */

interface SessionModalProps {
  state: SessionDetailState
  /** Shown in the header before the fetch lands, so the panel is never blank on open. */
  fallbackTitle: string | null
  now: number
  onClose: () => void
}

/**
 * Lines of a prompt shown before it is collapsed.
 *
 * Prompts are bimodal: most are a sentence, and a handful are an entire pasted file — the
 * largest measured on this repository is 83 KB. Showing every one in full would bury the
 * short ones that are usually what you came to read, so the long ones collapse and say so.
 */
const CLAMP_LINES = 6

export function SessionModal({ state, fallbackTitle, now, onClose }: SessionModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, from anywhere. Bound on the window rather than on the panel so it works
  // before focus has landed and after the reader has clicked the page behind.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stop the graph's own Escape handler from also closing an expanded commit row
        // underneath. Dismissing two things with one key reads as a glitch.
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const detail = state.detail
  const title = detail?.title ?? fallbackTitle ?? 'Untitled session'

  return (
    <div className="smodal" onMouseDown={onClose}>
      {/* The backdrop closes; the panel must not. `mousedown` rather than `click` so a
          selection dragged from inside the panel and released on the backdrop does not
          dismiss the thing you were selecting from. */}
      <div
        className="smodal__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Prompts from ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="smodal__head">
          {detail?.live != null && <span className="smodal__dot" aria-hidden="true" />}
          <h2 className="smodal__title">{title}</h2>
          <button
            className="smodal__close"
            onClick={onClose}
            title="Close (Esc)"
            type="button"
            ref={closeRef}
          >
            ✕
          </button>
        </header>

        {detail !== null && <Summary detail={detail} now={now} />}

        <div className="smodal__body">
          {state.error !== null ? (
            <p className="smodal__notice">{state.error}</p>
          ) : state.loading ? (
            <p className="smodal__notice">Reading the transcript…</p>
          ) : state.missing || detail === null ? (
            <p className="smodal__notice">
              No transcript for this session — it may have been cleaned up since the graph was
              read.
            </p>
          ) : detail.prompts.length === 0 ? (
            <p className="smodal__notice">This session recorded no prompts.</p>
          ) : (
            <ol className="smodal__prompts">
              {detail.prompts.map((prompt, index) => (
                <Prompt
                  key={`${prompt.at}:${index}`}
                  prompt={prompt}
                  showDate={spansDays(detail)}
                />
              ))}
            </ol>
          )}
        </div>

        {detail?.clipped && (
          <footer className="smodal__foot">
            Some prompts were long enough to be clipped for transport.
          </footer>
        )}
      </div>
    </div>
  )
}

/**
 * The header numbers.
 *
 * Working time and span are both shown, and showing only one would misrepresent the
 * session either way: a session left open overnight spans sixteen hours and worked for
 * forty minutes of them. The span says when it happened, the working figure says how long
 * it took, and on an ordinary session they differ by an order of magnitude.
 */
function Summary({ detail, now }: { detail: SessionDetail; now: number }) {
  return (
    <div className="smodal__summary">
      <span>
        {detail.prompts.length} prompt{detail.prompts.length === 1 ? '' : 's'}
      </span>
      {/* Null means no turn was ever recorded, which is not zero — so it is omitted
          entirely rather than rendered as "0s". */}
      {detail.workingMs !== null && (
        <span title="Summed over this session's recorded turns, idle time excluded">
          {formatDuration(detail.workingMs)} working
        </span>
      )}
      <span title={`${new Date(detail.startedAt).toLocaleString()} — ${new Date(detail.endedAt).toLocaleString()}`}>
        {formatDuration(detail.endedAt - detail.startedAt)} elapsed
      </span>
      {detail.outputTokens > 0 && <span>{formatTokens(detail.outputTokens)} out</span>}
      {detail.inputTokens > 0 && <span>{formatTokens(detail.inputTokens)} in</span>}
      <span className="smodal__spacer" />
      {detail.live != null ? (
        <span className="smodal__live">{detail.live.status ?? 'running'}</span>
      ) : (
        <span>{relativeTime(detail.endedAt, now)} ago</span>
      )}
    </div>
  )
}

function Prompt({ prompt, showDate }: { prompt: SessionPromptInfo; showDate: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const at = new Date(prompt.at)
  // Cheap and good enough: the clamp is a CSS line count, and measuring the rendered height
  // to decide whether the control is needed would cost a layout pass per prompt on open.
  // Over-offering "show more" on a prompt that happened to fit is invisible; the button
  // simply reveals the same text.
  const long = prompt.text.length > 280 || prompt.text.split('\n').length > CLAMP_LINES

  return (
    <li className="sprompt">
      <div className="sprompt__gutter">
        <time className="sprompt__at" dateTime={at.toISOString()} title={at.toLocaleString()}>
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {showDate && (
          <span className="sprompt__date">
            {at.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
        )}
        {prompt.durationMs !== null && (
          <span className="sprompt__took" title="How long the turn that followed took">
            {formatDuration(prompt.durationMs)}
          </span>
        )}
      </div>

      <div className="sprompt__main">
        {/* Untrusted text, as a text node. `pre-wrap` in the stylesheet keeps the shape of
            what was typed without a parser ever touching it. */}
        <p className={expanded || !long ? 'sprompt__text' : 'sprompt__text sprompt__text--clamped'}>
          {prompt.text}
        </p>
        {(long || prompt.clipped) && (
          <button className="sprompt__more" type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show more'}
            {prompt.clipped && expanded ? ' (clipped)' : ''}
          </button>
        )}
      </div>
    </li>
  )
}

/** Whether to date each prompt, which is only worth the column on a multi-day session. */
function spansDays(detail: SessionDetail): boolean {
  return new Date(detail.startedAt).toDateString() !== new Date(detail.endedAt).toDateString()
}
