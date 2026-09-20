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

const SECRET = 'secreto-de-prueba-del-nuc'

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  process.env.NUC_DEVICE_SECRET = SECRET
  ;({ a, b, cleanup } = await seedTwoFamilies('ingest'))
})
afterAll(async () => {
  await cleanup()
})

// El contador del rate limit es global al proceso: sin esto, los tests de más
// abajo empezarían a chocar contra el techo de 20 por minuto.
beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, secret: string | null) {
  return raw(JSON.stringify(body), secret)
}

async function raw(body: string, secret: string | null) {
  const { POST } = await import('@/app/api/ingest/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['x-device-secret'] = secret
  return POST(
    new NextRequest(new Request('http://localhost/api/ingest', { method: 'POST', headers, body })),
  )
}

describe('/api/ingest', () => {
  it('rechaza sin secreto y sin baby_id', async () => {
    expect((await post({ baby_id: a.babyId }, null)).status).toBe(401)
    expect((await post({}, SECRET)).status).toBe(400)
  })

  it('abre y cierra una sesión de sueño derivada', async () => {
    const start = await post(
      { baby_id: a.babyId, kind: 'sleep_start', occurred_at: '2026-01-15T20:00:00Z' },
      SECRET,
    )
    expect(start.status).toBe(200)
    const end = await post(
      { baby_id: a.babyId, kind: 'sleep_end', occurred_at: '2026-01-15T21:30:00Z' },
      SECRET,
    )
    expect(end.status).toBe(200)

    const admin = adminClient()
    const { data } = await admin
      .from('sleep_sessions')
      .select('started_at, ended_at, source')
      .eq('baby_id', a.babyId)
    expect(data).toHaveLength(1)
    expect(data![0].source).toBe('nuc_derived')
    expect(data![0].ended_at).not.toBeNull()
  })

  /**
   * HALLAZGO C2 de docs/auditorias/2026-09-20-auditoria-inicial.md.
   *
   * El secreto es uno solo para toda la instalación y el endpoint corre con
   * service_role, así que quien lo tenga puede escribir sobre CUALQUIER
   * baby_id de la base, no solo el suyo. Documentado, no corregido: el arreglo
   * de fondo (token hasheado por dispositivo) es cambio de schema y vive en
   * proposals/device-tokens-and-idempotency.md.
   */
  it('HALLAZGO: un secreto válido escribe sobre el bebé de otra familia', async () => {
    const res = await post({ baby_id: b.babyId, event_type: 'sound_alert' }, SECRET)
    expect(res.status).toBe(200)

    const admin = adminClient()
    const { data } = await admin.from('monitor_events').select('id').eq('baby_id', b.babyId)
    expect(data).toHaveLength(1)
  })
})
/**
 * Lo que la Tarea 8 endurece. Escritos antes del arreglo: al correrlos contra
 * el handler viejo dan 500 / 200 en vez de 400.
 */
describe('/api/ingest endurecido', () => {
  it('un body que no es JSON responde 400, no 500', async () => {
    expect((await raw('esto no es json', SECRET)).status).toBe(400)
  })

  it('un baby_id que no es uuid responde 400', async () => {
    expect((await post({ baby_id: 'la-bebe', event_type: 'sound_alert' }, SECRET)).status).toBe(400)
  })

  it('un event_type fuera de la lista blanca responde 400', async () => {
    expect((await post({ baby_id: a.babyId, event_type: 'video_clip' }, SECRET)).status).toBe(400)
  })

  it('un event_type ausente ya no se guarda como "unknown"', async () => {
    expect((await post({ baby_id: a.babyId }, SECRET)).status).toBe(400)
  })

  it('un occurred_at absurdo responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', occurred_at: '1899-01-01T00:00:00Z' },
      SECRET,
    )
    expect(res.status).toBe(400)
  })

  it('un kind desconocido responde 400', async () => {
    expect((await post({ baby_id: a.babyId, kind: 'sleep_sideways' }, SECRET)).status).toBe(400)
  })

  it('un meta gigante responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', meta: { blob: 'x'.repeat(4000) } },
      SECRET,
    )
    expect(res.status).toBe(400)
  })
})

describe('/api/ingest — techo de intentos', () => {
  it('el intento 21 dentro del minuto responde 429', async () => {
    let last = 0
    for (let i = 0; i < 21; i += 1) {
      last = (await post({ baby_id: a.babyId, event_type: 'sound_alert' }, 'secreto-malo')).status
    }
    expect(last).toBe(429)
  })
})
