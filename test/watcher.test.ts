import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RepoWatcher, buildIgnoreFilter } from '../src/watch/watcher.js'
import { openRepo } from '../src/git/repo.js'
import { builders, cleanupAll } from './fixtures/make.js'

describe('buildIgnoreFilter', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'git-artifact-ignore-'))
  mkdirSync(path.join(root, 'info'), { recursive: true })
  writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\n!keep.log\n')
  writeFileSync(path.join(root, 'info', 'exclude'), 'scratch/\n')

  const ignored = buildIgnoreFilter(root, root)
  const check = (relative: string) => ignored(path.join(root, relative))

  it('always skips .git and node_modules', () => {
    // Not merely wasteful: a large dependency tree can exhaust the file-descriptor limit.
    expect(check('.git/HEAD')).toBe(true)
    expect(check('node_modules/react/index.js')).toBe(true)
  })

  it('honours .gitignore, including negations', () => {
    expect(check('dist/bundle.js')).toBe(true)
    expect(check('debug.log')).toBe(true)
    expect(check('keep.log')).toBe(false)
  })

  it('honours .git/info/exclude', () => {
    expect(check('scratch/notes.md')).toBe(true)
  })

  it('watches ordinary source files', () => {
    expect(check('src/index.ts')).toBe(false)
    expect(check('README.md')).toBe(false)
  })

  it('never ignores the worktree root itself', () => {
    // Returning true here would make chokidar refuse to watch anything at all.
    expect(ignored(root)).toBe(false)
  })

  it('ignores anything outside the worktree', () => {
    expect(ignored('/etc/passwd')).toBe(true)
    expect(ignored(path.join(root, '..', 'sibling', 'file.ts'))).toBe(true)
  })
})

describe('RepoWatcher', () => {
  afterAll(cleanupAll)

  it('debounces refs faster than working-tree changes', async () => {
    // Ref changes are rare and are the event the user is waiting on; working-tree events
    // arrive in floods and need a wider coalescing window. Same watcher, different
    // budgets — and a stream of file saves must not keep postponing a ref update.
    const repo = await openRepo(builders.linear!())
    const seen: Array<{ kind: string; at: number }> = []
    const start = Date.now()

    const watcher = new RepoWatcher({
      repo,
      onChange: (kinds) => {
        for (const kind of kinds) seen.push({ kind, at: Date.now() - start })
      },
    })

    // Drive the private queue directly: exercising real fs events would make this a
    // timing-sensitive integration test for chokidar rather than for our policy.
    const queue = (kind: 'refs' | 'worktree') =>
      (watcher as unknown as { queue: (k: string) => void }).queue(kind)

    queue('refs')
    queue('worktree')

    await new Promise((resolve) => setTimeout(resolve, 400))
    await watcher.close()

    const refs = seen.find((s) => s.kind === 'refs')
    const worktree = seen.find((s) => s.kind === 'worktree')

    expect(refs).toBeDefined()
    expect(worktree).toBeDefined()
    expect(refs!.at).toBeLessThan(worktree!.at)
    expect(refs!.at).toBeLessThan(150)
  })

  it('gives session events the widest window of the three', async () => {
    /*
     * Nobody is waiting on a session changing status, and a working session flips status
     * every few seconds as it picks up and puts down tools. The window is there to coalesce
     * that chatter, so it must be the loosest budget — the opposite end of the scale from
     * refs, where the whole point is to be fast.
     */
    const repo = await openRepo(builders.linear!())
    const seen: Array<{ kind: string; at: number }> = []
    const start = Date.now()

    const watcher = new RepoWatcher({
      repo,
      onChange: (kinds) => {
        for (const kind of kinds) seen.push({ kind, at: Date.now() - start })
      },
    })
    const queue = (kind: string) =>
      (watcher as unknown as { queue: (k: string) => void }).queue(kind)

    queue('refs')
    queue('worktree')
    queue('sessions')

    await new Promise((resolve) => setTimeout(resolve, 1000))
    await watcher.close()

    const at = (kind: string) => seen.find((s) => s.kind === kind)?.at
    expect(at('sessions')).toBeDefined()
    expect(at('sessions')!).toBeGreaterThan(at('worktree')!)
    expect(at('worktree')!).toBeGreaterThan(at('refs')!)
  })

  it('watches nothing outside the repo unless handed a registry path', async () => {
    /*
     * The session registry lives in the home directory, which is the only path this project
     * ever watches outside the repository — so it has to be opt-in and explicit. Absent the
     * option, a `sessions` event cannot arise at all.
     */
    const repo = await openRepo(builders.linear!())
    const watcher = new RepoWatcher({ repo, onChange: () => {} })
    watcher.start()

    const paths = (watcher as unknown as { watchers: Array<{ getWatched(): object }> }).watchers
      .flatMap((w) => Object.keys(w.getWatched()))
    await watcher.close()

    expect(paths.every((p) => !p.includes(path.join('.claude', 'sessions')))).toBe(true)
  })

  it('coalesces a burst into a single callback', async () => {
    const repo = await openRepo(builders.linear!())
    let calls = 0
    const watcher = new RepoWatcher({ repo, debounceMs: 40, onChange: () => (calls += 1) })
    const queue = (watcher as unknown as { queue: (k: string) => void }).queue.bind(watcher)

    for (let i = 0; i < 50; i++) queue('worktree')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await watcher.close()

    expect(calls).toBe(1)
  })

  it('stops firing once closed', async () => {
    const repo = await openRepo(builders.linear!())
    let calls = 0
    const watcher = new RepoWatcher({ repo, debounceMs: 20, onChange: () => (calls += 1) })
    ;(watcher as unknown as { queue: (k: string) => void }).queue('refs')
    await watcher.close()

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(0)
  })
})
