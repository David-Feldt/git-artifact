/** Wire types shared by the daemon and the client. Keep this file free of imports from
 *  either side so neither can drag server-only code into the browser bundle. */

import type { GraphRow } from './graph/model.js'
import type { RepoState, Worktree } from './git/repo.js'

/** A file with uncommitted changes, as reported by `git status --porcelain=v2`. */
export interface DirtyFile {
  /** Path relative to the worktree root, always forward-slashed. */
  path: string
  /** Staged/unstaged status in `XY` form, e.g. ` M`, `A `, `??`, `UU`. */
  status: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  /** Last modification time in epoch milliseconds, or null if the file has gone. */
  mtimeMs: number | null
  /**
   * Recency score in `[0,1]` from an exponential decay on `mtimeMs`. 1 means "touched
   * just now". This is the activity-heat signal the UI renders as colour temperature.
   */
  heat: number
}

/** The uncommitted state of one worktree — the WIP pseudo-node at that lane's tip. */
export interface WorktreeStatus {
  path: string
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null
  head: string | null
  detached: boolean
  /** Commits ahead of / behind the tracking branch, when one is configured. */
  ahead: number | null
  behind: number | null
  upstream: string | null
  files: DirtyFile[]
  /** Highest `heat` across `files`, so the UI can rank worktrees without rescanning. */
  peakHeat: number
}

export interface RepoInfo {
  root: string
  /** Basename of the root, for the page title. */
  name: string
  state: RepoState
  currentBranch: string | null
  head: string | null
  worktrees: Worktree[]
  /** Configured remotes, used to classify ref decorations. */
  remotes: string[]
}

/** A moment work left the machine, from a remote-tracking reflog. */
export interface PushMarker {
  /** Remote-tracking ref the push advanced, e.g. `origin/main`. */
  ref: string
  /** Epoch milliseconds. */
  at: number
  authorName: string
}

/**
 * Which lane each worktree's HEAD currently sits in.
 *
 * Deliberately an annotation rather than a partition of the graph. Commits are shared
 * history — one commit is typically reachable from every worktree — so carving lanes into
 * per-worktree blocks would have to either duplicate commits or assign them arbitrarily.
 * What is genuinely per-worktree is the tip: its HEAD, branch, and uncommitted work. So
 * the UI labels the lane a worktree is sitting in and leaves the graph itself alone,
 * which also keeps lane indices stable the way phase 0 requires.
 */
export interface WorktreeLane {
  path: string
  /** Basename of the worktree directory, for display. */
  name: string
  branch: string | null
  head: string | null
  detached: boolean
  isMain: boolean
  /** Lane its HEAD commit occupies, or null when that commit is outside the window. */
  lane: number | null
}

/*
 * Dirty counts and ahead/behind deliberately live only on `StatusPayload`, not here.
 * Status refreshes on working-tree events and the graph on ref events, so copying mutable
 * fields into both would let them disagree — the header would show a file count from
 * before your last save. The client joins the two on `path` instead.
 */

/**
 * A run of commits observed alongside one Claude Code session.
 *
 * "Observed alongside", not "authored by", and the distinction is load-bearing. Nothing in
 * a transcript records that a session caused a commit; it is inferred from timing, so a
 * commit typed by hand shortly after Claude stopped lands in the band too. Copy that
 * claims authorship would be asserting something the data cannot support.
 */
export interface SessionBandInfo {
  sessionId: string
  /** Title Claude generated for the session, or null if it never produced one. */
  title: string | null
  /** Inclusive indices into `GraphPayload.rows`. */
  startRow: number
  endRow: number
  commitCount: number
  /** Human turns only — tool results and sub-agent traffic excluded. */
  promptCount: number
  /** Input plus cache reads and creations; cache traffic dominates and is real spend. */
  inputTokens: number
  outputTokens: number
  model: string | null
  /** Epoch milliseconds spanning the whole session, which may exceed the band's commits. */
  startedAt: number
  endedAt: number
  /** Branches the session touched. More than one for roughly a fifth of sessions. */
  branches: string[]
}

export interface GraphPayload {
  repo: RepoInfo
  rows: GraphRow[]
  /**
   * Session bands, ordered by first row and guaranteed non-overlapping.
   *
   * Empty whenever Claude Code is absent, has no transcripts for this repository, or wrote
   * a format we no longer recognise. None of those is an error — the graph is unaffected.
   */
  sessions: SessionBandInfo[]
  /**
   * Push events keyed by the sha the push landed on.
   *
   * Only the exact target is marked, not its ancestors. "A push happened here, at this
   * time" is a discrete event that belongs on a timeline; "is this commit published" is a
   * different question, answered per-branch by the ahead/behind counts.
   */
  pushes: Record<string, PushMarker[]>
  /** Tip annotations, one per live worktree. See {@link WorktreeLane}. */
  worktreeLanes: WorktreeLane[]
  /** Widest row, i.e. how many lane columns the renderer must reserve. */
  width: number
  /** True when history was cut short by the `--max-count` cap rather than exhausted. */
  capped: boolean
  maxCount: number
  /** Epoch millis the payload was assembled, for the "as of" indicator. */
  generatedAt: number
}

export interface StatusPayload {
  worktrees: WorktreeStatus[]
  generatedAt: number
}

/** A recoverable problem the daemon wants to show in the UI rather than swallow. */
export interface ProblemPayload {
  message: string
  detail?: string
}

/** Server-sent event names, kept in one place so both ends agree. */
export type ServerEvent =
  | { type: 'graph'; data: GraphPayload }
  | { type: 'status'; data: StatusPayload }
  | { type: 'problem'; data: ProblemPayload }
  | { type: 'hello'; data: { repo: RepoInfo } }
