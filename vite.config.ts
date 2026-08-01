import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is built into dist/client and served by our own zero-dep http server in
// production. In dev, this Vite server proxies /api to a separately-running daemon
// (see scripts/dev.mjs), which sets GIT_ARTIFACT_DEV_PORT.
const daemonPort = process.env.GIT_ARTIFACT_DEV_PORT ?? '7373'

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
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: false,
      },
    },
  },
})
