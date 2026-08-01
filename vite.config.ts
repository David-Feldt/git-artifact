import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is built into dist/client and served by our own zero-dep http server in
// production. In dev, this Vite server proxies to a separately-running daemon
// (see scripts/dev.mjs), which sets GIT_ARTIFACT_DEV_PORT.
const daemonPort = process.env.GIT_ARTIFACT_DEV_PORT ?? '7373'

/*
 * Paths the daemon owns.
 *
 * `/artifact` has to be here alongside `/api`, and it is easy to miss: Vite answers an
 * unproxied path with `index.html`, so the popup opened by "Generate artifact" came back
 * as a second copy of the dashboard rather than a 404. A missing proxy entry fails by
 * rendering the wrong thing successfully, which is the kind that survives a smoke test.
 */
const DAEMON_PATHS = ['/api', '/artifact']

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    strictPort: false,
    proxy: Object.fromEntries(
      DAEMON_PATHS.map((path) => [
        path,
        { target: `http://127.0.0.1:${daemonPort}`, changeOrigin: false },
      ]),
    ),
  },
})
