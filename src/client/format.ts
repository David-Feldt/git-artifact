/**
 * Display formatting shared by the live components and the SVG exporter.
 *
 * These were private to the components that first needed them. The exporter renders the
 * same strings into a file, and two implementations of "how long ago was this" would drift
 * — so they live here, free of JSX, and are imported by both.
 */

/**
 * Compact relative time.
 *
 * Deliberately terse — this is meant to be read at a glance from across a desk, where
 * "2h" lands and "2 hours ago" is a sentence. Future timestamps are possible after a
 * rebase or with clock skew and are clamped rather than rendered as negative.
 */
export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.round(months / 12)}y`
}

/**
 * Token counts run to tens of millions once cache reads are included, so raw digits are
 * unreadable at a glance and the exact figure is never the point.
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k tok`
  return `${count} tok`
}

/**
 * Map heat onto one of the five ramp steps.
 *
 * Stepped rather than interpolated: five discrete buckets read as distinct at a glance,
 * where a continuous gradient turns into mush at chip size. Thresholds are spaced by the
 * decay curve, so the top bucket means "within the last few minutes".
 *
 * Returns the bucket index rather than a colour, because the live view wants
 * `var(--heat-n)` and the exporter wants literal hex, and the thresholds must not be
 * written down twice.
 */
export function heatBucket(heat: number): 0 | 1 | 2 | 3 | 4 {
  if (heat >= 0.75) return 4
  if (heat >= 0.45) return 3
  if (heat >= 0.2) return 2
  if (heat >= 0.05) return 1
  return 0
}

export function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}
