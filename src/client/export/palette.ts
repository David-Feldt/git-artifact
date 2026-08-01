/**
 * The theme as literal hex, for export.
 *
 * The live view uses CSS custom properties, which is right for a page and wrong for a
 * standalone file: support for `var()` in SVG rasterisers ranges from partial to absent,
 * so an exported graph that referenced them would render correctly in a browser and lose
 * every colour on the way to PNG.
 *
 * These values are duplicated from `theme.css`, which is a drift risk — so `export.test.ts`
 * parses that file and asserts the two agree. Change a hue there and the test says so here.
 */

/** `--lane-1` … `--lane-8`, in validated order. */
export const LANE_HEX = [
  '#2a78d6',
  '#c9501f',
  '#0e8a5f',
  '#4a3aa7',
  '#a87400',
  '#c94f7c',
  '#008300',
  '#d63a39',
] as const

/** `--heat-0` … `--heat-4`, the sequential amber ramp. */
export const HEAT_HEX = ['#ece3d4', '#f0d9a8', '#edbc6a', '#e09a34', '#c9761a'] as const

export const PAPER = '#f5efe6'
export const CARD = '#fdfbf7'
export const RULE = '#e3d9c9'
export const RULE_STRONG = '#d3c5ae'
export const INK = '#2a2622'
export const INK_SECONDARY = '#6b6259'
export const INK_MUTED = '#9a8f83'

/** Hues cycle past eight, exactly as `laneColor` does. */
export function laneHex(lane: number): string {
  return LANE_HEX[((lane % LANE_HEX.length) + LANE_HEX.length) % LANE_HEX.length]!
}

export function heatHex(bucket: number): string {
  return HEAT_HEX[Math.min(Math.max(bucket, 0), HEAT_HEX.length - 1)]!
}

/**
 * Blend two hex colours, standing in for the `color-mix()` the stylesheet uses for chip
 * fills. `color-mix` works in sRGB there and is resolved at export time here, so the
 * arithmetic matches rather than approximates.
 */
export function mix(a: string, b: string, weightA: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const channel = (i: number) => Math.round(pa[i]! * weightA + pb[i]! * (1 - weightA))
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): number[] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16))
}
