import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: that one sets `root: 'src/client'` for the
// client bundle, which would hide every test outside the client directory.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    globals: true,
    // Fixtures shell out to git and clone repos; the default 5s is too tight on a cold
    // filesystem cache.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
