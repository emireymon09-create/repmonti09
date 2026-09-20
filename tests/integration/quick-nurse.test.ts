import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'

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
  delete process.env.QUICK_TOGGLE_BABY_ID
})

// El contador del rate limit es global al proceso.
beforeEach(() => {
  resetDeviceRateLimit()
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
 * HALLAZGO C1 de docs/auditorias/2026-09-20-auditoria-inicial.md, con el parche
 * aplicado.
 *
 * El endpoint corre con service_role (salta RLS) y antes elegía el `babies` más
 * ANTIGUO de toda la base sin filtrar por familia: con dos familias, el secreto
 * de cualquiera escribía sobre el bebé de la familia más vieja.
 *
 * Estos tests son la versión DADA VUELTA de los que documentaban el bug: ahora
 * el endpoint falla cerrado en vez de adivinar. El arreglo de fondo —resolver
 * el bebé desde el token del dispositivo— sigue siendo
 * proposals/device-tokens-and-idempotency.md §3.
 */
describe('/api/quick/nurse — a qué bebé le escribe', () => {
  it('con dos familias y sin configurar nada, falla cerrado en vez de adivinar', async () => {
    delete process.env.QUICK_TOGGLE_BABY_ID
    const res = await post({ side: 'left' }, SECRET)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('more than one baby')

    // Y no escribió nada en ninguna de las dos familias.
    const admin = adminClient()
    const { data } = await admin
      .from('nursing_sessions')
      .select('id')
      .in('baby_id', [a.babyId, b.babyId])
    expect(data).toEqual([])
  })

  it('con QUICK_TOGGLE_BABY_ID apuntando a B, la sesión aterriza en B', async () => {
    process.env.QUICK_TOGGLE_BABY_ID = b.babyId
    const res = await post({ side: 'left' }, SECRET)
    expect(res.status).toBe(200)

    const admin = adminClient()
    const { data: enB } = await admin
      .from('nursing_sessions')
      .select('id')
      .eq('baby_id', b.babyId)
      .is('ended_at', null)
    const { data: enA } = await admin.from('nursing_sessions').select('id').eq('baby_id', a.babyId)

    expect(enB).toHaveLength(1)
    expect(enA).toEqual([]) // la familia más vieja ya no se lo queda todo

    // Cerramos la sesión para no dejar estado colgando.
    await post({ side: 'left' }, SECRET)
  })

  it('un QUICK_TOGGLE_BABY_ID que no es uuid es un error de configuración, no un 200', async () => {
    process.env.QUICK_TOGGLE_BABY_ID = 'la-bebe'
    expect((await post({ side: 'left' }, SECRET)).status).toBe(500)
  })

  it('el toggle sigue el ciclo start -> switch -> end sobre el bebé configurado', async () => {
    process.env.QUICK_TOGGLE_BABY_ID = b.babyId
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
      .eq('baby_id', b.babyId)
    expect(data!.every((r) => r.ended_at !== null)).toBe(true)
  })
})
