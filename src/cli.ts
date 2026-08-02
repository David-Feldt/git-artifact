#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { ArtifactService } from './artifacts/service.js'
import { TEXT_COL, withBanner } from './banner.js'
import { NotARepoError, openRepo } from './git/repo.js'
import { generateToken } from './server/auth.js'
import { startDaemon } from './server/index.js'
import { GraphStore } from './server/store.js'
import { sessionRegistryRoot } from './sources/claude-code.js'
import { RepoWatcher } from './watch/watcher.js'

/** Replaced by esbuild at build time; see scripts/build-server.mjs. */
declare const __GIT_ARTIFACT_VERSION__: string | undefined
const VERSION = typeof __GIT_ARTIFACT_VERSION__ === 'string' ? __GIT_ARTIFACT_VERSION__ : 'dev'

const DEFAULT_PORT = 7373
const DEFAULT_MAX_COUNT = 5000

interface Args {
  repo: string
  port: number
  maxCount: number
  since?: string
  open: boolean
  help: boolean
  version: boolean
  harness: 'claude' | 'codex'
  model?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: process.cwd(),
    port: DEFAULT_PORT,
    maxCount: DEFAULT_MAX_COUNT,
    open: true,
    help: false,
    version: false,
    harness: 'claude',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      return value
    }

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true
        break
      case '-v':
      case '--version':
        args.version = true
        break
      case '--repo':
      case '-C':
        args.repo = next()
        break
      case '--port':
      case '-p':
        args.port = Number(next())
        break
      case '--max-count':
        args.maxCount = Number(next())
        break
      case '--since':
        args.since = next()
        break
      case '--no-open':
        args.open = false
        break
      case '--harness': {
        const value = next()
        if (value !== 'claude' && value !== 'codex') {
          throw new Error(`--harness must be claude or codex, not ${value}`)
        }
        args.harness = value
        break
      }
      case '--model':
        args.model = next()
        break
      default:
        // A bare path is a convenience for `git-artifact ~/some/repo`.
        if (!arg.startsWith('-')) args.repo = arg
        else throw new Error(`unknown option: ${arg}`)
    }
  }

  if (!Number.isFinite(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error(`invalid port: ${args.port}`)
  }
  if (!Number.isFinite(args.maxCount) || args.maxCount < 1) {
    throw new Error(`invalid --max-count: ${args.maxCount}`)
  }

  return args
}

const HELP = `
git-artifact — live commit-graph dashboard for a git repository

Usage
  git-artifact [path] [options]

Options
  -C, --repo <path>     Repository to watch (default: current directory)
  -p, --port <n>        Preferred port; the next free one is used if taken (default: ${DEFAULT_PORT})
      --max-count <n>   Maximum commits to load (default: ${DEFAULT_MAX_COUNT})
      --since <date>    Only load commits newer than this, e.g. 3.months
      --no-open         Do not open a browser
      --harness <name>  CLI used to write artifact pages: claude or codex (default: claude)
      --model <name>    Model passed to that CLI
  -h, --help            Show this message
  -v, --version         Show the version

git-artifact never writes to the repository. It reads the commit graph and the working
tree, and it sends no telemetry anywhere.

Explaining a commit runs your local Claude or Codex CLI, which sends that commit's diff to
the model — per click, never in the background. Pages are cached under
~/.cache/git-artifact/.
`.trim()

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`git-artifact: ${err instanceof Error ? err.message : String(err)}`)
    console.error('Try `git-artifact --help`.')
    process.exit(2)
  }

  if (args.help) {
    console.log(HELP)
    return
  }
  if (args.version) {
    console.log(VERSION)
    return
  }

  // Fail early and legibly, before spinning up a server pointed at nothing.
  let repoRoot: string
  try {
    repoRoot = (await openRepo(args.repo)).root
  } catch (err) {
    if (err instanceof NotARepoError) {
      console.error(`git-artifact: ${args.repo} is not a git repository.`)
      console.error('Run it from inside a repository, or pass one: git-artifact /path/to/repo')
      process.exit(1)
    }
    throw err
  }

  const store = new GraphStore(args.repo, { maxCount: args.maxCount, since: args.since })
  const token = generateToken()
  // In dev the client is served by Vite on another port, so its requests are genuinely
  // cross-origin and would otherwise be rejected. Never set this in a packaged run.
  const devOrigin = process.env.GIT_ARTIFACT_DEV_ORIGIN

  // Reading the graph is the slow part of startup, so the banner plays over it rather than
  // ahead of it. On a big repo the animation is free; on a small one it is the only wait.
  const daemon = await withBanner(
    (async () => {
      await store.init()
      return startDaemon({
        store,
        artifacts: new ArtifactService(store, { harness: args.harness, model: args.model }),
        token,
        port: args.port,
        extraOrigins: devOrigin ? [devOrigin] : undefined,
        serveClient: process.env.GIT_ARTIFACT_DEV_ORIGIN === undefined,
      })
    })(),
    { version: VERSION, repoRoot, animate: devOrigin === undefined },
  )

  const watcher = new RepoWatcher({
    repo: store.getRepo()!,
    sessionRegistryPath: sessionRegistryRoot(),
    onChange: (kinds) => {
      // A ref change can also move the working tree (checkout, rebase), so status is
      // refreshed either way; the graph is only re-read when refs actually moved.
      if (kinds.has('refs')) void store.refreshGraph()
      // Nothing in the registry can move a ref or dirty a file, so this deliberately does
      // not reach for either of the above — it re-reads which sessions are alive and stops.
      if (kinds.has('sessions')) void store.refreshLiveness()
      if (kinds.has('refs') || kinds.has('worktree')) void store.refreshStatus()
    },
    onError: (err) => {
      console.error(`git-artifact: watcher error: ${err instanceof Error ? err.message : err}`)
    },
  })
  watcher.start()

  const repo = store.getRepo()!
  // Lined up with the banner's text column, directly under the repository path.
  console.log(`${' '.repeat(TEXT_COL)}${daemon.url}\n`)
  for (const note of describeState(repo.state)) console.log(`  note: ${note}`)
  console.log('  read-only · no telemetry · ctrl-c to stop\n')

  if (args.open) openBrowser(daemon.url)

  const shutdown = async () => {
    await watcher.close()
    await daemon.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/** Conditions worth mentioning up front, so the UI is not the only place they surface. */
function describeState(state: import('./git/repo.js').RepoState): string[] {
  const notes: string[] = []
  if (state.empty) notes.push('repository has no commits yet')
  if (state.bare) notes.push('bare repository — no working tree to watch')
  if (state.shallow) notes.push('shallow clone — history is truncated')
  if (state.detachedHead) notes.push('HEAD is detached')
  if (state.rebaseInProgress) notes.push('rebase in progress')
  if (state.mergeInProgress) notes.push('merge in progress')
  if (state.cherryPickInProgress) notes.push('cherry-pick in progress')
  return notes
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.on('error', () => {
      /* No browser is a fine outcome; the URL is printed above. */
    })
    child.unref()
  } catch {
    /* Same. */
  }
}

main().catch((err) => {
  console.error(`git-artifact: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
