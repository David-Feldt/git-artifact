import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Generated pages on disk.
 *
 * Outside the repository, always. This project's guarantee is that it cannot touch your
 * repository, and writing generated pages into it — even into an ignored directory — would
 * be the first thing to break that.
 *
 * Caching is not an optimisation here. Generation costs real tokens, so a page is made once
 * and reused.
 */

const ROOT = path.join(os.homedir(), '.cache', 'git-artifact')

/**
 * Cache key.
 *
 * The sha alone would be wrong. A commit is immutable, but its *brief* is not: session
 * attribution can change when a transcript is written later, and a push marker appears the
 * moment the work leaves the machine. Keying on the brief means a changed input produces a
 * new page instead of serving a stale one that no longer matches what the graph shows.
 */
export function artifactKey(sha: string, brief: string): string {
  const digest = createHash('sha256').update(brief).digest('hex').slice(0, 12)
  return `${sha.slice(0, 12)}-${digest}`
}

function repoSlug(repoRoot: string): string {
  const name = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo'
  // The basename alone collides across checkouts of the same project, which is exactly the
  // situation this tool encourages with worktrees.
  const digest = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  return `${name}-${digest}`
}

function fileFor(repoRoot: string, key: string): string {
  return path.join(ROOT, repoSlug(repoRoot), `${key}.html`)
}

export async function readCached(repoRoot: string, key: string): Promise<string | null> {
  try {
    return await readFile(fileFor(repoRoot, key), 'utf8')
  } catch {
    return null
  }
}

export async function writeCached(repoRoot: string, key: string, html: string): Promise<string> {
  const target = fileFor(repoRoot, key)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, html, 'utf8')
  return target
}

/** Where a page for this key would live, whether or not it exists. For reporting. */
export function cachePath(repoRoot: string, key: string): string {
  return fileFor(repoRoot, key)
}
