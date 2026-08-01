import { describe, expect, it } from 'vitest'
import type { CommitDetail, DiffFile, SessionBandInfo } from '../src/api.js'
import { buildBrief, DEFAULT_BUDGET, type Budget } from '../src/artifacts/bundle.js'
import { artifactKey } from '../src/artifacts/cache.js'
import { extractFragment, HarnessError, sanitiseFragment } from '../src/artifacts/harness.js'

/**
 * The brief, and the budget that bounds it.
 *
 * The budget is the part of this feature that can fail catastrophically rather than badly:
 * measured on real history, one commit in the largest repository here is 85 MB and another
 * is a single 135,037-line text file. Both are represented below.
 */

function file(path: string, lines: number, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: lines,
    deletions: 0,
    binary: false,
    clipped: false,
    hunks: [
      {
        header: `@@ -1,0 +1,${lines} @@`,
        lines: Array.from({ length: lines }, (_, i) => ({
          kind: 'add' as const,
          oldLine: null,
          newLine: i + 1,
          text: `line ${i} of ${path} padded out to a realistic width for a source line`,
        })),
      },
    ],
    ...overrides,
  }
}

function detail(files: DiffFile[], overrides: Partial<CommitDetail> = {}): CommitDetail {
  return {
    sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    parents: ['0000000000000000000000000000000000000001'],
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.test',
    authorDate: 1_700_000_000,
    committerName: 'Ada Lovelace',
    committerEmail: 'ada@example.test',
    commitDate: 1_700_000_000,
    subject: 'Teach the engine to hold both viability legs',
    body: '',
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: 0,
    mergeFirstParent: false,
    clipped: false,
    ...overrides,
  }
}

const brief = (d: CommitDetail, budget?: Budget, session: SessionBandInfo | null = null) =>
  buildBrief(
    { repoName: 'demo', detail: d, session, pushes: [], refs: ['main'], now: 0 },
    budget ?? DEFAULT_BUDGET,
  )

describe('the budget', () => {
  it('admits smallest first, so one huge file cannot starve twenty small ones', () => {
    /*
     * The failure this exists to prevent. `readCommitDetail` fills its 512 KB ceiling
     * positionally, so a generated file early in the diff consumes everything and every
     * file after it arrives empty. Measured for real: a 135,037-line STEP file, which is
     * plain text and diffs happily.
     *
     * The huge file is deliberately first in the list, which is the order a positional
     * budget would honour. Every small file after it must still get its diff.
     */
    const files = [
      file('CAD/model.STEP', 9000),
      ...Array.from({ length: 20 }, (_, i) => file(`src/mod${i}.ts`, 8)),
    ]
    const result = brief(detail(files), { totalChars: 40_000, perFileChars: 5_000 })

    expect(result.stats.included).toBe(20)
    for (let i = 0; i < 20; i++) expect(result.text).toContain(`line 0 of src/mod${i}.ts`)

    // The big one is bounded rather than allowed to own the budget, and is labelled as cut.
    expect(result.stats.shortened).toEqual(['CAD/model.STEP'])
    expect(result.stats.included).toBeGreaterThan(result.stats.shortened.length)
  })

  it('omits a file outright once nothing legible would fit', () => {
    const files = [file('CAD/model.STEP', 9000), file('src/a.ts', 8)]
    const result = brief(detail(files), { totalChars: 700, perFileChars: 5_000 })

    // The small file takes what there is; the large one gets nothing rather than a stub.
    expect(result.text).toContain('line 0 of src/a.ts')
    expect(result.stats.omitted).toEqual(['CAD/model.STEP'])
  })

  it('never truncates the file list, only diff bodies', () => {
    const files = [file('huge.txt', 20_000), file('small.ts', 4)]
    const result = brief(detail(files), { totalChars: 800, perFileChars: 800 })

    // The invariant. A page can always say correctly *which* files changed.
    for (const f of files) expect(result.text).toContain(f.path)
    expect(result.text).toContain('The file list above is COMPLETE')
  })

  it('says what it dropped instead of leaving it to be inferred from absence', () => {
    const result = brief(detail([file('huge.txt', 20_000), file('ok.ts', 3)]), {
      totalChars: 600,
      perFileChars: 600,
    })
    expect(result.text).toContain('## Not included in this brief')
    expect(result.text).toContain('did not fit the diff budget')
  })

  it('gives a binary file no body and explains why', () => {
    const bin = file('assets/arm.stl', 0, { binary: true, additions: null, deletions: null })
    const result = brief(detail([bin, file('src/a.ts', 4)]))

    expect(result.stats.binary).toEqual(['assets/arm.stl'])
    expect(result.text).toContain('assets/arm.stl')
    expect(result.text).toContain('no line changes for these')
    // Rule 1 alone is not the mitigation, but it must still hold.
    expect(result.text).not.toContain('line 0 of assets/arm.stl')
  })

  it('reports a file the git layer already clipped separately from its own omissions', () => {
    // Different cause, different fix — collapsing them would hide which one happened.
    const upstream = file('vendor/bundle.js', 0, { clipped: true, hunks: [] })
    const result = brief(detail([upstream, file('src/a.ts', 4)]))

    expect(result.stats.clippedUpstream).toEqual(['vendor/bundle.js'])
    expect(result.text).toContain('512 KB patch ceiling')
  })

  it('shortens a lone oversized file rather than dropping it entirely', () => {
    const result = brief(detail([file('big.ts', 4000)]), {
      totalChars: 100_000,
      perFileChars: 3_000,
    })
    expect(result.stats.shortened).toEqual(['big.ts'])
    expect(result.text).toContain('diff shortened to fit the budget')
    expect(result.text).toContain('line 0 of big.ts')
  })

  it('never cuts a diff mid-line', () => {
    const result = brief(detail([file('big.ts', 4000)]), {
      totalChars: 100_000,
      perFileChars: 3_000,
    })
    const body = /```diff\n([\s\S]*?)```/.exec(result.text)![1]!
    for (const line of body.split('\n').filter(Boolean)) {
      expect(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('@') || line.startsWith('\\')).toBe(true)
    }
  })

  it('survives a commit where nothing at all fits', () => {
    const result = brief(detail([file('huge.txt', 50_000)]), {
      totalChars: 50,
      perFileChars: 50,
    })
    expect(result.text).toContain('No diff bodies fit the budget')
    expect(result.text).toContain('huge.txt')
  })
})

describe('the brief', () => {
  const session: SessionBandInfo = {
    sessionId: 's1',
    title: 'Understand background changes',
    startRow: 0,
    endRow: 1,
    commitCount: 2,
    promptCount: 7,
    inputTokens: 1000,
    outputTokens: 100,
    model: 'claude',
    startedAt: 0,
    endedAt: 1000,
    branches: ['main'],
  }

  it('tells the model that attribution is inferred, not recorded', () => {
    const result = brief(detail([file('a.ts', 3)]), DEFAULT_BUDGET, session)
    expect(result.text).toContain('observed alongside')
    expect(result.text).toContain('NOT authored by')
    expect(result.text).toContain('never state or')
  })

  it('tells it not to speculate when there is no session at all', () => {
    const result = brief(detail([file('a.ts', 3)]))
    expect(result.text).toContain('Do not speculate')
  })

  it('carries the repository name and never a path', () => {
    const result = brief(detail([file('a.ts', 3)]))
    expect(result.text).toContain('repository: demo')
    expect(result.text).not.toContain('/Users/')
    expect(result.text).not.toContain(process.cwd())
  })

  it('flags a merge as first-parent, because the default diff answers a different question', () => {
    const merge = detail([file('a.ts', 3)], {
      parents: ['1'.repeat(40), '2'.repeat(40)],
      mergeFirstParent: true,
    })
    expect(brief(merge).text).toContain('FIRST PARENT only')
  })

  it('notes a root commit rather than leaving the parent list blank', () => {
    expect(brief(detail([file('a.ts', 3)], { parents: [] })).text).toContain('root commit')
  })

  it('includes the message body when there is one', () => {
    const withBody = detail([file('a.ts', 3)], { body: 'Fixes the thing.\n\nDetail here.' })
    expect(brief(withBody).text).toContain('Detail here.')
  })
})

describe('extractFragment', () => {
  it('passes a bare fragment through', () => {
    expect(extractFragment('<p class="lede">Hello.</p>')).toBe('<p class="lede">Hello.</p>')
  })

  it('unwraps a fenced fragment', () => {
    expect(extractFragment('```html\n<p>Hi</p>\n```')).toBe('<p>Hi</p>')
  })

  it('drops a chatty preamble rather than writing it into the page', () => {
    const out = extractFragment("Sure! Here's the analysis:\n\n<p>Hi</p>")
    expect(out).toContain('<p>Hi</p>')
  })

  it('keeps only the body when the model returns a whole document anyway', () => {
    // The chassis supplies the chrome; a returned <head> would end up rendered as text.
    const out = extractFragment(
      '<!doctype html><html><head><style>p{color:red}</style></head><body><p>Real content</p></body></html>',
    )
    expect(out).toBe('<p>Real content</p>')
    expect(out).not.toContain('<style>')
  })

  it('fails loudly when there is no markup at all', () => {
    expect(() => extractFragment('I cannot help with that.')).toThrow(HarnessError)
    expect(() => extractFragment('   ')).toThrow(HarnessError)
  })
})

describe('sanitiseFragment', () => {
  /*
   * The page is served same-origin with the daemon, and its content derives from a diff —
   * which is text someone else can author when you review an untrusted branch.
   */
  it('removes a script element and its contents', () => {
    const out = sanitiseFragment('<p>ok</p><script>fetch("/api/graph")</script><p>after</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('fetch(')
    expect(out).toContain('<p>after</p>')
  })

  it('removes inline event handlers', () => {
    expect(sanitiseFragment('<p onclick="steal()">x</p>')).toBe('<p>x</p>')
    expect(sanitiseFragment("<div onerror='steal()'>x</div>")).toBe('<div>x</div>')
  })

  it('removes javascript: urls', () => {
    expect(sanitiseFragment('<a href="javascript:steal()">x</a>')).not.toContain('javascript:')
  })

  it('removes elements that can load or submit', () => {
    for (const tag of ['<iframe src="x"></iframe>', '<link rel="stylesheet" href="x">', '<form action="x"></form>']) {
      expect(sanitiseFragment(`<p>a</p>${tag}`)).toBe('<p>a</p>')
    }
  })

  it('leaves ordinary content, including inline svg diagrams, alone', () => {
    const svg = '<figure><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></figure>'
    expect(sanitiseFragment(svg)).toBe(svg)
  })
})

describe('artifactKey', () => {
  it('changes when the brief changes, even though the sha has not', () => {
    // A commit is immutable; its brief is not. Session attribution shifts when a transcript
    // is written later, and a push marker appears when the work leaves the machine.
    const sha = 'a'.repeat(40)
    expect(artifactKey(sha, 'brief one')).not.toBe(artifactKey(sha, 'brief two'))
  })

  it('is stable for the same inputs', () => {
    const sha = 'a'.repeat(40)
    expect(artifactKey(sha, 'same')).toBe(artifactKey(sha, 'same'))
  })
})
