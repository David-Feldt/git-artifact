import type { CommitDetail, DiffFile, DiffHunk, DiffLine } from '../api.js'
import { git, GitError } from './exec.js'

/**
 * Read one commit and its patch.
 *
 * Same separators as `log.ts`, for the same reason: commit messages contain every
 * printable character, and the ASCII unit/record separators cannot appear in the fields
 * git is being asked for.
 */
const FIELD = '\x1f'
const RECORD = '\x1e'

const FORMAT = [
  '%H', // sha
  '%P', // parent shas, space separated
  '%an',
  '%ae',
  '%at', // author date, unix seconds
  '%cn',
  '%ce',
  '%ct', // committer date, unix seconds
  '%s', // subject
  '%b', // body
].join(FIELD)

/**
 * How much patch text to accept for one commit.
 *
 * A vendored dependency drop or a lockfile churn is megabytes of diff that nobody will
 * read, and it would arrive as one JSON blob on a click. Past this the remaining files
 * keep their names and counts and lose their hunks, which is a far better failure than a
 * frozen tab.
 */
const MAX_PATCH_BYTES = 512 * 1024

/** Rejects anything that is not a plain abbreviated-or-full object name. */
const SHA_PATTERN = /^[0-9a-f]{4,40}$/

/** Thrown when the sha is well-formed but no such commit exists. */
export class UnknownCommitError extends Error {
  constructor(readonly sha: string) {
    super(`no such commit: ${sha}`)
    this.name = 'UnknownCommitError'
  }
}

export function isValidSha(sha: string): boolean {
  return SHA_PATTERN.test(sha)
}

/**
 * Load a commit's metadata and diff.
 *
 * `-m --first-parent` is passed unconditionally. On a merge it selects the first-parent
 * diff — the set of changes the merge brought in — rather than git's default combined
 * diff, which shows only what the merger resolved by hand and is empty for a clean merge.
 * On a non-merge, including a root commit, both flags are inert; verified against the
 * fixtures rather than assumed.
 *
 * The four reads are independent, so they are issued together and cost one round trip
 * rather than four.
 */
export async function readCommitDetail(cwd: string, sha: string): Promise<CommitDetail> {
  if (!isValidSha(sha)) throw new UnknownCommitError(sha)

  // `^{commit}` makes git reject a well-formed name that resolves to a tree or a blob,
  // which would otherwise dump file contents through the patch parser.
  const rev = `${sha}^{commit}`
  const diffFlags = ['-m', '--first-parent', '--format=', '-M', '--no-color']

  let meta: string
  let nameStatus: string
  let numstat: string
  let patch: string
  try {
    ;[meta, nameStatus, numstat, patch] = await Promise.all([
      git(cwd, ['show', '--no-patch', `--format=${FORMAT}${RECORD}`, rev]),
      git(cwd, ['show', ...diffFlags, '--name-status', '-z', rev]),
      git(cwd, ['show', ...diffFlags, '--numstat', '-z', rev]),
      // A commit far over budget is read up to a bounded ceiling and clipped below;
      // maxBuffer only has to stop a pathological object from being buffered whole.
      git(cwd, ['show', ...diffFlags, '--patch', '-U3', rev], {
        maxBuffer: MAX_PATCH_BYTES * 8,
      }).catch((err) => {
        // Over even that ceiling: keep the file list, drop every hunk.
        if (err instanceof RangeError || /maxBuffer/i.test(String(err))) return ''
        throw err
      }),
    ])
  } catch (err) {
    if (
      err instanceof GitError &&
      /unknown revision|bad revision|not a valid object name|ambiguous argument/i.test(err.stderr)
    ) {
      throw new UnknownCommitError(sha)
    }
    throw err
  }

  const commit = parseMeta(meta)
  const entries = zipFileEntries(parseNameStatus(nameStatus), parseNumstat(numstat))
  const { blocks, clipped } = parsePatch(patch)

  const files: DiffFile[] = entries.map((entry, index) => {
    const block = blocks[index]
    return {
      ...entry,
      hunks: block?.hunks ?? [],
      // A binary file legitimately has no hunks, so it is never "clipped".
      clipped: block === undefined && !entry.binary,
    }
  })

  return {
    ...commit,
    files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    mergeFirstParent: commit.parents.length > 1,
    clipped: clipped || files.some((file) => file.clipped),
  }
}

type CommitMeta = Omit<
  CommitDetail,
  'files' | 'additions' | 'deletions' | 'mergeFirstParent' | 'clipped'
>

/** Exported for tests: parse the `--format` record produced by {@link FORMAT}. */
export function parseMeta(raw: string): CommitMeta {
  const record = raw.split(RECORD)[0] ?? ''
  const fields = record.split(FIELD)

  return {
    sha: fields[0] ?? '',
    parents: (fields[1] ?? '').split(' ').filter(Boolean),
    authorName: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    authorDate: Number(fields[4] ?? 0),
    committerName: fields[5] ?? '',
    committerEmail: fields[6] ?? '',
    commitDate: Number(fields[7] ?? 0),
    subject: fields[8] ?? '',
    // The body is last and may contain anything except the separators, but rejoin rather
    // than index so a future added field cannot silently truncate it.
    body: fields.slice(9).join(FIELD).trimEnd(),
  }
}

interface NameStatusEntry {
  path: string
  oldPath: string | null
  status: DiffFile['status']
}

/**
 * Parse `--name-status -z`: a status letter, then one path, or two for a rename or copy.
 *
 * NUL-delimited rather than line-delimited because a path may contain a newline. The
 * same reason rules out reading paths off the patch's `---`/`+++` lines, which git pads
 * with a trailing tab whenever the path contains whitespace.
 */
export function parseNameStatus(raw: string): NameStatusEntry[] {
  const parts = raw.split('\0')
  const entries: NameStatusEntry[] = []

  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (code === undefined || code === '') continue

    // R and C carry a similarity score, e.g. `R073`.
    const letter = code[0]
    const renamed = letter === 'R' || letter === 'C'
    const first = parts[++i]
    if (first === undefined) break
    const second = renamed ? parts[++i] : undefined
    if (renamed && second === undefined) break

    entries.push({
      path: renamed ? second! : first,
      oldPath: renamed ? first : null,
      status: STATUS_BY_LETTER[letter ?? ''] ?? 'unknown',
    })
  }

  return entries
}

const STATUS_BY_LETTER: Record<string, DiffFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechanged',
}

interface NumstatEntry {
  path: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * Parse `--numstat -z`: `adds \t dels \t path`, with `-` counts for a binary file. A
 * rename emits an empty path field followed by the old and new paths as separate records.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const parts = raw.split('\0')
  const entries: NumstatEntry[] = []

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (record === undefined || record === '') continue

    // Split on the first two tabs only. A path may itself contain a tab, and `split('\t')`
    // would truncate it at the first one.
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const addsRaw = record.slice(0, firstTab)
    const delsRaw = record.slice(firstTab + 1, secondTab)

    // An empty path field means the next two records are the old and new paths.
    let path = record.slice(secondTab + 1)
    if (path === '') {
      i += 1 // parts[i] is the old path, which numstat's caller gets from --name-status
      path = parts[i + 1] ?? ''
      i += 1
    }

    const binary = addsRaw === '-' || delsRaw === '-'
    entries.push({
      path,
      additions: binary ? null : Number(addsRaw),
      deletions: binary ? null : Number(delsRaw),
      binary,
    })
  }

  return entries
}

/**
 * Merge the two listings, which git emits for the same file set in the same order.
 *
 * Zipping by index rather than joining on path is deliberate: paths are the one field
 * that can disagree between the two views of a rename, and index is exact.
 */
function zipFileEntries(
  statuses: NameStatusEntry[],
  counts: NumstatEntry[],
): Array<Omit<DiffFile, 'hunks' | 'clipped'>> {
  return statuses.map((entry, index) => {
    const count = counts[index]
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      // `?? 0` would be wrong here: a binary file's counts are legitimately null, and
      // folding them to zero reports it as present but unchanged.
      additions: count === undefined ? 0 : count.additions,
      deletions: count === undefined ? 0 : count.deletions,
      binary: count?.binary ?? false,
    }
  })
}

interface PatchBlock {
  hunks: DiffHunk[]
}

/**
 * Split a unified diff into per-file blocks and parse each one's hunks.
 *
 * The byte budget is applied before parsing, and the trailing block is then discarded
 * outright: a block cut mid-hunk would render as a file whose diff quietly stops partway,
 * which is worse than showing it as clipped.
 */
export function parsePatch(raw: string): { blocks: PatchBlock[]; clipped: boolean } {
  if (raw === '') return { blocks: [], clipped: false }

  let text = raw
  let clipped = false
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES) {
    // Cutting by code unit against a byte budget only ever keeps less than the budget,
    // since no UTF-8 character is under one byte. Exactness is not the point; a bound is.
    text = text.slice(0, MAX_PATCH_BYTES)
    clipped = true
  }

  const lines = text.split('\n')
  const blocks: PatchBlock[] = []
  let current: PatchBlock | null = null
  let oldLine = 0
  let newLine = 0
  let hunk: DiffHunk | null = null

  for (const line of lines) {
    // `diff --cc` appears in a combined diff. `--first-parent` means we should never see
    // one, but a block header we failed to recognise would silently merge two files.
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      current = { hunks: [] }
      blocks.push(current)
      hunk = null
      continue
    }
    if (current === null) continue

    if (line.startsWith('@@')) {
      const range = parseHunkHeader(line)
      if (range === null) continue
      oldLine = range.oldStart
      newLine = range.newStart
      hunk = { header: line, lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue // still in the file header (mode, index, ---, +++)

    const marker = line[0]
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine: newLine++, text: line.slice(1) })
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldLine: oldLine++, newLine: null, text: line.slice(1) })
    } else if (marker === ' ') {
      hunk.lines.push({
        kind: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        text: line.slice(1),
      })
    } else if (marker === '\\') {
      // `\ No newline at end of file` — annotates the line above, consumes no line number.
      hunk.lines.push({ kind: 'meta', oldLine: null, newLine: null, text: line.slice(2) })
    } else {
      // An empty string is the trailing newline of the patch; anything else means the
      // block ended and we are back in git's own framing.
      hunk = null
    }
  }

  if (clipped) blocks.pop()
  return { blocks, clipped }
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // `@@ -12,7 +12,9 @@ optional function context`. The counts are omitted when 1.
  const match = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  if (!match) return null
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}
