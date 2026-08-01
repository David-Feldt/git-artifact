import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateToken } from '../src/server/auth.js'
import { startDaemon, type Daemon } from '../src/server/index.js'
import { GraphStore } from '../src/server/store.js'
import { clearSessionCache, escapeProjectPath } from '../src/sources/claude-code.js'
import { builders, cleanupAll } from './fixtures/make.js'

/**
 * One session's prompts, end to end.
 *
 * The panel exists because the strip's cards can say "43 prompts" and not what any of them
 * were. What is asserted here is the part that could quietly go wrong: that the response is
 * bounded, that unknown time stays unknown, and that a session with no transcript is an
 * ordinary empty answer rather than an error.
 */

const homes: string[] = []
afterAll(() => {
  clearSessionCache()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  cleanupAll()
})

/** Matches `BASE_TIME` in `fixtures/make.ts`, which pins every fixture commit. */
const BASE_MS = 1_700_000_000 * 1000

interface Turn {
  text: string
  /** Minutes after `BASE_MS`. */
  at: number
  durationMs?: number
}

function fakeHome(dir: string, sessionId: string, turns: Turn[]): string {
  const home = mkdtempSync(path.join(tmpdir(), 'ga-sd-home-'))
  homes.push(home)

  // The *resolved* path: on macOS `tmpdir()` is a symlink and git reports the target, so a
  // fixture keyed on the unresolved path silently matches nothing.
  const repoDir = realpathSync(dir)
  const projects = path.join(home, '.claude', 'projects', escapeProjectPath(repoDir))
  mkdirSync(projects, { recursive: true })

  const records: unknown[] = [{ type: 'ai-title', sessionId, aiTitle: 'A session' }]
  for (const turn of turns) {
    records.push({
      type: 'user',
      sessionId,
      cwd: repoDir,
      gitBranch: 'main',
      timestamp: new Date(BASE_MS + turn.at * 60_000).toISOString(),
      origin: { kind: 'human' },
      message: { role: 'user', content: turn.text },
    })
    if (turn.durationMs !== undefined) {
      records.push({
        type: 'system',
        subtype: 'turn_duration',
        sessionId,
        cwd: repoDir,
        timestamp: new Date(BASE_MS + turn.at * 60_000 + turn.durationMs).toISOString(),
        durationMs: turn.durationMs,
        isSidechain: false,
      })
    }
  }

  writeFileSync(
    path.join(projects, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  return home
}

async function storeFor(turns: Turn[]): Promise<GraphStore> {
  const dir = builders.linear!()
  const store = new GraphStore(dir, {
    maxCount: 5000,
    claudeHome: fakeHome(dir, 'sess-1', turns),
  })
  await store.init()
  return store
}

describe('getSessionDetail', () => {
  it('returns the prompts in reading order with their measured timings', async () => {
    const store = await storeFor([
      { text: 'first thing', at: 0, durationMs: 90_000 },
      { text: 'second thing', at: 10, durationMs: 30_000 },
    ])

    const detail = (await store.getSessionDetail('sess-1'))!
    expect(detail.title).toBe('A session')
    expect(detail.prompts.map((p) => p.text)).toEqual(['first thing', 'second thing'])
    expect(detail.prompts.map((p) => p.durationMs)).toEqual([90_000, 30_000])
    expect(detail.workingMs).toBe(120_000)
    // Both figures, because they answer different questions: the span says when, the
    // working total says how long. Here they differ by a factor of five.
    expect(detail.endedAt - detail.startedAt).toBe(10 * 60_000 + 30_000)
    expect(detail.clipped).toBe(false)
    expect(detail.branches).toEqual(['main'])
  })

  it('leaves an unmeasured turn null rather than calling it zero', async () => {
    const store = await storeFor([{ text: 'interrupted', at: 0 }])

    const detail = (await store.getSessionDetail('sess-1'))!
    expect(detail.workingMs).toBeNull()
    expect(detail.prompts[0]!.durationMs).toBeNull()
  })

  it('clips a prompt too large to ship, and says so', async () => {
    // A prompt is whatever was pasted into a terminal and has no natural bound. The
    // largest single one measured on this repository is 83 KB.
    const store = await storeFor([
      { text: 'x'.repeat(400_000), at: 0 },
      { text: 'short one', at: 5 },
    ])

    const detail = (await store.getSessionDetail('sess-1'))!
    expect(detail.clipped).toBe(true)
    expect(detail.prompts[0]!.clipped).toBe(true)
    expect(detail.prompts[0]!.text.length).toBeLessThanOrEqual(16 * 1024)
    // The budget is spent newest-first, so the short recent prompt survives whole — it is
    // the one being looked for.
    expect(detail.prompts[1]!.clipped).toBe(false)
    expect(detail.prompts[1]!.text).toBe('short one')
  })

  it('bounds the whole response, not just each prompt', async () => {
    const store = await storeFor(
      Array.from({ length: 60 }, (_, i) => ({ text: 'y'.repeat(20_000), at: i })),
    )

    const detail = (await store.getSessionDetail('sess-1'))!
    const total = detail.prompts.reduce((sum, p) => sum + p.text.length, 0)
    expect(total).toBeLessThanOrEqual(256 * 1024)
    // Every prompt is still listed. Dropping entries would make the panel disagree with
    // the count on the card that opened it.
    expect(detail.prompts).toHaveLength(60)
  })

  it('returns null for a session this repository has no transcript for', async () => {
    const store = await storeFor([{ text: 'a', at: 0 }])
    expect(await store.getSessionDetail('nobody')).toBeNull()
  })
})

describe('GET /api/session', () => {
  let daemon: Daemon
  let token: string

  afterAll(async () => {
    await daemon?.close()
  })

  it('serves, rejects and reports missing', async () => {
    const store = await storeFor([{ text: 'do the thing', at: 0, durationMs: 4_000 }])
    token = generateToken()
    daemon = await startDaemon({ store, token, port: 0 })
    const base = `http://127.0.0.1:${daemon.port}`

    const ok = await fetch(`${base}/api/session?id=sess-1&t=${token}`)
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.prompts).toHaveLength(1)
    expect(body.prompts[0].text).toBe('do the thing')
    expect(body.workingMs).toBe(4_000)

    // Not a session id. The id never reaches the filesystem, but the shape check keeps a
    // directory scan from being spent on something that cannot match.
    const bad = await fetch(`${base}/api/session?id=${encodeURIComponent('../../etc')}&t=${token}`)
    expect(bad.status).toBe(400)

    const missing = await fetch(`${base}/api/session?id=unknown&t=${token}`)
    expect(missing.status).toBe(404)

    // The read-only rule is absolute and this route is no exception.
    const post = await fetch(`${base}/api/session?id=sess-1&t=${token}`, { method: 'POST' })
    expect(post.status).toBe(405)
  })
})
