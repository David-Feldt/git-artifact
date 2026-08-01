import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { heatFromMtime, parseNumstat, parseStatus, readStatus } from '../src/git/status.js'
import { builders, cleanupAll } from './fixtures/make.js'

afterAll(cleanupAll)

/** Build a NUL-delimited record stream the way git writes it with `-z`. */
const stream = (...records: string[]) => records.join('\0') + '\0'

describe('parseStatus', () => {
  it('reads the branch header block', () => {
    const parsed = parseStatus(
      stream(
        '# branch.oid 28ffce6be4ec52ba16cf5dbc0bc232d6474473f7',
        '# branch.head feat/server',
        '# branch.upstream origin/feat/server',
        '# branch.ab +3 -2',
      ),
    )

    expect(parsed.head).toBe('28ffce6be4ec52ba16cf5dbc0bc232d6474473f7')
    expect(parsed.branch).toBe('feat/server')
    expect(parsed.upstream).toBe('origin/feat/server')
    expect(parsed.ahead).toBe(3)
    expect(parsed.behind).toBe(2)
    expect(parsed.detached).toBe(false)
  })

  it('recognises a detached HEAD', () => {
    const parsed = parseStatus(stream('# branch.head (detached)'))
    expect(parsed.detached).toBe(true)
    expect(parsed.branch).toBeNull()
  })

  it('recognises an unborn branch', () => {
    const parsed = parseStatus(stream('# branch.oid (initial)', '# branch.head main'))
    expect(parsed.head).toBeNull()
    expect(parsed.branch).toBe('main')
  })

  it('classifies staged, unstaged and both', () => {
    const parsed = parseStatus(
      stream(
        '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
        '1 .M N... 100644 100644 100644 aaa bbb unstaged.ts',
        '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      ),
    )

    expect(parsed.files).toEqual([
      expect.objectContaining({ path: 'staged.ts', staged: true, unstaged: false }),
      expect.objectContaining({ path: 'unstaged.ts', staged: false, unstaged: true }),
      expect.objectContaining({ path: 'both.ts', staged: true, unstaged: true }),
    ])
  })

  it('reads untracked files and skips ignored ones', () => {
    const parsed = parseStatus(stream('? new.ts', '! dist/bundle.js', '? also-new.ts'))

    // Ignored files are not activity — surfacing build output as "work in progress"
    // would bury the real changes.
    expect(parsed.files.map((f) => f.path)).toEqual(['new.ts', 'also-new.ts'])
    expect(parsed.files.every((f) => f.untracked)).toBe(true)
  })

  it('marks unmerged entries as conflicted', () => {
    const parsed = parseStatus(
      stream('u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts'),
    )
    expect(parsed.files[0]).toMatchObject({ path: 'conflict.ts', conflicted: true })
  })

  it('consumes the extra field a rename record carries', () => {
    // A `2` record is followed by the original path in its own NUL field. Reading it as a
    // separate record would invent a bogus file and shift everything after it.
    const parsed = parseStatus(
      stream(
        '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.ts',
        'old-name.ts',
        '1 .M N... 100644 100644 100644 aaa bbb after.ts',
      ),
    )

    expect(parsed.files.map((f) => f.path)).toEqual(['new-name.ts', 'after.ts'])
  })

  it('keeps spaces in paths intact', () => {
    const parsed = parseStatus(
      stream('1 .M N... 100644 100644 100644 aaa bbb some dir/a file.ts'),
    )
    expect(parsed.files[0]!.path).toBe('some dir/a file.ts')
  })

  it('ignores trailing empty records', () => {
    expect(parseStatus('').files).toEqual([])
    expect(parseStatus('\0\0').files).toEqual([])
  })
})

describe('heatFromMtime', () => {
  const now = 1_700_000_000_000

  it('scores a file touched just now at 1', () => {
    expect(heatFromMtime(now, now)).toBe(1)
  })

  it('halves every ten minutes', () => {
    expect(heatFromMtime(now - 10 * 60_000, now)).toBeCloseTo(0.5, 5)
    expect(heatFromMtime(now - 20 * 60_000, now)).toBeCloseTo(0.25, 5)
  })

  it('decays to near zero over hours', () => {
    expect(heatFromMtime(now - 6 * 3_600_000, now)).toBeLessThan(0.001)
  })

  it('treats a missing mtime as cold', () => {
    expect(heatFromMtime(null, now)).toBe(0)
  })

  it('clamps a future mtime instead of exceeding 1', () => {
    // Clock skew and touched-by-build files routinely produce these.
    expect(heatFromMtime(now + 60_000, now)).toBe(1)
  })
})

describe('parseNumstat', () => {
  /**
   * The line counts on a WIP file chip.
   *
   * Parsed rather than shelled out to, for the same reason `parseStatus` is: the shapes that
   * break it — a rename's extra fields, a binary's `-` — are awkward to produce in a fixture
   * and trivial to write down.
   */

  it('reads added and deleted per path', () => {
    const counts = parseNumstat(stream('12\t3\tsrc/app.ts', '0\t7\tREADME.md'))
    expect(counts.get('src/app.ts')).toEqual({ added: 12, deleted: 3 })
    expect(counts.get('README.md')).toEqual({ added: 0, deleted: 7 })
  })

  it('reports a binary file as uncounted rather than unchanged', () => {
    // git writes `-` for both sides. Zero would claim the file did not change, which is
    // the opposite of what a `-` means.
    const counts = parseNumstat(stream('-\t-\tlogo.png'))
    expect(counts.get('logo.png')).toEqual({ added: null, deleted: null })
  })

  it('consumes the two extra fields a rename carries, and keeps the new name', () => {
    /*
     * The alignment case. A rename's record has an empty path and is followed by old and
     * new as separate NUL fields; missing that would read the next file's numbers against
     * this file's name and silently mislabel every count after it.
     */
    const counts = parseNumstat(
      stream('4\t2\t', 'src/old.ts', 'src/new.ts', '9\t1\tsrc/after.ts'),
    )
    expect(counts.get('src/new.ts')).toEqual({ added: 4, deleted: 2 })
    expect(counts.has('src/old.ts')).toBe(false)
    // The file after the rename must still line up with its own numbers.
    expect(counts.get('src/after.ts')).toEqual({ added: 9, deleted: 1 })
  })

  it('keeps spaces in paths intact', () => {
    const counts = parseNumstat(stream('1\t1\tdocs/design notes.md'))
    expect(counts.get('docs/design notes.md')).toEqual({ added: 1, deleted: 1 })
  })

  it('returns nothing for empty output', () => {
    // A clean tree, and an empty repository where there is no HEAD to diff against.
    expect(parseNumstat('')).toEqual(new Map())
    expect(parseNumstat('\0')).toEqual(new Map())
  })
})

describe('readStatus line counts', () => {
  /**
   * The counts as they actually reach a WIP chip, against a real repository.
   *
   * `parseNumstat` covers the awkward shapes; this covers the join — that a tracked file's
   * numbers survive into `DirtyFile`, and that an untracked file, which has no diff for git
   * to report, is counted by reading it.
   */

  it('counts a tracked edit, and agrees with git', async () => {
    const dir = builders.linear!()
    const file = path.join(dir, 'f.txt')
    writeFileSync(file, readFileSync(file, 'utf8') + 'one\ntwo\nthree\n')

    const status = await readStatus(dir)
    const entry = status.files.find((f) => f.path === 'f.txt')!

    // Not a hard-coded 3: asserted against git's own numstat, so the test cannot drift
    // from the tool it is meant to mirror.
    const [added, deleted] = execFileSync('git', ['diff', '--numstat', 'HEAD', '--', 'f.txt'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\t')
      .map(Number)

    expect(entry.added).toBe(added)
    expect(entry.deleted).toBe(deleted)
  }, 30_000)

  it('counts an untracked file, which has no diff to ask git for', async () => {
    const dir = builders.linear!()
    writeFileSync(path.join(dir, 'new.txt'), 'a\nb\nc\nd\n')

    const status = await readStatus(dir)
    const entry = status.files.find((f) => f.path === 'new.txt')!

    expect(entry.untracked).toBe(true)
    expect(entry.added).toBe(4)
    expect(entry.deleted).toBe(0)
  }, 30_000)

  it('counts a final line with no trailing newline, the way git does', async () => {
    const dir = builders.linear!()
    writeFileSync(path.join(dir, 'new.txt'), 'a\nb\nc')

    const status = await readStatus(dir)
    expect(status.files.find((f) => f.path === 'new.txt')!.added).toBe(3)
  }, 30_000)

  it('reports an untracked binary as uncounted rather than as zero', async () => {
    // A NUL byte is the test, the same one git uses. Zero would claim an empty file.
    const dir = builders.linear!()
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02, 0x0a]))

    const status = await readStatus(dir)
    const entry = status.files.find((f) => f.path === 'blob.bin')!
    expect(entry.added).toBeNull()
    expect(entry.deleted).toBeNull()
  }, 30_000)

  it('leaves counts unknown rather than failing when there is no HEAD', async () => {
    // An empty repository has nothing to diff against. The status itself must still work —
    // it is Tier A, and the counts on top of it are not.
    const dir = builders.empty!()
    writeFileSync(path.join(dir, 'first.txt'), 'hello\n')

    const status = await readStatus(dir)
    const entry = status.files.find((f) => f.path === 'first.txt')!
    // Untracked, so it is read directly and still gets a number even with no HEAD.
    expect(entry.added).toBe(1)
  }, 30_000)
})
