import type { CommitDetail, DiffFile, PushMarker, SessionBandInfo } from '../api.js'

/**
 * The brief: everything a model is told about a commit.
 *
 * This is the product, not the page. The page is written by the harness; what decides
 * whether it is any good is what goes in here. See docs/design/artifacts.md.
 *
 * Pure and free of git, the filesystem and the clock, so the budget — the one part that
 * can fail catastrophically — is directly testable.
 */

export interface BriefInput {
  repoName: string
  detail: CommitDetail
  /** The band this commit was observed alongside, if any. Never described as its author. */
  session: SessionBandInfo | null
  pushes: PushMarker[]
  /** Ref decorations on this commit, already stripped of `HEAD -> `. */
  refs: string[]
  now: number
}

export interface Budget {
  /**
   * Characters of diff body across the whole brief.
   *
   * Characters rather than tokens because tokenisation is model-specific and this has to
   * be decided before a model is chosen. Roughly four characters per token, so the default
   * is on the order of 30k tokens of diff — well inside any context window, and far below
   * the 512 KB `readCommitDetail` already caps a patch at.
   */
  totalChars: number
  /** Ceiling for any single file, so one generated blob cannot own the whole budget. */
  perFileChars: number
}

export const DEFAULT_BUDGET: Budget = {
  totalChars: 120_000,
  perFileChars: 24_000,
}

export interface BriefStats {
  /** Files whose diff body was included in full. */
  included: number
  /** Files included, but with their body cut at `perFileChars`. */
  shortened: string[]
  /** Files listed with their counts and no body, because the budget ran out. */
  omitted: string[]
  /** Files git reported as binary. Never carry a body at all. */
  binary: string[]
  /** Files the git layer had already clipped before the budget was applied. */
  clippedUpstream: string[]
}

export interface Brief {
  text: string
  stats: BriefStats
}

export function buildBrief(input: BriefInput, budget: Budget = DEFAULT_BUDGET): Brief {
  const { detail } = input
  const allocation = allocate(detail.files, budget)

  const out: string[] = []
  out.push(...identity(input))
  out.push(...intent(input))
  out.push(...timeline(input))
  out.push(...fileList(detail, allocation))
  out.push(...diffs(detail.files, allocation))
  out.push(...omissions(detail, allocation))

  return { text: out.join('\n'), stats: allocation.stats }
}

/* ---------------------------------------------------------------- the budget */

interface Allocation {
  /** Body to emit per path. Absent means "listed only". */
  bodies: Map<string, string>
  stats: BriefStats
}

/**
 * Decide which files get their diff into the brief.
 *
 * Smallest first, which is the whole point. `readCommitDetail` already caps a patch at
 * 512 KB, but it fills that cap *positionally* — so a single generated file early in the
 * diff consumes the entire allowance and every file after it arrives empty. Measured on
 * real history, that is not hypothetical: one commit in the largest repository here is a
 * 135,037-line STEP file, which is plain text, diffs happily, and would starve the twenty
 * ordinary source files beside it.
 *
 * Admitting smallest-first inverts that. A commit touching one enormous file and twenty
 * small ones spends its budget on the twenty, and says so.
 */
function allocate(files: DiffFile[], budget: Budget): Allocation {
  const bodies = new Map<string, string>()
  const stats: BriefStats = {
    included: 0,
    shortened: [],
    omitted: [],
    binary: [],
    clippedUpstream: [],
  }

  const candidates: { file: DiffFile; body: string }[] = []

  for (const file of files) {
    if (file.binary) {
      stats.binary.push(file.path)
      continue
    }
    if (file.clipped) {
      // The git layer dropped this one before we ever saw it. Distinct from our own
      // omission, and worth saying separately: the cause and the fix are different.
      stats.clippedUpstream.push(file.path)
      continue
    }
    if (file.hunks.length === 0) continue
    candidates.push({ file, body: renderFileDiff(file) })
  }

  candidates.sort((a, b) => a.body.length - b.body.length)

  let spent = 0
  for (const { file, body } of candidates) {
    const remaining = budget.totalChars - spent
    if (remaining <= 0) {
      stats.omitted.push(file.path)
      continue
    }

    const ceiling = Math.min(budget.perFileChars, remaining)
    if (body.length <= ceiling) {
      bodies.set(file.path, body)
      spent += body.length
      stats.included += 1
      continue
    }

    // Worth including partially only if there is room for something legible.
    if (ceiling < 400) {
      stats.omitted.push(file.path)
      continue
    }
    bodies.set(file.path, cutToLine(body, ceiling))
    spent += ceiling
    stats.shortened.push(file.path)
  }

  return { bodies, stats }
}

/** Cut at the last newline inside the ceiling, so a diff never ends mid-line. */
function cutToLine(body: string, ceiling: number): string {
  const slice = body.slice(0, ceiling)
  const lastBreak = slice.lastIndexOf('\n')
  return lastBreak > 0 ? slice.slice(0, lastBreak) : slice
}

function renderFileDiff(file: DiffFile): string {
  const out: string[] = []
  for (const hunk of file.hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      out.push(line.kind === 'meta' ? `\\ ${line.text}` : `${marker}${line.text}`)
    }
  }
  return out.join('\n')
}

/* ---------------------------------------------------------------- sections */

function identity(input: BriefInput): string[] {
  const { detail, repoName, refs } = input
  const out = [
    `# Commit ${detail.sha.slice(0, 7)} — ${detail.subject || '(no message)'}`,
    '',
    '## Identity',
    `- repository: ${repoName}`,
    `- sha: ${detail.sha}`,
    `- author: ${detail.authorName}`,
    `- authored: ${new Date(detail.authorDate * 1000).toISOString()}`,
  ]
  if (refs.length > 0) out.push(`- refs on this commit: ${refs.join(', ')}`)
  if (detail.parents.length > 0) {
    out.push(`- parents: ${detail.parents.map((p) => p.slice(0, 7)).join(', ')}`)
  } else {
    out.push('- parents: none (this is a root commit)')
  }
  if (detail.mergeFirstParent) {
    out.push(
      '- NOTE: this is a merge. The diff below is against the FIRST PARENT only, which is' +
        ' "what this merge brought in", not the conflict resolutions git shows by default.',
    )
  }
  if (detail.body.trim()) {
    out.push('', '### Commit message body', '```', detail.body.trim(), '```')
  }
  return out
}

/**
 * The session this commit was observed alongside.
 *
 * The wording here is load-bearing and is repeated for the model rather than assumed,
 * because prose invites the claim that a label does not: nothing in a transcript records
 * that a session *caused* a commit, and a page asserting authorship would be stating
 * something the data cannot support.
 */
function intent(input: BriefInput): string[] {
  const { session } = input
  if (session === null) {
    return [
      '',
      '## Intent',
      '- No Claude Code session was observed around this commit. Do not speculate about who',
      '  wrote it or why; describe what the diff does.',
    ]
  }

  const out = [
    '',
    '## Intent — observed alongside, NOT authored by',
    `- session title: ${session.title ?? 'Untitled session'}`,
    `- human prompts during the session: ${session.promptCount}`,
    `- commits observed alongside it: ${session.commitCount}`,
    `- model: ${session.model ?? 'unknown'}`,
  ]
  if (session.branches.length > 0) {
    out.push(`- branches touched: ${session.branches.join(', ')}`)
  }
  out.push(
    '- CONSTRAINT: this association is inferred from timing alone. Nothing records that the',
    '  session caused this commit. Write "observed alongside" or similar; never state or',
    '  imply that the session, or Claude, authored the change.',
  )
  return out
}

function timeline(input: BriefInput): string[] {
  if (input.pushes.length === 0) return []
  const sorted = [...input.pushes].sort((a, b) => a.at - b.at)
  return [
    '',
    '## Timeline',
    ...sorted.map((push) => `- pushed to ${push.ref} at ${new Date(push.at).toISOString()}`),
  ]
}

function fileList(detail: CommitDetail, allocation: Allocation): string[] {
  const out = [
    '',
    '## Files changed',
    `${detail.files.length} file${detail.files.length === 1 ? '' : 's'}, ` +
      `+${detail.additions} −${detail.deletions}`,
    '',
  ]

  for (const file of detail.files) {
    const counts = file.binary
      ? 'binary'
      : `+${file.additions ?? 0} −${file.deletions ?? 0}`
    const note = allocation.bodies.has(file.path) ? '' : ' [no diff body below]'
    const renamed = file.oldPath ? ` (was ${file.oldPath})` : ''
    out.push(`- ${file.path}${renamed} — ${file.status}, ${counts}${note}`)
  }

  return out
}

function diffs(files: DiffFile[], allocation: Allocation): string[] {
  const out: string[] = ['', '## Diffs']
  let any = false

  // Emitted in the commit's own file order, not the budget's size order — the ordering
  // that decides what to include should not also decide how it reads.
  for (const file of files) {
    const body = allocation.bodies.get(file.path)
    if (body === undefined) continue
    any = true
    const shortened = allocation.stats.shortened.includes(file.path)
    out.push('', `### ${file.path}`)
    if (shortened) out.push('(diff shortened to fit the budget; the rest is not shown)')
    out.push('```diff', body, '```')
  }

  if (!any) out.push('', 'No diff bodies fit the budget. The file list above is complete.')
  return out
}

/**
 * What the brief does not contain.
 *
 * The invariant is that the file list is always complete and only bodies are dropped, so
 * this section exists to make the drop visible rather than leave the model to infer it
 * from absence. A page that quietly described only the files it happened to receive would
 * be wrong in a way nobody could see.
 */
function omissions(detail: CommitDetail, allocation: Allocation): string[] {
  const { stats } = allocation
  const out: string[] = []
  const lines: string[] = []

  if (stats.binary.length > 0) {
    lines.push(
      `- ${stats.binary.length} binary file${stats.binary.length === 1 ? '' : 's'}: git records` +
        ' no line changes for these, so no diff exists to show.',
    )
  }
  if (stats.clippedUpstream.length > 0) {
    lines.push(
      `- ${stats.clippedUpstream.length} file${stats.clippedUpstream.length === 1 ? '' : 's'}` +
        " exceeded the reader's 512 KB patch ceiling before the brief was assembled.",
    )
  }
  if (stats.omitted.length > 0) {
    lines.push(
      `- ${stats.omitted.length} file${stats.omitted.length === 1 ? '' : 's'} did not fit the` +
        ' diff budget and appear in the file list with counts only.',
    )
  }
  if (stats.shortened.length > 0) {
    lines.push(`- ${stats.shortened.length} diff${stats.shortened.length === 1 ? ' was' : 's were'} cut short.`)
  }

  if (lines.length === 0) return out

  out.push('', '## Not included in this brief', ...lines)
  out.push(
    '',
    'The file list above is COMPLETE — every file this commit touched is named there. Only',
    'diff bodies were dropped. Say so in the page rather than describing the commit as if',
    'the omitted files did not change.',
  )
  if (detail.clipped) {
    out.push('The underlying patch was itself truncated by the reader before this point.')
  }
  return out
}
