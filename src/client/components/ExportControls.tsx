import { useState } from 'react'
import type { GraphPayload } from '../../api.js'
import { downloadPng, downloadSvg } from '../export/download.js'
import type { DisplayRow } from './layout.js'

interface ExportControlsProps {
  graph: GraphPayload
  rows: DisplayRow[]
  now: number
}

/**
 * Save the current graph as a file.
 *
 * The work happens entirely in the browser — there is no export endpoint, and the daemon
 * still writes nothing anywhere. See docs/design/export.md.
 */
export function ExportControls({ graph, rows, now }: ExportControlsProps) {
  const [busy, setBusy] = useState<'svg' | 'png' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'svg' | 'png') => {
    setBusy(kind)
    setError(null)
    try {
      const input = { graph, rows, now }
      // Yield first: rasterising a tall graph blocks long enough to swallow the click
      // feedback otherwise.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (kind === 'svg') downloadSvg(input)
      else await downloadPng(input)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed.')
    } finally {
      setBusy(null)
    }
  }

  const disabled = busy !== null || rows.length === 0

  return (
    <span className="export">
      <button
        className="export__btn"
        type="button"
        onClick={() => void run('svg')}
        disabled={disabled}
        title="Save the graph as a standalone SVG"
      >
        {busy === 'svg' ? 'saving…' : 'SVG'}
      </button>
      <button
        className="export__btn"
        type="button"
        onClick={() => void run('png')}
        disabled={disabled}
        title="Save the graph as a 2× PNG"
      >
        {busy === 'png' ? 'rendering…' : 'PNG'}
      </button>
      {error && (
        <span className="export__error" role="status">
          {error}
        </span>
      )}
    </span>
  )
}
