import { describe, expect, it } from 'vitest'
import { ESCAPE, LOOPBACK, resolverArgs } from '@/scripts/next-loopback.mjs'

// El envoltorio de scripts/next-loopback.mjs existe porque el puerto 3000
// quedó expuesto a internet dos veces (23 y 24 sep 2026). Lo que se prueba acá
// es la decisión, que es pura: con qué argumentos se llama al `next` real.

describe('resolverArgs', () => {
  it('le pone -H 127.0.0.1 a `start` cuando no se pasó ninguno', () => {
    const r = resolverArgs(['start'], {})
    expect(r.ok).toBe(true)
    expect(r.args).toEqual(['start', '-H', LOOPBACK])
    expect(r.accion).toBe('inyectado')
  })

  it('le pone -H 127.0.0.1 a `dev` conservando el resto de las opciones', () => {
    const r = resolverArgs(['dev', '-p', '3100'], {})
    expect(r.args).toEqual(['dev', '-H', LOOPBACK, '-p', '3100'])
  })

  it('cubre `next` sin subcomando, que en Next 14 corre `dev`', () => {
    expect(resolverArgs([], {}).args).toEqual(['-H', LOOPBACK])
    expect(resolverArgs(['-p', '3100'], {}).args).toEqual(['-H', LOOPBACK, '-p', '3100'])
  })

  it('deja pasar un -H que ya es loopback, sin duplicarlo', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const r = resolverArgs(['start', '-H', host], {})
      expect(r.ok).toBe(true)
      expect(r.args).toEqual(['start', '-H', host])
      expect(r.accion).toBe('ya-loopback')
    }
  })

  it('RECHAZA el bind del 24 sep 2026 (-H 172.17.0.1, el bridge de Docker)', () => {
    const r = resolverArgs(['start', '-H', '172.17.0.1', '-p', '3000'], {})
    expect(r.ok).toBe(false)
    expect(r.host).toBe('172.17.0.1')
    expect(r.error).toContain('172.17.0.1')
  })

  it('rechaza 0.0.0.0 y cualquier otro host fuera de loopback', () => {
    for (const host of ['0.0.0.0', '172.20.0.1', '::', '10.0.0.5']) {
      expect(resolverArgs(['dev', '--hostname', host], {}).ok).toBe(false)
    }
  })

  it('reconoce también la forma --hostname=valor y -H=valor', () => {
    expect(resolverArgs(['start', '--hostname=0.0.0.0'], {}).ok).toBe(false)
    expect(resolverArgs(['start', '-H=0.0.0.0'], {}).ok).toBe(false)
    expect(resolverArgs(['start', '--hostname=127.0.0.1'], {}).accion).toBe('ya-loopback')
  })

  it('sólo deja salir de loopback con la variable de escape explícita', () => {
    const args = ['start', '-H', '172.17.0.1']
    expect(resolverArgs(args, { [ESCAPE]: '1' }).ok).toBe(true)
    expect(resolverArgs(args, { [ESCAPE]: '1' }).accion).toBe('escape-explicito')
    // cualquier otro valor no alcanza: la salida se pide, no se insinúa
    expect(resolverArgs(args, { [ESCAPE]: 'true' }).ok).toBe(false)
    expect(resolverArgs(args, { [ESCAPE]: '0' }).ok).toBe(false)
  })

  it('deja intacto `next --version` y `next --help`, que no arrancan nada', () => {
    for (const flag of ['-v', '--version', '-h', '--help']) {
      const r = resolverArgs([flag], {})
      expect(r.ok).toBe(true)
      expect(r.args).toEqual([flag])
      expect(r.accion).toBe('sin-cambios')
    }
  })

  it('no toca los subcomandos que no abren ningún puerto', () => {
    for (const sub of ['build', 'lint', 'telemetry', 'info']) {
      const r = resolverArgs([sub, '--algo'], {})
      expect(r.ok).toBe(true)
      expect(r.args).toEqual([sub, '--algo'])
      expect(r.accion).toBe('sin-cambios')
    }
  })
})
