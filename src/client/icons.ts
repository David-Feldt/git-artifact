/**
 * Icon geometry shared by the DOM and the SVG export.
 *
 * Those two renderers are otherwise independent — `export/svg.ts` re-draws every row by
 * hand — which is fine for text and chips, where a drift is visible the moment you look
 * at either one. Path data is different: a `d` string that drifts stays invisible until
 * somebody exports. So it is written once, here.
 *
 * Paths are Lucide's (ISC licence), drawn on a 24×24 box with a 2-unit stroke and round
 * caps and joins. Inlined rather than taking a dependency on `lucide-react`: one icon
 * does not pay for a package, the export needs the raw geometry rather than a React
 * component anyway, and the client bundle is something users download.
 */

/** The box every path below is drawn on. Both renderers scale from this. */
export const ICON_VIEWBOX = 24

/** Stroke width in viewbox units, scaled with the icon. Lucide's default. */
export const ICON_STROKE = 2

/**
 * Lucide `monitor`.
 *
 * Its screen is a `<rect rx="2">` upstream, rewritten here as an equivalent path so both
 * renderers can map a single flat list instead of switching on element type.
 */
export const MONITOR_PATHS: readonly string[] = [
  'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  'M8 21h8',
  'M12 17v4',
]

/**
 * Lucide `x`. Marks a session with no recent transcript activity.
 *
 * Two strokes and nothing else, which is what makes it legible beside the monitor at 14px
 * where a glyph with interior detail — a circled cross, a power symbol — turns to mush. It
 * reads as a state on the icon it follows rather than as a second subject.
 */
export const X_PATHS: readonly string[] = ['M18 6 6 18', 'm6 6 12 12']

/**
 * Lucide `chart-network`. Marks generating an artifact.
 *
 * Three nodes joined by edges over an axis — the same thing the graph beside it draws, and
 * the same thing a generated page explains, which is why this one rather than a document or
 * a sparkle.
 *
 * Its three `<circle>` elements are rewritten as two-arc subpaths, for the reason above.
 * Verified rather than assumed: rasterised against the upstream file at 16×, the converted
 * form is pixel-identical — zero differing pixels of 147,456, maximum channel delta 0.
 */
export const CHART_NETWORK_PATHS: readonly string[] = [
  'm13.11 7.664 1.78 2.672',
  'm14.162 12.788-3.324 1.424',
  'm20 4-6.06 1.515',
  'M3 3v16a2 2 0 0 0 2 2h16',
  'M10 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0z',
  'M14 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0z',
  'M7 15a2 2 0 1 0 4 0a2 2 0 1 0-4 0z',
]
