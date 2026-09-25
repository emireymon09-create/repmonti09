// Arranque de Next.js que escucha SOLO en loopback, pase lo que pase.
//
// Por qué existe: `next dev` y `next start` sin `-H` bindean a 0.0.0.0, o sea
// a la IP pública del VPS. Pasó dos veces:
//
//   - 23 sep 2026 00:00 — `pnpm start` cuando el script `start` de
//     package.json era `next start` a secas (lo arregló 0ca86ae).
//   - 24 sep 2026 06:00 — un agente corrió `pnpm exec next start -H 172.17.0.1`
//     a mano para que un contenedor llegara a la app del host. Ese camino no
//     pasa por package.json, así que ponerle `-H` a los scripts no lo cubría.
//
// Y `HOSTNAME=127.0.0.1` NO sirve como default: en Next 14 sólo `--port` está
// atado a una env var (`.env('PORT')` en next/dist/bin/next); `--hostname` no,
// y `start-server.js` hace `server.listen(port, hostname)` con hostname
// undefined ⇒ todas las interfaces. Verificado el 25 sep 2026: con
// HOSTNAME=127.0.0.1, `next start -p 3099` dejó `*:3099` en `ss -tln`.
//
// Por eso la defensa es este envoltorio: inyecta `-H 127.0.0.1` cuando falta y
// RECHAZA un `-H` que no sea loopback. La salida de emergencia es explícita y
// auditable: AMELIA_BIND_PUBLICO=1.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const LOOPBACK = '127.0.0.1'
export const ESCAPE = 'AMELIA_BIND_PUBLICO'

// Los únicos subcomandos que abren un puerto. `build`, `lint`, `telemetry`,
// `info`... pasan de largo sin tocarles nada.
const SUBCOMANDOS_QUE_ESCUCHAN = new Set(['dev', 'start'])

// `next` sin subcomando corre `dev` (isDefault en next/dist/bin/next).
const SUBCOMANDO_POR_DEFECTO = 'dev'

// Opciones del programa, no del subcomando: `next --version` no arranca nada y
// tiene que llegar intacto.
const FLAGS_SIN_SUBCOMANDO = new Set(['-v', '--version', '-h', '--help'])

const HOSTS_LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function subcomandoDe(argv) {
  if (argv.length > 0 && FLAGS_SIN_SUBCOMANDO.has(argv[0])) return argv[0]
  if (argv.length === 0 || argv[0].startsWith('-')) return SUBCOMANDO_POR_DEFECTO
  return argv[0]
}

// Devuelve el valor de -H/--hostname, o null si no se pasó.
function hostnameDe(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-H' || a === '--hostname') return argv[i + 1] ?? ''
    if (a.startsWith('--hostname=')) return a.slice('--hostname='.length)
    if (a.startsWith('-H=')) return a.slice('-H='.length)
  }
  return null
}

/**
 * Decide con qué argumentos se llama al `next` real.
 * Pura: no arranca nada, no lee el entorno del proceso. Así se puede probar.
 */
export function resolverArgs(argv, env = {}) {
  const subcomando = subcomandoDe(argv)
  if (!SUBCOMANDOS_QUE_ESCUCHAN.has(subcomando)) {
    return { ok: true, args: argv, accion: 'sin-cambios' }
  }

  const host = hostnameDe(argv)

  if (host === null) {
    const traeSubcomando = argv.length > 0 && argv[0] === subcomando
    const args = traeSubcomando
      ? [subcomando, '-H', LOOPBACK, ...argv.slice(1)]
      : ['-H', LOOPBACK, ...argv]
    return { ok: true, args, accion: 'inyectado' }
  }

  if (HOSTS_LOOPBACK.has(host)) {
    return { ok: true, args: argv, accion: 'ya-loopback' }
  }

  if (env[ESCAPE] === '1') {
    return { ok: true, args: argv, accion: 'escape-explicito', host }
  }

  return {
    ok: false,
    host,
    error:
      `next ${subcomando} -H ${host}: ese bind NO es loopback y en este VPS ` +
      `quedaría expuesto a internet (pasó el 23 y el 24 sep 2026).\n` +
      `  Quitá el -H (queda en ${LOOPBACK}) o usá un túnel SSH.\n` +
      `  Si un contenedor tiene que llegar a la app del host, corré el ` +
      `contenedor con --add-host=host.docker.internal:host-gateway y pegale a ` +
      `host.docker.internal, en vez de abrir el puerto en la interfaz del bridge.\n` +
      `  Salida de emergencia, sólo con alguien mirando: ${ESCAPE}=1`,
  }
}

function main() {
  const resultado = resolverArgs(process.argv.slice(2), process.env)

  if (!resultado.ok) {
    console.error(`\n  ${resultado.error}\n`)
    process.exit(1)
  }

  if (resultado.accion === 'escape-explicito') {
    console.error(
      `\n  ⚠  ${ESCAPE}=1: Next va a escuchar en ${resultado.host}, fuera de loopback.\n`,
    )
  }

  const require = createRequire(import.meta.url)
  const binReal = require.resolve('next/dist/bin/next')

  const hijo = spawn(process.execPath, [binReal, ...resultado.args], {
    stdio: 'inherit',
    env: process.env,
  })

  for (const senal of ['SIGINT', 'SIGTERM']) {
    process.on(senal, () => hijo.kill(senal))
  }

  hijo.on('exit', (code, senal) => {
    if (senal) process.kill(process.pid, senal)
    else process.exit(code ?? 0)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
