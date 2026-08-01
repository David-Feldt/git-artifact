import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoInfo } from '../api.js'
import { CommitCard } from './components/CommitCard.js'
import { CommitDetailPanel } from './components/CommitDetail.js'
import { ExportControls } from './components/ExportControls.js'
import { Rails } from './components/Rails.js'
import { WipNode } from './components/WipNode.js'
import { SessionHeader } from './components/SessionHeader.js'
import { WorktreeStrip } from './components/WorktreeStrip.js'
import {
  DETAIL_HEIGHT,
  GUTTER_PAD,
  bodyHeight,
  buildDisplayRows,
  detailTop,
  gutterWidth,
  rowHeight,
  rowOffsets,
  rowTop,
} from './components/layout.js'
import { useCommitDetail } from './hooks/useCommitDetail.js'
import { useGraphStream, type Connection } from './hooks/useGraphStream.js'

export function App() {
  const { graph, status, problem, connection, fatal } = useGraphStream()
  const [selected, setSelected] = useState<string | null>(null)

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
  /*
   * The open panel is tracked by sha, not by row index, and the index is re-derived on
   * every render. Rows move under you constantly here — a commit, a rebase, or a WIP node
   * appearing all reindex the list — and an index would silently come to mean a different
   * commit. A sha that is no longer in the graph resolves to no row, which closes the
   * panel on its own.
   */
  const expanded = useMemo(() => {
    if (selected === null) return null
    const index = rows.findIndex(
      (row) => row.kind === 'commit' && row.row.commit.sha === selected,
    )
    const row = index === -1 ? undefined : rows[index]
    return row?.kind === 'commit' ? { index, lane: row.row.lane, sha: selected } : null
  }, [rows, selected])

  /*
   * Vertical geometry, computed once and shared by every layer that needs it — the SVG
   * rails, the HTML rows, the detail panel, and the session extent bars.
   *
   * It has to come after `expanded`, because a row's position depends on two things that
   * are not `index * ROW_HEIGHT`: session headers are shorter than commit rows, and an
   * open panel injects a gap beneath its row. Deriving those separately in each layer is
   * how the SVG and the HTML drift apart by a few pixels and it reads as a rendering bug.
   */
  const offsets = useMemo(
    () => rowOffsets(rows, expanded?.index ?? null),
    [rows, expanded],
  )

  const detail = useCommitDetail(expanded?.sha ?? null)

  const close = useCallback(() => setSelected(null), [])

  useEffect(() => {
    if (expanded === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded, close])

  useEffect(() => {
    document.title = graph ? `${graph.repo.name} · git-artifact` : 'git-artifact'
  }, [graph])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusedSha, setFocusedSha] = useState<string | null>(null)

  /**
   * Scroll a worktree's HEAD into view.
   *
   * Positions come from the shared offsets array rather than from measuring the DOM, so
   * this stays correct while the list is still rendering — and, unlike multiplying an
   * index, it stays correct when a session header or an open panel sits above the target.
   */
  const revealSha = useCallback(
    (sha: string) => {
      const index = rows.findIndex((r) => r.kind === 'commit' && r.row.commit.sha === sha)
      if (index === -1) return
      setFocusedSha(sha)
      scrollRef.current?.scrollTo({
        // Bias upward so the target lands a third of the way down rather than at the very
        // top, where its surrounding history would be cut off.
        top: Math.max(0, rowTop(offsets, index) - (scrollRef.current.clientHeight ?? 0) / 3),
        behavior: 'smooth',
      })
    },
    [rows, offsets],
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
        {graph && <ExportControls graph={graph} rows={rows} now={now} />}
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
            <div className="graph__body" style={{ height: bodyHeight(offsets) }}>
              <Rails rows={rows} width={graph.width} expandedIndex={expanded?.index ?? null} />
              {/* The extent rails sit behind the cards but above the graph, in the right
                  margin — the quietest part of a row, holding only a timestamp. Positions
                  come from the same offsets the rails use, so a band stretches correctly
                  when a detail panel opens inside it. */}
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
                const top = rowTop(offsets, first)
                const bottom = rowTop(offsets, last) + rowHeight(rows[last]!)
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
                    top: rowTop(offsets, row.index),
                    height: rowHeight(row),
                    paddingLeft: gutterWidth(graph.width) - GUTTER_PAD / 2,
                  }}
                >
                  {row.kind === 'commit' ? (
                    <CommitCard
                      row={row.row}
                      now={now}
                      pushes={graph.pushes[row.row.commit.sha]}
                      expanded={expanded?.sha === row.row.commit.sha}
                      onToggle={() =>
                        setSelected((current) =>
                          current === row.row.commit.sha ? null : row.row.commit.sha,
                        )
                      }
                    />
                  ) : row.kind === 'wip' ? (
                    <WipNode worktree={row.worktree} />
                  ) : (
                    <SessionHeader session={row.session} />
                  )}
                </div>
              ))}
              {expanded !== null && (
                <div
                  className="detail-slot"
                  style={{
                    top: detailTop(rows, offsets, expanded.index),
                    height: DETAIL_HEIGHT,
                    left: gutterWidth(graph.width) - GUTTER_PAD / 2,
                  }}
                >
                  <CommitDetailPanel
                    detail={detail.detail}
                    loading={detail.loading}
                    error={detail.error}
                    lane={expanded.lane}
                    onClose={close}
                  />
                </div>
              )}
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
