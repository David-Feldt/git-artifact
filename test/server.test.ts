import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateToken } from '../src/server/auth.js'
import { startDaemon, listenWithFallback, type Daemon } from '../src/server/index.js'
import { GraphStore } from '../src/server/store.js'
import { builders, cleanupAll } from './fixtures/make.js'
import { createServer } from 'node:http'

describe('daemon', () => {
  let daemon: Daemon
  let token: string
  let base: string

  beforeAll(async () => {
    const store = new GraphStore(builders.branchMerge!(), { maxCount: 5000 })
    await store.init()
    token = generateToken()
    // Port 0 lets the OS pick a free one, so the suite cannot collide with a running dev
    // daemon or with itself under parallel runs.
    daemon = await startDaemon({ store, token, port: 0 })
    base = `http://127.0.0.1:${daemon.port}`
  })

  afterAll(async () => {
    await daemon.close()
    cleanupAll()
  })

  const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)

  it('serves the graph to an authorised request', async () => {
    const res = await get(`/api/graph?t=${token}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.rows).toHaveLength(4)
    expect(body.repo.remotes).toEqual([])
  })

  it('serves the working-tree status', async () => {
    const res = await get(`/api/status?t=${token}`)
    expect(res.status).toBe(200)
    expect((await res.json()).worktrees).toHaveLength(1)
  })

  it('serves one commit with its patch', async () => {
    const head = (await (await get(`/api/graph?t=${token}`)).json()).rows[0].commit.sha
    const res = await get(`/api/commit?sha=${head}&t=${token}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.sha).toBe(head)
    expect(body.subject).toBe('merge feature')
    expect(body.files.length).toBeGreaterThan(0)
    // Volatile by nature, so it is deliberately absent and the response stays cacheable
    // by sha for the lifetime of the daemon.
    expect(body.refs).toBeUndefined()
  })

  it('refuses a sha-shaped argument that is really a revision expression', async () => {
    // `execFile` stops shell injection, but git would still happily resolve any of these,
    // and `?sha=HEAD` quietly returning a different commit each time is its own bug.
    for (const sha of ['HEAD', 'main', 'HEAD@{0}', '', '--output=/tmp/x']) {
      const res = await get(`/api/commit?sha=${encodeURIComponent(sha)}&t=${token}`)
      expect(res.status).toBe(400)
    }
  })

  it('reports an unknown commit as missing rather than failing', async () => {
    const res = await get(`/api/commit?sha=${'dead'.repeat(10)}&t=${token}`)
    expect(res.status).toBe(404)
  })

  it('requires authorisation for a commit patch too', async () => {
    // The patch endpoint returns source code, so it is the last place to forget this.
    expect((await get(`/api/commit?sha=${'0'.repeat(40)}`)).status).toBe(401)
  })

  it('never caches repository data', async () => {
    const res = await get(`/api/graph?t=${token}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('sends no CORS headers, ever', async () => {
    // There is no circumstance in which a cross-origin page should read from this daemon.
    const res = await get(`/api/graph?t=${token}`)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('issues a session cookie when the token arrives in the URL', async () => {
    // Without this the browser's own request for /assets/*.js is rejected, and a failed
    // module script fails silently — a blank page with nothing in the console.
    const res = await get(`/?t=${token}`)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('refuses every method that is not a read', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await get(`/api/graph?t=${token}`, { method })
      expect(res.status).toBe(405)
    }
  })

  it('rejects unauthorised and cross-origin requests', async () => {
    expect((await get('/api/graph')).status).toBe(401)
    expect((await get('/api/graph?t=wrong')).status).toBe(401)
    expect(
      (await get(`/api/graph?t=${token}`, { headers: { Origin: 'https://evil.example' } })).status,
    ).toBe(403)
  })

  it('does not serve files from outside the client directory', async () => {
    // This process can read the user's entire disk, so containment is checked on the
    // resolved path. Percent-encoded traversal survives URL normalisation and is the
    // case that actually needs catching.
    for (const path of [
      '/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const res = await get(`${path}?t=${token}`)
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain('root:')
    }
  })

  it('does not leak through a literal ../ path either', async () => {
    // `new URL()` normalises a literal `../` away before routing sees it, so this lands
    // on the single-page fallback rather than escaping. The status depends on whether a
    // client bundle has been built, which the unit suite does not require — the security
    // property is what matters here, so that is what is asserted.
    const res = await get(`/../../../../etc/passwd?t=${token}`)
    expect([200, 404]).toContain(res.status)
    expect(await res.text()).not.toContain('root:')
  })

  it('streams an initial snapshot over SSE', async () => {
    const controller = new AbortController()
    const res = await get(`/api/events?t=${token}`, { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    // A client connecting mid-session must get current state immediately, not wait for
    // the next commit to find out what the repo looks like.
    expect(chunk).toContain('event: graph')

    controller.abort()
  })
})

describe('listenWithFallback', () => {
  it('moves to the next port when the preferred one is taken', async () => {
    const blocker = createServer()
    const taken = await listenWithFallback(blocker, 0, 0)

    const server = createServer()
    const port = await listenWithFallback(server, taken, 20)

    // Local tools that assume their default port is free fail confusingly the moment you
    // run two of them, or leave one behind after a crash.
    expect(port).toBeGreaterThan(taken)

    await new Promise((r) => blocker.close(r))
    await new Promise((r) => server.close(r))
  })
})
