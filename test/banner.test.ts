import { describe, expect, it } from 'vitest'
import { bannerLines, truncatePath, withBanner } from '../src/banner.js'

const OPTS = { version: '1.2.3', repoRoot: '/Users/x/Projects/git-artifact' }
const ANSI = /\x1b\[/

/** A stdout stand-in. `isTTY: false` is the non-interactive path the animation must skip. */
function fakeStream(isTTY: boolean, columns = 80) {
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
  it('contains the wordmark, version and repo path', () => {
    const text = bannerLines(OPTS).join('\n')
    expect(text).toContain('git-artifact')
    expect(text).toContain('1.2.3')
    expect(text).toContain('/Users/x/Projects/git-artifact')
  })

  it('emits no escape sequences', () => {
    expect(bannerLines(OPTS).join('\n')).not.toMatch(ANSI)
  })

  it('never leaves trailing whitespace on a line', () => {
    for (const line of bannerLines(OPTS)) expect(line).toBe(line.trimEnd())
  })

  it('keeps every line inside the terminal width', () => {
    for (const columns of [32, 40, 80, 200]) {
      for (const line of bannerLines({ ...OPTS, repoRoot: '/a'.repeat(120) }, columns)) {
        expect(line.length).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('is a fixed-height block regardless of content', () => {
    expect(bannerLines(OPTS)).toHaveLength(8)
    expect(bannerLines({ ...OPTS, repoRoot: '/' }, 32)).toHaveLength(8)
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
  it('returns the work result and prints a static block when stdout is not a TTY', async () => {
    const stream = fakeStream(false)
    const result = await withBanner(Promise.resolve('ok'), { ...OPTS, stream })
    expect(result).toBe('ok')
    expect(stream.output()).toContain('git-artifact')
    expect(stream.output()).not.toMatch(ANSI)
  })

  it('propagates a rejection from the work it wraps', async () => {
    const stream = fakeStream(false)
    const work = Promise.reject(new Error('boom'))
    await expect(withBanner(work, { ...OPTS, stream })).rejects.toThrow('boom')
  })

  it('stays static on a TTY when animation is switched off', async () => {
    const stream = fakeStream(true)
    await withBanner(Promise.resolve(1), { ...OPTS, stream, animate: false })
    expect(stream.output()).toContain('git-artifact')
    expect(stream.output()).not.toMatch(ANSI)
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

  it('stops animating once the work settles', async () => {
    const stream = fakeStream(true)
    let release: () => void = () => {}
    const work = new Promise<void>((resolve) => (release = resolve))
    const done = withBanner(work, { ...OPTS, stream })
    release()
    await done
    // Eight rail frames, two wordmark frames, and a final settled frame — the pulse loop
    // sees `settled` before its first iteration, so it must not add frames of its own.
    expect(stream.output().split('\x1b[0J').length - 1).toBeLessThanOrEqual(12)
  })
})
