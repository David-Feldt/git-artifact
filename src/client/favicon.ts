/**
 * The tab icon, redrawn from repository state.
 *
 * The pitch for this tool is a second monitor, which means the tab is often the only part
 * of it you can see. A static icon spends that space on nothing. This one answers the two
 * questions worth answering from across a desk — is anything uncommitted, and is a session
 * running — in the one channel a favicon has room for, which is hue.
 *
 * It is drawn from `CHART_NETWORK_PATHS` rather than copied, so unlike `public/favicon.svg`
 * it cannot drift from the glyph the app uses; `test/favicon.test.ts` is what guards the
 * static file, which exists because a browser fetches an icon before any of this runs.
 *
 * Tier B, and deliberately so: an icon that fails to update is unremarkable, so every path
 * here degrades to leaving the static icon in place.
 */
import { useEffect } from 'react'
import { CHART_NETWORK_PATHS, ICON_VIEWBOX } from './icons.js'

export type FaviconState = 'offline' | 'session' | 'dirty' | 'clean'

/**
 * Four hues far enough apart to tell apart at 16 px, all lifted from `theme.css`.
 *
 * `dirty` is the amber `public/favicon.svg` already uses, which is the app's own colour for
 * uncommitted work — so the icon a browser shows before the page boots is the one state
 * that needs no correcting most of the time you open this.
 */
const DISC: Record<FaviconState, string> = {
  offline: '#9a8f83', // --ink-muted
  session: '#008300', // --live
  dirty: '#c9761a', // --heat-4 / --artifact-ready
  clean: '#2a78d6', // --lane-1
}

/** --card, the glyph colour. Legible on all four discs. */
const GLYPH = '#fdfbf7'

/** Matches `public/favicon.svg`: the 24-unit glyph centred on a 32-unit disc. */
const CANVAS = 32
const INSET = 6
const SCALE = (CANVAS - INSET * 2) / ICON_VIEWBOX

export function faviconSvg(state: FaviconState): string {
  const paths = CHART_NETWORK_PATHS.map((d) => `<path d="${d}"/>`).join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"`,
    ` role="img" aria-label="git-artifact — ${state}">`,
    `<circle cx="${CANVAS / 2}" cy="${CANVAS / 2}" r="${CANVAS / 2}" fill="${DISC[state]}"/>`,
    `<g transform="translate(${INSET} ${INSET}) scale(${SCALE.toFixed(4)})"`,
    ` fill="none" stroke="${GLYPH}" stroke-width="2.6"`,
    ' stroke-linecap="round" stroke-linejoin="round">',
    paths,
    '</g></svg>',
  ].join('')
}

/**
 * Percent-encoded rather than base64: the payload is ASCII either way, and this one stays
 * readable in devtools, which matters the first time it renders as a blank square.
 */
export function faviconDataUrl(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`
}

/**
 * What the icon should say, given everything the client knows.
 *
 * Ordered by what would make you look: a dead connection first, because every other state
 * it could show is then stale and a confident icon would be lying. `null` means "say
 * nothing yet" and leaves the static icon alone, which is the honest answer before the
 * first payload arrives.
 */
export function faviconState(input: {
  connected: boolean
  loaded: boolean
  liveSession: boolean
  dirtyFiles: number
}): FaviconState | null {
  if (!input.connected) return 'offline'
  if (!input.loaded) return null
  if (input.liveSession) return 'session'
  return input.dirtyFiles > 0 ? 'dirty' : 'clean'
}

export function useFavicon(state: FaviconState | null): void {
  useEffect(() => {
    if (state === null) return
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    // No link element means the page was served without one; adding it is not this hook's
    // job, and an icon is not worth mutating <head> shape over.
    if (link) link.href = faviconDataUrl(state)
  }, [state])
}
