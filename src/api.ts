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

export interface GraphPayload {
  repo: RepoInfo
  rows: GraphRow[]
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
