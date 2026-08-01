import { EventEmitter } from 'node:events'
import path from 'node:path'
import type {
  GraphPayload,
  ProblemPayload,
  PushMarker,
  RepoInfo,
  ServerEvent,
  SessionBandInfo,
  StatusPayload,
  WorktreeLane,
} from '../api.js'
import type { Commit, GraphRow } from '../graph/model.js'
import { assignLanes, graphWidth } from '../graph/lanes.js'
import { gitOrNull } from '../git/exec.js'
import { readLog } from '../git/log.js'
import { readPushEvents } from '../git/reflog.js'
import { openRepo, refreshRepo, type Repo } from '../git/repo.js'
import { readStatus } from '../git/status.js'
import { attributeCommits, buildBands } from '../sessions/attribute.js'
import { readSessionsForRepo } from '../sources/claude-code.js'

export interface StoreOptions {
  /** History cap. `git log --all` unbounded on a large repo hangs the first render. */
  maxCount: number
  since?: string
  /** Override the session attribution idle window. See `sessions/attribute.ts`. */
  sessionIdleLimitMs?: number
}

/**
 * Owns the current view of the repo and recomputes it on demand.
 *
 * The filesystem watcher only ever says *when* something changed; this is where we ask
 * git *what* changed. Keeping that split means a missed or duplicated fs event costs at
 * most a redundant `git log`, never a wrong graph.
 *
 * Refreshes are serialised per kind. A burst of writes during a rebase or a build can
 * easily fire faster than git can answer, and without this a slow refresh would be
 * overtaken by a newer one and publish stale data. Instead, a refresh requested while one
 * is in flight is coalesced into a single follow-up run.
 */
export class GraphStore extends EventEmitter {
  private graph: GraphPayload | null = null
  private status: StatusPayload | null = null
  private repo: Repo | null = null
  private remotes: string[] = []

  private graphRunning = false
  private graphQueued = false
  private statusRunning = false
  private statusQueued = false

  constructor(
    private readonly repoPath: string,
    private readonly options: StoreOptions,
  ) {
    super()
  }

  getGraph(): GraphPayload | null {
    return this.graph
  }

  getStatus(): StatusPayload | null {
    return this.status
  }

  getRepo(): Repo | null {
    return this.repo
  }

  /** Load everything once, so the first HTTP request is served from memory. */
  async init(): Promise<void> {
    this.repo = await openRepo(this.repoPath)
    const remotes = await gitOrNull(this.repoPath, ['remote'])
    this.remotes = (remotes ?? '').split('\n').map((r) => r.trim()).filter(Boolean)
    await this.refreshGraph()
    await this.refreshStatus()
  }

  private repoInfo(repo: Repo): RepoInfo {
    return {
      root: repo.root,
      name: path.basename(repo.root),
      state: repo.state,
      currentBranch: repo.currentBranch,
      head: repo.head,
      worktrees: repo.worktrees,
      remotes: this.remotes,
    }
  }

  async refreshGraph(): Promise<void> {
    if (this.graphRunning) {
      this.graphQueued = true
      return
    }
    this.graphRunning = true
    try {
      do {
        this.graphQueued = false
        await this.runGraphRefresh()
      } while (this.graphQueued)
    } finally {
      this.graphRunning = false
    }
  }

  private async runGraphRefresh(): Promise<void> {
    try {
      // HEAD, the branch, the worktree list and the in-progress flags all move underneath
      // us and are what the header renders — but the paths and the graft boundary do not,
      // so only the volatile half is re-read. That is the difference between two git
      // spawns per commit and five, which is most of the perceived update latency.
      const repo = this.repo ? await refreshRepo(this.repo) : await openRepo(this.repoPath)
      this.repo = repo

      const commits = await readLog(this.repoPath, {
        maxCount: this.options.maxCount,
        since: this.options.since,
      })
      const rows = assignLanes(commits, { grafted: repo.grafted })

      this.graph = {
        repo: this.repoInfo(repo),
        rows,
        pushes: await this.readPushes(repo),
        worktreeLanes: this.worktreeLanes(repo, rows),
        sessions: await this.readSessions(repo, commits),
        width: graphWidth(rows),
        // A full read returns exactly the cap when there is more history behind it.
        capped: commits.length >= this.options.maxCount,
        maxCount: this.options.maxCount,
        generatedAt: Date.now(),
      }
      this.emitEvent({ type: 'graph', data: this.graph })
    } catch (err) {
      this.reportProblem('Could not read the commit graph', err)
    }
  }

  async refreshStatus(): Promise<void> {
    if (this.statusRunning) {
      this.statusQueued = true
      return
    }
    this.statusRunning = true
    try {
      do {
        this.statusQueued = false
        await this.runStatusRefresh()
      } while (this.statusQueued)
    } finally {
      this.statusRunning = false
    }
  }

  private async runStatusRefresh(): Promise<void> {
    const repo = this.repo
    if (!repo) return

    // A bare repo has no working tree, so there is nothing uncommitted to report. This is
    // a normal configuration, not a failure — Tier A liveness simply does not apply.
    if (repo.state.bare) {
      this.status = { worktrees: [], generatedAt: Date.now() }
      this.emitEvent({ type: 'status', data: this.status })
      return
    }

    try {
      const now = Date.now()
      const live = repo.worktrees.filter((w) => !w.bare && !w.prunable)
      const worktrees = await Promise.all(
        live.map((w) => readStatus(w.path, { now }).catch(() => null)),
      )

      this.status = {
        worktrees: worktrees.filter((w) => w !== null),
        generatedAt: now,
      }
      this.emitEvent({ type: 'status', data: this.status })
    } catch (err) {
      this.reportProblem('Could not read the working tree status', err)
    }
  }

  /**
   * Push events, keyed by the sha each one landed on.
   *
   * Reflogs expire — 90 days for reachable entries by default — so an empty result is
   * normal for older history and never an error. Events pointing outside the loaded
   * window are dropped rather than carried, since there is no row to attach them to.
   */
  private async readPushes(repo: Repo): Promise<Record<string, PushMarker[]>> {
    const byS: Record<string, PushMarker[]> = {}
    try {
      for (const event of await readPushEvents(repo.commonDir)) {
        const list = byS[event.sha]
        const marker: PushMarker = {
          ref: event.ref,
          at: event.at,
          authorName: event.authorName,
        }
        if (list) list.push(marker)
        else byS[event.sha] = [marker]
      }
    } catch {
      // Push markers are an enrichment; losing them must not cost us the graph.
    }
    return byS
  }

  /**
   * Session bands for the loaded commits.
   *
   * Every failure mode here is silent by design: no Claude Code installed, no transcripts
   * for this repo, an unreadable or unrecognised file. Tier B enriches the view and must
   * never be able to take it down, so this returns an empty list rather than surfacing a
   * problem banner.
   *
   * Commits are matched on *committer* time, not author time — a rebase or an amend
   * rewrites the committer date and leaves the author date alone, so author time would
   * attribute rewritten commits to whenever they were originally written.
   */
  private async readSessions(repo: Repo, commits: Commit[]): Promise<SessionBandInfo[]> {
    try {
      const roots = [repo.root, ...repo.worktrees.filter((w) => !w.bare).map((w) => w.path)]
      const sessions = await readSessionsForRepo(roots)
      if (sessions.length === 0) return []

      const attribution = attributeCommits(
        commits.map((c) => ({ sha: c.sha, at: c.commitDate * 1000 })),
        sessions,
        { idleLimitMs: this.options.sessionIdleLimitMs },
      )
      const byId = new Map(sessions.map((s) => [s.sessionId, s]))

      return buildBands(commits.map((c) => c.sha), attribution).flatMap((band) => {
        const session = byId.get(band.sessionId)
        if (!session) return []
        return [{
          sessionId: band.sessionId,
          title: session.title,
          startRow: band.startRow,
          endRow: band.endRow,
          commitCount: band.shas.length,
          promptCount: session.prompts.length,
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          model: session.model,
          startedAt: session.start,
          endedAt: session.end,
          branches: session.branches,
        }]
      })
    } catch {
      return []
    }
  }

  /** Locate each live worktree's HEAD in the rendered rows. See {@link WorktreeLane}. */
  private worktreeLanes(repo: Repo, rows: GraphRow[]): WorktreeLane[] {
    const laneBySha = new Map<string, number>()
    for (const row of rows) laneBySha.set(row.commit.sha, row.lane)

    return repo.worktrees
      .filter((w) => !w.bare && !w.prunable)
      .map((worktree): WorktreeLane => ({
        path: worktree.path,
        name: path.basename(worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        detached: worktree.detached,
        isMain: worktree.isMain,
        // Null when HEAD fell outside the history cap. The UI says "off-screen" rather
        // than silently pinning the worktree to lane 0.
        lane: worktree.head ? (laneBySha.get(worktree.head) ?? null) : null,
      }))
  }

  private reportProblem(message: string, err: unknown): void {
    const problem: ProblemPayload = {
      message,
      detail: err instanceof Error ? err.message : String(err),
    }
    this.emitEvent({ type: 'problem', data: problem })
  }

  private emitEvent(event: ServerEvent): void {
    this.emit('event', event)
  }

  override on(name: 'event', listener: (event: ServerEvent) => void): this {
    return super.on(name, listener)
  }

  override off(name: 'event', listener: (event: ServerEvent) => void): this {
    return super.off(name, listener)
  }
}
