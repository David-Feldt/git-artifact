# Session bands

Design for phase 4: showing which Claude Code session produced which commits.

> **Outcome: bands were built, then removed.** The attribution below works until two
> sessions overlap, and measured on this repository's own history four pairs did — commits
> landed under the wrong session, and a band cannot represent the overlap even when it
> guesses right, because one commit gets exactly one owner. Concurrent work rendered as
> tidy sequential blocks: cleaner than the truth, which is worse than visibly wrong. Sessions
> are now cards above the graph that claim no commits at all. This document is kept for the
> measurements and for anyone tempted to try attribution again.

Rendered version, with the four encodings drawn at real scale:
<https://claude.ai/code/artifact/6c884543-f899-4a71-a8d0-522e07a8dc63>

Everything here is measured against the 214 real transcripts on the development machine
and the repositories they correspond to. None of it is assumed.

---

## The hard part is attribution, not rendering

Two problems, in order. Which commits belong to a session, and only then how to draw it.
The second is the easy one.

### What a session actually looks like

| | |
|---|---|
| median duration | 53 min |
| 75th percentile | 3.5 hr |
| 95th percentile | 25 hr |
| longest | **13.7 days** |
| single-branch | 80% (20% touch 2–6 branches) |

The long tail is what breaks things. Sessions get left open over a weekend, resumed, and
abandoned. Any design assuming a session is a tidy work block fails on that tail.

One result that helps: **a session's commits are always contiguous in topological row
order.** Never scattered. So a band can be one unbroken vertical span.

### Why naive time windows fail

The obvious rule — a session owns every commit between its first and last record —
produces garbage. Six real sessions from one repository, mapped onto commit rows:

```
b813e5f2  rows   0-  2       21 min  |###
01e72ed7  rows   0-  4    19782 min  |#####
25594ae1  rows   0-  4       71 min  |#####
8f125488  rows   3-  4      172 min  |   ##
fcea98dd  rows   5- 13      514 min  |     #########
4d132371  rows  14- 36      117 min  |              #######################

max overlapping sessions at any row: 4
```

Three sessions all claim rows 0–2. `01e72ed7` sat idle for 13.7 days, so its window
swallows every commit any other session made inside it. Drawn literally, four bands stack
on the same rows and none of them is true.

### The fix

Attribute each commit to **exactly one** session: the one whose most recent record
precedes it most closely, discarding any session idle longer than `SESSION_IDLE_LIMIT`
(30 minutes). Bands become non-overlapping by construction, which is what makes them
drawable at all.

```
row  commit   assigned  gap     subject
  0  918a5a6  b813e5f2   0.0m  fix(engine): hold both viability legs
  1  c6e05e3  25594ae1   0.0m  docs(readme): retire the voice-era README
  5  b3a6538  fcea98dd   0.0m  chore(deploy): Railway artifacts, pinned deps
 14  7dfbfff  4d132371   0.0m  feat(sim): simplify --demo to a 2-user auto

resulting bands: all contiguous, zero overlap
commits with no session: 10 / 47   (hand-made — correctly unbanded)
```

Gaps land at **0.0–0.4 minutes**. Commits follow session activity almost instantly, so
this is a clean separation rather than a heuristic scraping by.

### This is inference, and it can be wrong

Nothing in the data records that a session *caused* a commit. We infer it from timing. A
commit typed by hand twenty seconds after Claude stops will be attributed to that session.

The UI must therefore say **observed alongside**, never **authored by**. That is a copy
constraint, not a nicety — claiming authorship we cannot prove is the one way this feature
actively misleads.

---

## Encoding: hue is already spoken for

Lane colour is a validated categorical palette where hue carries lane identity. A band
must not use hue or it competes for the one channel the graph has committed. That leaves
position, weight, and value.

| Option | Hue-free | Shows extent | Width cost | Verdict |
|---|---|---|---|---|
| A · left gutter | yes | yes | ~130px always | Too expensive; the graph is already wide |
| B · row wash | yes | yes | none | Collides with activity heat and hover |
| C · header only | yes | **no** | none | Ambiguous where a session ends |
| **A+C** | yes | yes | ~16px | **Chosen** |

### Chosen: header row plus right-margin extent rail

A header row spliced above the band's first commit carries the content — title, prompt
count, token cost, model, duration. A thin rail in the right margin carries the extent, so
a commit that belongs to no session visibly falls outside it.

Why this one:

- It is the only option stating both things a band must state: what the session was, and
  exactly which commits it covers.
- It spends neither hue (lanes) nor value (activity heat).
- The right margin is the quietest part of a row — only a relative timestamp lives there.
- The header reuses the row-splicing machinery the WIP pseudo-node already uses, so it is
  not new layout code, and the fixed row height that makes phase 7 virtualisation cheap
  stays intact.

Row wash was the tempting alternative and is rejected specifically because activity heat
is a sequential amber ramp on the same surface. A warm row tint and a warm file chip start
arguing with each other, and heat is the more valuable signal.

---

## Available band content

All free from the transcript, no extra cost:

| Field | Source | Notes |
|---|---|---|
| title | `ai-title` record | Already human-readable, e.g. "Understand background changes" |
| prompts | `type:user` with `origin.kind === 'human'` | Excludes tool results and sidechains |
| token cost | `usage` on every assistant record | The one thing git genuinely cannot tell you |
| model | `message.model` | |
| duration | first/last `timestamp` | |

---

## Open questions

1. **Is 30 minutes right?** It cleanly separated every session measured here, but it is one
   number tuned on one machine. Probably wants to be a flag rather than a constant.
2. **Do sessions with no commits appear at all?** Most sessions produce nothing — reading,
   debugging, exploring. They are invisible on a commit graph, which is arguably correct,
   but it means the view under-reports the work.
3. **How much does a band say by default?** All five fields on every band is noise. Token
   cost is the one git cannot produce.
4. **Sessions spanning branches.** 20% touch more than one. Rows stay contiguous so the
   rail still works, but the band visibly straddles two lanes and that should be stated
   rather than left to be noticed.

---

## Implementation constraints

- **Every Claude Code assumption lives in one module** (`src/sources/claude-code.ts`). The
  JSONL layout and directory scheme are not stable public contracts, so a format change
  must be a one-file fix.
- **The escaping scheme is `[^a-zA-Z0-9] → -`**, verified across 26 directories. It is
  lossy and non-invertible: map forward from a repo path, never parse a directory name
  back.
- **`cwd` mutates within a session.** One transcript held three: a worktree, its `/server`
  subdirectory, and the main repo. Attribution must prefix-match per-record `cwd` against
  the repo root and its worktrees, never trust the directory name alone.
- **Transcripts get large** — the biggest on this machine is 52 MB. Parsing on every graph
  refresh is not viable; results must be cached on `(path, mtime, size)`.
- **Absence is normal.** No Claude Code installed, no transcripts, an unrecognised schema —
  each degrades to Tier A with no error surface.
