import { useEffect, useState } from 'react'
import type { SessionDetail } from '../../api.js'
import { readToken } from './useGraphStream.js'

export interface SessionDetailState {
  detail: SessionDetail | null
  loading: boolean
  /** Set only for a genuine failure. A session with no transcript is not one. */
  error: string | null
  /** The daemon looked and found no transcript for this session. */
  missing: boolean
}

const IDLE: SessionDetailState = { detail: null, loading: false, error: null, missing: false }

/**
 * Fetch one session's prompts, on demand.
 *
 * Deliberately uncached, which is the one way this differs from {@link useCommitDetail}. A
 * commit patch is fixed by its sha and can be held forever; a session is *append-only and
 * live* — reopening the card you are currently working in must show the prompt you typed a
 * moment ago, and a cache keyed by session id would show you the session as it was when you
 * last looked. Re-reading costs one local request against a memoised parse.
 *
 * Aborted rather than sequenced, because unlike the commit list there is only ever one
 * panel open: closing it or opening another tears this effect down, and a response that
 * arrives afterwards belongs to a panel that no longer exists.
 */
export function useSessionDetail(sessionId: string | null): SessionDetailState {
  const [state, setState] = useState<SessionDetailState>(IDLE)

  useEffect(() => {
    if (sessionId === null) {
      setState(IDLE)
      return
    }

    const controller = new AbortController()
    setState({ detail: null, loading: true, error: null, missing: false })

    fetch(
      `/api/session?id=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(readToken())}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const body = (await res.json()) as SessionDetail & { error?: string }
        // A missing transcript is an ordinary outcome — the session was for another repo,
        // or its file has been cleaned up — so it is reported as emptiness rather than as
        // a failure. Tier B never surfaces an error the reader cannot act on.
        if (res.status === 404) {
          setState({ detail: null, loading: false, error: null, missing: true })
          return
        }
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
        setState({ detail: body, loading: false, error: null, missing: false })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          detail: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          missing: false,
        })
      })

    return () => controller.abort()
  }, [sessionId])

  return state
}
