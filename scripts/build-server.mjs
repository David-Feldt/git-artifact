import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

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
  sourcemap: true,
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
