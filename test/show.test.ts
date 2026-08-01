import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  isValidSha,
  parseNameStatus,
  parseNumstat,
  parsePatch,
  readCommitDetail,
  UnknownCommitError,
} from '../src/git/show.js'
import { builders, cleanupAll } from './fixtures/make.js'

afterAll(() => cleanupAll())

const rev = (dir: string, spec: string) =>
  execFileSync('git', ['rev-parse', spec], { cwd: dir, encoding: 'utf8' }).trim()

describe('readCommitDetail', () => {
  it('reads metadata and the patch for an ordinary commit', async () => {
    const dir = builders.linear!()
    const detail = await readCommitDetail(dir, rev(dir, 'HEAD'))

    expect(detail.subject).toBe('third')
    expect(detail.authorName).toBe('Fixture Author')
    expect(detail.authorEmail).toBe('author@example.test')
    expect(detail.parents).toHaveLength(1)
    expect(detail.mergeFirstParent).toBe(false)
    expect(detail.clipped).toBe(false)

    expect(detail.files).toHaveLength(1)
    const [file] = detail.files
    expect(file!.path).toBe('f.txt')
    expect(file!.status).toBe('modified')
    expect(file!.additions).toBe(1)
    expect(file!.deletions).toBe(0)
    expect(file!.hunks.length).toBeGreaterThan(0)
    expect(detail.additions).toBe(1)
  })

  it('reads a root commit, whose whole tree is an addition', async () => {
    const dir = builders.linear!()
    const detail = await readCommitDetail(dir, rev(dir, 'HEAD~2'))

    expect(detail.parents).toEqual([])
    expect(detail.files[0]!.status).toBe('added')
    expect(detail.files[0]!.hunks[0]!.lines.every((line) => line.kind === 'add')).toBe(true)
  })

  it('diffs a merge against its first parent rather than showing a combined diff', async () => {
    // git's default for a merge is `--cc`, which lists only what the merger resolved by
    // hand — nothing at all on a clean merge. That is the case this fixture is.
    const dir = builders.octopus!()
    const detail = await readCommitDetail(dir, rev(dir, 'HEAD'))

    expect(detail.parents).toHaveLength(4)
    expect(detail.mergeFirstParent).toBe(true)
    expect(detail.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(detail.files.every((file) => file.hunks.length === 1)).toBe(true)
  })

  it('carries renames, binaries, deletes and awkward paths through intact', async () => {
    const dir = builders.patches!()
    const detail = await readCommitDetail(dir, rev(dir, 'HEAD'))

    const byPath = new Map(detail.files.map((file) => [file.path, file]))

    const renamed = byPath.get('verse.txt')
    expect(renamed?.status).toBe('renamed')
    expect(renamed?.oldPath).toBe('poem.txt')
    // Edits at both ends of the file, further apart than the context window.
    expect(renamed?.hunks).toHaveLength(2)

    const binary = byPath.get('logo.bin')
    expect(binary?.binary).toBe(true)
    // Null, not zero: git counts no lines in a binary file, and reporting `+0 −0` would
    // claim it was unchanged.
    expect(binary?.additions).toBeNull()
    expect(binary?.hunks).toEqual([])
    expect(binary?.clipped).toBe(false)

    expect(byPath.get("odd name'$.txt")?.status).toBe('deleted')
    expect(byPath.get('added.txt')?.status).toBe('added')
  })

  it('numbers lines against the pre- and post-image', async () => {
    const dir = builders.patches!()
    const detail = await readCommitDetail(dir, rev(dir, 'HEAD'))
    const hunk = detail.files.find((file) => file.path === 'verse.txt')!.hunks[0]!

    const added = hunk.lines.find((line) => line.kind === 'add')!
    const removed = hunk.lines.find((line) => line.kind === 'del')!
    expect(added.oldLine).toBeNull()
    expect(added.newLine).toBe(1)
    expect(removed.newLine).toBeNull()
    expect(removed.oldLine).toBe(1)
    expect(added.text).toBe('line one')

    const context = hunk.lines.find((line) => line.kind === 'context')!
    expect(context.oldLine).toBe(context.newLine)
  })

  it('rejects a sha that is not a commit', async () => {
    const dir = builders.linear!()
    // A blob's sha is a well-formed object name, and without the `^{commit}` peel git
    // would happily print the file's contents into the patch parser.
    await expect(readCommitDetail(dir, rev(dir, 'HEAD:f.txt'))).rejects.toBeInstanceOf(
      UnknownCommitError,
    )
  })

  it('rejects an unknown and a malformed sha without running git', async () => {
    const dir = builders.linear!()
    await expect(readCommitDetail(dir, 'deadbeef'.repeat(5))).rejects.toBeInstanceOf(
      UnknownCommitError,
    )
    await expect(readCommitDetail(dir, 'HEAD@{yesterday}')).rejects.toBeInstanceOf(
      UnknownCommitError,
    )
  })
})

describe('isValidSha', () => {
  it('accepts abbreviated and full object names', () => {
    expect(isValidSha('a1b2')).toBe(true)
    expect(isValidSha('0'.repeat(40))).toBe(true)
  })

  it('rejects anything that is a revision expression rather than an object name', () => {
    // Every one of these is a valid rev that git would resolve, and none is a sha.
    for (const input of ['HEAD', 'main', 'HEAD~1', 'HEAD@{0}', ':/fix', '../etc', '', 'ABC123']) {
      expect(isValidSha(input)).toBe(false)
    }
  })
})

describe('parseNameStatus', () => {
  it('pairs a rename with its old path', () => {
    const entries = parseNameStatus('M\0a.txt\0R073\0old name.txt\0new name.txt\0D\0gone.txt\0')
    expect(entries).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified' },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' },
      { path: 'gone.txt', oldPath: null, status: 'deleted' },
    ])
  })

  it('survives a path containing a newline', () => {
    const entries = parseNameStatus('A\0two\nlines.txt\0')
    expect(entries).toEqual([{ path: 'two\nlines.txt', oldPath: null, status: 'added' }])
  })
})

describe('parseNumstat', () => {
  it('marks a binary file with null counts rather than zeroes', () => {
    expect(parseNumstat('-\t-\tlogo.bin\0')).toEqual([
      { path: 'logo.bin', additions: null, deletions: null, binary: true },
    ])
  })

  it('takes the new path from a rename record', () => {
    // A rename leaves the path field empty and follows with old and new as separate records.
    const entries = parseNumstat('3\t1\t\0old.txt\0new.txt\x004\t0\tafter.txt\0')
    expect(entries).toEqual([
      { path: 'new.txt', additions: 3, deletions: 1, binary: false },
      { path: 'after.txt', additions: 4, deletions: 0, binary: false },
    ])
  })

  it('keeps a path containing a tab whole', () => {
    // `split('\t')` would truncate this at the first tab and lose half the filename.
    expect(parseNumstat('1\t0\ttabbed\tname.txt\0')[0]!.path).toBe('tabbed\tname.txt')
  })
})

describe('parsePatch', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -3,2 +3,3 @@ inside someFunction()',
    ' kept',
    '-dropped',
    '+first',
    '+second',
    '\\ No newline at end of file',
    '',
  ].join('\n')

  it('numbers both sides and keeps the header verbatim', () => {
    const { blocks, clipped } = parsePatch(patch)
    expect(clipped).toBe(false)
    expect(blocks).toHaveLength(1)

    const hunk = blocks[0]!.hunks[0]!
    expect(hunk.header).toBe('@@ -3,2 +3,3 @@ inside someFunction()')
    expect(hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 3, 3],
      ['del', 4, null],
      ['add', null, 4],
      ['add', null, 5],
      // The no-newline marker annotates the line above and consumes no line number.
      ['meta', null, null],
    ])
  })

  it('treats a single-line hunk header, where git omits the count, as one line', () => {
    const { blocks } = parsePatch('diff --git a/a b/a\n@@ -7 +7 @@\n-old\n+new\n')
    const [removed, added] = blocks[0]!.hunks[0]!.lines
    expect(removed!.oldLine).toBe(7)
    expect(added!.newLine).toBe(7)
  })

  it('starts a new block per file', () => {
    const two = `${patch}diff --git a/b.txt b/b.txt\n@@ -1 +1 @@\n-x\n+y\n`
    expect(parsePatch(two).blocks).toHaveLength(2)
  })

  it('reports an empty patch rather than inventing a block', () => {
    expect(parsePatch('')).toEqual({ blocks: [], clipped: false })
  })
})
