import type { CommitDetail } from '../api.js'

/**
 * The page around the model's writing.
 *
 * Originally the harness was asked for a whole HTML document. Measured on the first real
 * generation, that put 8.2 KB of stylesheet and a full re-typed patch into the output — 25.6
 * KB in all, and 3m46s for a one-file commit. Both are things this project already has: the
 * palette is in `theme.css` and the diff came out of `readCommitDetail` byte-exact.
 *
 * So the split is: the model writes the analysis, and this writes everything the analysis
 * sits in. Three things follow from that beyond the speed.
 *
 * - Pages cannot drift apart visually, because none of them carries its own styling.
 * - "Self-contained" stops being an instruction the model might not follow and becomes a
 *   property of the file: there is nowhere for a CDN link to enter.
 * - A quoted diff line is quoted from the real patch rather than retyped from it.
 */

export interface ChassisInput {
  repoName: string
  detail: CommitDetail
  /** The model's analysis, as an HTML fragment. */
  analysis: string
  generatedAt: number
}

export function renderArtifactPage(input: ChassisInput): string {
  const { detail, repoName } = input
  const short = detail.sha.slice(0, 7)
  const authored = new Date(detail.authorDate * 1000)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(short)} — ${esc(detail.subject || '(no message)')}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="page">
  <header class="head">
    <div class="eyebrow">${esc(repoName)} · commit</div>
    <h1><span class="sha">${esc(short)}</span> ${esc(detail.subject || '(no message)')}</h1>
    <dl class="meta">
      <dt>sha</dt><dd class="mono">${esc(detail.sha)}</dd>
      <dt>author</dt><dd>${esc(detail.authorName)}</dd>
      <dt>authored</dt><dd class="mono">${esc(authored.toISOString())}</dd>
      <dt>${detail.parents.length === 1 ? 'parent' : 'parents'}</dt>
      <dd class="mono">${detail.parents.length === 0 ? 'none — root commit' : esc(detail.parents.map((p) => p.slice(0, 7)).join(', '))}</dd>
    </dl>
    <div class="stat">
      <span>${detail.files.length} file${detail.files.length === 1 ? '' : 's'}</span>
      <span class="add">+${detail.additions}</span>
      <span class="del">−${detail.deletions}</span>
      ${detail.mergeFirstParent ? '<span class="warn">diff against first parent</span>' : ''}
      ${detail.clipped ? '<span class="warn">patch truncated by the reader</span>' : ''}
    </div>
  </header>

  <article class="analysis">
${input.analysis}
  </article>

  <section class="files">
    <h2>Every file this commit touched</h2>
    <table>
      <thead><tr><th>File</th><th>Status</th><th class="n">+</th><th class="n">−</th></tr></thead>
      <tbody>
${detail.files.map(fileRow).join('\n')}
      </tbody>
    </table>
  </section>

  <footer class="foot">
    <span>git-artifact</span>
    <span>written by a model from this commit's diff — not verified against it</span>
    <span class="mono">${esc(new Date(input.generatedAt).toISOString())}</span>
  </footer>
</main>
</body>
</html>`
}

/**
 * The complete file list, rendered here rather than asked for.
 *
 * The brief's invariant is that the file list is never truncated even when diff bodies are,
 * so the one part of the page that must be exhaustive is the one part not left to a model
 * working from a possibly-budgeted brief.
 */
function fileRow(f: CommitDetail['files'][number]): string {
  const counts = f.binary
    ? '<td class="n">—</td><td class="n">—</td>'
    : `<td class="n add">+${f.additions ?? 0}</td><td class="n del">−${f.deletions ?? 0}</td>`
  const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
  const flags = [f.binary ? 'binary' : '', f.clipped ? 'not in brief' : '']
    .filter(Boolean)
    .join(', ')
  return `        <tr><td class="mono">${esc(name)}</td><td>${esc(f.status)}${flags ? ` <span class="flag">${esc(flags)}</span>` : ''}</td>${counts}</tr>`
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** git-artifact's palette, from theme.css. Dark hues lightened for a dark ground. */
const STYLES = `
:root{color-scheme:light dark;
--paper:#f5efe6;--card:#fdfbf7;--sunk:#efe7da;--rule:#e3d9c9;--rule-strong:#d3c5ae;
--ink:#2a2622;--ink-2:#6b6259;--ink-3:#9a8f83;
--a1:#2a78d6;--a2:#c9501f;--a3:#0e8a5f;--a4:#4a3aa7;
--add-bg:#dfeddc;--add-ink:#1d6b2a;--del-bg:#f6dedc;--del-ink:#a3261e;
--ui:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{
--paper:#1b1917;--card:#23201d;--sunk:#2a2622;--rule:#363029;--rule-strong:#4a4239;
--ink:#ece5da;--ink-2:#b3a99c;--ink-3:#8a8075;
--a1:#6ba6ea;--a2:#e8834f;--a3:#3fb98c;--a4:#9184e0;
--add-bg:#1e3320;--add-ink:#7fcf8b;--del-bg:#3a1f1e;--del-ink:#e8918a}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--ui);
font-size:15px;line-height:1.62;-webkit-font-smoothing:antialiased}
.page{max-width:78ch;margin:0 auto;padding:48px 24px 80px}
.mono{font-family:var(--mono)}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
h1{margin:8px 0 20px;font-size:clamp(24px,4.4vw,33px);font-weight:620;letter-spacing:-.02em;line-height:1.2;text-wrap:balance}
h1 .sha{font-family:var(--mono);font-size:.72em;color:var(--a1);font-weight:400}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0 0 16px;font-size:13px}
.meta dt{font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
.meta dd{margin:0;color:var(--ink-2);word-break:break-all}
.stat{display:flex;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:12.5px;
color:var(--ink-3);padding-bottom:22px;border-bottom:1px solid var(--rule)}
.stat .add{color:var(--add-ink)}.stat .del{color:var(--del-ink)}
.stat .warn{color:var(--a2)}
.analysis{margin-top:34px}
.analysis h2{margin:38px 0 10px;font-size:20px;font-weight:620;letter-spacing:-.012em;line-height:1.28;text-wrap:balance}
.analysis h3{margin:26px 0 6px;font-size:15px;font-weight:620}
.analysis p{margin:0 0 14px;max-width:68ch;text-wrap:pretty}
.analysis ul,.analysis ol{margin:0 0 14px;padding-left:20px;max-width:68ch}
.analysis li{margin-bottom:6px}
.analysis>*:first-child{margin-top:0}
.lede{font-size:17px;line-height:1.55;color:var(--ink)}
code{font-family:var(--mono);font-size:.885em;background:var(--sunk);padding:1px 5px;border-radius:3px}
strong{font-weight:620}
.callout{background:var(--card);border:1px solid var(--rule);border-left:2px solid var(--a1);
border-radius:0 6px 6px 0;padding:13px 16px;margin:18px 0}
.callout--risk{border-left-color:var(--a2)}
.callout p:last-child{margin-bottom:0}
.callout .k{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;
text-transform:uppercase;color:var(--ink-3);margin-bottom:5px}
.diff{background:var(--card);border:1px solid var(--rule);border-radius:6px;
overflow-x:auto;margin:16px 0;font-family:var(--mono);font-size:12.5px;line-height:1.55}
.diff .path{padding:7px 12px;border-bottom:1px solid var(--rule);color:var(--ink-2);background:var(--sunk)}
.diff pre{margin:0;padding:10px 0}
.diff .l{display:block;padding:0 12px;white-space:pre}
.diff .add{background:var(--add-bg);color:var(--add-ink)}
.diff .del{background:var(--del-bg);color:var(--del-ink)}
figure{margin:20px 0}
figure svg{max-width:100%;height:auto;display:block}
figcaption{font-size:12.5px;color:var(--ink-3);margin-top:7px}
.files{margin-top:46px;padding-top:8px;border-top:1px solid var(--rule)}
.files h2{font-size:15px;font-weight:620;margin:18px 0 12px}
.files table{border-collapse:collapse;width:100%;font-size:13px}
.files th,.files td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--rule)}
.files th{font-family:var(--mono);font-size:10.5px;font-weight:400;letter-spacing:.07em;
text-transform:uppercase;color:var(--ink-3)}
.files td.n,.files th.n{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.files .add{color:var(--add-ink)}.files .del{color:var(--del-ink)}
.files .flag{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.foot{margin-top:40px;padding-top:14px;border-top:1px solid var(--rule);
display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11.5px;color:var(--ink-3)}
@media(max-width:560px){.page{padding:32px 16px 56px}.meta{grid-template-columns:1fr}}
`
