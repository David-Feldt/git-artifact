import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DirtyFile, WorktreeStatus } from '../api.js'
import { git, gitOrNull } from './exec.js'

/**
 * Half-life of the activity-heat signal, in milliseconds.
 *
 * Ten minutes is tuned for the intended use: glancing at a second monitor and seeing
 * which files the current session is churning. Long enough that a file you edited a few
 * minutes ago is still visibly warm, short enough that yesterday's work is cold.
 */
const HEAT_HALF_LIFE_MS = 10 * 60 * 1000

/** Map an mtime to `[0,1]`, where 1 is "just now". Exponential decay, halving per period. */
export function heatFromMtime(mtimeMs: number | null, now: number): number {
  if (mtimeMs === null) return 0
  const age = Math.max(0, now - mtimeMs)
  return 2 ** (-age / HEAT_HALF_LIFE_MS)
}

/**
 * Read the uncommitted state of a worktree.
 *
 * `--porcelain=v2` rather than v1 because it reports the branch header, upstream, and
 * ahead/behind counts in the same call — no extra spawns — and its field layout is a
 * documented stable format rather than something to be pattern-matched.
 *
 * `-z` is not optional: paths containing spaces, quotes or newlines are legal in git and
 * the newline-delimited output quotes them in a way that has to be unescaped by hand.
 * NUL-delimited output sidesteps that entirely.
 */
export async function readStatus(
  worktreePath: string,
  opts: { now?: number } = {},
): Promise<WorktreeStatus> {
  const now = opts.now ?? Date.now()
  const raw = await git(worktreePath, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z',
  ])

  const parsed = parseStatus(raw)
  const counts = await readNumstat(worktreePath)
  const files = await withMtimes(worktreePath, parsed.files, now, counts)

  return {
    path: worktreePath,
    branch: parsed.branch,
    head: parsed.head,
    detached: parsed.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstream: parsed.upstream,
    files,
    peakHeat: files.reduce((max, f) => Math.max(max, f.heat), 0),
  }
}

/** Lines added and removed for one path. */
export interface LineCount {
  added: number | null
  deleted: number | null
}

/**
 * Largest untracked file worth counting lines in.
 *
 * A new file has no diff to ask git for, so the only way to a number is to read it. That is
 * fine for the source file you just created and wrong for a 40 MB fixture someone dropped
 * in the tree, on a read that repeats every time the working tree changes. Past the cap the
 * count is reported as unknown, which is honest and costs nothing.
 */
const UNTRACKED_SCAN_LIMIT = 512 * 1024

/**
 * Lines changed per path, against `HEAD`.
 *
 * One spawn for the whole worktree rather than one per file. `HEAD` rather than the default
 * unstaged-only diff, so a file that is staged still reports its numbers — otherwise
 * `git add` would silently blank the counts on the WIP node.
 *
 * Tier A is the working-tree status itself; these numbers are enrichment on top of it, so
 * every failure here is an empty map. An empty repository has no `HEAD` to diff against and
 * takes exactly that path.
 */
export async function readNumstat(worktreePath: string): Promise<Map<string, LineCount>> {
  const raw = await gitOrNull(worktreePath, ['diff', '--numstat', '-z', 'HEAD'])
  return raw === null ? new Map() : parseNumstat(raw)
}

/**
 * Parse NUL-delimited `--numstat` output. Exported for tests, like {@link parseStatus}.
 *
 * A record is `added \t deleted \t path NUL`, except for a rename: there the path is empty
 * and the two fields that follow are the old and new paths. Consuming those is the only way
 * to stay aligned with the stream — and parsing line-wise instead would reintroduce exactly
 * the quoting problem `-z` exists to avoid.
 */
export function parseNumstat(raw: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>()
  const records = raw.split('\0')

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue

    const parts = record.split('\t')
    if (parts.length < 2) continue

    const added = countOrNull(parts[0])
    const deleted = countOrNull(parts[1])

    let filePath = parts[2] ?? ''
    if (filePath === '') {
      // Rename: the new path is the second of the two fields that follow. The file is
      // recorded under where it is now, which is the name the status output uses too.
      filePath = records[i + 2] ?? ''
      i += 2
    }
    if (filePath !== '') counts.set(filePath, { added, deleted })
  }

  return counts
}

/** git writes `-` for a binary file, which is "no line count", not zero. */
function countOrNull(field: string | undefined): number | null {
  if (field === undefined || field === '-') return null
  const value = Number(field)
  return Number.isFinite(value) ? value : null
}

/**
 * Lines in an untracked file, which has no diff for git to report.
 *
 * Counted as all-added, because that is what it is. A NUL byte anywhere means binary, and
 * binary means no count — the same answer git gives for a tracked binary, so the two kinds
 * of file do not disagree about what they are.
 */
async function countUntracked(absolute: string, size: number): Promise<LineCount> {
  if (size > UNTRACKED_SCAN_LIMIT) return { added: null, deleted: null }
  try {
    const buffer = await readFile(absolute)
    if (buffer.includes(0)) return { added: null, deleted: null }
    if (buffer.length === 0) return { added: 0, deleted: 0 }
    let lines = 0
    for (const byte of buffer) if (byte === 0x0a) lines += 1
    // A final line with no trailing newline still counts, which is how git counts it.
    if (buffer[buffer.length - 1] !== 0x0a) lines += 1
    return { added: lines, deleted: 0 }
  } catch {
    return { added: null, deleted: null }
  }
}

export interface ParsedStatus {
  branch: string | null
  head: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  /**
   * Everything `git status` alone can say about a file.
   *
   * The line counts are omitted alongside mtime and heat because none of the three is in
   * the status output — they are attached afterwards, from a separate diff and a `stat`.
   */
  files: Array<Omit<DirtyFile, 'mtimeMs' | 'heat' | 'added' | 'deleted'>>
}

/**
 * Parse NUL-delimited `--porcelain=v2` output. Exported for tests.
 *
 * Record kinds:
 *   `# key value`  header
 *   `1 XY ...path`  ordinary change
 *   `2 XY ...path\0origPath`  rename/copy — note the *extra* NUL field
 *   `u XY ...path`  unmerged
 *   `? path`        untracked
 *   `! path`        ignored
 */
export function parseStatus(raw: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    files: [],
  }

  const records = raw.split('\0')

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue

    if (record.startsWith('# ')) {
      applyHeader(record.slice(2), result)
      continue
    }

    const kind = record[0]

    if (kind === '?' || kind === '!') {
      if (kind === '!') continue // ignored files are not activity
      result.files.push({
        path: record.slice(2),
        status: '??',
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      })
      continue
    }

    if (kind === '1' || kind === '2' || kind === 'u') {
      const fields = record.split(' ')
      const xy = fields[1] ?? '  '
      // Field counts differ per kind; the path is everything after the fixed prefix.
      const fixed = kind === '1' ? 8 : kind === '2' ? 9 : 10
      const filePath = fields.slice(fixed).join(' ')

      // A rename record is followed by its original path in the *next* NUL field, which
      // must be consumed here or it would be misread as a fresh record.
      if (kind === '2') i += 1

      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      result.files.push({
        path: filePath,
        status: xy,
        staged: kind !== 'u' && x !== '.',
        unstaged: kind !== 'u' && y !== '.',
        untracked: false,
        conflicted: kind === 'u',
      })
    }
  }

  return result
}

function applyHeader(header: string, result: ParsedStatus): void {
  const space = header.indexOf(' ')
  const key = space === -1 ? header : header.slice(0, space)
  const value = space === -1 ? '' : header.slice(space + 1)

  switch (key) {
    case 'branch.oid':
      // `(initial)` on an unborn branch, i.e. a repo with no commits yet.
      result.head = value === '(initial)' ? null : value
      break
    case 'branch.head':
      if (value === '(detached)') {
        result.detached = true
        result.branch = null
      } else {
        result.branch = value
      }
      break
    case 'branch.upstream':
      result.upstream = value
      break
    case 'branch.ab': {
      // Reported as `+N -M`.
      const match = /^\+(\d+) -(\d+)$/.exec(value)
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
      break
    }
  }
}

/**
 * Attach mtimes, heat and line counts.
 *
 * `stat` runs across all dirty files concurrently. That is bounded work — it is the size
 * of your uncommitted change set, not the size of the repo — so it stays cheap even on a
 * large tree. A file that vanished between `git status` and here yields a null mtime
 * rather than an error, which happens routinely when a build process is running.
 *
 * The counts arrive already gathered for tracked files, in one diff. Only an untracked file
 * needs anything further, and the `stat` this already does is what decides whether it is
 * small enough to be worth reading.
 */
async function withMtimes(
  root: string,
  files: ParsedStatus['files'],
  now: number,
  counts: Map<string, LineCount>,
): Promise<DirtyFile[]> {
  return Promise.all(
    files.map(async (file): Promise<DirtyFile> => {
      const absolute = path.join(root, file.path)

      let mtimeMs: number | null = null
      let size: number | null = null
      try {
        const info = await stat(absolute)
        mtimeMs = info.mtimeMs
        size = info.size
      } catch {
        mtimeMs = null
      }

      let lines: LineCount = counts.get(file.path) ?? { added: null, deleted: null }
      if (file.untracked && size !== null) {
        lines = await countUntracked(absolute, size)
      }

      return {
        ...file,
        mtimeMs,
        added: lines.added,
        deleted: lines.deleted,
        heat: heatFromMtime(mtimeMs, now),
      }
    }),
  )
}
