import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

const SECRET = 'secreto-de-prueba-del-shortcut'

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  process.env.QUICK_TOGGLE_SECRET = SECRET
  ;({ a, b, cleanup } = await seedTwoFamilies('quicknurse'))
})
afterAll(async () => {
  await cleanup()
})

async function post(body: unknown, secret: string | null) {
  const { POST } = await import('@/app/api/quick/nurse/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['x-device-secret'] = secret
  return POST(
    new NextRequest(
      new Request('http://localhost/api/quick/nurse', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    ),
  )
}

describe('/api/quick/nurse — autenticación', () => {
  it('rechaza sin secreto', async () => {
    expect((await post({ side: 'left' }, null)).status).toBe(401)
  })

  it('rechaza con secreto incorrecto', async () => {
    expect((await post({ side: 'left' }, 'otro')).status).toBe(401)
  })

  it('rechaza un side inválido', async () => {
    expect((await post({ side: 'arriba' }, SECRET)).status).toBe(400)
  })
})

/**
 * HALLAZGO C1 de docs/auditorias/2026-09-20-auditoria-inicial.md.
 *
 * El endpoint corre con service_role (salta RLS) y elige el `babies` más
 * antiguo sin filtrar por familia (CLAUDE.md §7.3). Con una sola familia es
 * correcto; con dos, el secreto de CUALQUIERA escribe sobre el bebé de la
 * familia más vieja.
 *
 * Este archivo documenta el comportamiento tal como está. Cuando el arreglo de
 * fondo llegue (proposals/device-tokens-and-idempotency.md), estos tests tienen
 * que DARSE VUELTA. Hasta entonces, esto es la evidencia.
 */
describe('HALLAZGO: /api/quick/nurse escribe sobre el bebé más viejo de TODA la base', () => {
  it('con dos familias, la sesión aterriza en el bebé de la familia A', async () => {
    const res = await post({ side: 'left' }, SECRET)
    expect(res.status).toBe(200)

    const admin = adminClient()
    const { data: enA } = await admin
      .from('nursing_sessions')
      .select('id')
      .eq('baby_id', a.babyId)
      .is('ended_at', null)
    const { data: enB } = await admin
      .from('nursing_sessions')
      .select('id')
      .eq('baby_id', b.babyId)
      .is('ended_at', null)

    expect(enA).toHaveLength(1) // <- el bebé más viejo se lo queda todo
    expect(enB).toHaveLength(0) // <- la otra familia nunca recibe nada

    // Cerramos la sesión para no dejar estado colgando.
    await post({ side: 'left' }, SECRET)
  })

  it('el toggle sigue el ciclo start -> switch -> end sobre ese mismo bebé', async () => {
    const admin = adminClient()

    const started = await post({ side: 'left' }, SECRET)
    expect((await started.json()).action).toBe('started')

    const switched = await post({ side: 'right' }, SECRET)
    expect((await switched.json()).action).toBe('switched')

    const ended = await post({ side: 'right' }, SECRET)
    expect((await ended.json()).action).toBe('ended')

    const { data } = await admin
      .from('nursing_sessions')
      .select('id, ended_at')
      .eq('baby_id', a.babyId)
    expect(data!.every((r) => r.ended_at !== null)).toBe(true)
  })
})
