import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Las pruebas de layout en navegador (tests/e2e). Fuera de `pnpm test:all` a
// propósito: necesitan `pnpm build`, el stack local y un chrome-headless-shell.
// Se corren con `pnpm test:layout` (ver tests/e2e/README.md).
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
})
