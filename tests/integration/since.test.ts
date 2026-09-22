import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { diapersSince, feedingsSince, nursingSince, sleepSince } from '@/lib/db'
import { adminClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

// Las lecturas de los totales de /feeding, /diapers y /sleep (lib/db.ts,
// `…Since`), por el camino real: PostgREST + JWT de un padre, con RLS. Que
// traigan todo desde el inicio de la ventana sin cortar, que una sesión que
// empezó antes y termina adentro (o sigue en curso) venga igual, que lo
// borrado no venga, y que nunca aparezca nada de la otra familia.

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

const SINCE = '2026-09-16T07:00:00.000Z' // 16 sep 00:00 en Los Ángeles
const BEFORE = '2026-09-15T05:00:00.000Z' // 15 sep 22:00
const INSIDE = '2026-09-16T13:00:00.000Z' // 16 sep 06:00
const LATER = '2026-09-18T13:00:00.000Z'

const ids = {
  nightSleep: randomUUID(), // empezó antes, terminó adentro
  oldSleep: randomUUID(), // entera antes de la ventana
  runningSleep: randomUUID(), // empezó antes, sigue en curso
  voidedSleep: randomUUID(),
  crossNursing: randomUUID(),
  oldNursing: randomUUID(),
  feedIn: randomUUID(),
  feedOut: randomUUID(),
  diaperIn: randomUUID(),
  diaperOut: randomUUID(),
  otherSleep: randomUUID(),
  otherFeed: randomUUID(),
}

beforeAll(async () => {
  ;({ a, b, cleanup } = await seedTwoFamilies('since'))
  const admin = adminClient()
  const by = { baby_id: a.babyId, logged_by: a.userId }
  const inserts: [string, Record<string, unknown>[]][] = [
    [
      'sleep_sessions',
      [
        { id: ids.nightSleep, ...by, started_at: BEFORE, ended_at: INSIDE, source: 'manual' },
        {
          id: ids.oldSleep,
          ...by,
          started_at: '2026-09-14T05:00:00Z',
          ended_at: '2026-09-14T13:00:00Z',
          source: 'manual',
        },
        { id: ids.runningSleep, ...by, started_at: BEFORE, ended_at: null, source: 'nuc_derived' },
        {
          id: ids.voidedSleep,
          ...by,
          started_at: LATER,
          ended_at: LATER,
          source: 'manual',
          voided_at: LATER,
        },
        {
          id: ids.otherSleep,
          baby_id: b.babyId,
          logged_by: b.userId,
          started_at: LATER,
          ended_at: null,
          source: 'manual',
        },
      ],
    ],
    [
      'nursing_sessions',
      [
        { id: ids.crossNursing, ...by, side: 'left', started_at: BEFORE, ended_at: INSIDE },
        {
          id: ids.oldNursing,
          ...by,
          side: 'right',
          started_at: '2026-09-14T05:00:00Z',
          ended_at: '2026-09-14T05:20:00Z',
        },
      ],
    ],
    [
      'feedings',
      [
        { id: ids.feedIn, ...by, feeding_type: 'bottle', amount_ml: 100, fed_at: INSIDE },
        { id: ids.feedOut, ...by, feeding_type: 'bottle', amount_ml: 100, fed_at: BEFORE },
        {
          id: ids.otherFeed,
          baby_id: b.babyId,
          logged_by: b.userId,
          feeding_type: 'solid',
          fed_at: INSIDE,
        },
      ],
    ],
    [
      'diaper_changes',
      [
        { id: ids.diaperIn, ...by, diaper_type: 'both', changed_at: SINCE },
        { id: ids.diaperOut, ...by, diaper_type: 'wet', changed_at: BEFORE },
      ],
    ],
  ]
  for (const [table, rows] of inserts) {
    const { error } = await admin.from(table).insert(rows)
    if (error) throw error
  }
})
afterAll(async () => {
  await cleanup()
})

const db = () => a.client.schema('public')

describe('lecturas …Since', () => {
  it('sueño: la sesión que cruza el inicio y la en curso vienen; lo viejo y lo borrado no', async () => {
    const { data, error } = await sleepSince(a.babyId, SINCE, db())
    expect(error).toBeNull()
    expect(data.map((r) => r.id).sort()).toEqual([ids.nightSleep, ids.runningSleep].sort())
  })

  it('pecho: la sesión que empezó antes y terminó adentro viene', async () => {
    const { data, error } = await nursingSince(a.babyId, SINCE, db())
    expect(error).toBeNull()
    expect(data.map((r) => r.id)).toEqual([ids.crossNursing])
  })

  it('tomas y pañales: desde el inicio de la ventana, inclusive', async () => {
    const feeds = await feedingsSince(a.babyId, SINCE, db())
    expect(feeds.error).toBeNull()
    expect(feeds.data.map((r) => r.id)).toEqual([ids.feedIn])
    const diapers = await diapersSince(a.babyId, SINCE, db())
    expect(diapers.error).toBeNull()
    expect(diapers.data.map((r) => r.id)).toEqual([ids.diaperIn])
  })

  it('RLS: pedir el bebé de la otra familia no devuelve nada', async () => {
    for (const read of [sleepSince, feedingsSince, nursingSince, diapersSince]) {
      const { data, error } = await read(b.babyId, SINCE, db())
      expect(error).toBeNull()
      expect(data).toEqual([])
    }
  })

  it('sin límite: más de 20 filas en la ventana vienen todas', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      baby_id: a.babyId,
      logged_by: a.userId,
      diaper_type: 'wet',
      changed_at: new Date(Date.parse(LATER) + i * 60_000).toISOString(),
    }))
    const { error: insErr } = await adminClient().from('diaper_changes').insert(rows)
    if (insErr) throw insErr
    const { data, error } = await diapersSince(a.babyId, SINCE, db())
    expect(error).toBeNull()
    expect(data).toHaveLength(46)
  })
})
