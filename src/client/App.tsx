import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoInfo, SessionBandInfo } from '../api.js'
import { downloadSvg } from './export/download.js'
import { CommitCard } from './components/CommitCard.js'
import { CommitDetailPanel } from './components/CommitDetail.js'
import { ExportControls } from './components/ExportControls.js'
import { Rails } from './components/Rails.js'
import { WipNode } from './components/WipNode.js'
import { SessionHeader } from './components/SessionHeader.js'
import { ViewTabs } from './components/ViewTabs.js'
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
  sessionSpan,
  sliceRows,
} from './components/layout.js'
import { useCommitDetail } from './hooks/useCommitDetail.js'
import { useGraphStream, type Connection } from './hooks/useGraphStream.js'
import { ALL_VIEW, buildViews, selectView } from './views.js'

export function App() {
  const { graph, status, problem, connection, fatal } = useGraphStream()
  const [selected, setSelected] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<string>(ALL_VIEW)

  // One clock for the whole render, ticking slowly. Every row would otherwise call
  // Date.now() independently and disagree, and a fast tick would rerender the tree for
  // no visible change.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20_000)
    return () => window.clearInterval(id)
  }, [])

  /*
   * The unified graph plus one scoped view per worktree, derived entirely on the client
   * from the payload already in memory. Switching tabs therefore costs no round trip and
   * cannot show something the graph disagrees with — see `views.ts`.
   */
  const views = useMemo(
    () => (graph === null ? [] : buildViews(graph, status?.worktrees ?? [])),
    [graph, status],
  )

  /*
   * Everything below reads `view.graph`, never the payload directly. A tab is a filtered,
   * re-laned copy with the same shape, so the rails, the export and the session bands all
   * work against it unchanged — which is what keeps the scoping in one file instead of
   * spread through every consumer.
   *
   * `selectView` falls back to the unified view, so deleting the worktree you are looking
   * at drops you back to "All" rather than to an empty graph.
   */
  const view = views.length === 0 ? null : selectView(views, activeView)
  const vgraph = view?.graph ?? null

  const rows = useMemo(
    () => buildDisplayRows(vgraph?.rows ?? [], view?.statuses ?? [], vgraph?.sessions ?? []),
    [vgraph, view],
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

  const [exportError, setExportError] = useState<string | null>(null)

  /**
   * Open a commit's generated page in its own window.
   *
   * `window.open` and nothing else, deliberately. A popup opened after an `await` has lost
   * the user gesture that permits it and is blocked, so the window is opened immediately
   * and the daemon serves it a shell that starts the work and polls itself.
   *
   * Named per sha, so asking twice focuses the window already open on that commit rather
   * than stacking a second one over it.
   */
  const explain = useCallback((sha: string) => {
    const opened = window.open(
      `/artifact?sha=${encodeURIComponent(sha)}`,
      `git-artifact-${sha}`,
      'popup,width=940,height=900,noopener=no',
    )
    setExportError(
      opened === null
        ? 'Your browser blocked the popup. Allow popups for this page and try again.'
        : null,
    )
    opened?.focus()
  }, [])

  /**
   * Save one band's commits, rather than the whole graph.
   *
   * A session-sized excerpt is a few hundred pixels tall where a full history runs to
   * thousands, which is the difference between an image someone reads in a pull request and
   * one they scroll past. The rows are renumbered by `sliceRows`, because the rails read
   * their vertical position from a row's index within the list being drawn.
   */
  const exportSession = useCallback(
    (session: SessionBandInfo) => {
      if (vgraph === null) return
      const span = sessionSpan(vgraph.rows, rows, session)
      if (span === null) return
      try {
        setExportError(null)
        downloadSvg(
          { graph: vgraph, rows: sliceRows(rows, span.first, span.last), now },
          { scopeLabel: session.title ?? 'Untitled session' },
        )
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'The export failed.')
      }
    },
    [vgraph, rows, now],
  )

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
   * Switch tabs.
   *
   * The strip this replaced scrolled you to a tip buried in the middle of a graph holding
   * every other checkout. A scoped view puts that tip at the top by construction, so there
   * is nothing to hunt for — the scroll resets instead of animating, because the rows
   * underneath have been replaced wholesale and smoothly travelling through the old
   * view's geometry to reach the new view's offset would just be motion for its own sake.
   *
   * The tip still gets the focus flash, which is the one thing the strip did that is worth
   * keeping: it answers "which of these commits is the one I switched to".
   */
  const selectViewKey = useCallback(
    (key: string) => {
      setActiveView(key)
      scrollRef.current?.scrollTo({ top: 0 })
      setFocusedSha(views.find((v) => v.key === key)?.worktree?.head ?? null)
    },
    [views],
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
        {/* Counts and exports follow the tab: reporting the whole repository's total above
            a graph showing one worktree's slice of it would be describing something the
            reader cannot see. */}
        {vgraph && (
          <span className="header__meta">
            {vgraph.rows.length} commit{vgraph.rows.length === 1 ? '' : 's'}
          </span>
        )}
        {vgraph && <ExportControls graph={vgraph} rows={rows} now={now} />}
        <ConnectionBadge connection={connection} />
      </header>

      <ViewTabs
        views={views}
        active={view?.key ?? ALL_VIEW}
        statuses={status?.worktrees ?? []}
        onSelect={selectViewKey}
      />

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
        {exportError && (
          <div className="banner banner--error">
            <span>{exportError}</span>
          </div>
        )}
      </div>

      <div className="scroll" ref={scrollRef}>
        {vgraph === null ? (
          <div className="empty">
            <div className="empty__title">Reading the repository…</div>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState repo={vgraph.repo} scoped={view?.worktree != null} />
        ) : (
          <div className="graph">
            <div className="graph__body" style={{ height: bodyHeight(offsets) }}>
              <Rails rows={rows} width={vgraph.width} expandedIndex={expanded?.index ?? null} />
              {/* The extent rails sit behind the cards but above the graph, in the right
                  margin — the quietest part of a row, holding only a timestamp. Positions
                  come from the same offsets the rails use, so a band stretches correctly
                  when a detail panel opens inside it. */}
              {vgraph.sessions.map((session) => {
                const first = rows.findIndex(
                  (r) => r.kind === 'session' && r.session.sessionId === session.sessionId,
                )
                const last = rows.findIndex(
                  (r) =>
                    r.kind === 'commit' &&
                    r.row.commit.sha === vgraph.rows[session.endRow]?.commit.sha,
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
                    paddingLeft: gutterWidth(vgraph.width) - GUTTER_PAD / 2,
                  }}
                >
                  {row.kind === 'commit' ? (
                    <CommitCard
                      row={row.row}
                      now={now}
                      pushes={vgraph.pushes[row.row.commit.sha]}
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
                    <SessionHeader
                      session={row.session}
                      onExport={() => exportSession(row.session)}
                    />
                  )}
                </div>
              ))}
              {expanded !== null && (
                <div
                  className="detail-slot"
                  style={{
                    top: detailTop(rows, offsets, expanded.index),
                    height: DETAIL_HEIGHT,
                    left: gutterWidth(vgraph.width) - GUTTER_PAD / 2,
                  }}
                >
                  <CommitDetailPanel
                    detail={detail.detail}
                    loading={detail.loading}
                    error={detail.error}
                    lane={expanded.lane}
                    onClose={close}
                    onExplain={() => explain(expanded.sha)}
                  />
                </div>
              )}
            </div>
            {vgraph.capped && (
              <p className="empty">
                Showing the most recent {vgraph.maxCount} commits. Restart with
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

function EmptyState({ repo, scoped = false }: { repo: RepoInfo; scoped?: boolean }) {
  /*
   * A worktree tab can be empty while the repository is not, which the repo-level copy
   * below would explain incorrectly — it would blame `--since` for a window that is
   * actually fine. This happens when the tip sits outside the loaded set, so its ancestry
   * resolves to nothing.
   */
  if (scoped) {
    return (
      <div className="empty">
        <div className="empty__title">Nothing loaded for this worktree</div>
        <p>
          Its HEAD is outside the current window, so none of its history has been read.
          Other tabs are unaffected — try <code>--max-count</code> or a looser
          {' '}<code>--since</code>.
        </p>
      </div>
    )
  }
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
