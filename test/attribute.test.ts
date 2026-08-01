import { describe, expect, it } from 'vitest'
import {
  attributeCommits,
  buildBands,
  DEFAULT_IDLE_LIMIT_MS,
  type AttributableCommit,
  type AttributableSession,
} from '../src/sessions/attribute.js'

const MIN = 60_000
const T0 = 1_700_000_000_000

const session = (id: string, ...offsetsMin: number[]): AttributableSession => ({
  sessionId: id,
  activity: offsetsMin.map((m) => T0 + m * MIN).sort((a, b) => a - b),
})

const commit = (sha: string, offsetMin: number): AttributableCommit => ({
  sha,
  at: T0 + offsetMin * MIN,
})

const idOf = (m: Map<string, { sessionId: string | null }>, sha: string) =>
  m.get(sha)!.sessionId

describe('attributeCommits', () => {
  it('claims a commit for the session active just before it', () => {
    const result = attributeCommits([commit('c1', 10)], [session('s1', 0, 9)])
    expect(idOf(result, 'c1')).toBe('s1')
    expect(result.get('c1')!.gapMs).toBe(1 * MIN)
  })

  it('leaves a commit unclaimed when every session is too stale', () => {
    // A commit made by hand, hours after anything was running.
    const result = attributeCommits([commit('c1', 600)], [session('s1', 0, 30)])
    expect(idOf(result, 'c1')).toBeNull()
    expect(result.get('c1')!.gapMs).toBeNull()
  })

  it('never claims a commit for a session that had not started', () => {
    const result = attributeCommits([commit('c1', 5)], [session('s1', 10, 20)])
    expect(idOf(result, 'c1')).toBeNull()
  })

  /*
   * The case that motivates the whole algorithm.
   *
   * `idle` spans 13 days and its outer window contains every commit here. A naive
   * "session owns everything between first and last record" rule would give it all four,
   * on top of the sessions that actually produced them. Measured on real data this
   * stacked four overlapping bands on a single row.
   */
  it('does not let a long-idle session swallow other sessions work', () => {
    const DAY = 24 * 60
    const sessions = [
      session('idle', 0, 13 * DAY),
      session('worker-a', 100, 101),
      session('worker-b', 200, 201),
    ]
    const commits = [commit('c1', 102), commit('c2', 202)]

    const result = attributeCommits(commits, sessions)
    expect(idOf(result, 'c1')).toBe('worker-a')
    expect(idOf(result, 'c2')).toBe('worker-b')
  })

  it('prefers the more recently active of two overlapping sessions', () => {
    const sessions = [session('older', 0, 5), session('newer', 0, 9)]
    expect(idOf(attributeCommits([commit('c1', 10)], sessions), 'c1')).toBe('newer')
  })

  it('breaks exact ties deterministically', () => {
    // Two sessions last active on the same millisecond. Whatever the answer, it must not
    // change between refreshes, or bands reshuffle on screen for no reason.
    const sessions = [session('bbb', 9), session('aaa', 9)]
    const first = idOf(attributeCommits([commit('c1', 10)], sessions), 'c1')
    const second = idOf(attributeCommits([commit('c1', 10)], [...sessions].reverse()), 'c1')
    expect(first).toBe(second)
    expect(first).toBe('aaa')
  })

  it('honours the idle limit exactly at its boundary', () => {
    const limitMin = DEFAULT_IDLE_LIMIT_MS / MIN
    const s = [session('s1', 0)]
    expect(idOf(attributeCommits([commit('at', limitMin)], s), 'at')).toBe('s1')
    expect(idOf(attributeCommits([commit('past', limitMin + 0.001)], s), 'past')).toBeNull()
  })

  it('accepts a custom idle limit', () => {
    const s = [session('s1', 0)]
    const strict = attributeCommits([commit('c1', 5)], s, { idleLimitMs: 60_000 })
    expect(idOf(strict, 'c1')).toBeNull()
    const loose = attributeCommits([commit('c1', 5)], s, { idleLimitMs: 10 * MIN })
    expect(idOf(loose, 'c1')).toBe('s1')
  })

  it('ignores sessions with no recorded activity', () => {
    const result = attributeCommits([commit('c1', 10)], [{ sessionId: 'empty', activity: [] }])
    expect(idOf(result, 'c1')).toBeNull()
  })

  it('returns an entry for every commit, claimed or not', () => {
    const result = attributeCommits(
      [commit('c1', 10), commit('c2', 9999)],
      [session('s1', 0, 9)],
    )
    expect([...result.keys()].sort()).toEqual(['c1', 'c2'])
  })

  it('handles a session with many records without missing the nearest', () => {
    // Exercises the binary search rather than a scan.
    const activity = Array.from({ length: 5000 }, (_, i) => i)
    const result = attributeCommits([commit('c1', 4999.5)], [session('s1', ...activity)])
    expect(idOf(result, 'c1')).toBe('s1')
    expect(result.get('c1')!.gapMs).toBeCloseTo(0.5 * MIN, 0)
  })
})

describe('buildBands', () => {
  const attribution = (pairs: Record<string, string | null>) =>
    new Map(
      Object.entries(pairs).map(([sha, sessionId]) => [sha, { sessionId, gapMs: null }]),
    )

  it('groups a contiguous run into one band', () => {
    const bands = buildBands(
      ['a', 'b', 'c'],
      attribution({ a: 's1', b: 's1', c: 's1' }),
    )
    expect(bands).toEqual([{ sessionId: 's1', startRow: 0, endRow: 2, shas: ['a', 'b', 'c'] }])
  })

  it('starts a new band when the session changes', () => {
    const bands = buildBands(
      ['a', 'b', 'c'],
      attribution({ a: 's1', b: 's2', c: 's2' }),
    )
    expect(bands.map((b) => [b.sessionId, b.startRow, b.endRow])).toEqual([
      ['s1', 0, 0],
      ['s2', 1, 2],
    ])
  })

  it('breaks a band around an unattributed commit', () => {
    // The hand-made commit in the middle is not the session's, and a band drawn straight
    // over it would claim work the session did not do.
    const bands = buildBands(
      ['a', 'b', 'c'],
      attribution({ a: 's1', b: null, c: 's1' }),
    )
    expect(bands.map((b) => [b.sessionId, b.startRow, b.endRow])).toEqual([
      ['s1', 0, 0],
      ['s1', 2, 2],
    ])
  })

  it('emits nothing when no commit is attributed', () => {
    expect(buildBands(['a', 'b'], attribution({ a: null, b: null }))).toEqual([])
  })

  it('handles an empty graph', () => {
    expect(buildBands([], new Map())).toEqual([])
  })

  it('produces bands that never overlap', () => {
    const bands = buildBands(
      ['a', 'b', 'c', 'd', 'e'],
      attribution({ a: 's1', b: 's1', c: 's2', d: null, e: 's2' }),
    )
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.startRow).toBeGreaterThan(bands[i - 1]!.endRow)
    }
  })
})
