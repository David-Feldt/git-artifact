import { EventEmitter } from 'node:events'
import path from 'node:path'
import type {
  CommitDetail,
  GraphPayload,
  ProblemPayload,
  PushMarker,
  RepoInfo,
  ServerEvent,
  SessionBandInfo,
  SessionDetail,
  SessionLiveness,
  SessionPromptInfo,
  StatusPayload,
  WorktreeLane,
} from '../api.js'
import type { Commit, GraphRow } from '../graph/model.js'
import { assignLanes, graphWidth } from '../graph/lanes.js'
import { gitOrNull } from '../git/exec.js'
import { readLog, readLogStats } from '../git/log.js'
import { readPushEvents } from '../git/reflog.js'
import { openRepo, refreshRepo, type Repo } from '../git/repo.js'
import { readCommitDetail } from '../git/show.js'
import { readStatus } from '../git/status.js'
import { attributeCommits, buildBands } from '../sessions/attribute.js'
import {
  readLiveSessions,
  readSessionsForRepo,
  type LiveSession,
  type SessionRecord,
} from '../sources/claude-code.js'
import { listCachedShaPrefixes } from '../artifacts/cache.js'

/**
 * Narrow a registry entry to what the wire carries.
 *
 * The pid is deliberately dropped. It is what the server checks liveness *with*, and it is
 * a fact about this machine that the browser has no use for and an exported artifact should
 * certainly not carry.
 */
function liveness(entry: LiveSession | undefined): SessionLiveness | null {
  return entry === undefined ? null : { status: entry.status }
}

/** Both lists come from the same commit order, so position-wise equality is enough. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * How many commit patches to keep. Small, because the point is only to make re-opening a
 * row you just closed instant — not to hold history in memory.
 */
const DETAIL_CACHE_MAX = 64

/**
 * Ceiling on the prompt text one session response carries.
 *
 * A prompt is whatever someone pasted into a terminal and has no natural bound — the
 * largest single one measured on this repository is 83 KB, against 230 KB for every prompt
 * of every session here combined. The budget is generous enough that a normal session is
 * never touched and low enough that one pathological paste cannot hand the browser a
 * payload it will stall rendering.
 *
 * Spent in order, so it is the newest prompts that survive intact. They are the ones being
 * looked for.
 */
const PROMPT_BYTE_BUDGET = 256 * 1024

/** Per-prompt cap, so one giant paste cannot consume the whole budget by itself. */
const PROMPT_BYTE_CAP = 16 * 1024

/**
 * Project a parsed transcript onto the wire, spending the byte budget newest-first.
 *
 * Truncation is by code unit against a byte budget, which only ever keeps *less* than the
 * budget — the same conservative direction the patch reader takes, and for the same reason:
 * an over-estimate is a smaller response, an under-estimate is an unbounded one.
 */
function toSessionDetail(session: SessionRecord, live: SessionLiveness | null): SessionDetail {
  let remaining = PROMPT_BYTE_BUDGET
  let clipped = false

  // Newest first while spending, then restored to reading order below.
  const prompts: SessionPromptInfo[] = []
  for (let i = session.prompts.length - 1; i >= 0; i -= 1) {
    const prompt = session.prompts[i]!
    const allowance = Math.min(remaining, PROMPT_BYTE_CAP)
    const text = prompt.text.length > allowance ? prompt.text.slice(0, allowance) : prompt.text
    if (text.length < prompt.text.length) clipped = true
    remaining = Math.max(0, remaining - text.length)
    prompts.push({ at: prompt.at, text, durationMs: prompt.durationMs, clipped: text.length < prompt.text.length })
  }
  prompts.reverse()

  return {
    sessionId: session.sessionId,
    title: session.title,
    branches: session.branches,
    startedAt: session.start,
    endedAt: session.end,
    workingMs: session.workingMs,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    model: session.model,
    prompts,
    clipped,
    live,
  }
}

export interface StoreOptions {
  /** History cap. `git log --all` unbounded on a large repo hangs the first render. */
  maxCount: number
  since?: string
  /** Override the session attribution idle window. See `sessions/attribute.ts`. */
  sessionIdleLimitMs?: number
  /**
   * Override the home directory the Claude Code sources read from. For tests.
   *
   * Both sources take it, or a test would get fixture transcripts joined against the
   * developer's real running sessions — which is exactly the kind of pass that depends on
   * who ran it.
   */
  claudeHome?: string
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
  private readonly detailCache = new Map<string, CommitDetail>()

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

  /**
   * Read one commit's patch, memoised.
   *
   * Everything {@link CommitDetail} carries is determined by the sha — that is what a sha
   * means — so an entry can never go stale and no invalidation hook is needed. Insertion
   * order doubles as the LRU: re-reading moves the key to the end.
   */
  async getCommitDetail(sha: string): Promise<CommitDetail> {
    const cached = this.detailCache.get(sha)
    if (cached !== undefined) {
      this.detailCache.delete(sha)
      this.detailCache.set(sha, cached)
      return cached
    }

    const detail = await readCommitDetail(this.repoPath, sha)
    this.detailCache.set(sha, detail)
    if (this.detailCache.size > DETAIL_CACHE_MAX) {
      const oldest = this.detailCache.keys().next()
      if (!oldest.done) this.detailCache.delete(oldest.value)
    }
    return detail
  }

  /**
   * One session's prompts and timings, on demand.
   *
   * Pulled rather than pushed, like a commit patch and for the same reason — except that
   * unlike a patch this one *is* volatile. A running session grows a prompt every time you
   * type, so nothing here is cached: the transcript parse behind it is already memoised on
   * size and mtime, which makes a dormant session's re-read a `stat` and leaves only the
   * live session — the one whose file actually changed — to re-parse.
   *
   * That re-parse is the cost of this endpoint, and it is bounded by the transcript rather
   * than by anything we control: the largest here is 11 MB. It is paid on a click, once,
   * which is why this is a route of its own and not part of the refresh path.
   *
   * Tier B throughout. `null` for a session that no longer exists, a transcript that has
   * been deleted, or a format we cannot read — the panel says it found nothing rather than
   * raising a problem banner.
   */
  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const repo = this.repo
    if (repo === null) return null

    try {
      const roots = [repo.root, ...repo.worktrees.filter((w) => !w.bare).map((w) => w.path)]
      const sessions = await readSessionsForRepo(roots, { home: this.options.claudeHome })
      const session = sessions.find((s) => s.sessionId === sessionId)
      if (session === undefined) return null

      const live = await readLiveSessions({ home: this.options.claudeHome })
      return toSessionDetail(session, liveness(live.get(sessionId)))
    } catch {
      return null
    }
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

      const logOptions = { maxCount: this.options.maxCount, since: this.options.since }
      // Issued together: the stats traversal makes git diff every commit it walks, and
      // that is latency the graph should wait beside rather than behind.
      const [commits, stats] = await Promise.all([
        readLog(this.repoPath, logOptions),
        this.readStats(logOptions),
      ])
      const rows = assignLanes(commits, { grafted: repo.grafted })

      this.graph = {
        repo: this.repoInfo(repo),
        rows,
        stats,
        pushes: await this.readPushes(repo),
        worktreeLanes: this.worktreeLanes(repo, rows),
        sessions: await this.readSessions(repo, commits),
        artifacts: await this.readArtifacts(repo, commits),
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
   * Diff size per commit, for the counts on each row.
   *
   * Swallowed like the other enrichments, and for a sharper reason than most: the counts
   * come from a second `git log` that asks for more work than the first one, so it is the
   * read most likely to time out on a large repository or to be refused by an old git that
   * has no `--diff-merges`. Rows without counts are a smaller loss than no rows.
   */
  private async readStats(opts: { maxCount: number; since?: string }) {
    try {
      return await readLogStats(this.repoPath, opts)
    } catch {
      return {}
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
      const sessions = await readSessionsForRepo(roots, { home: this.options.claudeHome })
      if (sessions.length === 0) return []

      const attribution = attributeCommits(
        commits.map((c) => ({ sha: c.sha, at: c.commitDate * 1000 })),
        sessions,
        { idleLimitMs: this.options.sessionIdleLimitMs },
      )
      const byId = new Map(sessions.map((s) => [s.sessionId, s]))
      const live = await readLiveSessions({ home: this.options.claudeHome })

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
          live: liveness(live.get(band.sessionId)),
        }]
      })
    } catch {
      return []
    }
  }

  /**
   * Re-read which sessions are running, and nothing else.
   *
   * The registry changes for reasons the repository knows nothing about — a session starts,
   * goes idle, exits — so it gets its own refresh rather than riding on the graph's. That
   * separation is not tidiness. A full graph refresh re-parses transcripts, and the
   * transcript of the session whose status just changed is precisely the one being appended
   * to, so its size-and-mtime cache entry is always cold. Re-reading a 9 MB file every time
   * Claude picks up a tool would put a live session's own chatter in the update path.
   *
   * Publishes only on an actual change. Status flips arrive in bursts and most of them do
   * not alter what any band renders; pushing an unchanged graph down the SSE would re-render
   * the client's whole tree for nothing.
   */
  async refreshLiveness(): Promise<void> {
    const graph = this.graph
    if (graph === null || graph.sessions.length === 0) return

    try {
      const live = await readLiveSessions({ home: this.options.claudeHome })
      let changed = false

      const sessions = graph.sessions.map((band) => {
        const next = liveness(live.get(band.sessionId))
        if (next?.status === band.live?.status && (next === null) === (band.live === null)) {
          return band
        }
        changed = true
        return { ...band, live: next }
      })

      if (!changed) return
      // A new object, because the client diffs payloads by identity.
      this.graph = { ...graph, sessions }
      this.emitEvent({ type: 'graph', data: this.graph })
    } catch {
      // Tier B. Bands keep whatever liveness they last had rather than losing the graph.
    }
  }

  /**
   * Which of the loaded commits already have a generated page.
   *
   * One directory listing, matched against the commits in hand. The cache stores 12-char sha
   * prefixes, and this maps them back to full shas rather than making the client compare
   * prefixes — a prefix is an implementation detail of the filename, and putting it on the
   * wire would leak it into every consumer.
   */
  private async readArtifacts(repo: Repo, commits: Commit[]): Promise<string[]> {
    try {
      const prefixes = await listCachedShaPrefixes(repo.root)
      if (prefixes.size === 0) return []
      return commits.map((c) => c.sha).filter((sha) => prefixes.has(sha.slice(0, 12)))
    } catch {
      return [] // Tier B: no marks rather than no graph.
    }
  }

  /**
   * Re-read which commits have a page, and nothing else.
   *
   * Generating an artifact writes outside the repository, so nothing the watcher sees moves
   * and the graph would otherwise keep saying "not generated" until the next commit. The
   * service calls this when it finishes writing.
   *
   * Separate from the graph refresh for the same reason liveness is: this costs one readdir,
   * where a full refresh re-runs `git log` and re-parses transcripts. Publishes only on an
   * actual change, so a regeneration that overwrites an existing page stays silent.
   */
  async refreshArtifacts(): Promise<void> {
    const graph = this.graph
    if (graph === null || this.repo === null) return

    try {
      const commits = graph.rows.map((row) => row.commit)
      const artifacts = await this.readArtifacts(this.repo, commits)
      if (sameOrder(artifacts, graph.artifacts)) return

      this.graph = { ...graph, artifacts }
      this.emitEvent({ type: 'graph', data: this.graph })
    } catch {
      // Bands and marks keep whatever they had rather than costing the graph.
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
