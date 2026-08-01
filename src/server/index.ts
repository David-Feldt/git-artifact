import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerEvent } from '../api.js'
import {
  authorize,
  tokenCookieHeader,
  AUTH_FAILURE_MESSAGE,
  AUTH_FAILURE_STATUS,
  type AuthConfig,
} from './auth.js'
import { isValidSha, UnknownCommitError } from '../git/show.js'
import type { ArtifactService } from '../artifacts/service.js'
import { renderShell } from '../artifacts/shell.js'
import type { GraphStore } from './store.js'

/** Loopback only. There is no configuration to change this, deliberately. */
export const BIND_ADDRESS = '127.0.0.1'

const CLIENT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'client')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export interface DaemonOptions {
  store: GraphStore
  token: string
  /** Preferred port. Taken ports are skipped, see {@link listenWithFallback}. */
  port: number
  /** How many ports to try after the preferred one before giving up. */
  portAttempts?: number
  /** Extra allowed origins, for the Vite dev server. Empty in a packaged run. */
  extraOrigins?: string[]
  /** Serve the built client from disk. Off in dev, where Vite serves it instead. */
  serveClient?: boolean
  /** Absent when no harness is configured; the artifact routes then report as much. */
  artifacts?: ArtifactService
}

export interface Daemon {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { store, token, serveClient = true } = options
  const clients = new Set<ServerResponse>()

  const broadcast = (event: ServerEvent) => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const res of clients) res.write(frame)
  }
  store.on('event', broadcast)

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  const port = await listenWithFallback(server, options.port, options.portAttempts ?? 20)
  const authConfig: AuthConfig = { token, port, extraOrigins: options.extraOrigins }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${BIND_ADDRESS}:${port}`)

    /*
     * One endpoint accepts a write, and only one.
     *
     * Generating an artifact spends tokens and produces a file, so it cannot honestly be a
     * GET — and a browser cannot shell out to a CLI, so it has to be the daemon that does.
     * The rule that was actually load-bearing is unchanged and still absolute: nothing here
     * can modify the repository.
     */
    const isGenerate = req.method === 'POST' && url.pathname === '/api/artifact'
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isGenerate) {
      sendJson(res, 405, { error: 'This daemon does not modify anything but its own cache.' })
      return
    }

    const auth = authorize(req, url, authConfig)
    if (!auth.ok) {
      sendJson(res, AUTH_FAILURE_STATUS[auth.failure], {
        error: AUTH_FAILURE_MESSAGE[auth.failure],
      })
      return
    }

    // The browser will request the bundle and stylesheet by itself, with no chance for us
    // to attach `?t=`. Hand it a session cookie the moment it presents the token in a URL
    // so those follow-up requests carry credentials of their own.
    //
    // Set here rather than on the success path of any one route: the cookie is about
    // authorisation, not about what was found. Issuing it only alongside a served file
    // meant a daemon started before `npm run build` handed out no session at all.
    if (auth.source === 'query') res.setHeader('set-cookie', tokenCookieHeader(token))

    switch (url.pathname) {
      case '/api/graph':
        sendJson(res, 200, store.getGraph() ?? { error: 'not ready' })
        return
      case '/api/status':
        sendJson(res, 200, store.getStatus() ?? { error: 'not ready' })
        return
      case '/api/commit':
        await sendCommitDetail(url, res)
        return
      case '/api/session':
        await sendSessionDetail(url, res)
        return
      case '/api/events':
        openEventStream(req, res)
        return
      case '/api/artifact':
        await handleArtifactApi(req, url, res)
        return
      case '/artifact':
        await serveArtifactPage(url, res)
        return
      default:
        if (serveClient) await serveStatic(url.pathname, res)
        else sendJson(res, 404, { error: 'not found' })
    }
  }

  /**
   * One commit's metadata and patch, for an expanded row.
   *
   * The sha is validated before it reaches git. `execFile` already makes shell injection
   * impossible, but an unvalidated string is still a *revision*, and things like
   * `HEAD@{now}` or a path would be honoured — so the shape is checked here and the
   * revision is pinned to `^{commit}` in the reader.
   */
  async function sendCommitDetail(url: URL, res: ServerResponse): Promise<void> {
    const sha = url.searchParams.get('sha') ?? ''
    if (!isValidSha(sha)) {
      sendJson(res, 400, { error: 'A commit sha is required.' })
      return
    }

    try {
      sendJson(res, 200, await store.getCommitDetail(sha))
    } catch (err) {
      if (err instanceof UnknownCommitError) {
        sendJson(res, 404, { error: 'No such commit in this repository.' })
        return
      }
      throw err
    }
  }

  /**
   * One session's prompts and timings, for an opened card.
   *
   * The id never reaches the filesystem — it is matched against the ids parsed out of the
   * transcripts already in hand, so there is no path to traverse and no revision to
   * resolve. The shape check is therefore cheap defence rather than the thing keeping this
   * safe: it rejects the obviously-not-an-id before a directory scan is spent on it.
   */
  async function sendSessionDetail(url: URL, res: ServerResponse): Promise<void> {
    const id = url.searchParams.get('id') ?? ''
    if (!isValidSessionId(id)) {
      sendJson(res, 400, { error: 'A session id is required.' })
      return
    }

    const detail = await store.getSessionDetail(id)
    if (detail === null) {
      sendJson(res, 404, { error: 'No transcript for that session in this repository.' })
      return
    }
    sendJson(res, 200, detail)
  }

  /**
   * Artifact status (`GET`) and generation (`POST`).
   *
   * Both are the same route because they address the same thing; the method is the whole
   * difference between asking and spending.
   */
  async function handleArtifactApi(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    const artifacts = options.artifacts
    if (!artifacts) {
      sendJson(res, 501, { state: 'error', message: 'Artifact generation is not configured.' })
      return
    }

    const sha = url.searchParams.get('sha') ?? ''
    if (!isValidSha(sha)) {
      sendJson(res, 400, { state: 'error', message: 'A commit sha is required.' })
      return
    }

    const status =
      req.method === 'POST' ? await artifacts.generate(sha) : await artifacts.status(sha)
    sendJson(res, 200, status)
  }

  /**
   * The popup itself.
   *
   * Serves the generated page when there is one, and otherwise a shell that starts the
   * work and polls. Doing it this way is what keeps the click handler in the app to a bare
   * `window.open` — a popup opened after an `await` has lost its user gesture and is
   * blocked.
   */
  async function serveArtifactPage(url: URL, res: ServerResponse): Promise<void> {
    const artifacts = options.artifacts
    const sha = url.searchParams.get('sha') ?? ''
    if (!isValidSha(sha)) {
      sendHtml(res, 400, renderShell(sha || 'unknown', 'That is not a commit sha'), SHELL_CSP)
      return
    }
    if (!artifacts) {
      sendHtml(res, 501, renderShell(sha, 'Artifact generation is not configured'), SHELL_CSP)
      return
    }

    const page = await artifacts.page(sha)
    if (page !== null) {
      sendHtml(res, 200, page)
      return
    }

    const subject = store.getGraph()?.rows.find((row) => row.commit.sha === sha)?.commit.subject
    sendHtml(res, 200, renderShell(sha, subject ?? ''), SHELL_CSP)
  }

  function openEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'x-accel-buffering': 'no',
    })
    // Tell the browser to retry quickly; the client also backs off on its own.
    res.write('retry: 1000\n\n')

    const graph = store.getGraph()
    if (graph) res.write(`event: graph\ndata: ${JSON.stringify(graph)}\n\n`)
    const status = store.getStatus()
    if (status) res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`)

    clients.add(res)

    // A comment frame every 25s keeps intermediaries from reaping an idle connection and
    // lets the client notice a dead daemon promptly.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)

    const cleanup = () => {
      clearInterval(keepAlive)
      clients.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  return {
    server,
    port,
    url: `http://${BIND_ADDRESS}:${port}/?t=${token}`,
    close: () =>
      new Promise((resolve) => {
        store.off('event', broadcast)
        for (const res of clients) res.end()
        clients.clear()
        server.close(() => resolve())
      }),
  }
}

/**
 * A session id, as Claude Code writes them.
 *
 * Uuids in every transcript observed, but the check is deliberately looser than a uuid
 * pattern: the id is carried through from the transcript, and rejecting a future format on
 * a guess about its shape would break the panel for no gain. Length and character class are
 * enough to bound the work.
 */
function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._-]+$/.test(id)
}

/**
 * A generated page, or the shell standing in for one.
 *
 * `no-store` for the same reason every other response here carries it: this is repository
 * content, and neither a browser nor anything between should hold on to it. It also keeps
 * the shell's `location.reload()` from being answered out of cache with the shell again.
 */
function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  csp: string = ARTIFACT_CSP,
): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': csp,
  })
  res.end(html)
}

/**
 * What a generated page is allowed to do: render itself, and nothing else.
 *
 * This is the defence that holds. A generated page is served from this daemon's own origin —
 * the origin that carries the session cookie — so a script inside one would run with the API
 * reachable to it. And the page is written from a commit diff, which is content someone else
 * can author: reviewing a branch from an untrusted fork puts their text into the prompt.
 *
 * The fragment is also stripped of scripts before it is stored, but a regex is not a parser.
 * This says no at the browser instead of trusting that pass to have been complete.
 */
const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"

/** The shell polls, so it needs its own inline script — and still nothing from anywhere. */
const SHELL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'"


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Never let a browser or proxy hold on to repo data.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * Serve the built client.
 *
 * Unknown paths fall back to `index.html` so the app keeps working on reload, and every
 * resolved path is checked to be inside the client directory — `path.join` alone happily
 * walks out of it given `../`, and this process has read access to the user's whole disk.
 */
async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  let filePath = path.resolve(CLIENT_DIR, relative)

  if (!filePath.startsWith(CLIENT_DIR + path.sep) && filePath !== CLIENT_DIR) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }

  let info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) {
    filePath = path.join(CLIENT_DIR, 'index.html')
    info = await stat(filePath).catch(() => null)
  }
  if (!info?.isFile()) {
    sendJson(res, 404, {
      error: 'Client bundle not found. Run `npm run build` before starting the daemon.',
    })
    return
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(filePath).pipe(res)
}

/**
 * Bind the first free port at or after `preferred`.
 *
 * Local tools that assume their default port is available fail confusingly the moment you
 * run two of them, or leave one behind after a crash.
 */
export function listenWithFallback(
  server: Server,
  preferred: number,
  attempts: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferred
    let remaining = attempts

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' || remaining <= 0) {
        server.off('error', onError)
        reject(err)
        return
      }
      remaining -= 1
      port += 1
      server.listen(port, BIND_ADDRESS)
    }

    server.on('error', onError)
    server.listen(port, BIND_ADDRESS, () => {
      server.off('error', onError)
      // Report what was actually bound, not what was asked for. Port 0 means "let the OS
      // choose", so the requested number is not the answer — and the port ends up in the
      // URL we print and in the Origin check, both of which would then be wrong.
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}
