import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // The Workers runtime module, stood in for in Node
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    // The synchronizer's suite also runs the shared package's and the manager's tests
    dir: fileURLToPath(new URL('..', import.meta.url)),
    include: ['synchronizer/src/**/*.test.ts', 'shared/src/**/*.test.ts', 'manager/src/**/*.test.ts'],
  },
})
