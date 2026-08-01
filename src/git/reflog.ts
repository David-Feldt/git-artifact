import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Reflog reading.
 *
 * git keeps a per-ref append-only log under `.git/logs/`, and it is the only place that
 * records *when* something happened to a ref. The commit graph says a commit exists; the
 * reflog says it was pushed at 14:32, or that HEAD moved here during a rebase. That
 * timing is what turns a static graph into a timeline.
 *
 * Note this is history git will eventually discard — reflogs expire (90 days for
 * reachable entries, 30 for unreachable, by default). Everything built on it must treat
 * absence as normal rather than as an error.
 */

/** One line of a reflog. */
export interface ReflogEntry {
  /** Previous sha. All-zero when the ref was being created. */
  oldSha: string
  newSha: string
  authorName: string
  authorEmail: string
  /** Epoch seconds. */
  timestamp: number
  /** Raw timezone offset as git wrote it, e.g. `-0800`. */
  timezone: string
  /** Everything after the tab, e.g. `update by push` or `commit: fix the thing`. */
  message: string
  /**
   * The leading verb, e.g. `pull`, `commit`, `checkout`. git writes `<verb>: <detail>`
   * for most operations but a bare verb for some, notably `update by push`.
   */
  operation: string
}

const ZERO_SHA = '0'.repeat(40)

export function isCreation(entry: ReflogEntry): boolean {
  return entry.oldSha === ZERO_SHA
}

/**
 * Parse reflog file contents.
 *
 * The format is `<old> <new> <name> <email> <ts> <tz>\t<message>`, and it cannot be
 * split naively: the identity contains spaces (`David Feldt <david@Mac.(none)>`) and the
 * message contains colons. The tab is the only unambiguous delimiter, so the line is cut
 * there first, then the fixed-width shas are taken from the front and the timestamp pair
 * from the back — leaving the identity as whatever remains in the middle.
 */
export function parseReflog(raw: string): ReflogEntry[] {
  const entries: ReflogEntry[] = []

  for (const line of raw.split('\n')) {
    if (line === '') continue

    const tab = line.indexOf('\t')
    // A reflog line always has a tab. Anything else is a truncated or corrupt file, which
    // is worth skipping rather than throwing over — this data is a nice-to-have.
    if (tab === -1) continue

    const head = line.slice(0, tab)
    const message = line.slice(tab + 1)

    const oldSha = head.slice(0, 40)
    const newSha = head.slice(41, 81)
    if (!/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) continue

    // `<name> <email> <ts> <tz>` — take the timestamp and offset off the end.
    const rest = head.slice(82)
    const lastSpace = rest.lastIndexOf(' ')
    const secondLastSpace = rest.lastIndexOf(' ', lastSpace - 1)
    if (lastSpace === -1 || secondLastSpace === -1) continue

    const timezone = rest.slice(lastSpace + 1)
    const timestamp = Number(rest.slice(secondLastSpace + 1, lastSpace))
    if (!Number.isFinite(timestamp)) continue

    const identity = rest.slice(0, secondLastSpace)
    const emailStart = identity.lastIndexOf('<')
    const authorName = emailStart === -1 ? identity : identity.slice(0, emailStart).trim()
    const authorEmail =
      emailStart === -1 ? '' : identity.slice(emailStart + 1).replace(/>$/, '')

    const colon = message.indexOf(':')
    entries.push({
      oldSha,
      newSha,
      authorName,
      authorEmail,
      timestamp,
      timezone,
      message,
      operation: colon === -1 ? message : message.slice(0, colon),
    })
  }

  return entries
}

/** A ref being advanced by `git push`, with the moment it happened. */
export interface PushEvent {
  /** Remote-tracking ref, e.g. `origin/main`. */
  ref: string
  remote: string
  branch: string
  /** The sha the remote ref was moved to — the tip that got published. */
  sha: string
  previousSha: string
  /** Epoch milliseconds. */
  at: number
  authorName: string
}

/**
 * Read every `update by push` entry across the remote-tracking reflogs.
 *
 * This is the one durable local record that work left the machine. Comparing
 * ahead/behind only says whether a branch is *currently* published; the reflog says when
 * each push happened, which is what puts a marker on the timeline.
 *
 * Remote logs live under the *common* dir, shared across worktrees, so a push made from
 * any checkout shows up here.
 */
export async function readPushEvents(commonDir: string): Promise<PushEvent[]> {
  const root = path.join(commonDir, 'logs', 'refs', 'remotes')
  const files = await walk(root)
  const events: PushEvent[] = []

  await Promise.all(
    files.map(async (file) => {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        return // Raced with a prune, or unreadable. Not worth failing the whole read.
      }

      // `<root>/origin/feat/thing` -> remote `origin`, branch `feat/thing`. Branch names
      // legitimately contain slashes, so only the first segment is the remote.
      const relative = path.relative(root, file).split(path.sep)
      const remote = relative[0] ?? ''
      const branch = relative.slice(1).join('/')
      if (!remote || !branch) return

      for (const entry of parseReflog(raw)) {
        if (entry.message !== 'update by push') continue
        events.push({
          ref: `${remote}/${branch}`,
          remote,
          branch,
          sha: entry.newSha,
          previousSha: entry.oldSha,
          at: entry.timestamp * 1000,
          authorName: entry.authorName,
        })
      }
    }),
  )

  return events.sort((a, b) => a.at - b.at)
}

/**
 * Read `.git/logs/HEAD` — every HEAD movement, in order, with timestamps.
 *
 * Each worktree has its own HEAD log, so this takes the worktree's git dir rather than
 * the common one.
 */
export async function readHeadLog(gitDir: string): Promise<ReflogEntry[]> {
  try {
    return parseReflog(await readFile(path.join(gitDir, 'logs', 'HEAD'), 'utf8'))
  } catch {
    return [] // No HEAD log yet, e.g. a repo with no commits.
  }
}

/** Recursively list files, tolerating a missing tree. */
async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // No remotes configured, which is a perfectly ordinary repo.
  }

  const out: string[] = []
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await walk(full)))
      else if (entry.isFile()) out.push(full)
    }),
  )
  return out
}
