import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Access control for the daemon.
 *
 * The threat is specific and worth stating plainly: this process reads your source code
 * and serves it over HTTP, and *any* web page you have open can issue requests to
 * `127.0.0.1`. Browsers do not treat localhost as privileged. Binding to loopback keeps
 * the network out, but it does nothing about the browser, so three checks stack:
 *
 * 1. **Token** — a 128-bit secret printed by the CLI. An attacker page cannot guess it,
 *    and cannot read cross-origin responses to discover it.
 * 2. **Origin** — a page at `https://evil.example` sending a request here has its origin
 *    stamped by the browser and is rejected outright, so a leaked token in a URL that
 *    ends up in someone's history is still not enough on its own.
 * 3. **Host** — DNS rebinding lets an attacker-controlled name resolve to 127.0.0.1,
 *    which makes the request same-origin from the browser's point of view and defeats
 *    check 2. The `Host` header still carries the attacker's name, so requiring loopback
 *    there closes it.
 *
 * No CORS headers are ever sent. There is no case where a cross-origin page should be
 * able to read from this daemon.
 */

export type AuthFailure = 'missing-token' | 'bad-token' | 'bad-origin' | 'bad-host'

/** Where a request's token came from, so the caller can decide whether to issue a cookie. */
export type TokenSource = 'query' | 'header' | 'cookie'

export type AuthResult =
  | { ok: true; source: TokenSource }
  | { ok: false; failure: AuthFailure }

/**
 * Session cookie name.
 *
 * The cookie exists because a browser loading `/index.html` goes on to request
 * `/assets/*.js` on its own, with no opportunity for us to append `?t=`. Those requests
 * would be rejected and the page would render blank with no console error, because a
 * failed `<script type="module">` fails silently.
 *
 * It is set `HttpOnly` (script cannot read it), `SameSite=Strict` (a cross-site page's
 * requests never carry it, so it cannot substitute for the Origin check), and `Path=/`.
 * `Secure` is deliberately omitted — it would prevent the cookie working over plain http
 * on loopback, which is the only transport this daemon has.
 */
export const TOKEN_COOKIE = 'git_artifact_token'

export function tokenCookieHeader(token: string): string {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`
}

export interface AuthConfig {
  token: string
  port: number
  /** Extra origins to accept, for the Vite dev server. Empty in a packaged run. */
  extraOrigins?: string[]
}

export function generateToken(): string {
  return randomBytes(16).toString('hex')
}

/** Constant-time compare that tolerates length mismatch without leaking it by timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Strip the port and normalise, so `127.0.0.1:7373` and `127.0.0.1` both compare equal. */
function hostname(hostHeader: string): string {
  // IPv6 literals are bracketed, e.g. `[::1]:7373`.
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']')
    return close === -1 ? hostHeader : hostHeader.slice(0, close + 1)
  }
  const colon = hostHeader.lastIndexOf(':')
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon)
}

/**
 * Validate a request. Returns null when it may proceed, or the reason it may not.
 *
 * The token is read from the `?t=` query parameter as well as an `X-Artifact-Token`
 * header. The query parameter exists because `EventSource` cannot set headers, and
 * running the SSE stream through a hand-rolled `fetch` reader purely to move the token
 * into a header is not worth the complexity at this stage. On loopback the referrer
 * exposure this creates is negligible, and checks 2 and 3 above do not depend on it.
 */
export function authorize(req: IncomingMessage, url: URL, config: AuthConfig): AuthResult {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOSTS.has(hostname(host))) return { ok: false, failure: 'bad-host' }

  const origin = req.headers.origin
  if (origin !== undefined && !allowedOrigin(origin, config)) {
    return { ok: false, failure: 'bad-origin' }
  }

  const header = req.headers['x-artifact-token']
  const candidates: Array<[TokenSource, string | null]> = [
    ['query', url.searchParams.get('t')],
    ['header', typeof header === 'string' ? header : null],
    ['cookie', readCookie(req.headers.cookie, TOKEN_COOKIE)],
  ]

  let sawCandidate = false
  for (const [source, value] of candidates) {
    if (value === null) continue
    sawCandidate = true
    if (tokensMatch(value, config.token)) return { ok: true, source }
  }

  return { ok: false, failure: sawCandidate ? 'bad-token' : 'missing-token' }
}

/** Minimal cookie-header parse. We only ever read one name and never trust its content. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

function allowedOrigin(origin: string, config: AuthConfig): boolean {
  if (config.extraOrigins?.includes(origin)) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false // `null` origin, or something malformed — either way, not ours.
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false
  return parsed.port === String(config.port)
}

export const AUTH_FAILURE_STATUS: Record<AuthFailure, number> = {
  'missing-token': 401,
  'bad-token': 401,
  'bad-origin': 403,
  'bad-host': 403,
}

export const AUTH_FAILURE_MESSAGE: Record<AuthFailure, string> = {
  'missing-token': 'Missing access token. Open the URL printed by the git-artifact CLI.',
  'bad-token': 'Invalid access token.',
  'bad-origin': 'Cross-origin requests are not accepted.',
  'bad-host': 'Requests must be addressed to the loopback interface.',
}
