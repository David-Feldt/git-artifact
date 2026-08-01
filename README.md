# git-artifact

A live commit-graph dashboard for a git repository. Point it at a repo, put it on a second
monitor, and it keeps itself up to date while you work — commits appear as you make them,
and uncommitted edits show up as a work-in-progress node with the files you are actively
touching highlighted.

```sh
npx git-artifact
```

That is the whole setup. No global install, no config file, no account.

Because the binary is named `git-artifact`, git also picks it up as a subcommand:

```sh
git artifact
```

---

## It does not write to your repository

This is a hard constraint, not a v1 shortcut. git-artifact never checks out, never creates
a worktree, never commits, never moves a ref. It runs read commands with
`GIT_OPTIONAL_LOCKS=0`, so it will not take `index.lock` and cannot contend with the git
you are running in your terminal.

There are no mutating HTTP endpoints. Anything other than `GET` is refused outright.

It also does not write to `~/.claude/settings.json`, install hooks, or modify any other
tool's configuration. The only thing it writes is its own build output.

## No telemetry

None. No analytics, no crash reporting, no version check, no outbound network requests of
any kind. The daemon binds to `127.0.0.1` and talks to nothing but your browser.

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
  -h, --help
  -v, --version
```

History is capped at 5000 commits by default. `git log --all` unbounded on a very large
repository would hang the first render.

## Worktrees

Every linked worktree gets a chip in the strip below the header, colour-keyed to the lane
its HEAD sits in, and its own WIP node at that lane's tip. Clicking a chip scrolls to that
worktree's HEAD.

The chips **annotate** the graph rather than partitioning it, and that is a deliberate
choice. Commits are shared history — one commit is usually reachable from every checkout —
so carving lanes into per-worktree blocks would have to either duplicate commits or assign
them arbitrarily. What *is* unambiguously per-worktree is the tip. Keeping it an
annotation also preserves stable lane indices.

Two worktrees can legitimately share a lane, when one is checked out at an ancestor of the
other. That renders as two chips of the same colour, which is honest: they really are on
the same rail at different points.

## Push markers

Commits that a `git push` landed on carry a `↑ pushed 2h` marker, read from the
remote-tracking reflogs under `.git/logs/refs/remotes/`. That is the only durable local
record of *when* work left the machine.

Only the exact commit a push targeted is marked, not everything behind it. "A push
happened here, then" is a timeline event; whether a commit is *currently* published is a
different question, already answered per-branch by the ahead/behind counts on each chip.

Reflogs expire — 90 days for reachable entries by default — so older history simply has no
markers. That is normal, not an error.

## Session bands

If you use Claude Code, commits are grouped under the session they were made during, with
its title, prompt count, and token cost. Token cost is the one figure git genuinely cannot
produce.

**These are observed alongside, not authored by.** Nothing in a transcript records that a
session caused a commit — it is inferred from timing. A commit you type by hand shortly
after Claude stops will land in the band. The wording throughout says "observed alongside"
for exactly this reason.

Attribution gives each commit to the single session whose most recent activity precedes it
most closely, ignoring any session idle more than 30 minutes. The naive alternative — a
session owns every commit between its first and last record — produces nonsense, because
sessions sit idle for days: measured on real data, one session left open 13.7 days
swallowed every commit three other sessions made inside its window, stacking four bands on
one row. Design notes and measurements are in
[`docs/design/session-bands.md`](docs/design/session-bands.md).

Everything about Claude Code lives in `src/sources/claude-code.ts`. The transcript format
is not a stable public contract, so a format change is a one-file fix. If Claude Code is
absent, has no transcripts for this repository, or writes something unrecognised, the
graph renders exactly as before with no session data and no error. Nothing else depends on
it.

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

### Testing approach

`git log --graph` ships on every machine that will ever run this, which makes it a free
reference implementation for lane assignment. The test suite generates ten throwaway
repositories — linear, branch+merge, octopus, two roots, detached HEAD, mid-rebase,
mid-merge, empty, bare, shallow — with pinned timestamps so shas are stable, and compares
against git's own output on each.

Commit order is asserted exactly everywhere. Lane indices are asserted exactly on the
fixtures. On real history the lane *indices* are allowed to differ, because git compacts
columns when a lane closes and git-artifact deliberately does not — see below — but the
graph must never come out wider than git's.

### One deliberate difference from `git log --graph`

When a lane closes, git slides every lane to its right one column left. That is ideal for
a one-shot terminal dump. This graph re-renders live, so sliding would make unrelated
branches jump sideways every time some other branch got merged — so lanes keep their
column for life, and freed columns are reused leftmost-first.

The cost is an occasional transient empty column. Measured against a real 316-commit
repository, the maximum width came out *narrower* than git's (4 vs 5), so nothing is lost
in practice.

## Colour

Lane colours are not hand-picked. All 40,320 orderings of eight hues were scored against
the tan surface with the colour-vision validator, optimising so the first four slots clear
the all-pairs gates — four being both the maximum any subset of these hues can reach and
the widest a real graph got in testing. All eight clear the adjacent-pair gates. The hues
are stepped darker than a typical light-surface palette because rails are thin 2 px marks
and need the contrast.

Activity heat is a separate, single-hue sequential ramp, scoped to the file chips inside a
WIP node so it can never be confused with a lane.

## Licence

MIT
