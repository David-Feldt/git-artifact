import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { DirtyFile, WorktreeStatus } from '../api.js'
import { git } from './exec.js'

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
  const files = await withMtimes(worktreePath, parsed.files, now)

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

export interface ParsedStatus {
  branch: string | null
  head: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  files: Array<Omit<DirtyFile, 'mtimeMs' | 'heat'>>
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
 * Attach mtimes and heat.
 *
 * `stat` runs across all dirty files concurrently. That is bounded work — it is the size
 * of your uncommitted change set, not the size of the repo — so it stays cheap even on a
 * large tree. A file that vanished between `git status` and here yields a null mtime
 * rather than an error, which happens routinely when a build process is running.
 */
async function withMtimes(
  root: string,
  files: ParsedStatus['files'],
  now: number,
): Promise<DirtyFile[]> {
  return Promise.all(
    files.map(async (file): Promise<DirtyFile> => {
      let mtimeMs: number | null = null
      try {
        mtimeMs = (await stat(path.join(root, file.path))).mtimeMs
      } catch {
        mtimeMs = null
      }
      return { ...file, mtimeMs, heat: heatFromMtime(mtimeMs, now) }
    }),
  )
}
