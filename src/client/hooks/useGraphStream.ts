import { useEffect, useRef, useState } from 'react'
import type { GraphPayload, ProblemPayload, StatusPayload } from '../../api.js'

export type Connection = 'connecting' | 'live' | 'down'

export interface StreamState {
  graph: GraphPayload | null
  status: StatusPayload | null
  problem: ProblemPayload | null
  connection: Connection
  /** Set when the daemon rejected us outright; retrying will not help. */
  fatal: string | null
}

/** The token is handed to the page in the URL the CLI printed. */
export function readToken(): string {
  return new URLSearchParams(window.location.search).get('t') ?? ''
}

/**
 * Subscribe to the daemon's event stream.
 *
 * `EventSource` reconnects on its own, but silently and forever, which is exactly the
 * failure mode the plan calls out: a dead daemon must not look like a quiet one. So the
 * connection state is tracked explicitly and surfaced in the header.
 *
 * Auth failures are terminal. `EventSource` reports every error identically, so a 401
 * would otherwise become an infinite reconnect loop against a server that will never
 * accept us; a cheap probe of `/api/graph` distinguishes "daemon is down" from "we are
 * not allowed in" and stops retrying in the latter case.
 */
export function useGraphStream(): StreamState {
  const [graph, setGraph] = useState<GraphPayload | null>(null)
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [problem, setProblem] = useState<ProblemPayload | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [fatal, setFatal] = useState<string | null>(null)

  const retries = useRef(0)
  const timer = useRef<number | null>(null)
  const source = useRef<EventSource | null>(null)

  useEffect(() => {
    const token = readToken()
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
      source.current = es

      es.addEventListener('open', () => {
        retries.current = 0
        setConnection('live')
      })

      es.addEventListener('graph', (event) => {
        setGraph(JSON.parse((event as MessageEvent<string>).data) as GraphPayload)
        setProblem(null)
      })
      es.addEventListener('status', (event) => {
        setStatus(JSON.parse((event as MessageEvent<string>).data) as StatusPayload)
      })
      es.addEventListener('problem', (event) => {
        setProblem(JSON.parse((event as MessageEvent<string>).data) as ProblemPayload)
      })

      es.addEventListener('error', () => {
        es.close()
        if (cancelled) return
        setConnection('down')

        void fetch(`/api/graph?t=${encodeURIComponent(token)}`)
          .then((res) => {
            if (cancelled) return
            if (res.status === 401 || res.status === 403) {
              setFatal(
                'This page is not authorised. Open the URL printed by the git-artifact CLI — it carries a one-time access token.',
              )
              return
            }
            scheduleReconnect()
          })
          .catch(() => {
            if (!cancelled) scheduleReconnect()
          })
      })
    }

    const scheduleReconnect = () => {
      // Back off to 10s so a daemon that is gone for good stops generating traffic, but
      // stay quick for the first few tries — a restart during development is common.
      const delay = Math.min(10_000, 400 * 2 ** retries.current)
      retries.current += 1
      setConnection('connecting')
      timer.current = window.setTimeout(connect, delay)
    }

    connect()

    return () => {
      cancelled = true
      if (timer.current !== null) window.clearTimeout(timer.current)
      source.current?.close()
    }
  }, [])

  return { graph, status, problem, connection, fatal }
}
