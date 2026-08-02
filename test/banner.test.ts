import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bannerLines, truncatePath, withBanner, type RepoSnapshot } from '../src/banner.js'
import { assignLanes } from '../src/graph/lanes.js'
import type { Commit } from '../src/graph/model.js'

const OPTS = { version: '1.2.3', repoRoot: '/Users/x/Projects/git-artifact' }
const ANSI = /\x1b\[/
/** Header plus the fixed-height block. */
const HEIGHT = 10

function commit(sha: string, parents: string[], subject: string, refs: string[] = []): Commit {
  return {
    sha: sha.padEnd(40, '0'),
    parents: parents.map((p) => p.padEnd(40, '0')),
    authorName: 'A',
    authorEmail: 'a@example.com',
    authorDate: 1_700_000_000,
    commitDate: 1_700_000_000,
    subject,
    refs: refs.map((name) => ({ raw: name, name, kind: 'branch' as const, isHead: false })),
  }
}

function snapshot(commits: Commit[], dirtyFiles = 0): RepoSnapshot {
  return { rows: assignLanes(commits), dirtyFiles }
}

const LINEAR = [
  commit('aaa', ['bbb'], 'most recent thing', ['main']),
  commit('bbb', ['ccc'], 'middle thing'),
  commit('ccc', [], 'first thing'),
]

/** A stdout stand-in. `isTTY: false` is the non-interactive path the animation must skip. */
function fakeStream(isTTY: boolean, columns = 100) {
  const chunks: string[] = []
  return {
    isTTY,
    columns,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    output: () => chunks.join(''),
  } as unknown as NodeJS.WriteStream & { output: () => string }
}

describe('bannerLines', () => {
  it('heads the block with the wordmark, version and repo path', () => {
    expect(bannerLines(OPTS)[0]).toContain('git-artifact 1.2.3')
    expect(bannerLines(OPTS)[0]).toContain('/Users/x/Projects/git-artifact')
  })

  it('emits no escape sequences', () => {
    expect(bannerLines(OPTS).join('\n')).not.toMatch(ANSI)
  })

  it('never leaves trailing whitespace on a line', () => {
    for (const line of bannerLines(OPTS)) expect(line).toBe(line.trimEnd())
  })

  it('keeps every line inside the terminal width', () => {
    const opts = { ...OPTS, repoRoot: '/a'.repeat(120), snapshot: () => snapshot(LINEAR) }
    for (const columns of [32, 40, 80, 200]) {
      for (const line of bannerLines(opts, columns)) {
        expect(line.length).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('is a fixed-height block whatever it draws', () => {
    expect(bannerLines(OPTS)).toHaveLength(HEIGHT)
    expect(bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR) })).toHaveLength(HEIGHT)
    expect(bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR, 3) })).toHaveLength(HEIGHT)
    expect(bannerLines({ ...OPTS, repoRoot: '/' }, 32)).toHaveLength(HEIGHT)
  })
})

describe('bannerLines with a repository snapshot', () => {
  it('draws the real commits, with shas, refs and subjects', () => {
    const text = bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR) }).join('\n')
    expect(text).toContain('aaa0000')
    expect(text).toContain('most recent thing')
    expect(text).toContain('main')
    expect(text).toContain('first thing')
  })

  it('draws a working-tree node only when something is uncommitted', () => {
    const dirty = bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR, 3) }).join('\n')
    expect(dirty).toContain('3 files changed')
    expect(dirty).toContain('○')

    const clean = bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR, 0) }).join('\n')
    expect(clean).not.toContain('files changed')
  })

  it('counts a single dirty file in the singular', () => {
    const text = bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR, 1) }).join('\n')
    expect(text).toContain('1 file changed')
  })

  it('falls back to the decorative graph when the repository has no commits', () => {
    const text = bannerLines({ ...OPTS, snapshot: () => snapshot([]) }).join('\n')
    expect(text).not.toContain('0000')
    expect(text).toContain('●')
  })

  it('falls back rather than drawing a graph too wide for a banner', () => {
    // A seven-parent octopus needs more lanes than a banner should try to represent.
    const parents = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
    const wide = [
      commit('mmm', parents, 'octopus'),
      ...parents.map((p) => commit(p, [], `root ${p}`)),
    ]
    const text = bannerLines({ ...OPTS, snapshot: () => snapshot(wide) }).join('\n')
    expect(text).not.toContain('octopus')
  })

  it('falls back rather than propagating a snapshot that throws', () => {
    const boom = () => {
      throw new Error('status unavailable')
    }
    expect(() => bannerLines({ ...OPTS, snapshot: boom })).not.toThrow()
    expect(bannerLines({ ...OPTS, snapshot: boom })).toHaveLength(HEIGHT)
  })

  it('falls back when the terminal leaves no room for labels', () => {
    const text = bannerLines({ ...OPTS, snapshot: () => snapshot(LINEAR) }, 34).join('\n')
    expect(text).not.toContain('most recent thing')
  })
})

describe('truncatePath', () => {
  it('leaves a short path alone', () => {
    expect(truncatePath('/a/b', 10)).toBe('/a/b')
  })

  it('keeps the tail, which is the identifying part, and cuts on a separator', () => {
    expect(truncatePath('/very/long/path/to/repo', 10)).toBe('…/to/repo')
  })

  it('keeps a mid-segment cut when snapping would cost too much room', () => {
    const cut = truncatePath('/x/averyverylongdirectoryname/r', 20)
    expect(cut).toHaveLength(20)
    expect(cut.endsWith('/r')).toBe(true)
  })

  it('never exceeds the width it is given', () => {
    for (const max of [2, 5, 12, 40]) {
      expect(truncatePath('/very/long/path/to/some/repo', max).length).toBeLessThanOrEqual(max)
    }
  })

  it('degrades rather than throwing at absurd widths', () => {
    expect(truncatePath('/a/b/c', 1)).toBe('…')
    expect(truncatePath('/a/b/c', 0)).toBe('…')
  })
})

describe('withBanner', () => {
  /*
   * `isInteractive` reads the ambient environment as well as the stream, so faking
   * `isTTY` is not enough to reach the animated path: NO_COLOR, TERM=dumb, or CI — which
   * every CI runner sets — each send it down the static branch instead. Leaving that to
   * the host meant the animation tests below passed on a developer laptop and failed on
   * GitHub Actions, and would fail for anyone who runs with NO_COLOR set.
   *
   * Pinned for the whole block rather than per test, so the static-path cases are equally
   * insulated from a host that happens to set none of them.
   */
  beforeEach(() => {
    vi.stubEnv('CI', undefined)
    vi.stubEnv('NO_COLOR', undefined)
    vi.stubEnv('TERM', 'xterm-256color')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the work result and prints a static block when stdout is not a TTY', async () => {
    const stream = fakeStream(false)
    const result = await withBanner(Promise.resolve('ok'), { ...OPTS, stream })
    expect(result).toBe('ok')
    expect(stream.output()).toContain('git-artifact')
    expect(stream.output()).not.toMatch(ANSI)
  })

  it('shows the real graph on the static path too', async () => {
    const stream = fakeStream(false)
    await withBanner(Promise.resolve(1), { ...OPTS, stream, snapshot: () => snapshot(LINEAR) })
    expect(stream.output()).toContain('most recent thing')
  })

  it('stays static on a TTY when animation is switched off', async () => {
    const stream = fakeStream(true)
    await withBanner(Promise.resolve(1), { ...OPTS, stream, animate: false })
    expect(stream.output()).toContain('git-artifact')
    expect(stream.output()).not.toMatch(ANSI)
  })

  it('propagates a rejection from the work it wraps', async () => {
    const stream = fakeStream(false)
    const work = Promise.reject(new Error('boom'))
    await expect(withBanner(work, { ...OPTS, stream })).rejects.toThrow('boom')
  })

  it('prints nothing when the work it was covering failed', async () => {
    const stream = fakeStream(false)
    await expect(
      withBanner(Promise.reject(new Error('boom')), { ...OPTS, stream }),
    ).rejects.toThrow()
    expect(stream.output()).toBe('')
  })

  it('animates on a TTY and always restores the cursor', async () => {
    const stream = fakeStream(true)
    await withBanner(Promise.resolve(1), { ...OPTS, stream })
    const out = stream.output()
    expect(out).toContain('\x1b[?25l')
    expect(out).toContain('\x1b[?25h')
    expect(out.lastIndexOf('\x1b[?25h')).toBeGreaterThan(out.lastIndexOf('\x1b[?25l'))
  })

  it('restores the cursor even when the work rejects', async () => {
    const stream = fakeStream(true)
    const work = Promise.reject(new Error('boom'))
    await expect(withBanner(work, { ...OPTS, stream })).rejects.toThrow('boom')
    expect(stream.output()).toContain('\x1b[?25h')
  })

  it('morphs into the real graph once the work settles', async () => {
    const stream = fakeStream(true)
    await withBanner(Promise.resolve(1), { ...OPTS, stream, snapshot: () => snapshot(LINEAR, 2) })
    const out = stream.output()
    expect(out).toContain('most recent thing')
    expect(out).toContain('2 files changed')
    // The placeholder must have been drawn first — that is the whole point of the morph.
    expect(out.indexOf('most recent thing')).toBeGreaterThan(out.indexOf('\x1b[?25l'))
  })

  it('redraws every frame at the same height, so nothing scrolls away', async () => {
    const stream = fakeStream(true)
    await withBanner(Promise.resolve(1), { ...OPTS, stream, snapshot: () => snapshot(LINEAR) })
    const ups = [...stream.output().matchAll(/\x1b\[(\d+)A/g)].map((m) => Number(m[1]))
    expect(ups.length).toBeGreaterThan(0)
    expect(new Set(ups)).toEqual(new Set([HEIGHT - 1]))
  })
})
