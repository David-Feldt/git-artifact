# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev              # daemon + Vite, watching the current repo
npm run dev -- /path     # watch a different repo (useful for fixture repos)
npm test                 # vitest run
npm run typecheck        # tsc --noEmit
npm run build            # build:server (esbuild bundle) + build:client (vite)
```

Single test file or single case:

```sh
npx vitest run test/lanes.test.ts
npx vitest run -t "octopus"
npx vitest            # watch mode
```

There is no linter. `npm run typecheck` is the static gate.

Note the two Vite configs are deliberately separate: `vite.config.ts` sets `root: 'src/client'` for the browser bundle, and `vitest.config.ts` resets `root: '.'` so tests outside the client directory are visible. Fixture tests shell out to git and clone repos, hence the 30s timeouts there.

## Dev topology

`scripts/dev.mjs` runs two halves on different ports:

- **esbuild watch** bundles `src/cli.ts` → `dist/cli.js` and restarts the daemon on every successful rebuild (port 7373 by default, `GIT_ARTIFACT_DEV_PORT` to change).
- **Vite** serves the client on 5273 with hot reload and proxies `/api` to the daemon.

Because those are genuinely different origins, `dev.mjs` sets `GIT_ARTIFACT_DEV_ORIGIN` on the daemon. That env var does two things: adds the Vite origin to the allowed set, and turns *off* static file serving (Vite owns the client in dev). It must never be set in a packaged run — see `src/cli.ts:145-152`.

The daemon prints its own URL with the access token. In dev, open the **Vite** port with that token appended: `http://localhost:5273/?t=<token>`.

## Architecture

### The read path, end to end

```
chokidar → RepoWatcher → GraphStore → SSE → React client
           (trigger)     (asks git)   (push)
```

**Filesystem events are a trigger, not a source of truth.** `src/watch/watcher.ts` never parses a ref file; it debounces and tells the store *that* something changed, and the store asks git *what* changed. A missed event costs a delayed update, a spurious one costs a redundant read — neither can produce a wrong graph. This is what makes it safe to watch aggressively, and it should stay that way.

Two change classes are tracked separately with different debounce windows (`refs` at 60 ms, `worktree` at 200 ms), so editing a file re-reads `git status` only and never the whole commit graph.

`GraphStore` (`src/server/store.ts`) owns the current view. Refreshes are serialised per kind with a queued follow-up, so a burst during a rebase can't let a slow refresh overtake a newer one and publish stale data.

### Module boundaries that matter

- **`src/api.ts`** is the wire contract shared by daemon and browser. Keep it free of imports from either side, or server-only code gets dragged into the client bundle.
- **`src/graph/lanes.ts`** is the correctness core: pure, no git, no I/O, no clock. Tested directly and against `git log --graph`.
- **`src/git/exec.ts`** is the only place that spawns git. `execFile`, never a shell; env pinned with `GIT_OPTIONAL_LOCKS=0` so read commands never take `index.lock` and can't contend with the user's terminal.
- **`src/sources/claude-code.ts`** is the only place that knows the Claude Code transcript format. It is an internal format, not a stable contract, so a format change must remain a one-file fix.
- **`src/sessions/attribute.ts`** is pure timing logic, separate from transcript parsing, so it can be tested without building whole transcripts.

### Tier A / Tier B

A convention used throughout the comments:

- **Tier A** — the git-derived core: the graph, worktrees, working-tree status, liveness. This must always render.
- **Tier B** — enrichment: session bands, push markers. Every failure mode is silent by design (`store.ts:259` returns `[]` on anything unexpected, `readPushes` swallows). Tier B must never be able to take down Tier A, and never surfaces a problem banner.

When adding a feature, decide which tier it is first. Anything that reads an external tool's private data is Tier B.

### Client geometry

The rails are an SVG and the commit cards are HTML, both positioned from the same arithmetic in `src/client/components/layout.ts`. Its constants must match the CSS custom properties in `theme.css`, and the expanded detail panel is a fixed height on purpose — a content-sized panel could only be measured after layout, so the SVG would draw a frame late and every rail below it would visibly snap.

## Invariants

These are stated in the README as hard constraints and are load-bearing for what the project claims to be. Changing any of them is a product decision, not a refactor:

1. **Never writes to the repository.** No checkout, no worktree creation, no commit, no ref moves.
2. **No mutating HTTP endpoints.** `src/server/index.ts:79-84` refuses anything other than GET/HEAD outright.
3. **No outbound network requests of any kind.** No telemetry, no version check. The daemon binds loopback and talks only to the browser.
4. **Writes nothing but its own build output** — not `~/.claude/settings.json`, not hooks, not any other tool's config.

Auth stacks three checks because a localhost bind is not privileged in a browser: a 128-bit token, an Origin check with no CORS headers ever sent, and a Host check to defeat DNS rebinding. The token moves into an `HttpOnly; SameSite=Strict` cookie after first load so asset requests carry credentials. Reasoning is in `src/server/auth.ts`.

## Lane assignment differs from `git log --graph` on purpose

git slides every lane left when one closes. This graph re-renders live, so sliding would make unrelated branches jump sideways whenever some other branch merged. **Lanes keep their column for life**; freed columns are reused leftmost-first.

Consequence for tests: commit *order* is asserted exactly everywhere and lane *indices* exactly on fixtures, but on real history indices are allowed to differ from git's — what is asserted is that the graph is never wider than git's.

## Testing approach

`git log --graph` ships everywhere, which makes it a free reference implementation. `test/fixtures/make.ts` builds throwaway repos with author, committer and both timestamps pinned so shas are stable across machines — without that, the oracle comparison drifts whenever two commits land in the same second and git breaks the tie differently.

Fixture builders cover the shapes that break naive implementations: octopus merges, two roots, detached HEAD, mid-rebase, mid-merge, empty, bare, shallow, linked worktrees. `test/degradation.test.ts` asserts each degrades rather than throwing. Add a builder there rather than hand-rolling a repo in a test.

## Dependencies

The published package has **no runtime dependencies at all**. `chokidar` and `ignore` are the only non-dev libraries in the source, and esbuild inlines both into `dist/cli.js`, so they are declared in `devDependencies` — putting them in `dependencies` would make every `npx git-artifact` download packages the bundle never loads. The HTTP server is hand-written with `node:http`. React and Vite are dev-only — the client is bundled.

`test/packaging.test.ts` asserts the packed tarball declares no `dependencies`. Adding a real runtime dependency is a deliberate choice to weigh, not a default, and it means changing that test on purpose.
