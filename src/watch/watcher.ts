import { readFileSync } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import ignore, { type Ignore } from 'ignore'
import type { Repo } from '../git/repo.js'

/**
 * What changed, and therefore what needs re-reading.
 *
 * Splitting these is the difference between a dashboard that idles quietly and one that
 * re-reads the entire commit graph every time you press save. Working-tree edits are
 * frequent and only ever affect `git status`; ref changes are rare and are the only thing
 * that can alter the graph.
 */
export type ChangeKind = 'refs' | 'worktree' | 'sessions'

/**
 * Debounce windows, per change class.
 *
 * These differ on purpose. Working-tree events arrive in floods — editors write-then-
 * rename, formatters rewrite on save, build watchers touch hundreds of files — so they
 * need a wide enough window to coalesce, and nobody notices 200ms on a file save.
 *
 * Ref changes are the opposite: rare, arriving a handful at a time, and the one thing the
 * user is actually watching for. Waiting 200ms there is most of the perceptible lag
 * between typing `git commit` and seeing the node appear, for no coalescing benefit.
 */
const REFS_DEBOUNCE_MS = 60
const WORKTREE_DEBOUNCE_MS = 200
/**
 * Widest of the three, because nobody is waiting on it.
 *
 * A session changing status is ambient information, not the event the user typed a command
 * to see. Meanwhile a working session flips status every few seconds as it picks up and
 * puts down tools, so the window is set to coalesce a burst of those into one update rather
 * than to minimise latency.
 */
const SESSIONS_DEBOUNCE_MS = 750

const DEBOUNCE_MS: Record<ChangeKind, number> = {
  refs: REFS_DEBOUNCE_MS,
  worktree: WORKTREE_DEBOUNCE_MS,
  sessions: SESSIONS_DEBOUNCE_MS,
}

export interface WatcherOptions {
  repo: Repo
  /** Override every debounce window. Mainly for tests. */
  debounceMs?: number
  /**
   * Claude Code's live-session registry, watched for `sessions` events when given.
   *
   * Passed in rather than derived here, so this file keeps knowing nothing about Claude
   * Code — it watches a directory it is handed. Every assumption about that tool stays in
   * `sources/claude-code.ts`, which is what makes a format change a one-file fix. Omit it
   * and no session watching happens at all.
   */
  sessionRegistryPath?: string
  onChange: (kinds: Set<ChangeKind>) => void
  onError?: (err: unknown) => void
}

const ALWAYS_IGNORED = ['**/.git/**', '**/node_modules/**']

/**
 * Watch a repo for anything that would change what we display.
 *
 * These events are a *trigger only*. Nothing here is treated as truth — every event
 * results in asking git, which means a missed event costs a delayed update and a spurious
 * one costs a redundant read. Neither can produce a wrong graph, which is what makes it
 * safe to watch aggressively.
 */
export class RepoWatcher {
  private watchers: FSWatcher[] = []
  /** One timer per class, so a stream of file saves cannot keep delaying a ref update. */
  private timers = new Map<ChangeKind, NodeJS.Timeout>()
  private closed = false

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    const { repo } = this.options
    const gitPaths = this.gitWatchPaths()

    /*
     * `.git` internals: small, bounded, and safe to watch directly.
     *
     * Deliberately no `awaitWriteFinish` here. It exists for files that arrive in chunks,
     * but git publishes refs by writing a temp file and renaming it, so the ref appears
     * atomically and there is no partial state to wait out — the stability window would
     * be pure added latency on exactly the event the user is watching for. And because we
     * never parse ref files ourselves (we ask git), an event that somehow fires early
     * costs one redundant read, and the rename that follows fires another event anyway.
     */
    this.watchers.push(
      chokidar
        .watch(gitPaths, { ignoreInitial: true })
        .on('all', () => this.queue('refs'))
        .on('error', (err) => this.options.onError?.(err)),
    )

    // Working trees: potentially enormous, so filtered hard before chokidar descends.
    if (!repo.state.bare) {
      for (const worktree of repo.worktrees) {
        if (worktree.bare || worktree.prunable) continue
        const filter = buildIgnoreFilter(worktree.path, repo.commonDir)
        this.watchers.push(
          chokidar
            .watch(worktree.path, {
              ignoreInitial: true,
              ignored: (candidate) => filter(candidate),
              // Following symlinks into a linked dependency tree would explode the watch
              // set and, worse, watch files outside the repo entirely.
              followSymlinks: false,
            })
            .on('all', () => this.queue('worktree'))
            .on('error', (err) => this.options.onError?.(err)),
        )
      }
    }

    /*
     * The live-session registry: one small file per running session, so watching the whole
     * directory is cheap and needs no filter.
     *
     * The only watch pointed outside the repository, and it stays read-only like the rest.
     * A directory that does not exist is the normal case on a machine without Claude Code;
     * chokidar simply never fires, which is exactly the wanted behaviour and is why there
     * is no existence check here.
     */
    const registry = this.options.sessionRegistryPath
    if (registry !== undefined) {
      this.watchers.push(
        chokidar
          .watch(registry, { ignoreInitial: true, depth: 0 })
          .on('all', () => this.queue('sessions'))
          .on('error', (err) => this.options.onError?.(err)),
      )
    }
  }

  /**
   * The specific `.git` entries that can change the graph.
   *
   * `commonDir` rather than `gitDir`: in a linked worktree the two differ, and refs live
   * in the shared one. Watching only `gitDir` would miss every commit made from the main
   * checkout.
   */
  private gitWatchPaths(): string[] {
    const { commonDir } = this.options.repo
    return [
      path.join(commonDir, 'HEAD'),
      path.join(commonDir, 'packed-refs'),
      path.join(commonDir, 'refs'),
      path.join(commonDir, 'logs'),
      // Each linked worktree keeps its own HEAD under here.
      path.join(commonDir, 'worktrees'),
      // Presence of these is what "mid-rebase" and "mid-merge" mean.
      path.join(commonDir, 'MERGE_HEAD'),
      path.join(commonDir, 'rebase-merge'),
      path.join(commonDir, 'rebase-apply'),
      path.join(commonDir, 'CHERRY_PICK_HEAD'),
    ]
  }

  private queue(kind: ChangeKind): void {
    if (this.closed) return

    const existing = this.timers.get(kind)
    if (existing) clearTimeout(existing)

    const delay = this.options.debounceMs ?? DEBOUNCE_MS[kind]

    this.timers.set(
      kind,
      setTimeout(() => {
        this.timers.delete(kind)
        if (!this.closed) this.options.onChange(new Set([kind]))
      }, delay),
    )
  }

  async close(): Promise<void> {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.all(this.watchers.map((w) => w.close()))
    this.watchers = []
  }
}

/**
 * Build a path filter from the repo's ignore rules.
 *
 * Watching a real project without this is not merely wasteful — `node_modules` and build
 * output can exceed the OS file-descriptor limit outright, and an active dev server
 * rewriting `dist/` would keep the dashboard permanently busy re-reading status for files
 * git does not track anyway.
 *
 * Only the root `.gitignore` and `.git/info/exclude` are read. Nested `.gitignore` files
 * are not consulted, so a few extra events may get through; that is harmless, because git
 * is still the source of truth and will not report ignored files as dirty.
 */
export function buildIgnoreFilter(
  worktreePath: string,
  commonDir: string,
): (candidate: string) => boolean {
  const matcher: Ignore = ignore()
  matcher.add(['.git', 'node_modules'])

  for (const file of [
    path.join(worktreePath, '.gitignore'),
    path.join(commonDir, 'info', 'exclude'),
  ]) {
    try {
      matcher.add(readFileSync(file, 'utf8'))
    } catch {
      // Absent or unreadable ignore files are normal; the defaults above still apply.
    }
  }

  return (candidate: string): boolean => {
    const relative = path.relative(worktreePath, candidate)
    // Empty means the worktree root itself; `..` means outside it. Never ignore the root,
    // or chokidar would refuse to watch anything at all.
    if (relative === '' ) return false
    if (relative.startsWith('..')) return true

    // The `ignore` package expects posix separators regardless of platform.
    const posix = relative.split(path.sep).join('/')
    return matcher.ignores(posix)
  }
}

export { ALWAYS_IGNORED }
