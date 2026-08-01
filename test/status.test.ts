import { describe, expect, it } from 'vitest'
import { heatFromMtime, parseStatus } from '../src/git/status.js'

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
