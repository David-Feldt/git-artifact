import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isCreation, parseReflog, readHeadLog, readPushEvents } from '../src/git/reflog.js'
import { openRepo } from '../src/git/repo.js'
import { builders, cleanupAll } from './fixtures/make.js'

const line = (
  old: string,
  next: string,
  identity: string,
  ts: number,
  tz: string,
  message: string,
) => `${old} ${next} ${identity} ${ts} ${tz}\t${message}`

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

describe('parseReflog', () => {
  it('parses a real push line', () => {
    const [entry] = parseReflog(
      line(A, B, 'David Feldt <dsfeldt@gmail.com>', 1762929823, '-0800', 'update by push'),
    )

    expect(entry).toEqual({
      oldSha: A,
      newSha: B,
      authorName: 'David Feldt',
      authorEmail: 'dsfeldt@gmail.com',
      timestamp: 1762929823,
      timezone: '-0800',
      message: 'update by push',
      // No colon in this message, so the whole thing is the operation.
      operation: 'update by push',
    })
  })

  it('splits `verb: detail` messages into an operation', () => {
    const [entry] = parseReflog(
      line(A, B, 'X <x@y.z>', 1, '+0000', 'checkout: moving from master to feat/server'),
    )
    expect(entry!.operation).toBe('checkout')
    expect(entry!.message).toBe('checkout: moving from master to feat/server')
  })

  it('keeps a message containing colons intact', () => {
    const [entry] = parseReflog(
      line(A, B, 'X <x@y.z>', 1, '+0000', 'commit: fix: handle the 12:00 case'),
    )
    expect(entry!.message).toBe('commit: fix: handle the 12:00 case')
    expect(entry!.operation).toBe('commit')
  })

  it('handles identities with spaces and odd hostnames', () => {
    // These are real, taken from the machine this was developed on.
    for (const identity of [
      'David Feldt <david@Mac.(none)>',
      'David Feldt <david@Davids-MacBook-Pro.local>',
      'Mary Jo Q. Public-Smith <mj@example.test>',
    ]) {
      const [entry] = parseReflog(line(A, B, identity, 1, '+0000', 'commit: x'))
      expect(entry!.authorName).toBe(identity.slice(0, identity.lastIndexOf('<')).trim())
      expect(entry!.authorEmail).toBe(identity.slice(identity.indexOf('<') + 1, -1))
    }
  })

  it('recognises ref creation by its all-zero old sha', () => {
    const [entry] = parseReflog(line(ZERO, B, 'X <x@y.z>', 1, '+0000', 'branch: Created'))
    expect(isCreation(entry!)).toBe(true)
  })

  it('reads multiple lines and ignores blank ones', () => {
    const raw = [
      line(A, B, 'X <x@y.z>', 1, '+0000', 'one'),
      line(B, A, 'X <x@y.z>', 2, '+0000', 'two'),
      '',
    ].join('\n')
    expect(parseReflog(raw)).toHaveLength(2)
  })

  it('skips malformed lines rather than throwing', () => {
    // Reflog data is a nice-to-have; a truncated file must not take down the read.
    const raw = [
      'not a reflog line at all',
      `${A} ${B} missing-the-tab 1 +0000`,
      'zzzz notahex <x@y.z> 1 +0000\tbad shas',
      line(A, B, 'X <x@y.z>', 3, '+0000', 'good'),
    ].join('\n')

    const entries = parseReflog(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.message).toBe('good')
  })

  it('returns nothing for empty input', () => {
    expect(parseReflog('')).toEqual([])
  })
})

describe('readPushEvents', () => {
  afterAll(cleanupAll)

  it('finds pushes across nested branch names', async () => {
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    const logs = path.join(repo.commonDir, 'logs', 'refs', 'remotes', 'origin', 'feat')
    mkdirSync(logs, { recursive: true })

    // A branch name with a slash: only the first path segment is the remote.
    writeFileSync(
      path.join(logs, 'nested'),
      [
        line(ZERO, A, 'X <x@y.z>', 1000, '+0000', 'fetch origin'),
        line(A, B, 'X <x@y.z>', 2000, '+0000', 'update by push'),
      ].join('\n') + '\n',
    )

    const events = await readPushEvents(repo.commonDir)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      remote: 'origin',
      branch: 'feat/nested',
      ref: 'origin/feat/nested',
      sha: B,
      at: 2_000_000,
    })
  })

  it('ignores fetches, pulls and set-head entries', async () => {
    // These dominate a real remotes log — on the repo used for development, 132 of 186
    // entries were `remote set-head` and only 2 were pushes.
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    const logs = path.join(repo.commonDir, 'logs', 'refs', 'remotes', 'origin')
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      path.join(logs, 'main'),
      [
        line(A, B, 'X <x@y.z>', 1, '+0000', 'fetch --progress --prune origin'),
        line(A, B, 'X <x@y.z>', 2, '+0000', 'pull: fast-forward'),
        line(A, B, 'X <x@y.z>', 3, '+0000', 'remote set-head'),
        line(A, B, 'X <x@y.z>', 4, '+0000', 'clone: from git@example.test:x/y.git'),
      ].join('\n') + '\n',
    )

    expect(await readPushEvents(repo.commonDir)).toEqual([])
  })

  it('returns nothing when no remote is configured', async () => {
    const repo = await openRepo(builders.linear!())
    expect(await readPushEvents(repo.commonDir)).toEqual([])
  })

  it('sorts events oldest first', async () => {
    const dir = builders.linear!()
    const repo = await openRepo(dir)
    const logs = path.join(repo.commonDir, 'logs', 'refs', 'remotes', 'origin')
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      path.join(logs, 'a'),
      line(A, B, 'X <x@y.z>', 3000, '+0000', 'update by push') + '\n',
    )
    writeFileSync(
      path.join(logs, 'b'),
      line(A, B, 'X <x@y.z>', 1000, '+0000', 'update by push') + '\n',
    )

    const events = await readPushEvents(repo.commonDir)
    expect(events.map((e) => e.branch)).toEqual(['b', 'a'])
  })
})

describe('readHeadLog', () => {
  afterAll(cleanupAll)

  it('records every HEAD movement with a timestamp', async () => {
    const dir = builders.branchMerge!()
    const repo = await openRepo(dir)
    const entries = await readHeadLog(repo.gitDir)

    expect(entries.length).toBeGreaterThan(0)
    // The fixture commits, branches, checks out and merges, so those verbs must appear.
    const operations = new Set(entries.map((e) => e.operation))
    expect(operations.has('commit')).toBe(true)
    expect(operations.has('checkout')).toBe(true)
    // Timestamps are what make this a timeline rather than a list.
    expect(entries.every((e) => Number.isFinite(e.timestamp) && e.timestamp > 0)).toBe(true)
  })

  it('returns nothing for a repo with no commits', async () => {
    const repo = await openRepo(builders.empty!())
    expect(await readHeadLog(repo.gitDir)).toEqual([])
  })

  it('reads a linked worktree`s own HEAD log, not the shared one', async () => {
    const dir = builders.worktrees!()
    const repo = await openRepo(dir)
    const linked = repo.worktrees.find((w) => !w.isMain)!
    const linkedRepo = await openRepo(linked.path)

    // A linked worktree keeps HEAD under .git/worktrees/<name>/, so gitDir and commonDir
    // differ — reading the common one would report the main checkout's history instead.
    expect(linkedRepo.gitDir).not.toBe(linkedRepo.commonDir)
    const entries = await readHeadLog(linkedRepo.gitDir)
    expect(entries.length).toBeGreaterThan(0)
  })
})

describe('reflog against real git output', () => {
  afterAll(cleanupAll)

  it('agrees with `git reflog` on entry count and shas', async () => {
    const dir = builders.branchMerge!()
    const repo = await openRepo(dir)

    const expected = execFileSync(
      'git',
      ['--no-pager', 'reflog', 'show', '--format=%H', 'HEAD'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    )
      .split('\n')
      .filter(Boolean)

    // git lists newest first; the file is oldest first.
    const ours = (await readHeadLog(repo.gitDir)).map((e) => e.newSha).reverse()
    expect(ours).toEqual(expected)
  })
})
