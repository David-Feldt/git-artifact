import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assignLanes } from '../src/graph/lanes.js'
import type { Commit } from '../src/graph/model.js'
import type { GraphPayload, SessionBandInfo, WorktreeStatus } from '../src/api.js'
import { buildDisplayRows, sessionSpan, sliceRows } from '../src/client/components/layout.js'
import { HEAT_HEX, LANE_HEX, PAPER, laneHex, mix } from '../src/client/export/palette.js'
import { exportFilename } from '../src/client/export/download.js'
import { ICON_VIEWBOX, MONITOR_PATHS } from '../src/client/icons.js'

/** `--live` from `theme.css`. Asserted as absent from exports; see the band test below. */
const LIVE_HEX = '#008300'
import { fit, renderGraphSvg, type Font, type Measure } from '../src/client/export/svg.js'

/**
 * The exporter, tested without a browser.
 *
 * `renderGraphSvg` takes its text measurement as a parameter precisely so this is possible:
 * the only thing it needs from a DOM is how wide a string is, and a deterministic stub
 * makes the output byte-stable.
 */
const measure: Measure = (text: string, font: Font) => text.length * font.size * 0.55

function c(sha: string, subject: string, ...parents: string[]): Commit {
  return {
    sha,
    parents,
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.test',
    authorDate: 1_700_000_000,
    commitDate: 1_700_000_000,
    subject,
    refs: [],
  }
}

function payload(commits: Commit[], overrides: Partial<GraphPayload> = {}): GraphPayload {
  const rows = assignLanes(commits)
  return {
    repo: {
      root: '/Users/someone/Projects/demo',
      name: 'demo',
      state: {
        empty: false,
        bare: false,
        shallow: false,
        detachedHead: false,
        rebaseInProgress: false,
        mergeInProgress: false,
        cherryPickInProgress: false,
        bisectInProgress: false,
      },
      currentBranch: 'main',
      head: commits[0]?.sha ?? null,
      worktrees: [],
      remotes: ['origin'],
    },
    rows,
    sessions: [],
    pushes: {},
    worktreeLanes: [],
    width: Math.max(1, ...rows.map((r) => r.width)),
    capped: false,
    maxCount: 5000,
    // Local rather than UTC, so the filename assertions below do not depend on the zone the
    // suite happens to run in.
    generatedAt: new Date(2026, 7, 1, 12, 30).getTime(),
    ...overrides,
  }
}

const render = (graph: GraphPayload, worktrees: WorktreeStatus[] = []) =>
  renderGraphSvg(
    { graph, rows: buildDisplayRows(graph.rows, worktrees, graph.sessions), now: 1_700_000_000_000 },
    { measure },
  )

describe('renderGraphSvg', () => {
  it('produces a self-contained, parseable SVG', () => {
    const svg = render(payload([c('b2', 'second commit', 'a1'), c('a1', 'first commit')]))
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('first commit')
    expect(svg).toContain('second commit')
  })

  it('references nothing outside itself', () => {
    const svg = render(payload([c('a1', 'only')]))
    // No network, no stylesheet, no font file. A rasteriser gets the whole picture.
    // The SVG namespace is a URI rather than a fetch, so it is not what this is looking for.
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:\/\//)
    expect(svg).not.toContain('href')
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('@import')
    expect(svg).not.toContain('foreignObject')
  })

  it('resolves every colour to literal hex', () => {
    const svg = render(payload([c('b2', 'second', 'a1'), c('a1', 'first')]))
    // `var()` renders in a browser and silently loses every colour in most rasterisers.
    expect(svg).not.toContain('var(')
    expect(svg).not.toContain('color-mix')
    expect(svg).toContain(PAPER)
    expect(svg).toContain(laneHex(0))
  })

  it('never leaks the repository path', () => {
    const graph = payload([c('a1', 'only')])
    const svg = render(graph)
    // An exported artifact is the thing most likely to be forwarded. `repo.root` is a
    // home-directory path; only the basename belongs in it.
    expect(svg).not.toContain(graph.repo.root)
    expect(svg).toContain('demo')
  })

  it('escapes text that would otherwise break the document', () => {
    const svg = render(payload([c('a1', 'fix <script> & "quotes" in \'subjects\'')]))
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&amp;')
    expect(svg).not.toContain('<script>')
  })

  it('grows in height with the number of commits, and not in width', () => {
    const small = render(payload([c('a1', 'one')]))
    const large = render(payload([c('c3', 'three', 'b2'), c('b2', 'two', 'a1'), c('a1', 'one')]))
    const heightOf = (svg: string) => Number(/height="([\d.]+)"/.exec(svg)![1])
    const widthOf = (svg: string) => Number(/width="([\d.]+)"/.exec(svg)![1])

    expect(heightOf(large)).toBeGreaterThan(heightOf(small))
    expect(widthOf(large)).toBe(widthOf(small))
  })

  it('carries the "observed alongside" qualifier whenever a band is drawn', () => {
    const session: SessionBandInfo = {
      sessionId: 's1',
      title: 'Understand background changes',
      startRow: 0,
      endRow: 1,
      commitCount: 2,
      promptCount: 7,
      inputTokens: 2_400_000,
      outputTokens: 60_000,
      model: 'claude',
      startedAt: Date.UTC(2026, 7, 1, 10, 0),
      endedAt: Date.UTC(2026, 7, 1, 11, 0),
      branches: ['main', 'feature'],
      live: null,
    }
    const graph = payload([c('b2', 'second', 'a1'), c('a1', 'first')], { sessions: [session] })
    const svg = render(graph)

    expect(svg).toContain('Understand background changes')
    expect(svg).toContain('2.5M tok')
    expect(svg).toContain('2 branches')
    // The wording is load-bearing: nothing records that a session *caused* a commit, and
    // the file is read with none of the UI around it to qualify the claim.
    expect(svg).toContain('observed alongside')
    expect(svg).not.toContain('authored by them.</text>'.replace('them.', 'these'))
  })

  it('opens a band with the same icon geometry the DOM draws', () => {
    /*
     * The export re-draws every row by hand, so nothing but this stops the icon in a saved
     * file drifting from the one on screen once someone edits `icons.ts`. Asserting the
     * path data rather than "an icon is present" is the whole point.
     */
    const session: SessionBandInfo = {
      sessionId: 's1',
      title: 'Understand background changes',
      startRow: 0,
      endRow: 0,
      commitCount: 1,
      promptCount: 3,
      inputTokens: 1000,
      outputTokens: 100,
      model: 'claude',
      startedAt: Date.UTC(2026, 7, 1, 10, 0),
      endedAt: Date.UTC(2026, 7, 1, 11, 0),
      branches: ['main'],
      live: null,
    }
    const svg = render(payload([c('a1', 'first')], { sessions: [session] }))

    for (const d of MONITOR_PATHS) expect(svg).toContain(`<path d="${d}"/>`)
    // Scaled into the 14px box `.shead__mark` declares, not left at the 24-unit viewbox.
    expect(svg).toContain(`scale(${Math.round((14 / ICON_VIEWBOX) * 100) / 100})`)
  })

  it('dates a band by its last activity, and never claims it is running', () => {
    const session: SessionBandInfo = {
      sessionId: 's1',
      title: 'Understand background changes',
      startRow: 0,
      endRow: 0,
      commitCount: 1,
      promptCount: 3,
      inputTokens: 1000,
      outputTokens: 100,
      model: 'claude',
      startedAt: Date.UTC(2026, 7, 1, 10, 0),
      endedAt: Date.UTC(2026, 7, 1, 11, 0),
      branches: ['main'],
      live: { status: 'busy' },
    }
    const graph = payload([c('a1', 'first')], { sessions: [session] })
    const svg = renderGraphSvg(
      {
        graph,
        rows: buildDisplayRows(graph.rows, [], graph.sessions),
        now: session.endedAt + 2 * 60 * 60 * 1000,
      },
      { measure },
    )

    // The measurement, in the margin, in the same words a commit row uses.
    expect(svg).toContain('>2h<')

    /*
     * Liveness is deliberately absent. On screen a dot says "running right now" and is
     * re-pushed the moment that stops being true; a file forwarded next week has no such
     * correction available, so the export carries only what stays true — see the note in
     * `renderSessionRow`. This asserts the omission, because a later change that "fixed the
     * inconsistency" by drawing it would be a regression, not a fix.
     */
    expect(svg).not.toContain('busy')
    expect(svg).not.toContain(LIVE_HEX)
  })

  it('keeps a dated band inside the card it is drawn in', () => {
    /*
     * The margin timestamp shortens the rule and squeezes the meta, so this is the widest a
     * band's contents get. Exercised at the width where the fitting has least slack.
     */
    const session: SessionBandInfo = {
      sessionId: 's1',
      title: 'A session title that simply refuses to stop going on and on and on',
      startRow: 0,
      endRow: 0,
      commitCount: 1,
      promptCount: 3,
      inputTokens: 2_400_000,
      outputTokens: 60_000,
      model: 'claude',
      startedAt: Date.UTC(2026, 7, 1, 10, 0),
      endedAt: Date.UTC(2026, 7, 1, 11, 0),
      branches: ['main', 'feature', 'third'],
      live: null,
    }
    const graph = payload([c('a1', 'first')], { sessions: [session] })
    const svg = renderGraphSvg(
      {
        graph,
        rows: buildDisplayRows(graph.rows, [], graph.sessions),
        now: session.endedAt + 40 * 24 * 60 * 60 * 1000,
      },
      { measure },
    )

    const width = Number(/width="([\d.]+)"/.exec(svg)![1])
    for (const [, x] of svg.matchAll(/<text x="([\d.-]+)"/g)) {
      expect(Number(x)).toBeLessThan(width)
    }
    for (const [, x] of svg.matchAll(/translate\(([\d.-]+) /g)) {
      expect(Number(x)).toBeLessThan(width)
    }
  })

  it('keeps every line of text inside the document', () => {
    /*
     * The layout invariant that matters. On screen a flex row absorbs an over-long branch
     * name by squeezing its neighbour; here every position is computed up front, so an
     * unbudgeted chip runs straight through the text beside it. This is the guard.
     */
    const long = c('a1', 'a subject that goes on and on and really does not know when to stop')
    long.refs = [
      { raw: 'HEAD -> main', name: 'main', kind: 'head', isHead: true },
      { raw: 'a-branch-name-nobody-should-have-chosen-but-here-we-are', name: 'a-branch-name-nobody-should-have-chosen-but-here-we-are', kind: 'branch', isHead: false },
      { raw: 'origin/another-extremely-long-remote-tracking-branch', name: 'origin/another-extremely-long-remote-tracking-branch', kind: 'remote', isHead: false },
    ]
    const svg = render(payload([long]))
    const width = Number(/width="([\d.]+)"/.exec(svg)![1])

    for (const match of svg.matchAll(/<text x="([\d.]+)"[^>]*font-size="([\d.]+)"([^>]*)>(.*?)<\/text>/g)) {
      const x = Number(match[1])
      const size = Number(match[2])
      const anchored = match[3]!.includes('text-anchor="end"')
      const content = match[4]!
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
      const rightEdge = anchored ? x : x + content.length * size * 0.55
      expect(rightEdge).toBeLessThanOrEqual(width)
    }
  })

  it('truncates an over-long ref rather than letting it run into the subject', () => {
    const commit = c('a1', 'the subject')
    commit.refs = [
      { raw: 'x'.repeat(200), name: 'x'.repeat(200), kind: 'branch', isHead: false },
    ]
    const svg = render(payload([commit]))
    expect(svg).not.toContain('x'.repeat(200))
    expect(svg).toContain('…')
    // The subject still gets drawn; the ref does not consume the whole row.
    expect(svg).toContain('the subject')
  })

  it('says so when history was capped', () => {
    const graph = payload([c('a1', 'only')], { capped: true, maxCount: 10 })
    expect(render(graph)).toContain('History capped at 10 commits.')
  })

  it('renders a WIP row with its dirty files', () => {
    const worktree: WorktreeStatus = {
      path: '/Users/someone/Projects/demo',
      branch: 'main',
      head: 'a1',
      detached: false,
      ahead: 1,
      behind: 0,
      upstream: 'origin/main',
      files: [
        { path: 'src/deep/nested/engine.ts', status: ' M', staged: false, unstaged: true, untracked: false, conflicted: false, mtimeMs: 0, heat: 0.9 },
        { path: 'README.md', status: '??', staged: false, unstaged: false, untracked: true, conflicted: false, mtimeMs: 0, heat: 0.1 },
      ],
      peakHeat: 0.9,
    }
    const svg = render(payload([c('a1', 'first')]), [worktree])

    expect(svg).toContain('>wip<')
    expect(svg).toContain('2 files')
    // Basenames only: a full path does not fit and the directory is not the point.
    expect(svg).toContain('engine.ts')
    expect(svg).not.toContain('src/deep/nested/engine.ts')
    // Heat is a five-step ramp, and the hottest file must not read as the coolest.
    expect(svg).toContain(HEAT_HEX[4])
  })

  it('marks a pushed commit', () => {
    const graph = payload([c('a1', 'first')], {
      pushes: { a1: [{ ref: 'origin/main', at: 1_699_996_400_000, authorName: 'Ada' }] },
    })
    expect(render(graph)).toContain('pushed')
  })

  it('handles an empty graph without producing a broken document', () => {
    const svg = render(payload([]))
    expect(svg).toContain('</svg>')
    expect(svg).toContain('0 commits')
  })
})

describe('scoped export', () => {
  const session: SessionBandInfo = {
    sessionId: 's1',
    title: 'Understand background changes',
    startRow: 1,
    endRow: 2,
    commitCount: 2,
    promptCount: 7,
    inputTokens: 1000,
    outputTokens: 100,
    model: 'claude',
    startedAt: 0,
    endedAt: 60_000,
    branches: ['main'],
    live: null,
  }

  const scoped = () => {
    const graph = payload(
      [
        c('d4', 'newest, outside the band', 'c3'),
        c('c3', 'inside the band, newer', 'b2'),
        c('b2', 'inside the band, older', 'a1'),
        c('a1', 'oldest, outside the band'),
      ],
      { sessions: [session] },
    )
    const rows = buildDisplayRows(graph.rows, [], graph.sessions)
    const span = sessionSpan(graph.rows, rows, session)!
    return { graph, rows, span }
  }

  it('resolves a band to its display rows through the end commit sha', () => {
    const { rows, span } = scoped()
    // The header is spliced in above the band's first commit, so the display indices are
    // not the graph indices the server sent.
    expect(rows[span.first]!.kind).toBe('session')
    expect(span.last).toBeGreaterThan(span.first)
  })

  it('renumbers a slice so its rails are drawn against the right rows', () => {
    const { rows, span } = scoped()
    const slice = sliceRows(rows, span.first, span.last)
    expect(slice.map((r) => r.index)).toEqual([0, 1, 2])
    // The originals are untouched; slicing must not mutate the live list.
    expect(rows[span.first]!.index).toBe(span.first)
  })

  it('renders only the band, and counts only what it drew', () => {
    const { graph, rows, span } = scoped()
    const svg = renderGraphSvg(
      { graph, rows: sliceRows(rows, span.first, span.last), now: 1_700_000_000_000 },
      { measure, scopeLabel: session.title! },
    )

    expect(svg).toContain('inside the band, newer')
    expect(svg).toContain('inside the band, older')
    expect(svg).not.toContain('outside the band')
    // Two commits, not the repository's four.
    expect(svg).toContain('2 commits')
    expect(svg).not.toContain('4 commits')
  })

  it('names what it is an excerpt of, so it cannot pass as the whole history', () => {
    const { graph, rows, span } = scoped()
    const svg = renderGraphSvg(
      { graph, rows: sliceRows(rows, span.first, span.last), now: 1_700_000_000_000 },
      { measure, scopeLabel: session.title! },
    )
    expect(svg).toContain('Understand background changes')
    // The branch chip is replaced by the scope, not joined by it.
    expect(svg).not.toContain('>main<')
  })

  it('clips the body so a rail leaving the last row cannot cross the footer', () => {
    const { graph, rows, span } = scoped()
    const svg = renderGraphSvg(
      { graph, rows: sliceRows(rows, span.first, span.last), now: 1_700_000_000_000 },
      { measure, scopeLabel: session.title! },
    )
    expect(svg).toContain('<clipPath id="body">')
    expect(svg).toContain('clip-path="url(#body)"')
    // Nothing in a slice should produce undefined geometry.
    expect(svg).not.toContain('NaN')
  })

  it('keeps the attribution wording on an excerpt, which is always a band', () => {
    const { graph, rows, span } = scoped()
    const svg = renderGraphSvg(
      { graph, rows: sliceRows(rows, span.first, span.last), now: 1_700_000_000_000 },
      { measure, scopeLabel: session.title! },
    )
    expect(svg).toContain('observed alongside')
  })

  it('drops the band note from an excerpt that has no band in it', () => {
    const { graph, rows, span } = scoped()
    // Commits only, header excluded.
    const svg = renderGraphSvg(
      { graph, rows: sliceRows(rows, span.first + 1, span.last), now: 1_700_000_000_000 },
      { measure },
    )
    expect(svg).not.toContain('observed alongside')
  })
})

describe('fit', () => {
  it('leaves text that already fits alone', () => {
    expect(fit('short', 1000, { family: 'ui', size: 13, weight: 400 }, measure)).toEqual({
      text: 'short',
      truncated: false,
    })
  })

  it('truncates with an ellipsis and stays inside the budget', () => {
    const font: Font = { family: 'ui', size: 13, weight: 400 }
    const result = fit('a subject far too long for the column it is in', 60, font, measure)
    expect(result.truncated).toBe(true)
    expect(result.text.endsWith('…')).toBe(true)
    expect(measure(result.text, font)).toBeLessThanOrEqual(60)
  })

  it('returns nothing rather than overflowing when there is no room at all', () => {
    expect(fit('anything', 0, { family: 'ui', size: 13, weight: 400 }, measure).text).toBe('')
  })
})

describe('palette', () => {
  it('matches theme.css, which is the source of truth', async () => {
    // The hex is duplicated so the export needs no stylesheet. This is the guard that stops
    // the two drifting: change a hue in theme.css and this fails.
    const css = await readFile(
      fileURLToPath(new URL('../src/client/theme.css', import.meta.url)),
      'utf8',
    )
    const declared = (name: string) => {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
      return match?.[1]?.toLowerCase()
    }

    LANE_HEX.forEach((hex, index) => expect(declared(`lane-${index + 1}`)).toBe(hex))
    HEAT_HEX.forEach((hex, index) => expect(declared(`heat-${index}`)).toBe(hex))
    expect(declared('paper')).toBe(PAPER)
  })

  it('cycles lane hues past eight, exactly as the live palette does', () => {
    expect(laneHex(8)).toBe(LANE_HEX[0])
    expect(laneHex(9)).toBe(LANE_HEX[1])
  })

  it('mixes two colours in sRGB, standing in for color-mix()', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#ff0000')
  })
})

describe('exportFilename', () => {
  const input = (name: string) => ({
    graph: { ...payload([]), repo: { ...payload([]).repo, name } },
    rows: [],
    now: 0,
  })

  it('names the file after the repository and the moment it was taken', () => {
    expect(exportFilename(input('demo'), 'svg')).toBe('demo-20260801-1230.svg')
  })

  it('strips anything that would be awkward in a filename', () => {
    expect(exportFilename(input('my repo/v2'), 'png')).toBe('my-repo-v2-20260801-1230.png')
  })

  it('distinguishes a scoped file from the full one it sits beside', () => {
    expect(exportFilename(input('demo'), 'svg', 'Understand background changes')).toBe(
      'demo-Understand-background-changes-20260801-1230.svg',
    )
  })

  it('bounds a scope that is really a sentence', () => {
    const long = 'A session title that simply refuses to stop going on and on and on'
    const name = exportFilename(input('demo'), 'svg', long)
    expect(name.length).toBeLessThan(70)
    expect(name.endsWith('-20260801-1230.svg')).toBe(true)
    expect(name).not.toContain('--')
  })
})
