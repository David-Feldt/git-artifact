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
