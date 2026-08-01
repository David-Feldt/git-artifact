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
 * An annotation rather than a partition, and the distinction survives the arrival of
 * worktree tabs. Within a *single* render the graph genuinely cannot be carved up:
 * commits are shared history — one commit is typically reachable from every worktree — so
 * per-worktree lane blocks would have to either duplicate commits or assign them
 * arbitrarily. What is unambiguous is the tip: its HEAD, branch, and uncommitted work.
 *
 * The client scopes by *filtering into a separate render* instead (`client/views.ts`),
 * where shared history is simply drawn again in each tab and nothing has to be assigned
 * to one owner. This payload stays whole and unpartitioned, which is what lets a tab be
 * derived without a round trip and keeps lane indices stable the way phase 0 requires.
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
/**
 * Set when Claude Code's registry says this session is running right now.
 *
 * The one fact about a band that is not inferred. Everything else here is deduced from
 * timing — this is a registry entry naming a live pid, so `live: null` means the session is
 * not running rather than "we could not tell".
 *
 * The exception, worth stating because it is the only one: an absent or unreadable registry
 * also produces `null` everywhere, which reads as "nothing is running". That is the correct
 * failure direction — a missing dot is unremarkable, a dot on a session that has been over
 * for a week is a lie the picture tells.
 */
export interface SessionLiveness {
  /**
   * What Claude Code says the session is doing: `busy`, `idle`, `waiting`, `shell`. An
   * unrecognised value is passed through rather than dropped, so the client must treat this
   * as opaque text.
   */
  status: string | null
}

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
  /** Non-null only while the session is actually running. See {@link SessionLiveness}. */
  live: SessionLiveness | null
}

/**
 * How much one commit changed, in the same terms `git log --shortstat` reports.
 *
 * On a merge these are the first-parent numbers — what the merge brought in — matching
 * what {@link CommitDetail} shows when the row is expanded. Git's default combined diff
 * would list only the hand-resolved conflicts, which on a clean merge is nothing.
 *
 * Binary files count toward `files` and contribute no lines, because git counts no lines
 * for them. A commit that changes nothing is `0/0/0`, not absent.
 */
export interface CommitStat {
  files: number
  additions: number
  deletions: number
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
  /**
   * Diff size per sha, for the counts on each row. See {@link CommitStat}.
   *
   * A map rather than a field on `GraphRow`, for the same reason `pushes` is one: rows come
   * out of `assignLanes`, which is pure and knows nothing about diffs. Keying by sha also
   * means the worktree tabs get it for free — they re-lane a filtered commit list, and a
   * sha-keyed map survives that untouched.
   *
   * Empty when the extra traversal failed, and missing for any commit it did not cover; the
   * row then renders without counts. Losing them must not cost the graph.
   */
  stats: Record<string, CommitStat>
  /** Tip annotations, one per live worktree. See {@link WorktreeLane}. */
  worktreeLanes: WorktreeLane[]
  /**
   * Shas that already have a generated page on disk.
   *
   * Answers "is there something here to read", not "is it still current" — the second needs
   * each commit's brief, which costs a `git show` apiece. A page whose brief has since moved
   * is still listed, and following it regenerates. Empty on any failure, like every other
   * Tier B field: an unmarked icon is unremarkable, and the click still works.
   */
  artifacts: string[]
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

/** One line inside a hunk. `meta` carries git's own annotations, e.g. "\ No newline". */
export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'meta'
  /** Line number in the pre-image, or null on an added line. */
  oldLine: number | null
  /** Line number in the post-image, or null on a removed line. */
  newLine: number | null
  /** The line without its leading marker character. */
  text: string
}

export interface DiffHunk {
  /** The `@@ … @@` line verbatim, including any function-context suffix git found. */
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  /** Pre-rename path, set only when `status` is `renamed`. */
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechanged' | 'unknown'
  /** Null on a binary file, where git counts no lines. */
  additions: number | null
  deletions: number | null
  binary: boolean
  hunks: DiffHunk[]
  /**
   * The file is listed with its counts but carries no hunks, because the commit's patch
   * ran past the byte budget before reaching it. Distinguishing this from "no changes"
   * matters: a silently empty diff reads as a bug.
   */
  clipped: boolean
}

/**
 * A single commit with its patch, fetched on demand when a row is expanded.
 *
 * Not part of {@link GraphPayload}: patches are orders of magnitude larger than the graph
 * and are wanted for one commit at a time, so shipping them with every refresh would cost
 * the live update path everything it saves by being incremental.
 */
export interface CommitDetail {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  authorDate: number
  committerName: string
  committerEmail: string
  commitDate: number
  subject: string
  /** Message after the subject, empty when there is none. */
  body: string
  /**
   * No `refs` field, deliberately. Every other field here is fixed by the sha and so is
   * safe to cache forever, but decorations move whenever a branch does — caching them
   * would make the cache lie. The card the panel opens under already renders them.
   */
  files: DiffFile[]
  additions: number
  deletions: number
  /**
   * This commit is a merge, so the diff shown is against the first parent only.
   * The combined diff git shows by default lists just the conflict resolutions, which on
   * a clean merge is nothing at all — accurate, and useless as an answer to "what landed".
   */
  mergeFirstParent: boolean
  /** True when the patch was cut short by the byte budget; see {@link DiffFile.clipped}. */
  clipped: boolean
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
