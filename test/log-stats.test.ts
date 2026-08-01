import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { parseLogStats, readLogStats } from '../src/git/log.js'
import { builders, cleanupAll } from './fixtures/make.js'

afterAll(() => cleanupAll())

const rev = (dir: string, spec: string) =>
  execFileSync('git', ['rev-parse', spec], { cwd: dir, encoding: 'utf8' }).trim()

/**
 * The parser reads prose git writes for humans, which is only safe because `exec.ts` pins
 * `LC_ALL=C`. So these pin the *shape* of that prose, and the fixture tests below check it
 * against a real git rather than trusting the shape to still be current.
 */
describe('parseLogStats', () => {
  const R = '\x1e'

  it('reads a full summary line', () => {
    const raw = `${R}abc123\n 3 files changed, 40 insertions(+), 7 deletions(-)\n`
    expect(parseLogStats(raw)).toEqual({ abc123: { files: 3, additions: 40, deletions: 7 } })
  })

  it('handles a commit with only additions', () => {
    const raw = `${R}abc123\n 1 file changed, 12 insertions(+)\n`
    expect(parseLogStats(raw)).toEqual({ abc123: { files: 1, additions: 12, deletions: 0 } })
  })

  it('handles a commit with only deletions', () => {
    const raw = `${R}abc123\n 2 files changed, 9 deletions(-)\n`
    expect(parseLogStats(raw)).toEqual({ abc123: { files: 2, additions: 0, deletions: 9 } })
  })

  /*
   * The case that decides whether "nobody counted" and "nothing changed" look alike further
   * down. Git prints no summary line at all for a commit that changes nothing, and the row
   * has to be able to say 0/0/0 rather than fall through to the absent-stat rendering.
   */
  it('reads a commit with no summary line as zero rather than as missing', () => {
    expect(parseLogStats(`${R}abc123\n`)).toEqual({
      abc123: { files: 0, additions: 0, deletions: 0 },
    })
  })

  it('keeps adjacent records apart, including an empty one between two full ones', () => {
    const raw =
      `${R}aaa\n 1 file changed, 1 insertion(+)\n\n` +
      `${R}bbb\n\n` +
      `${R}ccc\n 2 files changed, 3 insertions(+), 4 deletions(-)\n`

    expect(parseLogStats(raw)).toEqual({
      aaa: { files: 1, additions: 1, deletions: 0 },
      bbb: { files: 0, additions: 0, deletions: 0 },
      ccc: { files: 2, additions: 3, deletions: 4 },
    })
  })

  it('is empty for empty output', () => {
    expect(parseLogStats('')).toEqual({})
  })
})

describe('readLogStats', () => {
  it('counts every commit in the window, including the root', async () => {
    const dir = builders.linear!()
    const stats = await readLogStats(dir)

    expect(Object.keys(stats)).toHaveLength(3)
    // The root has no parent to diff against, so git diffs it against the empty tree and
    // the whole file reads as an addition.
    expect(stats[rev(dir, 'HEAD~2')]).toEqual({ files: 1, additions: 1, deletions: 0 })
    expect(stats[rev(dir, 'HEAD')]).toEqual({ files: 1, additions: 1, deletions: 0 })
  })

  /*
   * The reason `--diff-merges=first-parent` is passed at all. Git's default for a merge is
   * the combined diff, which lists only what the merger resolved by hand — nothing on a
   * clean merge — so every merge in the graph would otherwise report zero files.
   */
  it('reports what a merge brought in rather than its combined diff', async () => {
    const dir = builders.branchMerge!()
    const stats = await readLogStats(dir)

    expect(stats[rev(dir, 'HEAD')]).toEqual({ files: 1, additions: 1, deletions: 0 })
  })

  it('does the same for an octopus, where three parents merge cleanly', async () => {
    const dir = builders.octopus!()
    const stats = await readLogStats(dir)

    expect(stats[rev(dir, 'HEAD')]!.files).toBe(3)
  })

  /*
   * `-M`, and the fact that a binary file is a file with no lines. Without rename detection
   * the moved poem would read as a 20-line add plus a 20-line delete, which is a wildly
   * wrong answer to "how big was this commit".
   */
  it('detects renames and counts a binary file as a file with no lines', async () => {
    const dir = builders.patches!()
    const stat = (await readLogStats(dir))[rev(dir, 'HEAD')]!

    // verse.txt (renamed, edited), logo.bin (binary), added.txt, and the deleted odd name.
    expect(stat.files).toBe(4)
    // Two edited lines in the rename plus one added file, and no sign of 20 moved lines.
    expect(stat.additions).toBe(3)
    expect(stat.deletions).toBe(3)
  })

  it('returns nothing for a repo with no commits', async () => {
    expect(await readLogStats(builders.empty!())).toEqual({})
  })

  it('honours the history cap', async () => {
    const dir = builders.linear!()
    expect(Object.keys(await readLogStats(dir, { maxCount: 2 }))).toHaveLength(2)
  })
})
