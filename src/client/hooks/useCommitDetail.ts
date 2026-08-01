import { useEffect, useRef, useState } from 'react'
import type { CommitDetail } from '../../api.js'
import { readToken } from './useGraphStream.js'

export interface DetailState {
  detail: CommitDetail | null
  loading: boolean
  error: string | null
}

/**
 * Fetch one commit's patch, on demand.
 *
 * Deliberately not part of the event stream. The graph is pushed because it changes under
 * you; a patch is fixed by its sha and is wanted for the one row you opened, so it is
 * pulled instead and kept in a cache that never needs invalidating.
 *
 * The request is sequenced, not just aborted: clicking down a list of commits faster than
 * git can answer would otherwise let an earlier response land after a later one and show
 * the wrong diff under the open row.
 */
export function useCommitDetail(sha: string | null): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, loading: false, error: null })
  const cache = useRef(new Map<string, CommitDetail>())

  useEffect(() => {
    if (sha === null) {
      setState({ detail: null, loading: false, error: null })
      return
    }

    const cached = cache.current.get(sha)
    if (cached !== undefined) {
      setState({ detail: cached, loading: false, error: null })
      return
    }

    const controller = new AbortController()
    setState({ detail: null, loading: true, error: null })

    fetch(`/api/commit?sha=${encodeURIComponent(sha)}&t=${encodeURIComponent(readToken())}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json()) as CommitDetail & { error?: string }
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
        return body
      })
      .then((detail) => {
        cache.current.set(sha, detail)
        setState({ detail, loading: false, error: null })
      })
      .catch((err: unknown) => {
        // An abort is this effect being torn down, not a failure to report.
        if (controller.signal.aborted) return
        setState({
          detail: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    return () => controller.abort()
  }, [sha])

  return state
}
