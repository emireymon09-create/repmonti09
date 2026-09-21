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
let pinnedB: string
let familyA: string
let ingestOnlyA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('quicknurse'))
  pinnedB = (
    await seedDeviceToken({ familyId: b.familyId, babyId: b.babyId, scopes: ['quick_nurse'] })
  ).token
  familyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_nurse'] })).token
  ingestOnlyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })).token
})
afterAll(async () => {
  await cleanup()
})

beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, token: string | null) {
  const { POST } = await import('@/app/api/quick/nurse/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
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

async function sessionsOf(babyId: string) {
  const { data } = await adminClient()
    .from('nursing_sessions')
    .select('id, ended_at')
    .eq('baby_id', babyId)
  return data ?? []
}

describe('/api/quick/nurse — autenticación', () => {
  it('rechaza sin token', async () => {
    expect((await post({ side: 'left' }, null)).status).toBe(401)
  })

  it('rechaza un token que no existe', async () => {
    expect((await post({ side: 'left' }, 'amd_' + 'z'.repeat(43))).status).toBe(401)
  })

  it('rechaza un token sin el scope quick_nurse', async () => {
    expect((await post({ side: 'left' }, ingestOnlyA)).status).toBe(403)
  })

  it('rechaza un side inválido', async () => {
    expect((await post({ side: 'arriba' }, pinnedB)).status).toBe(400)
  })
})

/**
 * HALLAZGO C1, CERRADO. Antes: el bebé más antiguo de toda la base, después un
 * parche con QUICK_TOGGLE_BABY_ID. Ahora el bebé sale del token.
 */
describe('/api/quick/nurse — a qué bebé le escribe', () => {
  it('un token clavado a B escribe en B y la familia A no se entera', async () => {
    const res = await post({ side: 'left' }, pinnedB)
    expect(res.status).toBe(200)
    expect((await res.json()).action).toBe('started')
    expect(await sessionsOf(a.babyId)).toEqual([])
    expect((await sessionsOf(b.babyId)).filter((s) => s.ended_at === null)).toHaveLength(1)
    await post({ side: 'left' }, pinnedB) // cerrar
  })

  it('un token de familia con un solo bebé escribe en ese bebé', async () => {
    expect((await post({ side: 'right' }, familyA)).status).toBe(200)
    expect(await sessionsOf(a.babyId)).toHaveLength(1)
    await post({ side: 'right' }, familyA) // cerrar
  })

  it('un token de A no puede apuntar al bebé de B con baby_id', async () => {
    const before = (await sessionsOf(b.babyId)).length
    expect((await post({ side: 'left', baby_id: b.babyId }, familyA)).status).toBe(403)
    expect(await sessionsOf(b.babyId)).toHaveLength(before)
  })

  it('el toggle sigue el ciclo start -> switch -> end', async () => {
    expect((await (await post({ side: 'left' }, pinnedB)).json()).action).toBe('started')
    expect((await (await post({ side: 'right' }, pinnedB)).json()).action).toBe('switched')
    expect((await (await post({ side: 'right' }, pinnedB)).json()).action).toBe('ended')
    expect((await sessionsOf(b.babyId)).every((s) => s.ended_at !== null)).toBe(true)
  })

  it('con dos bebés en la familia y un token de familia, falla cerrado (409)', async () => {
    const { error } = await adminClient()
      .from('babies')
      .insert({ family_id: a.familyId, name: 'Bebe a2', birth_date: '2026-09-01' })
    expect(error).toBeNull()
    const before = (await sessionsOf(a.babyId)).length
    const res = await post({ side: 'left' }, familyA)
    expect(res.status).toBe(409)
    expect(await sessionsOf(a.babyId)).toHaveLength(before)
  })
})
