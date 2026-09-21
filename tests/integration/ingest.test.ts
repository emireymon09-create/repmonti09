import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let familyA: string // toda la familia A, scope ingest
let pinnedA: string // clavado al bebé de A
let nurseOnlyA: string // scope equivocado
let revokedA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('ingest'))
  familyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })).token
  pinnedA = (await seedDeviceToken({ familyId: a.familyId, babyId: a.babyId, scopes: ['ingest'] }))
    .token
  nurseOnlyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_nurse'] })).token
  revokedA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'], revoked: true }))
    .token
})
afterAll(async () => {
  await cleanup()
})

// El contador del rate limit es global al proceso.
beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, token: string | null, extra: Record<string, string> = {}) {
  return raw(JSON.stringify(body), token, extra)
}

async function raw(body: string, token: string | null, extra: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/ingest/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return POST(
    new NextRequest(new Request('http://localhost/api/ingest', { method: 'POST', headers, body })),
  )
}

async function eventsOf(babyId: string) {
  const { data } = await adminClient().from('monitor_events').select('id').eq('baby_id', babyId)
  return data ?? []
}

describe('/api/ingest — quién entra', () => {
  it('sin token, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, null)).status).toBe(401)
  })

  it('el header viejo x-device-secret ya no abre nada', async () => {
    const res = await post({ baby_id: a.babyId, event_type: 'sound_alert' }, null, {
      'x-device-secret': 'secreto-de-prueba-del-nuc',
    })
    expect(res.status).toBe(401)
  })

  it('un token bien formado que no existe, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, 'amd_' + 'x'.repeat(43))).status).toBe(401)
  })

  it('un token revocado, 401', async () => {
    expect((await post({ event_type: 'sound_alert' }, revokedA)).status).toBe(401)
  })

  it('un token sin el scope ingest, 403', async () => {
    expect((await post({ event_type: 'sound_alert' }, nurseOnlyA)).status).toBe(403)
  })

  it('marca last_used_at del token que entró', async () => {
    const t = await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })
    expect((await post({ event_type: 'sound_alert' }, t.token)).status).toBe(200)
    const { data } = await adminClient()
      .from('device_tokens')
      .select('last_used_at')
      .eq('id', t.id)
      .single()
    expect(data!.last_used_at).not.toBeNull()
  })
})

/**
 * HALLAZGO C2, CERRADO. Antes: un secreto válido escribía sobre el bebé de
 * cualquier familia. Ahora el bebé se valida contra la familia del token.
 */
describe('/api/ingest — a qué bebé le escribe', () => {
  it('un token de la familia A NO escribe sobre el bebé de B', async () => {
    const res = await post({ baby_id: b.babyId, event_type: 'sound_alert' }, familyA)
    expect(res.status).toBe(403)
    expect(await eventsOf(b.babyId)).toEqual([])
  })

  it('un token clavado a A tampoco escribe sobre B', async () => {
    expect((await post({ baby_id: b.babyId, event_type: 'sound_alert' }, pinnedA)).status).toBe(403)
    expect(await eventsOf(b.babyId)).toEqual([])
  })

  it('un token de familia escribe sobre un bebé de su familia', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ baby_id: a.babyId, event_type: 'motion_start' }, familyA)).status).toBe(
      200,
    )
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('sin baby_id, un token clavado usa su bebé', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ event_type: 'motion_end' }, pinnedA)).status).toBe(200)
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('sin baby_id, un token de familia con un solo bebé usa ese', async () => {
    const before = (await eventsOf(a.babyId)).length
    expect((await post({ event_type: 'sound_alert' }, familyA)).status).toBe(200)
    expect(await eventsOf(a.babyId)).toHaveLength(before + 1)
  })

  it('abre y cierra una sesión de sueño derivada', async () => {
    const start = await post(
      { baby_id: a.babyId, kind: 'sleep_start', occurred_at: '2026-09-20T20:00:00Z' },
      familyA,
    )
    expect(start.status).toBe(200)
    const end = await post(
      { baby_id: a.babyId, kind: 'sleep_end', occurred_at: '2026-09-20T21:30:00Z' },
      familyA,
    )
    expect(end.status).toBe(200)

    const { data } = await adminClient()
      .from('sleep_sessions')
      .select('ended_at, source')
      .eq('baby_id', a.babyId)
    expect(data).toHaveLength(1)
    expect(data![0].source).toBe('nuc_derived')
    expect(data![0].ended_at).not.toBeNull()
  })
})

describe('/api/ingest — con un segundo bebé en la familia A', () => {
  let secondA: string

  beforeAll(async () => {
    const { data, error } = await adminClient()
      .from('babies')
      .insert({ family_id: a.familyId, name: 'Bebe a2', birth_date: '2026-09-01' })
      .select('id')
      .single()
    if (error) throw error
    secondA = data.id
  })

  it('un token de familia sin baby_id falla cerrado (409), no adivina', async () => {
    const res = await post({ event_type: 'sound_alert' }, familyA)
    expect(res.status).toBe(409)
  })

  it('un token de familia con baby_id del segundo bebé, escribe ahí', async () => {
    expect((await post({ baby_id: secondA, event_type: 'sound_alert' }, familyA)).status).toBe(200)
    expect(await eventsOf(secondA)).toHaveLength(1)
  })

  it('un token clavado al primero no escribe sobre el segundo, aunque sea de su familia', async () => {
    expect((await post({ baby_id: secondA, event_type: 'sound_alert' }, pinnedA)).status).toBe(403)
  })
})

describe('/api/ingest — validación del payload', () => {
  it('un body que no es JSON responde 400, no 500', async () => {
    expect((await raw('esto no es json', familyA)).status).toBe(400)
  })

  it('un baby_id que no es uuid responde 400', async () => {
    expect((await post({ baby_id: 'la-bebe', event_type: 'sound_alert' }, familyA)).status).toBe(
      400,
    )
  })

  it('un event_type fuera de la lista blanca responde 400', async () => {
    expect((await post({ baby_id: a.babyId, event_type: 'video_clip' }, familyA)).status).toBe(400)
  })

  it('un event_type ausente no se guarda como "unknown"', async () => {
    expect((await post({ baby_id: a.babyId }, familyA)).status).toBe(400)
  })

  it('un occurred_at absurdo responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', occurred_at: '1899-01-01T00:00:00Z' },
      familyA,
    )
    expect(res.status).toBe(400)
  })

  it('un kind desconocido responde 400', async () => {
    expect((await post({ baby_id: a.babyId, kind: 'sleep_sideways' }, familyA)).status).toBe(400)
  })

  it('un meta gigante responde 400', async () => {
    const res = await post(
      { baby_id: a.babyId, event_type: 'sound_alert', meta: { blob: 'x'.repeat(4000) } },
      familyA,
    )
    expect(res.status).toBe(400)
  })
})

describe('/api/ingest — techo de intentos', () => {
  it('el intento 21 dentro del minuto responde 429', async () => {
    let last = 0
    for (let i = 0; i < 21; i += 1) {
      last = (await post({ event_type: 'sound_alert' }, 'amd_' + 'y'.repeat(43))).status
    }
    expect(last).toBe(429)
  })
})
