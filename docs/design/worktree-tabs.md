# Worktree tabs

A worktree is a place you are working. Until now the UI treated one as an annotation: a
chip in a strip, colour-keyed to the lane its tip happened to occupy, whose only power was
to scroll you to that tip inside a graph still holding every other checkout's history.
This makes each worktree its own render instead.

## Why the old objection does not apply

`api.ts` carried this, and `WorktreeStrip.tsx` repeated it:

> Deliberately an annotation rather than a partition of the graph. Commits are shared
> history — one commit is typically reachable from every worktree — so carving lanes into
> per-worktree blocks would have to either duplicate commits or assign them arbitrarily.

That is correct, and it is still correct. It describes a **partition within a single
render**, which is what "lane groups" in phase 3 tried to be. A commit reachable from three
checkouts cannot occupy three lanes at once, so something has to give: either it is drawn
three times in one layout, or one worktree is declared its owner and the other two are
lying.

Tabs are not that. A tab is a **filter producing a separate render**, and across renders
duplication is free — `base` simply appears in both graphs, the way `git log main` and
`git log feat` both print it without anyone calling that a contradiction. The payload
stays whole and unpartitioned; only the view is scoped.

So the rule the old comment protects survives intact, and the comment has been rewritten
rather than deleted, because the distinction it draws is the reason this design works.

## A view is derived on the client

`client/views.ts` builds every view from the payload already in memory:

1. Walk the payload's own parent links from the worktree's HEAD to get its ancestry. A
   parent past the `--max-count` cap is simply absent, which is the same condition
   `assignLanes` already treats as truncation — so the window boundary is inherited for
   free rather than re-derived.
2. Filter rows to that set and re-run `assignLanes` **from scratch**. Slicing would be
   wrong: lanes are positions in a layout, so carrying the unified view's indices across
   leaves a tab with a lane 5 and nothing in lanes 1–4.
3. Re-index session bands into the filtered rows, and drop any band that lost all of its
   commits.
4. Scope the worktree statuses, so a tab only grows the WIP node it owns.

No server change, no wire change, no extra git spawns. Switching tabs costs no round trip
and cannot show something the graph disagrees with, because it *is* the graph.

The one thing this does not fix: `--max-count` is still a budget shared by the single
`git log --all` walk. A worktree crowded out of that window renders an empty tab, which
the empty state now says explicitly rather than blaming `--since`. Per-tab walks would fix
it and cost a refresh path per worktree; not worth it at a default cap of 5000.

## Sessions cut across worktrees, and that is not an edge case

This is the reason tabs were a product decision rather than a refactor.

`session-bands.md` already records that `cwd` mutates within a session — one transcript
held three. In this repository, session `e160b0e7` ran in both the main checkout and
`.claude/worktrees/infra`, and its transcript lives under the *worktree's* project
directory, not the repo's. Its band covers 5 commits across 3 branches and 2 worktrees.

Scoping the graph necessarily cuts a band like that in half. Three options were on the
table:

| | |
|---|---|
| **Bands split, no unified view** | Cleanest model, but a session can never be seen whole. |
| **Band picks a home worktree** | No double-counting, but commits sit under no band in the tab you are reading. |
| **Keep a unified view as home** ✔ | Bands stay whole in "All", scoped elsewhere. Two truth sources for one count. |

The third was chosen. Worktree is a *spatial* axis and session is a *temporal* one; they
are orthogonal, and forcing one to win distorts the other. "All" stays first and stays the
default, so the whole-session reading is the one you get without asking.

The cost is that the same band reports different counts in different tabs. That is
addressed rather than hidden: a scoped band carries `elsewhere`, the count of its commits
outside the current view, and the header renders `+N elsewhere`. Absent means "not
scoped" — the unified view is the payload itself, so a band that was never cut has no
remainder to report.

## What a tab replaces

The strip's scroll-to-tip is gone, because a scoped view puts the tip at the top by
construction. The focus flash is kept: it answers "which of these is the one I switched
to". The scroll resets rather than animating — the rows underneath have been replaced
wholesale, so travelling smoothly through the old view's geometry would be motion for its
own sake.

Header counts and the export follow the active tab. Reporting the repository's total above
a graph showing one worktree's slice of it would be describing something the reader cannot
see.

A tab is labelled by **worktree**, with the branch as secondary text. The strip labelled by
branch, which was defensible there — a chip annotated a branch tip in the lanes, so it was
named after what it pointed at. A tab is the worktree itself: the path identifies it and
stays put, while the branch in it can move, change, or not exist. Labelling by branch left
`.claude/worktrees/infra` showing as `merge-detail-sessions` with nothing connecting the
two, and rendered every detached worktree as the same literal string. The branch is also
the only part of a tab that truncates, because the strip scrolls and an untruncated long
ref pushes later tabs off the edge — which is how a reader concludes the tabs they cannot
see do not exist.

## Verified

- **Shared history appears in every tab that can reach it.** Asserted directly, since it
  is the property the old objection said was impossible.
- **Tabs re-lane from zero.** A branch sitting in lane 1 of the unified graph occupies
  lane 0 alone in its own tab, and the graph is one column wide.
- **Bands stay ordered and non-overlapping after scoping.** `buildDisplayRows` keys
  headers off `startRow` and assumes the guarantee the wire type makes, so a filter that
  broke ordering would misplace headers silently.
- **A deleted worktree drops you to "All"**, not to a blank graph — the payload arrives
  without it on the very next SSE frame.
- **An off-screen tip renders an empty tab** rather than throwing.
