// postinstall: hace que `node_modules/.bin/next` pase por
// scripts/next-loopback.mjs.
//
// Los scripts `dev` y `start` de package.json ya fuerzan `-H 127.0.0.1`, pero
// nadie está obligado a usarlos: `pnpm exec next start`, `npx next dev` y
// `./node_modules/.bin/next start` van derecho al binario. El 24 sep 2026 un
// agente levantó la app en 172.17.0.1 por ese camino. Reemplazando el shim que
// genera pnpm, los tres quedan cubiertos.
//
// pnpm regenera ese shim en cada `pnpm install`, por eso esto es postinstall.
// Nunca hace fallar la instalación: si no puede escribir, avisa y sigue.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = dirname(dirname(fileURLToPath(import.meta.url)))
const shim = join(raiz, 'node_modules', '.bin', 'next')

const MARCA = '# blindado por scripts/blindar-next-bin.mjs'

const CONTENIDO = `#!/bin/sh
${MARCA}
# NO editar a mano: \`pnpm install\` lo vuelve a escribir.
# Fuerza que \`next dev\` / \`next start\` escuchen sólo en 127.0.0.1, también
# cuando se invocan sin pasar por los scripts de package.json.
basedir=$(cd -- "$(dirname -- "$0")" > /dev/null 2>&1 && pwd -P)
exec node "$basedir/../../scripts/next-loopback.mjs" "$@"
`

if (!existsSync(shim)) {
  console.error('  aviso: no está node_modules/.bin/next; no hay nada que blindar')
  process.exit(0)
}

try {
  if (readFileSync(shim, 'utf8').includes(MARCA)) process.exit(0)
  writeFileSync(shim, CONTENIDO)
  chmodSync(shim, 0o755)
  console.error('  node_modules/.bin/next blindado (bind sólo en loopback)')
} catch (e) {
  console.error(`  aviso: no se pudo blindar node_modules/.bin/next: ${e.message}`)
}
