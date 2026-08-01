import { useEffect, useMemo, useState } from 'react'
import type { RepoInfo } from '../api.js'
import { CommitCard } from './components/CommitCard.js'
import { Rails } from './components/Rails.js'
import { WipNode } from './components/WipNode.js'
import {
  GUTTER_PAD,
  ROW_HEIGHT,
  buildDisplayRows,
  gutterWidth,
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
    () => buildDisplayRows(graph?.rows ?? [], status?.worktrees ?? []),
    [graph, status],
  )

  useEffect(() => {
    document.title = graph ? `${graph.repo.name} · git-artifact` : 'git-artifact'
  }, [graph])

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

      <div className="scroll">
        {graph === null ? (
          <div className="empty">
            <div className="empty__title">Reading the repository…</div>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState repo={graph.repo} />
        ) : (
          <div className="graph">
            <div
              className="graph__body"
              style={{ height: rows.length * ROW_HEIGHT }}
            >
              <Rails rows={rows} width={graph.width} />
              {rows.map((row) => (
                <div
                  key={row.kind === 'commit' ? row.row.commit.sha : `wip:${row.worktree.path}`}
                  className={row.kind === 'wip' ? 'row wip' : 'row'}
                  style={{
                    top: row.index * ROW_HEIGHT,
                    paddingLeft: gutterWidth(graph.width) - GUTTER_PAD / 2,
                  }}
                >
                  {row.kind === 'commit' ? (
                    <CommitCard row={row.row} now={now} />
                  ) : (
                    <WipNode worktree={row.worktree} />
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
