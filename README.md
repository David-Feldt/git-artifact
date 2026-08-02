<div align="center">

<img src="https://raw.githubusercontent.com/David-Feldt/git-artifact/main/docs/images/icon.svg" alt="" width="88" height="88">

# git-artifact

**A live commit-graph dashboard for a git repository.**<br>
Read-only, local-first, no telemetry, zero runtime dependencies.

[![npm](https://img.shields.io/npm/v/git-artifact?color=c9761a&label=npm)](https://www.npmjs.com/package/git-artifact)
[![CI](https://img.shields.io/github/actions/workflow/status/David-Feldt/git-artifact/ci.yml?branch=main&label=CI)](https://github.com/David-Feldt/git-artifact/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/git-artifact?color=3c873a)](https://nodejs.org)
![dependencies](https://img.shields.io/badge/runtime%20deps-0-3c873a)
[![licence](https://img.shields.io/npm/l/git-artifact?color=666)](LICENSE)

`git` · `commit graph` · `worktrees` · `local-first` · `read-only` · `no telemetry` · `claude code`

<img src="https://raw.githubusercontent.com/David-Feldt/git-artifact/main/docs/images/dashboard.png" alt="git-artifact showing a live commit graph with lanes, merges, push markers and Claude Code session cards" width="900">

</div>

Point it at a repo, put it on a second monitor, and it keeps itself up to date while you
work — commits appear as you make them, and uncommitted edits show up as a work-in-progress
node with the files you are actively touching highlighted.

## Install

From inside any repository:

```sh
npx git-artifact
```

That is the whole setup. No global install, no config file, no account.

Install it properly and you get the short form:

```sh
npm install -g git-artifact
artifact
```

It also installs as `git-artifact`, which git finds as a subcommand, so `git artifact`
works too.

<details>
<summary>Running an unreleased commit, and the <code>git artifact --help</code> caveat</summary>

<br>

git claims `--help` for its own manual system and will report *"No manual entry for
git-artifact"* rather than passing it through. Use `git artifact -h`, or just
`artifact --help`, which git never sees.

To run an unreleased commit straight from GitHub — a fix that has not been published yet,
or your own fork:

```sh
npx github:David-Feldt/git-artifact        # main
npx github:David-Feldt/git-artifact#<sha>  # a specific commit
```

That clones the repo and builds it on your machine, so it needs git and a moment longer
than the published tarball. Prefer the registry unless you want a particular commit.

Note that `npm install -g` does **not** work against a git URL: npm skips the package's
devDependencies before running its build, so the build cannot run. This is npm's
behaviour rather than something this package can fix. Use `npx` as above, or install the
published version globally.

To run it from a clone instead:

```sh
git clone https://github.com/David-Feldt/git-artifact
cd git-artifact
npm install
node dist/cli.js -C /path/to/your/repo
```

</details>

---

## It does not write to your repository

This is a hard constraint, not a v1 shortcut. git-artifact never checks out, never creates
a worktree, never commits, never moves a ref. It runs read commands with
`GIT_OPTIONAL_LOCKS=0`, so it will not take `index.lock` and cannot contend with the git
you are running in your terminal.

One endpoint accepts a write, and only one: `POST /api/artifact`, which generates an
explanation page. Everything else refuses anything but `GET`. That endpoint still cannot
touch your repository — it spends tokens and writes a file under `~/.cache/git-artifact/`,
outside the repo and outside any other tool's configuration.

It does not write to `~/.claude/settings.json`, install hooks, or modify any other tool's
configuration.

## No telemetry

None. No analytics, no crash reporting, no version check. The daemon binds to `127.0.0.1`
and opens no sockets of its own.

There is exactly one way anything leaves your machine, and you have to click it. Asking for
an explanation of a commit runs your local `claude` or `codex` CLI as a subprocess, which
sends that commit's diff to the model. Per click, never in the background, and never for a
commit you did not ask about. The daemon holds no API key and makes no network request
itself — whichever harness you have already installed and authenticated is the one that
runs.

## Security

The daemon reads your source code and serves it over HTTP. Any web page you have open can
send requests to `127.0.0.1` — browsers do not treat localhost as privileged — so three
checks stack on top of the loopback bind:

| Check | Stops |
|---|---|
| **Token** — 128 bits, printed by the CLI, required on every request | Anything that has not been handed the URL |
| **Origin** — foreign origins refused, no CORS headers ever sent | A page at `evil.example` reading your repo, even if it somehow learned the token |
| **Host** — must address a loopback name | DNS rebinding, which defeats the Origin check by making the request look same-origin |

After the first page load the token moves into a `HttpOnly; SameSite=Strict` session
cookie, so the browser can fetch the app bundle without the token being appended to every
asset URL.

One deliberate trade-off: the token arrives as a `?t=` query parameter, because
`EventSource` cannot set request headers. On loopback the referrer exposure this creates
is negligible, and neither the Origin nor the Host check depends on it.

## Options

```
git-artifact [path] [options]

  -C, --repo <path>     Repository to watch (default: current directory)
  -p, --port <n>        Preferred port; the next free one is used if taken (default: 7373)
      --max-count <n>   Maximum commits to load (default: 5000)
      --since <date>    Only load commits newer than this, e.g. 3.months
      --no-open         Do not open a browser
      --harness <name>  CLI that writes explanation pages: claude or codex (default: claude)
      --model <name>    Model passed to that CLI
  -h, --help
  -v, --version
```

History is capped at 5000 commits by default. `git log --all` unbounded on a very large
repository would hang the first render.

## Worktrees

Every linked worktree gets a chip in the strip below the header, colour-keyed to the lane
its HEAD sits in, and its own WIP node at that lane's tip. Clicking a chip scrolls to that
worktree's HEAD.

The chips **annotate** the graph rather than partitioning it. Commits are shared history, so
carving lanes into per-worktree blocks would have to either duplicate commits or assign them
arbitrarily; what *is* unambiguously per-worktree is the tip. Two worktrees can legitimately
share a lane when one sits at an ancestor of the other, and that renders as two chips of the
same colour — honest, because they really are on the same rail at different points.
Reasoning in [`docs/design/worktree-tabs.md`](docs/design/worktree-tabs.md).

## Push markers

Commits that a `git push` landed on carry a `↑ pushed 2h` marker, read from the
remote-tracking reflogs under `.git/logs/refs/remotes/` — the only durable local record of
*when* work left the machine.

Only the exact commit a push targeted is marked, not everything behind it. "A push happened
here, then" is a timeline event; whether a commit is *currently* published is a different
question, already answered by the ahead/behind counts on each chip. Reflogs expire (90 days
by default), so older history simply has no markers.

## Sessions

If you use Claude Code, the strip above the graph shows one card per session that worked in
this repository — newest first, with its title, the branches it touched, how many prompts it
took, and what it cost. Token cost is the one figure git genuinely cannot produce. A live
session carries a dot and what it is doing right now.

**Everything on a card is read from a transcript, not deduced.** Branch tags come from the
`gitBranch` stamped on every record, so "this session worked on `export`" is a fact.

Cards are deliberately **not** joined to the commits below them, and that is the main thing
worth knowing. Sessions were once drawn as bands claiming a run of commits, which requires
knowing which session produced which commit — and nothing records that. Inferring it from
timing breaks as soon as two sessions overlap, and on this repository's own history four
pairs did. The claim was dropped rather than dressed up; measurements and the full argument
are in [`docs/design/session-bands.md`](docs/design/session-bands.md).

Everything about Claude Code lives in `src/sources/claude-code.ts`. The transcript format
is not a stable public contract, so a format change is a one-file fix. If Claude Code is
absent, has no transcripts for this repository, or writes something unrecognised, the
graph renders exactly as before with no session data and no error. Nothing else depends on
it.

## Explaining a commit

Open a commit and press **Generate artifact**. A window opens, and a page appears in it
that says what changed, why it matters, and what to review first.

<div align="center">
  <img src="https://raw.githubusercontent.com/David-Feldt/git-artifact/main/docs/images/artifact-page.png" alt="A generated artifact page for commit 0c951bd, with the sha, author, diff size, and prose sections explaining the change" width="820">
  <br>
  <sub>A generated artifact page — written by Claude from a brief this project assembles.</sub>
</div>

The page is **written by Claude, not rendered by git-artifact**. This project's job is the
brief: the diff, the session the commit was observed alongside, when it was pushed, where it
sits in the graph. That last part is what makes the brief worth more than `git show` —
`git show` can tell a model five files changed together, and cannot tell it what someone was
trying to do.

A popup rather than a panel because these are pages you keep open, put on another monitor,
and compare. The window is named after the commit, so asking twice focuses the one already
open instead of stacking a second.

**There is no oracle here.** Lane assignment can be checked against `git log --graph`, which
is why the graph is confidently correct. Nothing checks an explanation. A model can be
fluently wrong about a diff and this tool cannot tell, so read them as a well-informed first
pass, not as ground truth.

### The budget, which is the whole difficulty

Putting the diff in the prompt is the obvious plan and it fails: measured across a real
repository, the median commit diff is **237 tokens** and the largest is **21.3 million**.
Dropping binary files does not fix it — the second-worst commit measured contains none, just
one 135,037-line text STEP file that git diffs happily. So diffs are admitted **smallest
first**, which spends the budget on twenty ordinary source files instead of one CAD export.

One invariant holds throughout:

> **The file list is never truncated. Only diff bodies are.**

A page can always say correctly which files changed and by how much. When bodies are
dropped, the brief says so and the page is told to say so too — silently describing only the
files that happened to fit would be wrong in a way nobody could see. Measurements and the
full budget policy are in [`docs/design/artifacts.md`](docs/design/artifacts.md).

### What it will not claim, and what it costs

The page is told that a session is **observed alongside** a commit and never its author;
that it must not invent tickets, discussions or intentions the brief does not contain; that
a merge diff is against the first parent; and that only the repository *name* may appear,
never a path. Those constraints live in `src/artifacts/page-spec.ts`, a plain file you can
read and change.

Generation takes a minute or two and spends real tokens, so a page is written once and
reused. The cache key is the **brief**, not the sha: a commit is immutable but its brief is
not — session attribution shifts when a transcript is written later, and a push marker
appears when the work leaves the machine. Keying on the sha alone would serve a stale page
that no longer matches the graph beside it.

## How liveness works

Filesystem events are a **trigger, not a source of truth**. A change under `.git` or in a
working tree schedules a 200 ms debounce, and then git is asked what actually happened.
A missed event costs a delayed update; a spurious one costs a redundant read. Neither can
produce a wrong graph.

Two classes of change are tracked separately, so editing a file does not re-read the
entire commit graph:

- **refs** (`HEAD`, `refs/`, `packed-refs`, `logs/`, `worktrees/`) → re-read `git log`
- **working tree** → re-read `git status --porcelain=v2` only

Working trees are filtered through `.gitignore` and `.git/info/exclude` before being
watched, so `node_modules` and build output are never descended into.

## Degrading gracefully

Each of these renders a clear message instead of a stack trace, and none of them stops the
rest of the app from working:

| State | Behaviour |
|---|---|
| Empty repository | "No commits yet"; the branch name is still shown |
| Bare repository | Graph renders; working-tree tracking is unavailable |
| Shallow clone | Graph renders with a frayed rail at the graft boundary |
| Detached HEAD | Rendered normally, flagged in the header |
| Rebase / merge / cherry-pick in progress | Flagged in a banner |
| Daemon stops | The page says so and reconnects with backoff |

A shallow clone is worth calling out: git reports a grafted commit with *no parents*, so
it is textually identical to a root commit. git-artifact reads `.git/shallow` to tell the
difference, rather than claiming your history begins at the boundary.

## Development

```sh
npm install
npm run dev            # daemon + Vite with hot reload, watching the current repo
npm run dev -- /path   # watch a different repo
npm test
npm run typecheck
npm run build
```

`git log --graph` ships everywhere, which makes it a free oracle for lane assignment. The
suite builds ten throwaway repositories — linear, branch+merge, octopus, two roots,
detached HEAD, mid-rebase, mid-merge, empty, bare, shallow — with pinned timestamps so shas
are stable, and checks each against git's own output.

One deliberate disagreement: when a lane closes git slides every lane left, and this graph
does not, because sliding would make unrelated branches jump sideways whenever some other
branch merged. Lanes keep their column for life. That, the exact test assertions, and where
the lane colours came from are in [`docs/design/graph.md`](docs/design/graph.md).

### Design notes

| | |
|---|---|
| [`graph.md`](docs/design/graph.md) | Lane assignment, the `git log --graph` oracle, colour |
| [`artifacts.md`](docs/design/artifacts.md) | The brief, the token budget, page constraints |
| [`session-bands.md`](docs/design/session-bands.md) | Session attribution, and why bands were dropped |
| [`worktree-tabs.md`](docs/design/worktree-tabs.md) | One render per checkout |

## Licence

MIT
