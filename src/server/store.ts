import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { GraphPayload, ProblemPayload, RepoInfo, ServerEvent, StatusPayload } from '../api.js'
import { assignLanes, graphWidth } from '../graph/lanes.js'
import { gitOrNull } from '../git/exec.js'
import { readLog } from '../git/log.js'
import { openRepo, refreshRepo, type Repo } from '../git/repo.js'
import { readStatus } from '../git/status.js'

export interface StoreOptions {
  /** History cap. `git log --all` unbounded on a large repo hangs the first render. */
  maxCount: number
  since?: string
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
