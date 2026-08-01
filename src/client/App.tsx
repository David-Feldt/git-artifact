import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoInfo } from '../api.js'
import { CommitCard } from './components/CommitCard.js'
import { Rails } from './components/Rails.js'
import { WipNode } from './components/WipNode.js'
import { SessionHeader } from './components/SessionHeader.js'
import { WorktreeStrip } from './components/WorktreeStrip.js'
import {
  GUTTER_PAD,
  ROW_HEIGHT,
  buildDisplayRows,
  gutterWidth,
  rowHeight,
  rowOffsets,
} from './components/layout.js'
import { useGraphStream, type Connection } from './hooks/useGraphStream.js'

export function App() {
  const { graph, status, problem, connection, fatal } = useGraphStream()

  // One clock for the whole render, ticking slowly. Every row would otherwise call
  // Date.now() independently and disagree, and a fast tick would rerender the tree for
  // no visible change.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20_000)
    return () => window.clearInterval(id)
  }, [])

  const rows = useMemo(
    () => buildDisplayRows(graph?.rows ?? [], status?.worktrees ?? [], graph?.sessions ?? []),
    [graph, status],
  )
  // Rows are no longer a uniform height, so positions come from here rather than from
  // multiplying an index. Both the SVG rails and the HTML cards read the same array.
  const offsets = useMemo(() => rowOffsets(rows), [rows])

  useEffect(() => {
    document.title = graph ? `${graph.repo.name} · git-artifact` : 'git-artifact'
  }, [graph])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusedSha, setFocusedSha] = useState<string | null>(null)

  /**
   * Scroll a worktree's HEAD into view.
   *
   * Row positions are computed rather than measured — every row is exactly one
   * ROW_HEIGHT, which is the same property that makes virtualisation drop in later — so
   * this needs no DOM query and stays correct while the list is still rendering.
   */
  const revealSha = useCallback(
    (sha: string) => {
      const index = rows.findIndex((r) => r.kind === 'commit' && r.row.commit.sha === sha)
      if (index === -1) return
      setFocusedSha(sha)
      scrollRef.current?.scrollTo({
        // Bias upward so the target lands a third of the way down rather than at the very
        // top, where its surrounding history would be cut off.
        top: Math.max(0, index * ROW_HEIGHT - (scrollRef.current.clientHeight ?? 0) / 3),
        behavior: 'smooth',
      })
    },
    [rows],
  )

  if (fatal) {
    return (
      <div className="app">
        <div className="empty">
          <div className="empty__title">Not authorised</div>
          <p>{fatal}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <span className="header__name">{graph?.repo.name ?? 'git-artifact'}</span>
        {graph?.repo.currentBranch != null && (
          <span className="header__branch">{graph.repo.currentBranch}</span>
        )}
        {graph?.repo.state.detachedHead && <span className="header__branch">detached HEAD</span>}
        <span className="header__spacer" />
        {graph && (
          <span className="header__meta">
            {graph.rows.length} commit{graph.rows.length === 1 ? '' : 's'}
          </span>
        )}
        <ConnectionBadge connection={connection} />
      </header>

      {graph && (
        <WorktreeStrip
          lanes={graph.worktreeLanes}
          statuses={status?.worktrees ?? []}
          onSelect={revealSha}
        />
      )}

      <div className="banners">
        {graph && <StateBanners repo={graph.repo} capped={graph.capped} maxCount={graph.maxCount} />}
        {problem && (
          <div className="banner banner--error">
            <span>{problem.message}</span>
            {problem.detail && <span className="banner__detail">{problem.detail}</span>}
          </div>
        )}
        {connection === 'down' && (
          <div className="banner banner--error">
            <span>Lost contact with the git-artifact daemon. Reconnecting…</span>
          </div>
        )}
      </div>

      <div className="scroll" ref={scrollRef}>
        {graph === null ? (
          <div className="empty">
            <div className="empty__title">Reading the repository…</div>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState repo={graph.repo} />
        ) : (
          <div className="graph">
            <div className="graph__body" style={{ height: offsets[rows.length] ?? 0 }}>
              <Rails rows={rows} width={graph.width} />
              {/* The extent rails sit behind the cards but above the graph, in the right
                  margin — the quietest part of a row, holding only a timestamp. */}
              {graph.sessions.map((session) => {
                const first = rows.findIndex(
                  (r) => r.kind === 'session' && r.session.sessionId === session.sessionId,
                )
                const last = rows.findIndex(
                  (r) =>
                    r.kind === 'commit' &&
                    r.row.commit.sha === graph.rows[session.endRow]?.commit.sha,
                )
                if (first === -1 || last === -1) return null
                const top = offsets[first] ?? 0
                const bottom = (offsets[last] ?? 0) + rowHeight(rows[last]!)
                return (
                  <div
                    key={`band:${session.sessionId}`}
                    className="sband"
                    style={{ top, height: bottom - top }}
                    aria-hidden="true"
                  />
                )
              })}
              {rows.map((row) => (
                <div
                  key={rowKey(row)}
                  className={[
                    'row',
                    row.kind === 'wip' ? 'wip' : '',
                    row.kind === 'session' ? 'row--session' : '',
                    row.kind === 'commit' && row.row.commit.sha === focusedSha ? 'row--focus' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    top: offsets[row.index] ?? 0,
                    height: rowHeight(row),
                    paddingLeft: gutterWidth(graph.width) - GUTTER_PAD / 2,
                  }}
                >
                  {row.kind === 'commit' ? (
                    <CommitCard
                      row={row.row}
                      now={now}
                      pushes={graph.pushes[row.row.commit.sha]}
                    />
                  ) : row.kind === 'wip' ? (
                    <WipNode worktree={row.worktree} />
                  ) : (
                    <SessionHeader session={row.session} />
                  )}
                </div>
              ))}
            </div>
            {graph.capped && (
              <p className="empty">
                Showing the most recent {graph.maxCount} commits. Restart with
                {' '}<code>--max-count</code> to load more.
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="footer">
        <span>read-only</span>
        <span>no telemetry</span>
        {graph && <span title={graph.repo.root}>{graph.repo.root}</span>}
      </footer>
    </div>
  )
}

/** Stable React key per row kind; a session and a commit can never collide. */
function rowKey(row: import('./components/layout.js').DisplayRow): string {
  switch (row.kind) {
    case 'commit':
      return row.row.commit.sha
    case 'wip':
      return `wip:${row.worktree.path}`
    case 'session':
      return `session:${row.session.sessionId}:${row.session.startRow}`
  }
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const label =
    connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting' : 'disconnected'
  return (
    <span className={`conn conn--${connection}`}>
      <span className="conn__dot" />
      {label}
    </span>
  )
}

/**
 * Repository conditions worth saying out loud.
 *
 * Every one of these is a state a healthy repo passes through, so none is an error — but
 * each one changes what the graph means, and silently rendering a truncated or frozen
 * view would be worse than saying so.
 */
function StateBanners({
  repo,
  capped,
  maxCount,
}: {
  repo: RepoInfo
  capped: boolean
  maxCount: number
}) {
  const notes: string[] = []
  // A repo with no commits but a dirty working tree still has a WIP row to draw, so the
  // graph is not "empty" and the full-page empty state never fires. Without this banner
  // that case renders a lone WIP node and never explains why there is no history.
  if (repo.state.empty) {
    notes.push('No commits yet — everything below is uncommitted work.')
  }
  if (repo.state.bare) notes.push('Bare repository — no working tree, so uncommitted work is not tracked.')
  if (repo.state.shallow) notes.push('Shallow clone — history is truncated at the graft boundary.')
  if (repo.state.rebaseInProgress) notes.push('A rebase is in progress.')
  if (repo.state.mergeInProgress) notes.push('A merge is in progress.')
  if (repo.state.cherryPickInProgress) notes.push('A cherry-pick is in progress.')
  if (repo.state.detachedHead) notes.push('HEAD is detached.')
  if (capped) notes.push(`History capped at ${maxCount} commits.`)

  return (
    <>
      {notes.map((note) => (
        <div className="banner" key={note}>
          <span>{note}</span>
        </div>
      ))}
    </>
  )
}

function EmptyState({ repo }: { repo: RepoInfo }) {
  if (repo.state.empty) {
    return (
      <div className="empty">
        <div className="empty__title">No commits yet</div>
        <p>
          This repository has been initialised but nothing has been committed. Make a commit
          and the graph will appear here on its own.
        </p>
      </div>
    )
  }
  return (
    <div className="empty">
      <div className="empty__title">Nothing to show</div>
      <p>No commits matched the current window. Try relaxing <code>--since</code>.</p>
    </div>
  )
}
