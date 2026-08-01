import type { Commit, RefDecoration } from '../graph/model.js'
import { git, GitError } from './exec.js'

/**
 * Field and record separators.
 *
 * Commit subjects routinely contain `|`, and author names contain almost anything, so a
 * printable delimiter is not safe. ASCII unit/record separators cannot appear in any of
 * the fields we ask for, which makes parsing exact rather than best-effort.
 */
const FIELD = '\x1f'
const RECORD = '\x1e'

const FORMAT = [
  '%H', // sha
  '%P', // parent shas, space separated
  '%an', // author name
  '%ae', // author email
  '%at', // author date, unix seconds
  '%ct', // committer date, unix seconds
  '%D', // ref decorations
  '%s', // subject
].join(FIELD)

export interface LogOptions {
  /** Cap history. `git log --all` on a kernel-sized repo would hang the first render. */
  maxCount?: number
  /** Restrict to commits newer than this, e.g. `3.months`. */
  since?: string
}

/**
 * Read the commit graph.
 *
 * `--topo-order` is required, not cosmetic: lane assignment depends on children being
 * emitted before their parents, and the default reverse-chronological order violates that
 * whenever clock skew or rebasing puts a parent's timestamp after its child's.
 */
export async function readLog(cwd: string, opts: LogOptions = {}): Promise<Commit[]> {
  const args = [
    'log',
    '--all',
    '--topo-order',
    `--pretty=format:${FORMAT}${RECORD}`,
    '--no-color',
  ]
  if (opts.maxCount !== undefined) args.push(`--max-count=${opts.maxCount}`)
  if (opts.since !== undefined) args.push(`--since=${opts.since}`)

  let out: string
  try {
    out = await git(cwd, args)
  } catch (err) {
    // An empty repo has no HEAD and no refs; git treats that as an error but it is a
    // perfectly normal state for a freshly-initialised project.
    if (err instanceof GitError && /does not have any commits yet|bad revision/i.test(err.stderr)) {
      return []
    }
    throw err
  }

  return parseLog(out)
}

/** Exported for tests: parse the raw `git log` output produced by {@link FORMAT}. */
export function parseLog(raw: string): Commit[] {
  const commits: Commit[] = []

  for (const record of raw.split(RECORD)) {
    // `format:` puts a newline between records, which lands at the head of the next one.
    const trimmed = record.replace(/^\n/, '')
    if (trimmed === '') continue

    const fields = trimmed.split(FIELD)
    if (fields.length < 8) continue

    const [sha, parentsRaw, authorName, authorEmail, authorAt, commitAt, decorations] = fields
    // The subject is the last field and is the only one that may itself contain a
    // newline-free remainder; rejoin defensively in case a future format adds fields.
    const subject = fields.slice(7).join(FIELD)

    commits.push({
      sha: sha ?? '',
      parents: (parentsRaw ?? '').split(' ').filter(Boolean),
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authorDate: Number(authorAt ?? 0),
      commitDate: Number(commitAt ?? 0),
      subject,
      refs: parseDecorations(decorations ?? ''),
    })
  }

  return commits
}

/**
 * Parse the `%D` decoration list, e.g. `HEAD -> main, origin/main, tag: v1.0`.
 *
 * Classifying `remote` by "contains a slash" would misfile a local branch named
 * `feat/server`, so remotes are identified by matching against the decoration git itself
 * prefixes with a known remote name — in practice `%D` gives no marker, so we fall back
 * to a conservative rule and let the caller refine it with the real remote list.
 */
export function parseDecorations(raw: string, remoteNames: string[] = []): RefDecoration[] {
  if (raw.trim() === '') return []

  return raw
    .split(', ')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): RefDecoration => {
      if (entry.startsWith('tag: ')) {
        const name = entry.slice('tag: '.length)
        return { raw: entry, name, kind: 'tag', isHead: false }
      }

      const arrow = entry.indexOf(' -> ')
      if (arrow !== -1) {
        // `HEAD -> main`: HEAD is attached to this branch.
        const name = entry.slice(arrow + 4)
        return { raw: entry, name, kind: 'branch', isHead: true }
      }

      if (entry === 'HEAD') {
        return { raw: entry, name: 'HEAD', kind: 'head', isHead: true }
      }

      const firstSegment = entry.split('/')[0] ?? ''
      const isRemote = remoteNames.length > 0
        ? remoteNames.includes(firstSegment)
        : firstSegment === 'origin' || firstSegment === 'upstream'

      return {
        raw: entry,
        name: entry,
        kind: isRemote ? 'remote' : 'branch',
        isHead: false,
      }
    })
}
