import { afterAll, describe, expect, it } from 'vitest'
import { readLog } from '../src/git/log.js'
import { openRepo } from '../src/git/repo.js'
import { asciiGraph, asciiText, asciiWidth } from '../src/graph/ascii.js'
import { assignLanes } from '../src/graph/lanes.js'
import { builders, cleanupAll } from './fixtures/make.js'

/**
 * The banner's renderer, checked against the same fixtures the SVG one is.
 *
 * Both draw from `assignLanes`, so these assert the glyphs rather than the lanes — lane
 * correctness is `lanes.test.ts` and `oracle.test.ts`'s job, and duplicating it here would
 * just mean two places to update when a fixture changes.
 */
async function render(name: keyof typeof builders, maxLines = 20): Promise<string[]> {
  const dir = builders[name]!()
  const repo = await openRepo(dir)
  const commits = await readLog(repo.root, { maxCount: 50 })
  return asciiText(asciiGraph(assignLanes(commits), { maxLines }))
}

describe('asciiGraph', () => {
  afterAll(cleanupAll)

  it('draws linear history as a bare column, with no connectors', async () => {
    expect(await render('linear')).toEqual(['●', '●', '●'])
  })

  it('opens a lane at a merge and closes it where the branches rejoin', async () => {
    expect(await render('branchMerge')).toEqual([
      '●', // merge feature
      '├─╮',
      '│ ●', // feature work
      '● │', // main work
      '├─╯',
      '●', // base
    ])
  })

  it('fans an octopus out and back without losing a middle branch', async () => {
    // The case that breaks corner-placement written as case analysis: the middle branches
    // are both an endpoint and a column a longer run crosses.
    expect(await render('octopus')).toEqual([
      '●', // octopus merge
      '├─┬─┬─╮',
      '│ │ │ ●',
      '│ │ ● │',
      '│ ● │ │',
      '├─┴─┴─╯',
      '●', // base
    ])
  })

  it('ends a lane that has no parent rather than drawing it into the next commit', async () => {
    // Two roots: the second lane simply stops. A connector here would claim a relationship
    // between two histories that have none.
    expect(await render('twoRoots')).toEqual(['●', '├─╮', '│ ●', '●'])
  })

  it('draws independent tips as parallel lanes with no split above them', async () => {
    expect(await render('worktreesDiverged')).toEqual(['●', '│ ●', '├─╯', '●'])
  })

  it('renders every fixture without throwing', async () => {
    for (const name of Object.keys(builders)) {
      await expect(render(name)).resolves.toBeInstanceOf(Array)
    }
  })

  it('emits nothing for a repository with no commits', async () => {
    expect(await render('empty')).toEqual([])
  })

  it('honours maxLines, counting connectors against it', async () => {
    for (const maxLines of [1, 2, 3, 5]) {
      expect((await render('octopus', maxLines)).length).toBeLessThanOrEqual(maxLines)
    }
  })

  it('never ends a line in whitespace', async () => {
    for (const line of await render('octopus')) expect(line).toBe(line.trimEnd())
  })

  it('reports a width that covers every line it drew', async () => {
    const dir = builders.octopus!()
    const repo = await openRepo(dir)
    const lines = asciiGraph(assignLanes(await readLog(repo.root, { maxCount: 50 })), {
      maxLines: 20,
    })
    for (const line of lines) expect(line.cells.length).toBeLessThanOrEqual(asciiWidth(lines))
    expect(asciiWidth(lines)).toBe(7) // four lanes, two columns apart
  })

  it('attaches a commit to node lines and nothing to connectors', async () => {
    const dir = builders.branchMerge!()
    const repo = await openRepo(dir)
    const lines = asciiGraph(assignLanes(await readLog(repo.root, { maxCount: 50 })), {
      maxLines: 20,
    })
    expect(lines.filter((l) => l.commit).length).toBe(4)
    for (const line of lines) {
      if (line.commit === null) expect(line.cells.some((c) => c.glyph === '●')).toBe(false)
    }
  })

  it('colours every glyph it draws with a real lane', async () => {
    // A cell with a glyph but lane -1 would render uncoloured against its neighbours.
    const dir = builders.octopus!()
    const repo = await openRepo(dir)
    const lines = asciiGraph(assignLanes(await readLog(repo.root, { maxCount: 50 })), {
      maxLines: 20,
    })
    for (const line of lines) {
      for (const cell of line.cells) {
        if (cell.glyph !== ' ') expect(cell.lane).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
