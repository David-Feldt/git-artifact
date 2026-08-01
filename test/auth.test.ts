import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { authorize, generateToken, readCookie, TOKEN_COOKIE } from '../src/server/auth.js'

/**
 * The daemon reads your source code and answers on a port every web page you visit can
 * reach. These tests are the record of what is supposed to stop that.
 */

const TOKEN = 'a'.repeat(32)
const PORT = 7373
const config = { token: TOKEN, port: PORT }

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { host: `127.0.0.1:${PORT}`, ...headers } } as unknown as IncomingMessage
}

const url = (query = '') => new URL(`http://127.0.0.1:${PORT}/api/graph${query}`)

describe('authorize', () => {
  it('accepts a correct token in the query string', () => {
    expect(authorize(request(), url(`?t=${TOKEN}`), config)).toEqual({
      ok: true,
      source: 'query',
    })
  })

  it('accepts a correct token in the header', () => {
    const result = authorize(request({ 'x-artifact-token': TOKEN }), url(), config)
    expect(result).toEqual({ ok: true, source: 'header' })
  })

  it('accepts a correct token in the session cookie', () => {
    const result = authorize(request({ cookie: `${TOKEN_COOKIE}=${TOKEN}` }), url(), config)
    expect(result).toEqual({ ok: true, source: 'cookie' })
  })

  it('rejects a request with no token at all', () => {
    expect(authorize(request(), url(), config)).toEqual({ ok: false, failure: 'missing-token' })
  })

  it('rejects a wrong token', () => {
    expect(authorize(request(), url('?t=' + 'b'.repeat(32)), config)).toEqual({
      ok: false,
      failure: 'bad-token',
    })
  })

  it('rejects a token of the wrong length without leaking it by timing', () => {
    expect(authorize(request(), url('?t=short'), config)).toEqual({
      ok: false,
      failure: 'bad-token',
    })
  })

  /*
   * The cross-origin case. Any page you have open can issue requests to localhost; the
   * browser stamps its origin on them, and that is what we reject on. Note the token is
   * *valid* in these — a leaked token must still not be enough on its own.
   */
  it('rejects a foreign origin even with a valid token', () => {
    const result = authorize(
      request({ origin: 'https://evil.example' }),
      url(`?t=${TOKEN}`),
      config,
    )
    expect(result).toEqual({ ok: false, failure: 'bad-origin' })
  })

  it('rejects loopback on a different port', () => {
    const result = authorize(
      request({ origin: 'http://127.0.0.1:9999' }),
      url(`?t=${TOKEN}`),
      config,
    )
    expect(result).toEqual({ ok: false, failure: 'bad-origin' })
  })

  it('accepts our own origin', () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
      expect(authorize(request({ origin }), url(`?t=${TOKEN}`), config).ok).toBe(true)
    }
  })

  it('accepts an explicitly allowed dev origin', () => {
    const result = authorize(request({ origin: 'http://localhost:5273' }), url(`?t=${TOKEN}`), {
      ...config,
      extraOrigins: ['http://localhost:5273'],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a malformed origin', () => {
    const result = authorize(request({ origin: 'null' }), url(`?t=${TOKEN}`), config)
    expect(result).toEqual({ ok: false, failure: 'bad-origin' })
  })

  /*
   * DNS rebinding: an attacker's hostname resolves to 127.0.0.1, so the browser considers
   * the request same-origin and sends no Origin header at all. The Host header still
   * carries the attacker's name, which is the only thing left to catch it.
   */
  it('rejects a rebound host even with a valid token and no origin', () => {
    const result = authorize(request({ host: 'evil.example' }), url(`?t=${TOKEN}`), config)
    expect(result).toEqual({ ok: false, failure: 'bad-host' })
  })

  it('rejects a missing host header', () => {
    const req = { headers: {} } as unknown as IncomingMessage
    expect(authorize(req, url(`?t=${TOKEN}`), config)).toEqual({ ok: false, failure: 'bad-host' })
  })

  it('accepts loopback hosts in every spelling', () => {
    for (const host of ['127.0.0.1:7373', 'localhost:7373', '[::1]:7373', '127.0.0.1']) {
      expect(authorize(request({ host }), url(`?t=${TOKEN}`), config).ok).toBe(true)
    }
  })

  it('checks host and origin before the token', () => {
    // Otherwise a cross-origin probe could distinguish "wrong token" from "right token"
    // by the status code, turning a 403 into a token oracle.
    expect(authorize(request({ host: 'evil.example' }), url('?t=wrong'), config)).toEqual({
      ok: false,
      failure: 'bad-host',
    })
  })
})

describe('readCookie', () => {
  it('finds a named cookie among others', () => {
    expect(readCookie(`other=1; ${TOKEN_COOKIE}=abc; third=2`, TOKEN_COOKIE)).toBe('abc')
  })

  it('returns null when absent or headerless', () => {
    expect(readCookie('other=1', TOKEN_COOKIE)).toBeNull()
    expect(readCookie(undefined, TOKEN_COOKIE)).toBeNull()
  })

  it('does not match a cookie whose name merely ends with the target', () => {
    expect(readCookie(`not_${TOKEN_COOKIE}=abc`, TOKEN_COOKIE)).toBeNull()
  })
})

describe('generateToken', () => {
  it('produces 128 bits of hex', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, generateToken))
    expect(seen.size).toBe(200)
  })
})
