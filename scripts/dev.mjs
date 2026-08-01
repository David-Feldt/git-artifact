import { spawn } from 'node:child_process'
import process from 'node:process'
import * as esbuild from 'esbuild'

/**
 * Development loop: the daemon rebuilds and restarts on change, Vite serves the client
 * with hot reload and proxies `/api` through.
 *
 * The two halves are on different ports, so the browser's requests to the daemon are
 * genuinely cross-origin. `GIT_ARTIFACT_DEV_ORIGIN` is how the daemon is told to accept
 * that one specific origin — and it also switches off static file serving, since Vite
 * owns the client here.
 */

const DAEMON_PORT = Number(process.env.GIT_ARTIFACT_DEV_PORT ?? 7373)
const CLIENT_PORT = 5273
const repo = process.argv[2] ?? process.cwd()

const context = await esbuild.context({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  packages: 'bundle',
  define: { __GIT_ARTIFACT_VERSION__: '"dev"' },
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  plugins: [
    {
      name: 'restart-daemon',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error('build failed; keeping the previous daemon alive')
            return
          }
          restartDaemon()
        })
      },
    },
  ],
})

let daemon = null

function restartDaemon() {
  if (daemon) {
    daemon.kill('SIGTERM')
    daemon = null
  }
  daemon = spawn(
    process.execPath,
    ['dist/cli.js', '--repo', repo, '--port', String(DAEMON_PORT), '--no-open'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_ARTIFACT_DEV_ORIGIN: `http://localhost:${CLIENT_PORT}`,
      },
    },
  )
}

await context.watch()

const vite = spawn('npx', ['vite', '--port', String(CLIENT_PORT)], {
  stdio: 'inherit',
  env: { ...process.env, GIT_ARTIFACT_DEV_PORT: String(DAEMON_PORT) },
})

console.log(`\n  dev: client on http://localhost:${CLIENT_PORT}, daemon on ${DAEMON_PORT}`)
console.log(`  watching ${repo}\n`)
console.log('  The daemon prints its URL with a token — open that one.\n')

const shutdown = async () => {
  daemon?.kill('SIGTERM')
  vite.kill('SIGTERM')
  await context.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
