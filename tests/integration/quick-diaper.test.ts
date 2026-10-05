import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'

// POST /api/quick/diaper — proposals/changer-display.md §4 y §10.2.

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let pinnedB: string
let familyA: string
let nurseOnlyA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('quickdiaper'))
  pinnedB = (
    await seedDeviceToken({ familyId: b.familyId, babyId: b.babyId, scopes: ['quick_diaper'] })
  ).token
  familyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_diaper'] })).token
  nurseOnlyA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['quick_nurse'] })).token
})
afterAll(async () => {
  await cleanup()
})

beforeEach(() => {
  resetDeviceRateLimit()
})

async function post(body: unknown, token: string | null) {
  const { POST } = await import('@/app/api/quick/diaper/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return POST(
    new NextRequest(
      new Request('http://localhost/api/quick/diaper', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    ),
  )
}

async function diapersOf(babyId: string) {
  const { data } = await adminClient()
    .from('diaper_changes')
    .select('id, diaper_type')
    .eq('baby_id', babyId)
  return data ?? []
}

describe('/api/quick/diaper — autenticación y validación', () => {
  it('rechaza sin token', async () => {
    expect((await post({ type: 'wet' }, null)).status).toBe(401)
  })

  it('rechaza un token sin el scope quick_diaper', async () => {
    expect((await post({ type: 'wet' }, nurseOnlyA)).status).toBe(403)
  })

  it('rechaza un tipo inválido', async () => {
    expect((await post({ type: 'lleno' }, pinnedB)).status).toBe(400)
  })

  it('rechaza un id que no es uuid', async () => {
    expect((await post({ type: 'wet', id: 'no-soy-uuid' }, pinnedB)).status).toBe(400)
  })
})

describe('/api/quick/diaper — escribe una vez, en el bebé del token', () => {
  it('el mismo id dos veces es UNA fila', async () => {
    const id = randomUUID()
    const first = await post({ type: 'both', id }, pinnedB)
    expect(first.status).toBe(200)
    expect((await first.json()).action).toBe('logged')
    const again = await post({ type: 'both', id }, pinnedB)
    expect(again.status).toBe(200)
    expect((await again.json()).action).toBe('already_logged')
    expect((await diapersOf(b.babyId)).filter((d) => d.id === id)).toHaveLength(1)
  })

  it('un token clavado a B escribe en B y la familia A no se entera', async () => {
    const before = (await diapersOf(a.babyId)).length
    expect((await post({ type: 'wet' }, pinnedB)).status).toBe(200)
    expect(await diapersOf(a.babyId)).toHaveLength(before)
  })

  it('reusar el id de una fila de OTRA familia es 409 y no la toca', async () => {
    const id = randomUUID()
    expect((await post({ type: 'dirty', id }, pinnedB)).status).toBe(200)
    const res = await post({ type: 'wet', id }, familyA)
    expect(res.status).toBe(409)
    const rowB = (await diapersOf(b.babyId)).find((d) => d.id === id)
    expect(rowB?.diaper_type).toBe('dirty')
    expect((await diapersOf(a.babyId)).find((d) => d.id === id)).toBeUndefined()
  })

  it('un token de A no puede apuntar al bebé de B con baby_id', async () => {
    const before = (await diapersOf(b.babyId)).length
    expect((await post({ type: 'wet', baby_id: b.babyId }, familyA)).status).toBe(403)
    expect(await diapersOf(b.babyId)).toHaveLength(before)
  })
})
