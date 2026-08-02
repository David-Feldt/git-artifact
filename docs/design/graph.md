# Graph: lanes, testing, colour

How the commit graph is verified, the one place it deliberately disagrees with git, and
where the lane colours came from. Summarised in the README; the detail lives here.

---

## `git log --graph` is a free reference implementation

It ships on every machine that will ever run this, which makes it an oracle for lane
assignment — a rare luxury. The test suite generates ten throwaway repositories and
compares against git's own output on each:

linear, branch+merge, octopus, two roots, detached HEAD, mid-rebase, mid-merge, empty,
bare, shallow.

Fixtures pin the author, committer and both timestamps, so shas are stable across machines.
Without that, the oracle comparison drifts whenever two commits land in the same second and
git breaks the tie differently.

What is asserted, and how strictly:

| Property | Fixtures | Real history |
|---|---|---|
| Commit order | exact | exact |
| Lane indices | exact | may differ from git's |
| Graph width | exact | never wider than git's |

Lane indices are free on real history for the reason below.

## One deliberate difference from `git log --graph`

When a lane closes, git slides every lane to its right one column left. That is ideal for a
one-shot terminal dump, where the output is never seen again.

This graph re-renders live. Sliding would make unrelated branches jump sideways every time
some other branch got merged — motion that carries no information about the branch that
moved. So **lanes keep their column for life**, and freed columns are reused leftmost-first.

The cost is an occasional transient empty column. Measured against a real 316-commit
repository the maximum width came out *narrower* than git's (4 vs 5), so nothing is lost in
practice.

Consequence for anyone adding a fixture: assert order exactly, and assert width against
git's as an upper bound rather than an equality.

## Colour

Lane colours are not hand-picked. All 40,320 orderings of eight hues were scored against
the tan surface with the colour-vision validator, optimising so the first four slots clear
the all-pairs gates — four being both the maximum any subset of these hues can reach, and
the widest a real graph got in testing. All eight clear the adjacent-pair gates.

The hues are stepped darker than a typical light-surface palette because rails are thin
2 px marks, and a thin mark needs more contrast than a filled block to read as the same
colour.

Activity heat is a separate, single-hue sequential ramp, scoped to the file chips inside a
WIP node so it can never be confused with a lane.
