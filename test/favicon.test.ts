import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHART_NETWORK_PATHS } from '../src/client/icons.js'

/**
 * The tab icon, and the one thing that stops it drifting.
 *
 * It is the same glyph as the artifact control on every commit row, but it cannot import
 * `icons.ts` — a favicon is a static file a browser fetches before any of our code runs. So
 * the geometry is copied, and a copy with nothing watching it is a copy that goes stale the
 * first time somebody edits the icon. That is the entire reason this file exists; it is the
 * favicon's half of the parity `icons.ts` describes.
 */

const favicon = readFileSync(
  fileURLToPath(new URL('../src/client/public/favicon.svg', import.meta.url)),
  'utf8',
)
const indexHtml = readFileSync(
  fileURLToPath(new URL('../src/client/index.html', import.meta.url)),
  'utf8',
)

describe('favicon', () => {
  it('draws the same glyph as the artifact control', () => {
    // Asserting the path data rather than "an icon is present" is the whole point — a `d`
    // string that drifts stays invisible until somebody looks at a browser tab.
    for (const d of CHART_NETWORK_PATHS) {
      expect(favicon).toContain(`<path d="${d}"/>`)
    }
  })

  it('carries no path the glyph does not have', () => {
    // The reverse direction: a path left behind after `icons.ts` drops one would otherwise
    // survive here forever, drawing something the app no longer draws.
    const drawn = [...favicon.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!)
    expect(drawn.sort()).toEqual([...CHART_NETWORK_PATHS].sort())
  })

  it('is a self-contained document that fetches nothing', () => {
    // It is served by our own daemon and the project makes no outbound requests. An icon
    // referencing a font or a remote image would be the one thing on the page that did.
    expect(favicon).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
    expect(favicon).not.toContain('<image')
    expect(favicon).not.toContain('@import')
    expect(favicon).not.toContain('<script')
  })

  it('resolves its colours to literal hex', () => {
    // No stylesheet reaches a favicon, so a `var()` here renders as nothing at all.
    expect(favicon).not.toContain('var(')
    expect(favicon).toContain('#c9761a') // --artifact-ready, the disc
    expect(favicon).toContain('#fdfbf7') // --card, the glyph
  })

  it('is linked from the page that needs it', () => {
    // The file existing is not the feature; being referenced is. Vite copies `public/` to
    // the bundle root, which is what makes this absolute path resolve in dev and packaged.
    expect(indexHtml).toContain('rel="icon"')
    expect(indexHtml).toContain('href="/favicon.svg"')
  })
})
