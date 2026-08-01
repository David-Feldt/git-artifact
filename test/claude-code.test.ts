import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearSessionCache,
  escapeProjectPath,
  readSession,
  readLiveSessions,
  readSessionsForRepo,
} from '../src/sources/claude-code.js'

/**
 * The transcript layout is not a stable public contract, so these tests pin the shape we
 * actually observed rather than one we hope for. If Claude Code changes format, this file
 * is where it should fail — loudly, and in one place.
 */

const temps: string[] = []
afterEach(() => {
  clearSessionCache()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'ga-home-'))
  temps.push(home)
  return home
}

/** Write a transcript into the escaped directory for `cwd`. */
function writeTranscript(home: string, cwd: string, id: string, records: unknown[]): string {
  const dir = path.join(home, '.claude', 'projects', escapeProjectPath(cwd))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

const stamp = (min: number) => new Date(1_700_000_000_000 + min * 60_000).toISOString()

const userRecord = (cwd: string, min: number, text: string, extra = {}) => ({
  type: 'user',
  sessionId: 's1',
  cwd,
  gitBranch: 'main',
  timestamp: stamp(min),
  version: '2.1.220',
  origin: { kind: 'human' },
  message: { role: 'user', content: text },
  ...extra,
})

const assistantRecord = (cwd: string, min: number, usage: Record<string, number>) => ({
  type: 'assistant',
  sessionId: 's1',
  cwd,
  timestamp: stamp(min),
  message: { role: 'assistant', model: 'claude-opus-4-8', content: [], usage },
})

describe('escapeProjectPath', () => {
  it('collapses every non-alphanumeric character to a hyphen', () => {
    // Verified against 26 real directories on the development machine.
    expect(escapeProjectPath('/Users/x/3E8-Robotics/Blueprint_ForgeCAD_Setup')).toBe(
      '-Users-x-3E8-Robotics-Blueprint-ForgeCAD-Setup',
    )
    expect(escapeProjectPath('/Users/x/Documents/Obsidian Vault')).toBe(
      '-Users-x-Documents-Obsidian-Vault',
    )
    expect(escapeProjectPath('/Users/x/.claude/worktrees/a')).toBe('-Users-x--claude-worktrees-a')
  })

  it('is lossy, which is why it is only ever used forward', () => {
    // `a_b`, `a.b` and `a b` are indistinguishable afterwards. Parsing a directory name
    // back into a path would silently pick the wrong repository.
    expect(escapeProjectPath('/x/a_b')).toBe(escapeProjectPath('/x/a.b'))
    expect(escapeProjectPath('/x/a b')).toBe(escapeProjectPath('/x/a-b'))
  })
})

describe('readSession', () => {
  it('extracts the fields a band needs', async () => {
    const home = fakeHome()
    const cwd = '/repo'
    const file = writeTranscript(home, cwd, 'abc', [
      userRecord(cwd, 0, 'do the thing'),
      assistantRecord(cwd, 1, {
        input_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        output_tokens: 250,
      }),
      { type: 'ai-title', sessionId: 's1', aiTitle: 'Do the thing' },
      userRecord(cwd, 5, 'and another'),
    ])

    const session = (await readSession(file))!
    expect(session.sessionId).toBe('s1')
    expect(session.title).toBe('Do the thing')
    expect(session.prompts.map((p) => p.text)).toEqual(['do the thing', 'and another'])
    expect(session.model).toBe('claude-opus-4-8')
    expect(session.version).toBe('2.1.220')
    expect(session.branches).toEqual(['main'])
    // Cache reads and creations are real spend and dominate the total — counting only
    // `input_tokens` would under-report by orders of magnitude.
    expect(session.inputTokens).toBe(1510)
    expect(session.outputTokens).toBe(250)
    // Three, not four: `ai-title` records carry no timestamp, so they contribute a title
    // but no activity. Attribution keys off activity, and inventing a timestamp for a
    // metadata record would drag a session's apparent last-active moment around.
    expect(session.activity).toHaveLength(3)
    expect(session.start).toBe(Date.parse(stamp(0)))
    expect(session.end).toBe(Date.parse(stamp(5)))
  })

  it('counts only human turns as prompts', async () => {
    const home = fakeHome()
    const cwd = '/repo'
    const file = writeTranscript(home, cwd, 'abc', [
      userRecord(cwd, 0, 'real prompt'),
      // Tool results come back as `type: user` too. Counting them turns a 2-prompt
      // session into a 100-prompt one.
      userRecord(cwd, 1, 'tool output', { toolUseResult: { ok: true } }),
      userRecord(cwd, 2, 'sidechain', { isSidechain: true }),
      userRecord(cwd, 3, 'meta', { isMeta: true }),
      userRecord(cwd, 4, 'agent turn', { origin: { kind: 'agent' } }),
    ])

    const session = (await readSession(file))!
    expect(session.prompts.map((p) => p.text)).toEqual(['real prompt'])
  })

  it('records every cwd a session moved through', async () => {
    // Real transcripts hold several: a worktree, a subdirectory, and the main repo. The
    // directory name alone therefore cannot decide which repository a session belongs to.
    const home = fakeHome()
    const file = writeTranscript(home, '/repo/wt', 'abc', [
      userRecord('/repo/wt', 0, 'a'),
      userRecord('/repo/wt/server', 1, 'b'),
      userRecord('/repo', 2, 'c'),
    ])

    const session = (await readSession(file))!
    expect(session.cwds.sort()).toEqual(['/repo', '/repo/wt', '/repo/wt/server'])
  })

  it('survives a truncated final line', async () => {
    // Expected while a session is live and mid-write.
    const home = fakeHome()
    const dir = path.join(home, '.claude', 'projects', escapeProjectPath('/repo'))
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'abc.jsonl')
    writeFileSync(file, JSON.stringify(userRecord('/repo', 0, 'ok')) + '\n{"type":"user","cw')

    const session = (await readSession(file))!
    expect(session.prompts).toHaveLength(1)
  })

  it('returns null for a transcript with no timestamps', async () => {
    const home = fakeHome()
    const file = writeTranscript(home, '/repo', 'abc', [{ type: 'summary', text: 'x' }])
    expect(await readSession(file)).toBeNull()
  })

  it('returns null for a missing file', async () => {
    expect(await readSession('/nonexistent/nope.jsonl')).toBeNull()
  })

  it('re-parses only when the file changes', async () => {
    const home = fakeHome()
    const cwd = '/repo'
    const file = writeTranscript(home, cwd, 'abc', [userRecord(cwd, 0, 'one')])

    const first = await readSession(file)
    expect((await readSession(file))).toBe(first) // same object: cache hit

    // Transcripts reach 52 MB, and the graph refreshes on every commit, so an uncached
    // re-read would dominate the update path.
    writeFileSync(
      file,
      [userRecord(cwd, 0, 'one'), userRecord(cwd, 1, 'two')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    const second = await readSession(file)
    expect(second).not.toBe(first)
    expect(second!.prompts).toHaveLength(2)
  })
})

describe('readSessionsForRepo', () => {
  it('finds sessions for the repo root', async () => {
    const home = fakeHome()
    const repo = '/repo'
    writeTranscript(home, repo, 'a', [userRecord(repo, 0, 'x')])

    const sessions = await readSessionsForRepo([repo], { home })
    expect(sessions).toHaveLength(1)
  })

  it('finds a session launched in a subdirectory', async () => {
    // The escaped directory name will not match the repo root, so this only works because
    // recorded cwds are checked too.
    const home = fakeHome()
    const repo = '/repo'
    writeTranscript(home, '/repo/server', 'a', [userRecord('/repo/server', 0, 'x')])

    const sessions = await readSessionsForRepo([repo], { home })
    expect(sessions).toHaveLength(1)
  })

  it('ignores sessions belonging to a different repository', async () => {
    const home = fakeHome()
    writeTranscript(home, '/other', 'a', [userRecord('/other', 0, 'x')])
    expect(await readSessionsForRepo(['/repo'], { home })).toEqual([])
  })

  it('does not match a sibling whose path merely shares a prefix', async () => {
    // `/repo-backup` starts with `/repo` as a string but is a different repository.
    const home = fakeHome()
    writeTranscript(home, '/repo-backup', 'a', [userRecord('/repo-backup', 0, 'x')])
    expect(await readSessionsForRepo(['/repo'], { home })).toEqual([])
  })

  it('includes worktree paths given as additional roots', async () => {
    const home = fakeHome()
    writeTranscript(home, '/wt/feature', 'a', [userRecord('/wt/feature', 0, 'x')])

    const sessions = await readSessionsForRepo(['/repo', '/wt/feature'], { home })
    expect(sessions).toHaveLength(1)
  })

  it('returns nothing when Claude Code is not installed', async () => {
    // The whole feature is optional; absence must never surface as an error.
    const home = fakeHome()
    expect(await readSessionsForRepo(['/repo'], { home })).toEqual([])
  })

  it('sorts sessions oldest first', async () => {
    const home = fakeHome()
    const repo = '/repo'
    writeTranscript(home, repo, 'late', [userRecord(repo, 100, 'x')])
    writeTranscript(home, repo, 'early', [userRecord(repo, 0, 'x')])

    const sessions = await readSessionsForRepo([repo], { home })
    expect(sessions.map((s) => path.basename(s.file))).toEqual(['early.jsonl', 'late.jsonl'])
  })
})

describe('readLiveSessions', () => {
  /**
   * Unlike everything above, this is not inference — a registry entry names a pid, and a
   * pid either exists or it does not. So the tests are about trusting it exactly as far as
   * it deserves: an entry alone proves nothing, an entry with a living process proves
   * everything.
   */

  /** Write a registry entry as Claude Code writes them. */
  function writeEntry(home: string, pid: number, fields: Record<string, unknown> = {}): void {
    const dir = path.join(home, '.claude', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: `s-${pid}`, status: 'idle', ...fields }),
    )
  }

  /**
   * A pid that is certainly not running.
   *
   * Picked above the default `pid_max` on both platforms rather than by allocating and
   * killing a process, which would race: the kernel is free to hand the number straight to
   * somebody else, and the test would then flake as a *pass* on some other program.
   */
  const DEAD_PID = 4_000_000

  it('reports a session whose process is alive', async () => {
    const home = fakeHome()
    writeEntry(home, process.pid, { sessionId: 'mine', status: 'busy' })

    const live = await readLiveSessions({ home })
    expect(live.get('mine')).toEqual({ sessionId: 'mine', pid: process.pid, status: 'busy' })
  })

  it('ignores an entry whose process is gone', async () => {
    // The reason the file alone is not the signal: a session that dies without cleaning up
    // leaves one behind, and trusting it would light up a band forever.
    const home = fakeHome()
    writeEntry(home, DEAD_PID, { sessionId: 'stale' })

    expect(await readLiveSessions({ home })).toEqual(new Map())
  })

  it('passes an unrecognised status through instead of dropping it', async () => {
    // Claude Code's vocabulary is internal and open-ended. A status we have never seen is a
    // session that is plainly running, and must not be silently demoted to dead.
    const home = fakeHome()
    writeEntry(home, process.pid, { sessionId: 'mine', status: 'refactoring-the-universe' })

    expect((await readLiveSessions({ home })).get('mine')?.status).toBe('refactoring-the-universe')
  })

  it('survives entries it cannot use', async () => {
    const home = fakeHome()
    const dir = path.join(home, '.claude', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    writeFileSync(path.join(dir, 'nopid.json'), JSON.stringify({ sessionId: 'x' }))
    writeFileSync(path.join(dir, 'nosession.json'), JSON.stringify({ pid: process.pid }))
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
    writeEntry(home, process.pid, { sessionId: 'good' })

    // One bad file must not cost the others. Tier B degrades per entry, not wholesale.
    expect([...(await readLiveSessions({ home })).keys()]).toEqual(['good'])
  })

  it('returns nothing when there is no registry at all', async () => {
    // Claude Code absent, or a version predating the registry. Neither is an error.
    expect(await readLiveSessions({ home: fakeHome() })).toEqual(new Map())
  })
})
