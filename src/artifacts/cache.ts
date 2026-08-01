import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

/**
 * Which commits have a page on disk, as the 12-character sha prefixes the keys start with.
 *
 * One `readdir`, deliberately. The exact question — "is the page for this commit still
 * current" — needs the brief, and a brief costs a `git show` per commit; asking it for every
 * row on every graph refresh would put the whole history's diffs in the update path to
 * decide the colour of an icon.
 *
 * So this answers the weaker question: has a page ever been written for this commit. A brief
 * that has since changed leaves the old page on disk and this still reports the commit as
 * generated, which is the right way round — the mark means "there is something here to
 * read", and following it regenerates against the current brief anyway.
 */
export async function listCachedShaPrefixes(repoRoot: string): Promise<Set<string>> {
  const prefixes = new Set<string>()
  try {
    for (const name of await readdir(path.join(ROOT, repoSlug(repoRoot)))) {
      if (!name.endsWith('.html')) continue
      // `<sha12>-<briefDigest>.html`; everything before the first hyphen is the sha.
      const prefix = name.slice(0, name.indexOf('-'))
      if (prefix.length > 0) prefixes.add(prefix)
    }
  } catch {
    // No cache directory yet. Nothing has been generated, which is not a failure.
  }
  return prefixes
}
