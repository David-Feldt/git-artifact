# Export

Design for phase 5: turning the live view into a file you can keep, paste into a pull
request, or hand to someone who does not have the daemon running.

Everything about repository sizes here is measured against the 39 repositories on the
development machine. The font and layout numbers come from `theme.css` and `layout.ts` as
they stand.

---

## An export is a different document from the dashboard

The dashboard is tuned for glancing at a second monitor while you work: it updates, it has
hover targets, it expands rows, and it assumes you know what you were just doing. An
exported artifact is read later, by someone who was not there, with no daemon and no
context.

Those are different documents, and the temptation to make export mean "screenshot of the
dashboard" is the main thing to design away from. A faithful clone would have to reproduce
hover titles, focus rings, buttons and `aria-expanded` state — none of which mean anything
in a static file — while inheriting the one property the dashboard has that an artifact
should not: it is sized for a screen you are sitting in front of.

So the export **shares geometry and palette with the dashboard, and shares no components
with it.** That is what makes it a small feature rather than a second UI.

---

## Format

| Option | Self-contained | Embeds in a PR | Rasterises | Reuses the UI | Verdict |
|---|---|---|---|---|---|
| A · standalone SVG | yes | yes | yes | no — needs its own text path | **Chosen** |
| B · self-contained HTML | yes | no | no | yes, entirely | Later; it is a saved dashboard, not an artifact |
| C · PNG | yes | yes | n/a | no | **Chosen as a derivative of A** |
| D · SVG with `<foreignObject>` | yes | yes | **no** | yes | Rejected |

Option D deserves the explicit rejection because it looks like it solves everything: wrap
the existing HTML cards in a `<foreignObject>` and the text layer comes for free, laid out
by the browser. It renders correctly in browsers and is silently ignored by every
standalone rasteriser — resvg, librsvg, most converters — which produces an SVG that looks
perfect until someone converts it to PNG and gets rails with no text. A format that fails
that way is worse than one that never had the text.

PNG falls out of SVG almost for free once the SVG exists (draw the blob into a canvas,
`toBlob`), and it is what you actually want for Slack or an issue comment. It is listed
separately only because it is a second button, not a second renderer.

### The cost: SVG needs its own text path

The live view is deliberately two layers — "SVG for the graph, HTML for the text", because
text in SVG loses selection, wrapping and subpixel hinting. That decision is correct for
the dashboard and it is exactly what makes export non-trivial: the half of the view
carrying all the meaning is HTML, and a standalone SVG cannot include it.

So the exporter re-renders the text as `<text>` elements. Not the components — the
content: sha, refs, subject, author, relative time, push markers, session header fields,
WIP file chips.

### Text measurement

SVG has no text wrapping and no automatic truncation, so the exporter has to know how wide
a string will be before it writes it.

| Approach | Accuracy | Verdict |
|---|---|---|
| `canvas.measureText` with the resolved computed font | exact | **Chosen** |
| Per-character width estimate | ±15% | Fallback for a headless CLI export |
| `textLength` + `lengthAdjust` | exact width, distorted glyphs | Rejected — visibly squeezed text |
| Measure the live DOM | exact, but only for rendered rows | Rejected — breaks under phase 7 virtualisation |

Measuring the live DOM is the obvious move and the wrong one: once rows are virtualised,
off-screen rows are not in the DOM to measure. `canvas.measureText` measures any string
against any font without either constraint, so it survives that change.

---

## Where it runs

| Option | Daemon writes files | New HTTP surface | Works headless | Text metrics |
|---|---|---|---|---|
| **Browser button → Blob download** | **no** | **none** | no | exact |
| `GET /api/export.svg` | no | one route | yes | estimated |
| `git-artifact --export out.svg` | **yes** | none | yes | estimated |

Chosen: **a button in the browser.** Three reasons, in order of weight.

1. **It keeps the "writes nothing" guarantee literally true.** The daemon still writes
   nothing anywhere; the browser saves to Downloads through the ordinary download path.
   No new sentence is needed in the README, and no new question about where a file lands.
2. **No new server surface.** No route, no auth consideration, no fifth thing that can
   return repo contents.
3. **Exact text metrics**, per above.

The CLI flag is the one that costs something. `git-artifact --export graph.svg` run inside
a repository writes a file into that repository, and the README currently promises "the
only thing it writes is its own build output". That claim is worth more than the flag. If
the flag lands later it should default to **stdout** — `git-artifact --export - > graph.svg`
— so the redirect is the user's, and writing to a named path stays an explicit opt-in that
the README describes honestly rather than a promise quietly weakened.

---

## Scope: what goes in one file

This is where the design nearly went wrong. The `--max-count` default is 5000, and 5000
rows at `ROW_HEIGHT = 44` is a 220,000-pixel-tall image — so the first instinct was that
export must be scoped before it can ship at all.

The measured repositories say otherwise:

| | commits |
|---|---|
| largest repository on this machine | **227** |
| second largest | 139 |
| median | **8** |
| under 60 commits | 35 of 39 |
| over 100 commits | 2 of 39 |
| more than one branch | 5 of 39 |

The median repository exports to about 350 pixels. Even the largest is roughly a
10,000-pixel-tall SVG — tall, but a legitimate artifact: it scrolls and it zooms. The
5000-commit case is a safety valve, not the common case, and designing the feature around
it would have been designing around a repository nobody here has.

Measured after building it, rendering the 227-commit repository: **996 × 10,070 px, 2,022
elements, 275 KB.** The pixel estimate was right and the size estimate was not — 275 KB is
close to twice the 150 KB guessed here before the renderer existed. Still a fine size for a
file you keep, but the guess was not evidence.

**So the default scope is everything currently loaded, and it ships that way.** Scoping is
a refinement for readability, not a prerequisite.

The refinement is still worth having, because the tall-narrow aspect ratio is the real
cost: a full-history export embedded at 800px wide is 8000px tall, and a reader usually
wants one thing, not the whole repo. Two scopes map directly onto that:

| Scope | How it is bounded | Typical size | Cost |
|---|---|---|---|
| **Everything loaded** | as displayed | 8 rows median, 227 at the top | none — ships first |
| **One session** | `startRow`/`endRow` already on `SessionBandInfo` | 3–23 rows | trivial |
| **One branch** | commits since the merge-base with the default branch | varies | needs a base, and a reachability walk |

Session scope is nearly free — the band already carries its own row range, and a
session-sized artifact (a few hundred pixels tall) is the one that actually pastes into a
pull request without anyone scrolling. It answers "what did this session do" exactly.

Branch scope is the one with real work in it. The client already has the full parent DAG in
`GraphPayload.rows`, so reachability is computable without another git call, but "the
merge-base with *what*" has no obvious answer in a repo whose default branch is not named
`main` and whose branch has no upstream. It goes after session scope.

---

## What has to be refactored

One thing, and it is worth doing on its own merits.

`renderEdges` in `Rails.tsx` computes rail geometry and emits JSX in the same pass. The
exporter needs the same geometry and cannot use the JSX. Splitting it into a pure function
that returns `{ d, stroke, kind }[]`, which `Rails.tsx` maps to `<path>` and the exporter
maps to a string, gives both callers the same rails by construction.

The side benefit is the real argument: rail geometry is currently untested. `lanes.test.ts`
covers lane *assignment*, and the oracle suite compares against `git log --graph`, but
nothing asserts the paths that get drawn — because asserting them today would mean
rendering React. As a pure function it is directly testable, including the case the comment
in `Rails.tsx` calls out by hand: a merge whose second parent lands in a lane that is
already busy, which needs two lines drawn and produced a broken rail on real history when
only one was.

Everything else is reuse as-is: `layout.ts` for vertical geometry, `buildDisplayRows` for
row interleaving, `laneX`/`laneColor` for horizontal placement.

---

## Implementation constraints

- **No `var()` in the output, and no `<style>` block.** The palette is CSS custom
  properties (`--lane-1` … `--lane-8`, `--paper`, `--ink`), and custom-property support in
  standalone rasterisers ranges from partial to absent. Colours resolve to literal hex on
  presentation attributes at export time. At a few hundred rows the repetition costs
  nothing and it is the maximally compatible form.
- **Fonts will be substituted.** `--font-ui` starts with `ui-sans-serif`, which no
  rasteriser resolves. Text positions are computed from *browser* metrics at export time,
  so a substituted font shifts them. Left-align by default and use `text-anchor="end"` for
  the right margin, both of which are anchored rather than fitted; truncate with a margin
  of error rather than to the pixel.
- **The palette is light-only.** There is no `prefers-color-scheme` block in `theme.css`,
  so there is one surface to bake in and no theme question to answer.
- **Nothing live goes in the file.** No token, no URL, no port, no absolute repo path
  beyond the repository name. An exported artifact is the thing most likely to be shared,
  and the footer of the live view shows `repo.root`, which is a home-directory path.
- **The export is a snapshot and must say so.** `GraphPayload.generatedAt` already exists;
  the artifact carries that timestamp and the repository name, and nothing that implies it
  is still updating.

---

## Settled while building

The four questions above, as they were actually answered.

1. **Uncommitted work is included**, with the header timestamp carrying the caveat. It is
   the most volatile thing in the file and often the only reason to take one.
2. **Session bands appear**, and the footer states "observed alongside these commits, not
   authored by them" whenever one is drawn. That sentence is the reason the band is
   allowed in at all — it is the only part of the graph inferred rather than read, and the
   file is the version most likely to be forwarded past anyone who knows that.
3. **The card column is 820 px**, giving roughly 1000 px overall at typical lane counts.
4. **PNG at 2×.**

### One thing measurement changed

Chips (refs, push markers, file names) originally sized themselves to exactly their
measured text. Rendered through librsvg — which substitutes a font, because no rasteriser
resolves `ui-monospace` — the text ran past its own chip and into the commit subject beside
it. The stub measurer in the test suite could not catch this, because it measures the same
way the renderer does; it took rasterising a real repository and looking at it.

The fix is `CHIP_SLACK`, six per cent on every chip's text width. Bounded, applied in one
place, and the cheap direction to be wrong in: a slightly roomier chip costs nothing, and a
branch name printed across a commit subject costs the whole artifact.

## Still open

1. **A scoped export.** Session scope is nearly free and not built yet; branch scope needs a
   merge-base and an answer for repositories whose default branch is not named `main`.
2. **Whether the 820 px column should be configurable.** It decides where every subject
   truncates, and long conventional-commit subjects hit it.

---

## Explicitly out of scope

- **A summary table or digest artifact** — commits per branch, per session, per author.
  It answers "what is the current status" better than a graph does, but it is a different
  artifact with different inputs, and folding it in here would make phase 5 two features.
- **Any other output format.** No PDF, no Mermaid, no DOT.
- **Uploading, hosting, or sharing.** The file lands in Downloads. What happens to it next
  is not this tool's business, and outbound network requests are a thing this project does
  not have.
