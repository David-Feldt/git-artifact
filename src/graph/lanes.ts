import type { Commit, GraphEdge, GraphRow } from './model.js'

/**
 * Assign lanes (columns) to commits and produce the edges needed to draw the rails.
 *
 * Pure: no git, no I/O, no clock. This is the correctness core of the renderer and is
 * tested directly against synthetic DAGs as well as against `git log --graph`.
 *
 * The algorithm is the standard "active lanes" walk. We keep an array where each slot
 * holds the sha that lane is *waiting for* — the next commit expected to appear there.
 * Commits arrive in topological order (children before parents, which is what
 * `git log --topo-order` gives us), so by the time a commit is emitted, every lane that
 * wants it is already waiting.
 *
 * Two behaviours are worth calling out because they are where naive implementations go
 * wrong:
 *
 * - **Convergence.** Several lanes can wait for the same sha, when multiple branches
 *   descend from one commit. The commit is drawn once, in the leftmost waiting lane; the
 *   others terminate by curving into it. That curve is emitted on the *previous* row,
 *   which is why edges are resolved in a second pass with one row of lookahead.
 *
 * - **Truncation.** A parent may not be in the loaded set, because history was capped or
 *   the clone is shallow. Those lanes are freed rather than left waiting forever, and the
 *   child is flagged so the renderer can fray the edge instead of drawing it into space.
 *
 * Lane indices are stable: a lane that is merely passing through a row keeps its column,
 * so the graph does not shimmer sideways as you scroll. Freed slots are reused
 * leftmost-first, which keeps the graph narrow without reshuffling live lanes.
 */
export interface LaneOptions {
  /**
   * Commits sitting on a shallow clone's graft boundary. git reports these with no
   * parents at all, so without this they would be drawn as roots — claiming history
   * starts here when it merely stops here.
   */
  grafted?: ReadonlySet<string>
}

export function assignLanes(commits: Commit[], options: LaneOptions = {}): GraphRow[] {
  const known = new Set(commits.map((c) => c.sha))
  const grafted = options.grafted ?? new Set<string>()

  /** `active[i]` is the sha lane `i` is waiting for, or null when the lane is free. */
  const active: (string | null)[] = []

  // Pass 1 — place each commit and record the lane state it leaves behind.
  interface Placement {
    lane: number
    /** Lanes this commit's own edges depart from, with their kind. */
    outgoing: { lane: number; parentSha: string; kind: 'first' | 'merge' }[]
    /** Lane state after this row, used by pass 2 to route edges into the next row. */
    stateAfter: (string | null)[]
    /** Lanes occupied by this row, for width. */
    occupied: Set<number>
    /** Lanes alive on entry that did not converge into this commit. */
    incoming: number[]
    truncated: boolean
  }
  const placements: Placement[] = []

  for (const commit of commits) {
    const aliveBefore = new Set<number>()
    for (let i = 0; i < active.length; i++) if (active[i] !== null) aliveBefore.add(i)

    // Every lane waiting for this commit converges here; the leftmost one wins.
    const waiting: number[] = []
    for (let i = 0; i < active.length; i++) if (active[i] === commit.sha) waiting.push(i)

    const lane = waiting.length > 0 ? waiting[0]! : allocateLane(active)
    for (const i of waiting) active[i] = null
    active[lane] = null

    const outgoing: Placement['outgoing'] = []
    let truncated = grafted.has(commit.sha)

    for (let pi = 0; pi < commit.parents.length; pi++) {
      const parentSha = commit.parents[pi]!

      // A parent outside the loaded set ends the line here. Free the lane rather than
      // leaving it waiting for a sha that will never arrive.
      if (!known.has(parentSha)) {
        truncated = true
        continue
      }

      if (pi === 0) {
        // The first parent continues in this commit's own lane, which keeps mainline
        // history in a straight column.
        active[lane] = parentSha
        outgoing.push({ lane, parentSha, kind: 'first' })
        continue
      }

      // Later parents of a merge join an existing lane if one is already headed there,
      // otherwise they open a new one.
      const existing = active.indexOf(parentSha)
      const target = existing >= 0 ? existing : allocateLane(active)
      active[target] = parentSha
      outgoing.push({ lane: target, parentSha, kind: 'merge' })
    }

    const occupied = new Set<number>([lane])
    // Lanes that were alive coming in and did not converge into this commit still occupy
    // a column on this row.
    const incoming: number[] = []
    for (const i of aliveBefore) {
      if (waiting.includes(i)) continue
      occupied.add(i)
      incoming.push(i)
    }
    for (let i = 0; i < active.length; i++) if (active[i] !== null) occupied.add(i)

    placements.push({
      lane,
      outgoing,
      stateAfter: active.slice(),
      occupied,
      incoming,
      truncated,
    })
  }

  // Pass 2 — resolve edges, now that we know which lane each following commit landed in.
  const rows: GraphRow[] = []

  for (let idx = 0; idx < commits.length; idx++) {
    const commit = commits[idx]!
    const place = placements[idx]!
    const next = placements[idx + 1]
    const nextSha = commits[idx + 1]?.sha

    const kindByLane = new Map<number, 'first' | 'merge'>()
    const parentByLane = new Map<number, string>()
    for (const out of place.outgoing) {
      kindByLane.set(out.lane, out.kind)
      parentByLane.set(out.lane, out.parentSha)
    }

    const edges: GraphEdge[] = []
    for (let i = 0; i < place.stateAfter.length; i++) {
      const waitingFor = place.stateAfter[i]
      if (waitingFor == null) continue

      // If the very next row is the commit this lane wants, the edge lands in that
      // commit's lane — which is how converging branches visibly rejoin.
      const toLane = next && waitingFor === nextSha ? next.lane : i

      edges.push({
        fromLane: i,
        toLane,
        parentSha: waitingFor,
        kind: kindByLane.get(i) ?? 'pass',
      })
      // Guard against a lane whose recorded parent disagrees with the state, which would
      // mean pass 1 lost track of an edge.
      const declared = parentByLane.get(i)
      if (declared !== undefined && declared !== waitingFor) {
        throw new Error(
          `lane ${i} at ${commit.sha}: edge targets ${declared} but lane waits for ${waitingFor}`,
        )
      }
    }

    let width = 0
    for (const i of place.occupied) width = Math.max(width, i + 1)

    rows.push({
      commit,
      lane: place.lane,
      edges,
      incoming: place.incoming,
      width,
      truncated: place.truncated,
    })
  }

  return rows
}

/** Claim the leftmost free slot, growing the array only when every slot is taken. */
function allocateLane(active: (string | null)[]): number {
  for (let i = 0; i < active.length; i++) {
    if (active[i] === null) return i
  }
  active.push(null)
  return active.length - 1
}

/** Widest row in the graph, i.e. how many columns the renderer must reserve. */
export function graphWidth(rows: GraphRow[]): number {
  let width = 0
  for (const row of rows) width = Math.max(width, row.width)
  return width
}
