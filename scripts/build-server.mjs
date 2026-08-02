import { readFileSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

/*
 * Clear the whole output directory first, because neither esbuild nor vite removes files
 * it no longer emits. That is not housekeeping — `files: ["dist"]` publishes whatever is
 * on disk, so a stale artifact from an earlier build ships. Turning sourcemaps off left a
 * 390 KB `cli.js.map` behind and it went on being packed, which is exactly the failure
 * this prevents. Runs here rather than as a shell `rm -rf` so the build stays portable.
 */
rmSync('dist', { recursive: true, force: true })

/**
 * Bundle the daemon into a single `dist/cli.js`.
 *
 * Bundling rather than shipping loose `tsc` output keeps `npx git-artifact` fast: one
 * file to read instead of walking a dependency tree at startup. `chokidar` and `ignore`
 * are bundled too, so the published package installs nothing at runtime.
 */
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Off by default. The map was 390 KB against a 174 KB bundle — 47% of the published
  // tarball, to describe code almost nobody will step through, and npm downloads it on
  // every `npx`. Set GIT_ARTIFACT_SOURCEMAP=1 for a local build you intend to debug.
  sourcemap: process.env.GIT_ARTIFACT_SOURCEMAP === '1',
  // Node builtins stay external; everything else is inlined.
  packages: 'bundle',
  // Baked in at build time so the CLI never has to locate package.json at runtime, which
  // is fragile once the file has been bundled somewhere else.
  define: { __GIT_ARTIFACT_VERSION__: JSON.stringify(version) },
  banner: {
    // esbuild's ESM output can reference these CJS globals via bundled dependencies.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})
