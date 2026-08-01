/**
 * Deciding which commits belong to which session.
 *
 * Pure: no filesystem, no clock, no git. The inputs are commit times and session activity
 * times, both epoch milliseconds.
 *
 * The naive rule — a session owns every commit between its first and last record — does
 * not work, and it fails badly rather than subtly. Sessions sit idle for days; measured on
 * real data, one that stayed open 13.7 days swallowed every commit three other sessions
 * made inside its window, and up to four bands stacked on a single row. See
 * docs/design/session-bands.md for the measurements.
 *
 * Instead each commit is claimed by exactly one session: whichever was active most
 * recently before it, provided that activity was recent enough to be plausible. Bands are
 * then non-overlapping by construction, which is what makes them drawable at all.
 *
 * This is inference, not a record. Nothing in a transcript says a session *caused* a
 * commit — it is deduced from timing, so a commit typed by hand shortly after Claude
 * stopped will be attributed to that session. Callers must present the result as
 * "observed alongside", never "authored by".
 */

/** Only the fields attribution needs, so tests need not build whole transcripts. */
export interface AttributableSession {
  sessionId: string
  /** Ascending epoch-millisecond timestamps of every record in the session. */
  activity: number[]
}

export interface AttributableCommit {
  sha: string
  /** Committer time in epoch milliseconds. Committer, not author: a rebased or amended
   *  commit keeps its original author date, which would attribute it to the wrong day. */
  at: number
}

/**
 * How long a session may be idle and still be credited with a commit.
 *
 * Thirty minutes cleanly separated every session measured, with the actual gaps landing
 * between 0.0 and 0.4 minutes — commits follow session activity almost immediately, so the
 * threshold sits in a wide empty band rather than cutting through the distribution.
 */
export const DEFAULT_IDLE_LIMIT_MS = 30 * 60 * 1000

export interface Attribution {
  /** Session that claimed this commit, or null when none was plausibly active. */
  sessionId: string | null
  /** Milliseconds between the session's last activity and the commit. Null if unclaimed. */
  gapMs: number | null
}

export interface AttributeOptions {
  idleLimitMs?: number
}

/**
 * Map each commit to at most one session.
 *
 * Ties — two sessions whose last activity lands on the same millisecond — are broken by
 * session id so the result is deterministic. Without that the bands would reshuffle
 * between refreshes for no visible reason.
 */
export function attributeCommits(
  commits: AttributableCommit[],
  sessions: AttributableSession[],
  options: AttributeOptions = {},
): Map<string, Attribution> {
  const idleLimit = options.idleLimitMs ?? DEFAULT_IDLE_LIMIT_MS
  const result = new Map<string, Attribution>()

  const usable = sessions
    .filter((s) => s.activity.length > 0)
    .map((s) => ({ id: s.sessionId, activity: s.activity }))

  for (const commit of commits) {
    let bestId: string | null = null
    let bestGap = Infinity

    for (const session of usable) {
      const last = lastAtOrBefore(session.activity, commit.at)
      if (last === null) continue

      const gap = commit.at - last
      if (gap > idleLimit) continue
      if (gap < bestGap || (gap === bestGap && bestId !== null && session.id < bestId)) {
        bestGap = gap
        bestId = session.id
      }
    }

    result.set(commit.sha, {
      sessionId: bestId,
      gapMs: bestId === null ? null : bestGap,
    })
  }

  return result
}

/** Largest value in an ascending array that is <= `at`, or null. Binary search. */
function lastAtOrBefore(ascending: number[], at: number): number | null {
  let low = 0
  let high = ascending.length - 1
  let found: number | null = null

  while (low <= high) {
    const mid = (low + high) >> 1
    const value = ascending[mid]!
    if (value <= at) {
      found = value
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return found
}

/** A contiguous run of rows claimed by one session. */
export interface SessionBand {
  sessionId: string
  /** Inclusive row indices into the array passed to {@link buildBands}. */
  startRow: number
  endRow: number
  shas: string[]
}

/**
 * Group attributed commits into contiguous row bands.
 *
 * Measured on real repositories, a session's commits are always contiguous in topological
 * order, so a band is one unbroken span. This does not assume that: if a session's rows
 * turn out to be interrupted by another session's, it emits separate bands rather than
 * one band that silently swallows the rows in between. Drawing a band over commits it does
 * not own would be worse than drawing two bands.
 */
export function buildBands(
  orderedShas: string[],
  attribution: Map<string, Attribution>,
): SessionBand[] {
  const bands: SessionBand[] = []
  let current: SessionBand | null = null

  orderedShas.forEach((sha, row) => {
    const sessionId = attribution.get(sha)?.sessionId ?? null

    if (sessionId === null) {
      current = null
      return
    }
    if (current !== null && current.sessionId === sessionId) {
      current.endRow = row
      current.shas.push(sha)
      return
    }

    current = { sessionId, startRow: row, endRow: row, shas: [sha] }
    bands.push(current)
  })

  return bands
}
