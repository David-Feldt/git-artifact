import { describe, expect, it } from 'vitest'
import type { SessionBandInfo } from '../src/api.js'
import { toCards } from '../src/client/components/SessionStrip.js'

/**
 * Collapsing bands back into sessions.
 *
 * `graph.sessions` carries one entry per band, and a session splits into several bands the
 * moment another session's commits interleave with its own — measured on this repository,
 * 8 bands for 5 sessions. Cards are about sessions, so the split has to be undone.
 */

function band(overrides: Partial<SessionBandInfo> = {}): SessionBandInfo {
  return {
    sessionId: 's1',
    title: 'A session',
    startRow: 0,
    endRow: 1,
    commitCount: 2,
    promptCount: 7,
    inputTokens: 1_000_000,
    outputTokens: 50_000,
    model: 'claude',
    startedAt: 1_000,
    endedAt: 2_000,
    branches: ['main'],
    live: null,
    ...overrides,
  }
}

describe('toCards', () => {
  it('collapses several bands of one session into a single card', () => {
    const cards = toCards([
      band({ startRow: 0, endRow: 0 }),
      band({ startRow: 4, endRow: 6 }),
      band({ startRow: 9, endRow: 11 }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.sessionId).toBe('s1')
  })

  it('unions the branches across a session, whichever band carried them', () => {
    const cards = toCards([
      band({ branches: ['main'] }),
      band({ branches: ['export', 'main'] }),
    ])
    expect(cards[0]!.branches).toEqual(['main', 'export'])
  })

  it('takes the outer bounds of the timestamps', () => {
    const cards = toCards([
      band({ startedAt: 5_000, endedAt: 9_000 }),
      band({ startedAt: 1_000, endedAt: 3_000 }),
    ])
    expect(cards[0]!.startedAt).toBe(1_000)
    expect(cards[0]!.endedAt).toBe(9_000)
  })

  it('keeps a session live when any of its bands says so', () => {
    const cards = toCards([band({ live: null }), band({ live: { status: 'busy' } })])
    expect(cards[0]!.live).toEqual({ status: 'busy' })
  })

  it('orders by most recent activity, not by position in the graph', () => {
    // The session you were just in is the one you want to see first, and that is not the
    // one whose commits happen to sit highest.
    const cards = toCards([
      band({ sessionId: 'old', endedAt: 1_000 }),
      band({ sessionId: 'new', endedAt: 9_000 }),
      band({ sessionId: 'mid', endedAt: 5_000 }),
    ])
    expect(cards.map((c) => c.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('keeps distinct sessions distinct', () => {
    const cards = toCards([band({ sessionId: 'a' }), band({ sessionId: 'b' })])
    expect(cards).toHaveLength(2)
  })

  it('handles a repository with no sessions at all', () => {
    expect(toCards([])).toEqual([])
  })

  it('carries no commit information, because none of it is recorded', () => {
    const card = toCards([band()])[0]!
    expect(card).not.toHaveProperty('commitCount')
    expect(card).not.toHaveProperty('startRow')
    expect(card).not.toHaveProperty('endRow')
  })
})
