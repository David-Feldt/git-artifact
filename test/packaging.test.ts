import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builders, cleanupAll } from './fixtures/make.js'

/**
 * Tests the artifact that actually ships, rather than the source it was built from.
 *
 * Everything else in this suite imports from `src/`, which means a whole class of failure
 * is invisible to it: a wrong `files` entry, a missing shebang, a `bin` pointing at a path
 * the build no longer emits. The sharpest case is static serving — `CLIENT_DIR` in
 * `src/server/index.ts` resolves relative to the module, so under `src/` it points at
 * `src/server/client/`, a directory that does not exist. Every static request in
 * `server.test.ts` therefore takes the not-found branch, and the path every user hits
 * first has no coverage at all until it is exercised from `dist/`.
 *
 * So this packs the real tarball, unpacks it somewhere clean, and boots it as a user would.
 *
 * Note that `npm pack` runs `prepare`, which rebuilds `dist/` from scratch. That is what
 * makes the test trustworthy — it can never assert against a stale build — but it does
 * mean running this suite stamps on the `dist/` that a concurrent `npm run dev` is using.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

let unpacked: string
let tarballEntries: string[]

beforeAll(() => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'git-artifact-pack-'))
  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

  /*
   * npm passes its configuration to child processes through `npm_config_*` environment
   * variables, and this suite runs inside `prepublishOnly` — so a `npm publish --dry-run`
   * exports `npm_config_dry_run=true`, the nested pack below inherits it, prints a
   * filename, and writes no tarball. The test then fails inside the one command it exists
   * to protect, which is worse than not having it.
   *
   * Strip the whole namespace rather than overriding the single flag: anything the parent
   * invocation happens to be configured with is the wrong input here. What this must pack
   * is the tarball a user downloads, under default configuration.
   */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
  )

  execFileSync('npm', ['pack', '--pack-destination', scratch], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    env,
  })

  const tarball = path.join(scratch, `git-artifact-${version}.tgz`)
  tarballEntries = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    // npm prefixes every entry with `package/`; strip it so assertions read like paths.
    .map((entry) => entry.replace(/^package\//, ''))

  execFileSync('tar', ['xzf', tarball], { cwd: scratch })
  unpacked = path.join(scratch, 'package')
}, 120_000)

afterAll(() => {
  if (unpacked) rmSync(path.dirname(unpacked), { recursive: true, force: true })
  cleanupAll()
})

describe('the published tarball', () => {
  it('ships the entry point and the built client', () => {
    expect(tarballEntries).toContain('dist/cli.js')
    expect(tarballEntries).toContain('dist/client/index.html')
    expect(tarballEntries.some((e) => /^dist\/client\/assets\/.+\.js$/.test(e))).toBe(true)
    expect(tarballEntries.some((e) => /^dist\/client\/assets\/.+\.css$/.test(e))).toBe(true)
    expect(tarballEntries).toContain('LICENSE')
    expect(tarballEntries).toContain('README.md')
  })

  it('ships no source, tests or fixtures', () => {
    for (const entry of tarballEntries) {
      expect(entry).not.toMatch(/^(src|test|scripts)\//)
    }
  })

  it('ships no sourcemap', () => {
    // Off by default because the map ran 390 KB against a 174 KB bundle, and npm downloads
    // it on every `npx`. GIT_ARTIFACT_SOURCEMAP=1 is a local-debug escape hatch only.
    expect(tarballEntries.some((e) => e.endsWith('.map'))).toBe(false)
  })

  it('declares no runtime dependencies', () => {
    // chokidar and ignore are inlined by esbuild, so declaring them would make every
    // install download packages the bundle never loads. See scripts/build-server.mjs.
    const manifest = JSON.parse(readFileSync(path.join(unpacked, 'package.json'), 'utf8'))
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  it('imports nothing at runtime but node builtins', () => {
    // The stronger form of the assertion above: even a correct manifest would not save us
    // if the bundle had left a bare import behind.
    const bundle = readFileSync(path.join(unpacked, 'dist/cli.js'), 'utf8')
    const specifiers = [...bundle.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    )
    const external = specifiers.filter((s) => !s.startsWith('.') && !s.startsWith('/'))

    expect(external.length).toBeGreaterThan(0) // guards against the regex silently matching nothing
    for (const specifier of new Set(external)) {
      // esbuild emits builtins both prefixed and bare, so ask Node rather than keeping a
      // hand-written list that has to be edited every time the bundle touches a new one.
      expect(isBuiltin(specifier), specifier).toBe(true)
    }
  })

  it('exposes an executable entry point', () => {
    const bin = readFileSync(path.join(unpacked, 'dist/cli.js'), 'utf8')
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true)
  })
})

describe('the packaged daemon', () => {
  let child: ChildProcess
  let base: string
  let token: string

  beforeAll(async () => {
    const repo = builders.branchMerge!()

    // Port 0 lets the OS pick, so this cannot collide with a running dev daemon. The real
    // port comes back on stdout, which is also the line users copy.
    child = spawn('node', [path.join(unpacked, 'dist/cli.js'), '--no-open', '--port', '0', repo], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(
        () => reject(new Error(`daemon printed no URL within 30s:\n${output}`)),
        30_000,
      )
      const scan = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([a-f0-9]+)/)
        if (!match) return
        clearTimeout(timer)
        resolve(match[0])
      }
      child.stdout!.on('data', scan)
      child.stderr!.on('data', scan)
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`daemon exited with ${code} before listening:\n${output}`))
      })
    })

    const parsed = new URL(url)
    base = parsed.origin
    token = parsed.searchParams.get('t')!
  }, 60_000)

  afterAll(() => {
    child?.kill()
  })

  it('serves the built client at the root', async () => {
    const res = await fetch(`${base}/?t=${token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<title>git-artifact</title>')
  })

  it('serves the hashed client assets the page asks for', async () => {
    // The failure this exists for: `dist/client` moving out from under CLIENT_DIR. The
    // root would still 200 from the index fallback, so only a real asset proves the path.
    const html = await (await fetch(`${base}/?t=${token}`)).text()
    const assets = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]!)
    expect(assets.length).toBeGreaterThan(0)

    for (const asset of assets) {
      const res = await fetch(`${base}/${asset}?t=${token}`)
      expect(res.status, asset).toBe(200)
      expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    }
  })

  it('serves the graph API', async () => {
    const res = await fetch(`${base}/api/graph?t=${token}`)
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(4)
  })

  /**
   * `fetch` is the wrong instrument for the last two cases and fails open on both: `Host`
   * is a forbidden header name, so undici drops it and the rebinding guard is never
   * reached, and the WHATWG URL parser resolves `/../` away client-side, so the traversal
   * never leaves the process. Both looked like passes against a server doing nothing. This
   * writes the request line and headers verbatim instead.
   */
  const raw = (requestPath: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { hostname, port } = new URL(base)
      const req = request({ hostname, port, path: requestPath, method, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      })
      req.on('error', reject)
      req.end()
    })

  const status = async (...args: Parameters<typeof raw>) => (await raw(...args)).status

  it('still enforces all three auth checks once packaged', async () => {
    // Covered against `src/` in auth.test.ts. Repeated here because these three are the
    // reason a loopback bind is safe, and a packaging change must not be able to drop them.
    expect(await status('/')).toBe(401)
    expect(await status(`/?t=${'0'.repeat(32)}`)).toBe(401)
    expect(await status(`/?t=${token}`, { Host: 'evil.com' })).toBe(403)
    expect(await status(`/?t=${token}`, { Origin: 'http://evil.com' })).toBe(403)
    expect(await status(`/api/graph?t=${token}`, {}, 'POST')).toBe(405)
  })

  /**
   * Two layers stop a traversal, and they catch different spellings — worth pinning both,
   * because a test that only covers the first would still pass if the second were deleted.
   *
   * `new URL()` collapses dot segments before `serveStatic` ever runs, and it decodes `%2e`
   * while doing so, so those forms cannot escape and simply miss and hit the SPA fallback.
   * `%2f` is *not* decoded during normalisation, so that is the one spelling that reaches
   * `serveStatic` with a live `..` — and the containment check at index.ts:370 is the only
   * thing standing between it and a process that can read the user's whole disk.
   */
  it('refuses a traversal that survives URL normalisation', async () => {
    expect(await status(`/%2e%2e%2f%2e%2e%2fpackage.json?t=${token}`)).toBe(403)
    expect(await status(`/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd?t=${token}`)).toBe(403)
  })

  it('falls back to the app for a normalised path instead of leaking a file', async () => {
    for (const attempt of ['/../package.json', '/%2e%2e/package.json', '/../../../etc/passwd']) {
      const res = await raw(`${attempt}?t=${token}`)
      expect(res.status, attempt).toBe(200)
      expect(res.body, attempt).toContain('<title>git-artifact</title>')
      expect(res.body, attempt).not.toContain('"name": "git-artifact"') // not the manifest
      expect(res.body, attempt).not.toContain('root:') // not /etc/passwd
    }
  })
})
