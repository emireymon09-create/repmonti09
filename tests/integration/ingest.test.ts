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

const SECRET = 'secreto-de-prueba-del-nuc'

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  process.env.NUC_DEVICE_SECRET = SECRET
  ;({ a, b, cleanup } = await seedTwoFamilies('ingest'))
})
afterAll(async () => {
  await cleanup()
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
