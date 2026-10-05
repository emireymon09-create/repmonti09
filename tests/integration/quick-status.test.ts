import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'
import { DEFAULT_FEED_THRESHOLD_MINUTES, dueFrom, lastFeedingEnd } from '@/lib/schedule'

// GET /api/quick/status — proposals/changer-display.md §5 y §10.2.

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let pinnedB: string
let diaperOnlyB: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  ;({ a, b, cleanup } = await seedTwoFamilies('quickstatus'))
  pinnedB = (
    await seedDeviceToken({ familyId: b.familyId, babyId: b.babyId, scopes: ['read_status'] })
  ).token
  diaperOnlyB = (
    await seedDeviceToken({ familyId: b.familyId, babyId: b.babyId, scopes: ['quick_diaper'] })
  ).token
})
afterAll(async () => {
  await cleanup()
})

beforeEach(() => {
  resetDeviceRateLimit()
})

async function get(token: string | null, query = '') {
  const { GET } = await import('@/app/api/quick/status/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  return GET(new NextRequest(new Request(`http://localhost/api/quick/status${query}`, { headers })))
}

describe('/api/quick/status', () => {
  it('rechaza sin token y sin el scope read_status', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await get(diaperOnlyB)).status).toBe(403)
  })

  it('no cruza de familia con baby_id', async () => {
    expect((await get(pinnedB, `?baby_id=${a.babyId}`)).status).toBe(403)
  })

  it('sin lactancia: último pañal, última comida y feed_due igual a lib/schedule', async () => {
    const db = adminClient()
    const fedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const changedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    await db.from('feedings').insert({ baby_id: b.babyId, fed_at: fedAt, feeding_type: 'bottle' })
    await db
      .from('diaper_changes')
      .insert({ baby_id: b.babyId, changed_at: changedAt, diaper_type: 'wet' })

    const res = await get(pinnedB)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nursing).toBeNull()
    expect(Date.parse(body.last_diaper.at)).toBe(Date.parse(changedAt))
    expect(body.last_diaper.type).toBe('wet')
    expect(Date.parse(body.last_feeding_end)).toBe(Date.parse(fedAt))

    const expected = dueFrom(
      lastFeedingEnd(
        [{ id: 'x', fed_at: fedAt, feeding_type: 'bottle', amount_ml: null, notes: null }],
        [],
      ),
      DEFAULT_FEED_THRESHOLD_MINUTES,
      Date.parse(body.now),
    )
    expect(Date.parse(body.feed_due.due_at)).toBe(Date.parse(expected!.dueAt))
    expect(body.feed_due.overdue).toBe(expected!.overdue)
  })

  it('con una lactancia corriendo: nursing presente y feed_due null', async () => {
    const db = adminClient()
    const startedAt = new Date(Date.now() - 12 * 60_000).toISOString()
    await db
      .from('nursing_sessions')
      .insert({ baby_id: b.babyId, side: 'left', started_at: startedAt, ended_at: null })
    const body = await (await get(pinnedB)).json()
    expect(body.nursing.side).toBe('left')
    expect(Date.parse(body.nursing.started_at)).toBe(Date.parse(startedAt))
    expect(body.feed_due).toBeNull()
    expect(body.last_feeding_end).not.toBeNull()
    await db
      .from('nursing_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('baby_id', b.babyId)
      .is('ended_at', null)
  })
})
