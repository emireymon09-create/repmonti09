import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { adminClient } from '../helpers/supabase'
import {
  DAY,
  HOUR,
  OZ,
  assertMilkInvariant,
  containerRow,
  feedOk,
  feedingRow,
  hasMilkV4,
  iso,
  liveDiscards,
  newBaby,
  portionsOf,
  pumpOk,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import type { SeededFamily } from '../helpers/supabase'
import {
  discardContainerOp,
  editBottleFeedOp,
  estimateLegacySplits,
  legacySplitInputs,
  listContainers,
  listDiscards,
  listDrawdowns,
  logBottleFeedOp,
  logPumpingOp,
  milkErrorText,
  milkResultOf,
  milkRules,
  saveMilkBottleCount,
  saveMilkRules,
  sendOpWith,
  voidBottleFeedOp,
} from '@/lib/db'
import { DEFAULT_MILK_RULES } from '@/lib/milk'
import type { Feeding } from '@/lib/types'

// La capa de datos de la leche v4 (H3) por el camino REAL de lib/db.ts: las ops
// que arma la app (logPumpingOp, discardContainerOp, logBottleFeedOp,
// editBottleFeedOp, voidBottleFeedOp) mandadas con sendOpWith como lo hace la
// cola, y las lecturas (listContainers, listDiscards, legacySplitInputs,
// milkRules) con el cliente de un padre autenticado: PostgREST + JWT + RLS.
//
// Lo que se prueba acá y no en milkV4*.test.ts (que llaman a las RPC a mano):
// que lo que arma lib/db.ts es lo que la base acepta, que un replay de cada op
// nueva deja el efecto UNA vez, y que las lecturas sin límite traen todo (I-100).

const ready = await hasMilkV4()
let fx: V4Families

const db = (f: SeededFamily) => f.client.schema('public')

/** La toma como la lee la app (las columnas de FEEDING_COLUMNS). */
async function feedingAsRead(f: SeededFamily, id: string): Promise<Feeding> {
  const { data, error } = await f.client
    .from('feedings')
    .select('id, fed_at, feeding_type, amount_ml, notes, breast_milk_ml, formula_ml, leftover_ml')
    .eq('id', id)
    .single()
  if (error) throw error
  return data as Feeding
}

async function editContext(f: SeededFamily) {
  const [containers, drawdowns, discards] = await Promise.all([
    listContainers(f.babyId, f.client),
    listDrawdowns(f.babyId, f.client),
    listDiscards(f.babyId, f.client),
  ])
  return { containers: containers.data, drawdowns: drawdowns.data, discards: discards.data }
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { count: n, error } = await adminClient()
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value)
  if (error) throw error
  return n ?? 0
}

const remaining = async (id: string) => Number((await containerRow(id)).remaining_ml)

describe.skipIf(!ready)('v4 · lib/db.ts por el camino real', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-db')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('log_pumping_session con el biberón elegido: el replay deja una sesión y un contenedor', async () => {
    const [f] = await newBaby(fx.a)
    const built = logPumpingOp(
      f.babyId,
      f.userId,
      { left_ml: 2 * OZ, right_ml: OZ, notes: null, pumped_at: iso(Date.now() - HOUR) },
      { rules: DEFAULT_MILK_RULES },
      'M4',
    )!
    for (let i = 0; i < 2; i++) {
      expect((await sendOpWith(db(f), built.op, 'replay')).error).toBeNull()
    }
    expect(await count('pumping_sessions', 'id', built.op.id)).toBe(1)
    const listed = (await listContainers(f.babyId, f.client)).data
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ label: 'M4', released_at: null, lost_ml: 0 })
    expect(listed[0].remaining_ml).toBeCloseTo(3 * OZ, 9)
    expect(listed[0].id).toBe(built.op.creates![0])
  })

  it('discard_container: replay = un solo desecho; listDiscards lo trae con su número', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 2 * OZ, 'M2', Date.now() - 5 * DAY)
    const [c] = (await listContainers(f.babyId, f.client)).data
    const op = discardContainerOp(f.babyId, f.userId, c)
    for (let i = 0; i < 2; i++) {
      const sent = await sendOpWith(db(f), op, 'replay')
      expect(sent.error).toBeNull()
    }
    expect(await liveDiscards(p.containerId)).toHaveLength(1)
    const discards = (await listDiscards(f.babyId, f.client)).data
    expect(discards).toHaveLength(1)
    expect(discards[0]).toMatchObject({ id: op.id, container_id: c.id, label: 'M2' })
    expect(discards[0].amount_ml).toBeCloseTo(2 * OZ, 9)
    const after = (await listContainers(f.babyId, f.client)).data[0]
    expect(after.remaining_ml).toBe(0)
    expect(after.released_at).toBeTruthy()
    // La otra familia no lo ve (RLS).
    expect((await listDiscards(f.babyId, fx.b.client)).data).toEqual([])
  })

  it('discard_container antes de vencer: rechazo milk_not_expired:M# con texto para la pantalla', async () => {
    const [f] = await newBaby(fx.a)
    await pumpOk(f, OZ, 'M1')
    const [c] = (await listContainers(f.babyId, f.client)).data
    const sent = await sendOpWith(db(f), discardContainerOp(f.babyId, f.userId, c), 'write')
    expect(sent.error).toBe('milk_not_expired:M1')
    expect(milkErrorText(sent.error, 'es')).toMatch(/de M1 todavía no venció/)
    expect((await listDiscards(f.babyId, f.client)).data).toEqual([])
  })

  it('log_bottle_feed con sobró: replay = una toma, se descuenta una vez, sobró guardado', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const op = logBottleFeedOp(f.babyId, f.userId, {
      fed_at: iso(Date.now()),
      notes: null,
      formula_ml: OZ,
      portions: [{ container_id: p.containerId, amount_ml: 3 * OZ }],
      leftover_ml: OZ,
    })
    for (let i = 0; i < 2; i++) {
      expect((await sendOpWith(db(f), op, 'replay')).error).toBeNull()
    }
    expect(await count('feedings', 'id', op.id)).toBe(1)
    expect(await remaining(p.containerId)).toBeCloseTo(OZ, 9)
    const read = await feedingAsRead(f, op.id)
    expect(Number(read.leftover_ml)).toBeCloseTo(OZ, 9)
    expect(Number(read.amount_ml)).toBeCloseTo(4 * OZ, 9)
  })

  it('edit_bottle_feed: el mismo op dos veces se aplica una; devuelve lo que movió', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const seen = await feedingAsRead(f, id)
    const op = editBottleFeedOp(
      seen,
      { fed_at: seen.fed_at, breast_ml: 2 * OZ, formula_ml: OZ, leftover_ml: 0, notes: 'menos' },
      await editContext(f),
    )
    expect(op.refs).toEqual([p.containerId])
    const first = await sendOpWith(db(f), op, 'replay')
    expect(first.error).toBeNull()
    const moved = milkResultOf(first.data)!
    expect(moved.returned_ml).toBeCloseTo(OZ, 9)
    expect(moved.lost).toEqual([])
    expect(await remaining(p.containerId)).toBeCloseTo(2 * OZ, 9)

    const again = await sendOpWith(db(f), op, 'replay')
    expect(again.error).toBeNull()
    expect(milkResultOf(again.data)!.returned_ml).toBeCloseTo(OZ, 9)
    expect(await remaining(p.containerId)).toBeCloseTo(2 * OZ, 9)
    expect(await portionsOf(id)).toEqual({ M3: expect.closeTo(2 * OZ, 9) })
    const row = await feedingRow(id)
    expect(row).toMatchObject({ notes: 'menos' })
    expect(Number(row.leftover_ml)).toBe(0)
    expect(Number(row.formula_ml)).toBeCloseTo(OZ, 9)
  })

  it('edit_bottle_feed: un reenvío tardío después de otra edición no la pisa (ABA, AJ-3)', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const seen = await feedingAsRead(f, id)
    const toTwo = editBottleFeedOp(
      seen,
      { fed_at: seen.fed_at, breast_ml: 2 * OZ, formula_ml: 0, leftover_ml: null, notes: null },
      await editContext(f),
    )
    expect((await sendOpWith(db(f), toTwo, 'write')).error).toBeNull()
    const seenAtTwo = await feedingAsRead(f, id)
    // El otro teléfono la vuelve a 3 oz.
    const seen2 = await feedingAsRead(f2, id)
    const backToThree = editBottleFeedOp(
      seen2,
      { fed_at: seen2.fed_at, breast_ml: 3 * OZ, formula_ml: 0, leftover_ml: null, notes: null },
      await editContext(f2),
    )
    expect((await sendOpWith(db(f2), backToThree, 'write')).error).toBeNull()
    // Llega tarde el reenvío de la primera: no-op, queda en 3 oz.
    expect((await sendOpWith(db(f), toTwo, 'replay')).error).toBeNull()
    expect(Number((await feedingRow(id)).breast_milk_ml)).toBeCloseTo(3 * OZ, 9)
    expect(await remaining(p.containerId)).toBeCloseTo(OZ, 9)
    // Y un intento NUEVO armado con lo que esta pantalla vio en 2 oz: conflicto.
    const stale = editBottleFeedOp(
      seenAtTwo,
      { fed_at: seenAtTwo.fed_at, breast_ml: OZ, formula_ml: 0, leftover_ml: null, notes: null },
      await editContext(f),
    )
    const refused = await sendOpWith(db(f), stale, 'write')
    expect(refused.error).toBe('milk_edit_conflict')
    expect(milkErrorText(refused.error, 'es')).toMatch(/otro teléfono/)
  })

  it('edit_bottle_feed sin leche suficiente: milk_not_enough con los ml, en oz para la pantalla', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 2 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, OZ]])
    const seen = await feedingAsRead(f, id)
    const op = editBottleFeedOp(
      seen,
      { fed_at: seen.fed_at, breast_ml: 5 * OZ, formula_ml: 0, leftover_ml: null, notes: null },
      await editContext(f),
    )
    const sent = await sendOpWith(db(f), op, 'write')
    expect(sent.error).toMatch(/^milk_not_enough:/)
    expect(milkErrorText(sent.error, 'en')).toMatch(/only 1 oz/)
    expect(await remaining(p.containerId)).toBeCloseTo(OZ, 9)
  })

  it('void_bottle_feed: devuelve el jsonb; el replay no devuelve dos veces', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 3 * OZ, 'M5', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 2 * OZ]])
    const op = voidBottleFeedOp(id)
    const first = await sendOpWith(db(f), op, 'replay')
    expect(first.error).toBeNull()
    expect(milkResultOf(first.data)).toMatchObject({ lost: [] })
    expect(milkResultOf(first.data)!.returned_ml).toBeCloseTo(2 * OZ, 9)
    const again = await sendOpWith(db(f), op, 'replay')
    expect(milkResultOf(again.data)).toEqual({ returned_ml: 0, lost: [], taken: [] })
    expect(await remaining(p.containerId)).toBeCloseTo(3 * OZ, 9)
  })

  it('void_bottle_feed con la leche que no puede volver (D-9): el jsonb lo nombra', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 2 * OZ, 'M6', Date.now() - 2 * HOUR)
    const id = await feedOk(f, [[p.containerId, 2 * OZ]])
    // M6 quedó vacío y libre; otra extracción ocupa el número.
    await pumpOk(f, OZ, 'M6', Date.now() - HOUR)
    const sent = await sendOpWith(db(f), voidBottleFeedOp(id), 'write')
    expect(sent.error).toBeNull()
    const r = milkResultOf(sent.data)!
    expect(r.returned_ml).toBe(0)
    expect(r.lost).toHaveLength(1)
    expect(r.lost[0].label).toBe('M6')
    expect(r.lost[0].ml).toBeCloseTo(2 * OZ, 9)
  })

  it('milkRules / saveMilkRules / saveMilkBottleCount: N lo ven los dos padres; otra familia no puede (I-98, I-99)', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    expect((await milkRules(f.babyId, f.client)).data?.milk_bottle_count).toBe(6)
    expect((await saveMilkBottleCount(f.babyId, 4, f.client)).error).toBeNull()
    expect((await milkRules(f.babyId, f2.client)).data?.milk_bottle_count).toBe(4)
    const both = await saveMilkRules(
      f.babyId,
      { ...DEFAULT_MILK_RULES, milk_fridge_days: 3, milk_bottle_count: 8 },
      f2.client,
    )
    expect(both.error).toBeNull()
    expect((await milkRules(f.babyId, f.client)).data).toMatchObject({
      milk_fridge_days: 3,
      milk_bottle_count: 8,
    })
    // Sin N: las reglas solas no lo tocan.
    expect((await saveMilkRules(f.babyId, DEFAULT_MILK_RULES, f.client)).error).toBeNull()
    expect((await milkRules(f.babyId, f.client)).data?.milk_bottle_count).toBe(8)
    expect((await saveMilkBottleCount(f.babyId, 2, fx.b.client)).error).toBe('milk_baby_not_found')
    expect((await saveMilkBottleCount(f.babyId, 31, f.client)).error).toBeTruthy()
    expect((await milkRules(f.babyId, f.client)).data?.milk_bottle_count).toBe(8)
  })

  it('I-100: contenedores, desechos y entradas de la estimación vienen TODOS (> 100), sin límite', async () => {
    const [f] = await newBaby(fx.a)
    const N = 105
    const old = Date.now() - 6 * DAY
    for (let i = 1; i <= N; i++) {
      const built = logPumpingOp(
        f.babyId,
        f.userId,
        { left_ml: OZ, right_ml: null, notes: null, pumped_at: iso(old + i * 1000) },
        { rules: DEFAULT_MILK_RULES },
        `M${i}`,
      )!
      const sent = await sendOpWith(db(f), built.op, 'write')
      expect(sent.error, `M${i}`).toBeNull()
    }
    const containers = (await listContainers(f.babyId, f.client)).data
    expect(containers).toHaveLength(N)
    for (const c of containers) {
      expect(
        (await sendOpWith(db(f), discardContainerOp(f.babyId, f.userId, c), 'write')).error,
      ).toBeNull()
    }
    const discards = (await listDiscards(f.babyId, f.client)).data
    expect(discards).toHaveLength(N)
    expect(new Set(discards.map((d) => d.label)).size).toBe(N)

    // Tomas viejas sin desglose (como las de v0.12.1): un INSERT directo, que el
    // trigger deja pasar porque no tienen desglose.
    const { error } = await f.client.from('feedings').insert(
      Array.from({ length: N }, (_, i) => ({
        baby_id: f.babyId,
        logged_by: f.userId,
        feeding_type: 'bottle',
        amount_ml: 30,
        fed_at: iso(old + (N + i) * 1000),
      })),
    )
    expect(error).toBeNull()
    const inputs = await legacySplitInputs(f.babyId, f.client)
    expect(inputs.error).toBeNull()
    expect(inputs.data.feedings).toHaveLength(N)
    expect(inputs.data.pumping).toHaveLength(N)
    expect(inputs.data.containerSessionIds).toHaveLength(N)
    // Toda extracción llenó un biberón: no hay pozo y la estimación es fórmula.
    const split = estimateLegacySplits(inputs.data, DEFAULT_MILK_RULES.milk_fridge_days)
    expect(split.size).toBe(N)
    for (const s of split.values()) expect(s.breastMl).toBe(0)
    // Otra familia: nada.
    const other = await legacySplitInputs(f.babyId, fx.b.client)
    expect(other.data).toEqual({ feedings: [], pumping: [], containerSessionIds: [] })
  }, 120_000)
})
