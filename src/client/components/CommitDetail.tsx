import type { CommitDetail, DiffFile, DiffHunk } from '../../api.js'
import { laneColor } from './layout.js'

/**
 * Ceiling on how many lines of one file's patch reach the DOM.
 *
 * The daemon's byte budget already bounds the payload, but a single generated file can
 * spend that entire budget on one diff, and thousands of absolutely-positioned rows inside
 * a scroller is where the frame budget goes. The cap is announced in place rather than
 * applied quietly — a diff that simply stops reads as a bug in the tool.
 */
const MAX_LINES_PER_FILE = 600

interface CommitDetailPanelProps {
  detail: CommitDetail | null
  loading: boolean
  error: string | null
  /** Lane of the commit this panel belongs to, so the panel carries its rail's colour. */
  lane: number
  onClose: () => void
}

export function CommitDetailPanel({
  detail,
  loading,
  error,
  lane,
  onClose,
}: CommitDetailPanelProps) {
  return (
    <div className="detail" style={{ ['--detail-accent' as string]: laneColor(lane) }}>
      <button className="detail__close" onClick={onClose} title="Close (Esc)" type="button">
        ✕
      </button>

      {error !== null ? (
        <div className="detail__notice detail__notice--error">{error}</div>
      ) : loading || detail === null ? (
        <div className="detail__notice">Reading the commit…</div>
      ) : (
        <Loaded detail={detail} />
      )}
    </div>
  )
}

function Loaded({ detail }: { detail: CommitDetail }) {
  const authored = new Date(detail.authorDate * 1000)
  // Committer and author differ after a rebase, a cherry-pick, or a patch applied on
  // someone's behalf — exactly the cases where knowing both is the point.
  const rewritten =
    detail.committerEmail !== detail.authorEmail || detail.commitDate !== detail.authorDate

  return (
    <>
      <div className="detail__head">
        <span className="detail__sha" title={detail.sha}>
          {detail.sha.slice(0, 12)}
        </span>
        <span className="detail__author">
          {detail.authorName} <span className="detail__email">{detail.authorEmail}</span>
        </span>
        <span className="detail__date" title={authored.toISOString()}>
          {authored.toLocaleString()}
        </span>
        <span className="detail__spacer" />
        <DiffStat detail={detail} />
      </div>

      <div className="detail__submeta">
        {detail.parents.length > 0 && (
          <span>
            {detail.parents.length === 1 ? 'parent' : 'parents'}{' '}
            {detail.parents.map((parent) => (
              <code key={parent} title={parent}>
                {parent.slice(0, 7)}
              </code>
            ))}
          </span>
        )}
        {detail.parents.length === 0 && <span>root commit</span>}
        {rewritten && (
          <span title={new Date(detail.commitDate * 1000).toISOString()}>
            committed by {detail.committerName}
          </span>
        )}
        {detail.mergeFirstParent && <span>diff shown against the first parent</span>}
      </div>

      <div className="detail__scroll">
        <div className="detail__subject">{detail.subject || <em>(no message)</em>}</div>
        {detail.body !== '' && <pre className="detail__body">{detail.body}</pre>}

        {detail.files.length === 0 ? (
          <div className="detail__notice">This commit changes no files.</div>
        ) : (
          detail.files.map((file) => <FileDiff key={`${file.oldPath ?? ''}>${file.path}`} file={file} />)
        )}
      </div>
    </>
  )
}

function DiffStat({ detail }: { detail: CommitDetail }) {
  return (
    <span className="detail__stat">
      <span className="detail__files">
        {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
      </span>
      <span className="detail__add">+{detail.additions}</span>
      <span className="detail__del">−{detail.deletions}</span>
    </span>
  )
}

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  typechanged: 'type changed',
  unknown: 'changed',
}

function FileDiff({ file }: { file: DiffFile }) {
  const rendered = clipHunks(file.hunks, MAX_LINES_PER_FILE)

  return (
    <section className="file">
      <header className="file__head">
        <span className={`file__status file__status--${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="file__path" title={file.path}>
          {file.oldPath !== null && <span className="file__old">{file.oldPath} → </span>}
          <PathLabel path={file.path} />
        </span>
        {!file.binary && (
          <span className="file__counts">
            <span className="detail__add">+{file.additions ?? 0}</span>
            <span className="detail__del">−{file.deletions ?? 0}</span>
          </span>
        )}
      </header>

      {file.binary ? (
        <div className="file__note">Binary file — no line diff.</div>
      ) : file.clipped ? (
        <div className="file__note">
          Patch not shown: this commit&rsquo;s diff ran past the size budget.
        </div>
      ) : rendered.hunks.length === 0 ? (
        <div className="file__note">No textual changes.</div>
      ) : (
        <>
          {rendered.hunks.map((hunk, index) => (
            <Hunk key={index} hunk={hunk} />
          ))}
          {rendered.omitted > 0 && (
            <div className="file__note">
              {rendered.omitted} more line{rendered.omitted === 1 ? '' : 's'} not shown.
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * A path that gives up its directories before its filename when space runs short.
 *
 * The obvious trick for this is `direction: rtl`, which moves the ellipsis to the front —
 * but it also reorders the neutral characters bidi leaves unanchored, so a path holding a
 * quote, a dollar sign or a bracket renders subtly wrong. Splitting the string and letting
 * only the directory half shrink gets the same result with no bidi involved at all.
 */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/')
  if (cut === -1) return <span className="file__base">{path}</span>

  return (
    <>
      <span className="file__dir">{path.slice(0, cut + 1)}</span>
      <span className="file__base">{path.slice(cut + 1)}</span>
    </>
  )
}

/** Take hunks up to a line budget, reporting how many lines were left behind. */
function clipHunks(hunks: DiffHunk[], budget: number): { hunks: DiffHunk[]; omitted: number } {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  if (total <= budget) return { hunks, omitted: 0 }

  const kept: DiffHunk[] = []
  let spent = 0
  for (const hunk of hunks) {
    if (spent >= budget) break
    const room = budget - spent
    kept.push(room >= hunk.lines.length ? hunk : { ...hunk, lines: hunk.lines.slice(0, room) })
    spent += Math.min(room, hunk.lines.length)
  }

  return { hunks: kept, omitted: total - spent }
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="hunk">
      <div className="hunk__header">{hunk.header}</div>
      {hunk.lines.map((line, index) => (
        <div className={`dline dline--${line.kind}`} key={index}>
          <span className="dline__no">{line.oldLine ?? ''}</span>
          <span className="dline__no">{line.newLine ?? ''}</span>
          {/* The marker is a real character rather than a ::before, so a copied selection
              carries it and the add/delete distinction never rests on colour alone. */}
          <span className="dline__mark">
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'meta' ? '\\' : ' '}
          </span>
          <span className="dline__text">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
