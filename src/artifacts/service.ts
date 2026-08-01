import type { GraphPayload, PushMarker, SessionBandInfo } from '../api.js'
import type { GraphStore } from '../server/store.js'
import { buildBrief, DEFAULT_BUDGET, type Brief, type Budget } from './bundle.js'
import { artifactKey, cachePath, readCached, writeCached } from './cache.js'
import { renderArtifactPage } from './chassis.js'
import { generateAnalysis, HarnessError, type HarnessName } from './harness.js'

/**
 * Turning a sha into a page.
 *
 * Everything expensive or fallible lives behind this: assembling the brief, spending
 * tokens, and writing the result. The server routes above it stay thin.
 */

export type ArtifactStatus =
  | { state: 'absent' }
  | { state: 'running' }
  | { state: 'ready'; key: string; path: string }
  | { state: 'error'; message: string; detail?: string }

export interface ArtifactServiceOptions {
  harness?: HarnessName
  model?: string
  budget?: Budget
}

export class ArtifactService {
  /** In-flight generations, keyed by sha, so a double click costs one run. */
  private readonly inFlight = new Map<string, Promise<ArtifactStatus>>()
  /** Last failure per sha, so a popup polling for status learns why rather than hanging. */
  private readonly failures = new Map<string, { message: string; detail?: string }>()

  constructor(
    private readonly store: GraphStore,
    private readonly options: ArtifactServiceOptions = {},
  ) {}

  /** Cheap: reads the cache, never generates. */
  async status(sha: string): Promise<ArtifactStatus> {
    if (this.inFlight.has(sha)) return { state: 'running' }

    const failure = this.failures.get(sha)
    if (failure) return { state: 'error', ...failure }

    const repoRoot = this.repoRoot()
    if (repoRoot === null) return { state: 'absent' }

    const brief = await this.brief(sha).catch(() => null)
    if (brief === null) return { state: 'absent' }

    const key = artifactKey(sha, brief.text)
    const cached = await readCached(repoRoot, key)
    return cached === null
      ? { state: 'absent' }
      : { state: 'ready', key, path: cachePath(repoRoot, key) }
  }

  async page(sha: string): Promise<string | null> {
    const repoRoot = this.repoRoot()
    if (repoRoot === null) return null
    const brief = await this.brief(sha).catch(() => null)
    if (brief === null) return null
    return readCached(repoRoot, artifactKey(sha, brief.text))
  }

  /**
   * Generate, or join the run already under way.
   *
   * Deduplicating on the sha matters more than it looks: the popup is opened by a click and
   * asks for generation itself, so a second click on the same commit — or a reload of the
   * popup — would otherwise start a second paid run for the same page.
   */
  generate(sha: string): Promise<ArtifactStatus> {
    const existing = this.inFlight.get(sha)
    if (existing) return existing

    const run = this.run(sha).finally(() => this.inFlight.delete(sha))
    this.inFlight.set(sha, run)
    return run
  }

  private async run(sha: string): Promise<ArtifactStatus> {
    this.failures.delete(sha)

    const repoRoot = this.repoRoot()
    if (repoRoot === null) {
      return this.fail(sha, 'The repository is not ready yet.')
    }

    let brief: Brief
    try {
      brief = await this.brief(sha)
    } catch (err) {
      return this.fail(sha, 'That commit could not be read.', String(err))
    }

    const key = artifactKey(sha, brief.text)

    const cached = await readCached(repoRoot, key)
    if (cached !== null) return { state: 'ready', key, path: cachePath(repoRoot, key) }

    let analysis: string
    try {
      analysis = await generateAnalysis(brief.text, {
        harness: this.options.harness,
        model: this.options.model,
      })
    } catch (err) {
      if (err instanceof HarnessError) return this.fail(sha, err.message, err.detail)
      return this.fail(sha, 'Generation failed.', String(err))
    }

    // The model wrote the analysis; everything it sits in is rendered here, from data this
    // project already holds exactly.
    const html = renderArtifactPage({
      repoName: this.store.getGraph()?.repo.name ?? 'repository',
      detail: await this.store.getCommitDetail(sha),
      analysis,
      generatedAt: Date.now(),
    })

    const path = await writeCached(repoRoot, key, html)
    return { state: 'ready', key, path }
  }

  private fail(sha: string, message: string, detail?: string): ArtifactStatus {
    this.failures.set(sha, { message, detail })
    return { state: 'error', message, detail }
  }

  /** Assemble the brief for a sha, pulling its session and push context out of the graph. */
  private async brief(sha: string): Promise<Brief> {
    const detail = await this.store.getCommitDetail(sha)
    const graph = this.store.getGraph()

    return buildBrief(
      {
        // The payload's name, never `repo.root`: a brief that carried a home-directory path
        // would put it straight into a page meant to be shared.
        repoName: graph?.repo.name ?? 'repository',
        detail,
        session: graph ? sessionFor(graph, sha) : null,
        pushes: graph ? (graph.pushes[sha] as PushMarker[] | undefined) ?? [] : [],
        refs: graph ? refsFor(graph, sha) : [],
        now: Date.now(),
      },
      this.options.budget ?? DEFAULT_BUDGET,
    )
  }

  private repoRoot(): string | null {
    return this.store.getRepo()?.root ?? null
  }
}

/** The band whose row range covers this commit, if any. */
export function sessionFor(graph: GraphPayload, sha: string): SessionBandInfo | null {
  const index = graph.rows.findIndex((row) => row.commit.sha === sha)
  if (index === -1) return null
  return (
    graph.sessions.find((band) => index >= band.startRow && index <= band.endRow) ?? null
  )
}

export function refsFor(graph: GraphPayload, sha: string): string[] {
  const row = graph.rows.find((r) => r.commit.sha === sha)
  return row ? row.commit.refs.map((ref) => ref.name) : []
}
