import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  faviconDataUrl,
  faviconState,
  faviconSvg,
  type FaviconState,
} from '../src/client/favicon.js'
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

const STATES: FaviconState[] = ['offline', 'session', 'dirty', 'clean']

/**
 * The state-carrying icon that replaces the static one once the page boots.
 *
 * It builds from `icons.ts` directly, so it cannot drift the way the static file can. What
 * these guard instead is that it stays *the same picture* — a second icon that slowly
 * became a different glyph would be worse than no second icon.
 */
describe('dynamic favicon', () => {
  it('draws the same glyph as the static file, in every state', () => {
    for (const state of STATES) {
      for (const d of CHART_NETWORK_PATHS) expect(faviconSvg(state)).toContain(`<path d="${d}"/>`)
    }
  })

  it('carries no path the glyph does not have', () => {
    const drawn = [...faviconSvg('clean').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!)
    expect(drawn.sort()).toEqual([...CHART_NETWORK_PATHS].sort())
  })

  it('places the glyph exactly where the static file does', () => {
    // Same viewBox, inset and scale, or the icon visibly jumps the moment the page boots.
    expect(faviconSvg('clean')).toContain('viewBox="0 0 32 32"')
    expect(faviconSvg('clean')).toContain('translate(6 6)')
    expect(favicon).toContain('translate(6 6)')
    expect(faviconSvg('clean')).toContain('scale(0.8333)')
    expect(favicon).toContain('scale(0.8333)')
  })

  it('gives every state its own hue', () => {
    const discs = STATES.map((s) => /<circle[^>]*fill="([^"]+)"/.exec(faviconSvg(s))![1])
    expect(new Set(discs).size).toBe(STATES.length)
  })

  it('reuses the static file’s amber for the state it boots into most often', () => {
    // The browser shows `public/favicon.svg` before any of this runs. Matching it on the
    // common state means the icon usually needs no correcting at all.
    expect(faviconSvg('dirty')).toContain('#c9761a')
  })

  it('is self-contained and fetches nothing, like the file it replaces', () => {
    for (const state of STATES) {
      const svg = faviconSvg(state)
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
      expect(svg).not.toContain('<image')
      expect(svg).not.toContain('<script')
      expect(svg).not.toContain('var(')
    }
  })

  it('round-trips through its data URL', () => {
    const url = faviconDataUrl('session')
    expect(url.startsWith('data:image/svg+xml,')).toBe(true)
    expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(faviconSvg('session'))
    // `#` unescaped would truncate the document at the first colour.
    expect(url).not.toContain('#')
  })
})

describe('faviconState', () => {
  const base = { connected: true, loaded: true, liveSession: false, dirtyFiles: 0 }

  it('says nothing until the first payload lands', () => {
    expect(faviconState({ ...base, loaded: false })).toBeNull()
  })

  it('reports a dead connection over anything it used to know', () => {
    // Every other state is stale once the stream is down; a confident icon would be lying.
    expect(faviconState({ ...base, connected: false, loaded: false })).toBe('offline')
    expect(faviconState({ ...base, connected: false, liveSession: true, dirtyFiles: 9 })).toBe(
      'offline',
    )
  })

  it('ranks a live session above uncommitted work', () => {
    expect(faviconState({ ...base, liveSession: true, dirtyFiles: 4 })).toBe('session')
  })

  it('distinguishes uncommitted work from a clean tree', () => {
    expect(faviconState({ ...base, dirtyFiles: 1 })).toBe('dirty')
    expect(faviconState({ ...base, dirtyFiles: 0 })).toBe('clean')
  })
})
