import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Las pruebas de integración escriben en una base compartida: sin
    // paralelismo entre archivos, o dos suites se pisan el seed.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
