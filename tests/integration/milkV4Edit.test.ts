import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient } from '../helpers/supabase'
import {
  BAD_AMOUNTS,
  DAY,
  FRIDGE_MS,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  containerRow,
  discardArgs,
  editArgs,
  feedArgs,
  feedOk,
  feedingRow,
  hasMilkV4,
  iso,
  milkSnapshot,
  newBaby,
  portionsOf,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Inventario v4 (0015): edición completa de una toma — edit_bottle_feed
// (regla 17). Casos I-74…I-92 de docs/plan-pruebas-v4.md. Cada prueba con su
// propio bebé: "la más vieja a esa hora" no puede depender de lo que dejaron
// las anteriores.

const ready = await hasMilkV4()
let fx: V4Families

const remaining = async (id: string) => Number((await containerRow(id)).remaining_ml)

describe.skipIf(!ready)('v4 · edit_bottle_feed (I-74…I-92)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-edit')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-74 leche 3 → 2 oz, todo de M3: M3 recupera 1 oz', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 2 * OZ }))
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({ lost: [], taken: [] })
    expect((r.data as { returned_ml: number }).returned_ml).toBeCloseTo(OZ, 9)
    expect(await remaining(p.containerId)).toBeCloseTo(2 * OZ, 9)
    const row = await feedingRow(id)
    expect(Number(row.breast_milk_ml)).toBeCloseTo(2 * OZ, 9)
    expect(Number(row.amount_ml)).toBeCloseTo(2 * OZ, 9)
  })

  it('I-75 M3 1,75 (más viejo) + M4 1,25 (más nuevo) → 2 oz: vuelve 1 oz a M4, M3 intacto (D-17)', async () => {
    const [f] = await newBaby(fx.a)
    const m3 = await pumpOk(f, 1.75 * OZ, 'M3', Date.now() - 2 * DAY)
    const m4 = await pumpOk(f, 1.25 * OZ, 'M4', Date.now() - DAY)
    const id = await feedOk(f, [
      [m3.containerId, 1.75 * OZ],
      [m4.containerId, 1.25 * OZ],
    ])
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 2 * OZ }))).error,
    ).toBeNull()
    const portions = await portionsOf(id)
    expect(portions.M3).toBeCloseTo(1.75 * OZ, 9)
    expect(portions.M4).toBeCloseTo(0.25 * OZ, 9)
    expect(await remaining(m4.containerId)).toBeCloseTo(OZ, 9)
    // M4 se había vaciado; con su número libre, la leche lo re-ocupa.
    expect((await containerRow(m4.containerId)).released_at).toBeNull()
    expect((await containerRow(m3.containerId)).released_at).not.toBeNull()
  })

  it('I-75b bajar más que la porción más nueva: esa se anula y sigue con la siguiente', async () => {
    const [f] = await newBaby(fx.a)
    const m3 = await pumpOk(f, 2 * OZ, 'M3', Date.now() - 2 * DAY)
    const m4 = await pumpOk(f, OZ, 'M4', Date.now() - DAY)
    const id = await feedOk(f, [
      [m3.containerId, 2 * OZ],
      [m4.containerId, OZ],
    ])
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 1.5 * OZ }))).error,
    ).toBeNull()
    const portions = await portionsOf(id)
    expect(Object.keys(portions)).toEqual(['M3'])
    expect(portions.M3).toBeCloseTo(1.5 * OZ, 9)
    expect(await remaining(m4.containerId)).toBeCloseTo(OZ, 9)
    expect(await remaining(m3.containerId)).toBeCloseTo(0.5 * OZ, 9)
  })

  it('I-76 leche 2 → 3 oz con M5 (lunes) y M6 (martes) a esa hora: sale 1 oz de M5 (D-18)', async () => {
    const [f] = await newBaby(fx.a)
    const x = await pumpOk(f, 2 * OZ, 'M1', Date.now() - 3 * HOUR)
    const m6 = await pumpOk(f, 2 * OZ, 'M6', Date.now() - DAY)
    const m5 = await pumpOk(f, 2 * OZ, 'M5', Date.now() - 2 * DAY)
    const id = await feedOk(f, [[x.containerId, 2 * OZ]])
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 3 * OZ }))
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({ returned_ml: 0, lost: [] })
    expect((r.data as { taken: { label: string; ml: number }[] }).taken).toEqual([
      { label: 'M5', ml: OZ },
    ])
    expect(await remaining(m5.containerId)).toBeCloseTo(OZ, 9)
    expect(await remaining(m6.containerId)).toBeCloseTo(2 * OZ, 9)
    const portions = await portionsOf(id)
    expect(portions.M1).toBeCloseTo(2 * OZ, 9)
    expect(portions.M5).toBeCloseTo(OZ, 9)
  })

  it('I-76b la leche más vieja se mide A LA HORA de la toma: no entra una extracción posterior ni una vencida a esa hora', async () => {
    const [f] = await newBaby(fx.a)
    const fedAt = Date.now() - 2 * HOUR
    const x = await pumpOk(f, OZ, 'M1', fedAt - HOUR)
    // Vencía antes de la toma (aunque sea el más viejo).
    await pumpOk(f, 2 * OZ, 'M2', fedAt - FRIDGE_MS - HOUR)
    // Posterior a la toma.
    const after = await pumpOk(f, 5 * OZ, 'M3', fedAt + HOUR)
    const ok = await pumpOk(f, 2 * OZ, 'M4', fedAt - 2 * HOUR)
    const id = await feedOk(f, [[x.containerId, OZ]], { at: fedAt })
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 2 * OZ }))
    expect(r.error).toBeNull()
    expect((r.data as { taken: unknown[] }).taken).toEqual([{ label: 'M4', ml: OZ }])
    expect(await remaining(after.containerId)).toBeCloseTo(5 * OZ, 9)
    expect(await remaining(ok.containerId)).toBeCloseTo(OZ, 9)
  })

  it('I-77 leche 2 → 5 oz con 1 oz disponible a esa hora: milk_not_enough:29.5735 y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const x = await pumpOk(f, 2 * OZ, 'M1', Date.now() - 2 * HOUR)
    await pumpOk(f, OZ, 'M2', Date.now() - HOUR)
    const id = await feedOk(f, [[x.containerId, 2 * OZ]])
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 5 * OZ }))
    expect(r.error).toBe('milk_not_enough:29.5735')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    // Sin nada disponible, el sufijo es 0.
    const [g] = await newBaby(fx.a)
    const y = await pumpOk(g, OZ, 'M1', Date.now() - HOUR)
    const id2 = await feedOk(g, [[y.containerId, OZ]])
    const r2 = await rpc(g.client, 'edit_bottle_feed', await editArgs(id2, { breast: 2 * OZ }))
    expect(r2.error).toBe('milk_not_enough:0')
  })

  it('I-78 fórmula 1 → 3 oz sin leche en la heladera: se guarda', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, OZ]], { formula: OZ })
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { formula: 3 * OZ }))
    expect(r.error).toBeNull()
    const row = await feedingRow(id)
    expect(Number(row.formula_ml)).toBeCloseTo(3 * OZ, 9)
    expect(Number(row.amount_ml)).toBeCloseTo(4 * OZ, 9)
    // Y solo fórmula, sin porciones.
    const id2 = await feedOk(f, [], { formula: OZ })
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id2, { formula: 3 * OZ }))).error,
    ).toBeNull()
  })

  it('I-79 mover la hora a cuando M3 ya vencía: milk_container_unusable:M3 y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 2 * OZ, 'M3', at)
    const id = await feedOk(f, [[p.containerId, OZ]], { at: at + HOUR })
    const before = await milkSnapshot(f.babyId)
    for (const fedAt of [Date.now() - 10 * MIN, at + FRIDGE_MS, at - HOUR]) {
      const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { fedAt: iso(fedAt) }))
      expect(r.error, iso(fedAt)).toBe('milk_container_unusable:M3')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    // A una hora en que servía, sí.
    const ok = await rpc(
      f.client,
      'edit_bottle_feed',
      await editArgs(id, { fedAt: iso(at + 2 * HOUR) }),
    )
    expect(ok.error).toBeNull()
  })

  it('I-79b toma aceptada ANTES de la extracción (S-17): cambiar solo la nota, el sobró o la fórmula entra; mover la hora o la leche sí re-valida (m-1)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const p = await pumpOk(f, 2 * OZ, 'M3', at)
    // log_bottle_feed acepta una toma 3 h antes de que la leche entrara al
    // refri (solo mira la caducidad a la hora de la toma).
    const id = await feedOk(f, [[p.containerId, OZ]], { at: at - 3 * HOUR })
    for (const req of [{ notes: 'solo la nota' }, { leftover: 5 }, { formula: 10 }]) {
      const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, req))
      expect(r.error, JSON.stringify(req)).toBeNull()
    }
    const row = await feedingRow(id)
    expect(row.notes).toBe('solo la nota')
    expect(Number(row.leftover_ml)).toBe(5)
    expect(Number(row.formula_ml)).toBe(10)
    expect(await portionsOf(id)).toEqual({ M3: OZ })
    // Mover la hora (aunque sea un minuto) o la leche re-valida las porciones.
    const before = await milkSnapshot(f.babyId)
    for (const req of [{ fedAt: iso(at - 3 * HOUR + MIN) }, { breast: OZ / 2 }]) {
      const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, req))
      expect(r.error, JSON.stringify(req)).toBe('milk_container_unusable:M3')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-107 hora guardada con microsegundos y enviada al milisegundo: no es mover la hora (O-4) — solo nota entra sin re-validar y la hora no cambia', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const p = await pumpOk(f, 2 * OZ, 'M3', at)
    // La toma, anterior a la extracción (S-17), con una hora de microsegundos.
    const micro = iso(at - 3 * HOUR).replace('Z', '456Z')
    const args = feedArgs(f, [[p.containerId, OZ]], { at: at - 3 * HOUR })
    args.p_fed_at = micro
    expect((await rpc(f.client, 'log_bottle_feed', args)).error).toBeNull()
    const id = args.p_id as string
    const stored = (await feedingRow(id)).fed_at
    expect(stored).toMatch(/\.\d{3}456/)
    const ms = new Date(stored).toISOString()
    expect(Date.parse(ms)).toBe(Date.parse(stored))
    const r = await rpc(
      f.client,
      'edit_bottle_feed',
      await editArgs(id, { fedAt: ms, notes: 'solo la nota' }),
    )
    expect(r.error).toBeNull()
    const row = await feedingRow(id)
    expect(row.notes).toBe('solo la nota')
    expect(row.fed_at).toBe(stored)
    expect(await portionsOf(id)).toEqual({ M3: OZ })
    // Un milisegundo de diferencia sí es mover la hora: re-valida.
    const moved = iso(Date.parse(ms) + 1)
    const r2 = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { fedAt: moved }))
    expect(r2.error).toBe('milk_container_unusable:M3')
  })

  it('I-80 hora futura: milk_future_time', async () => {
    const [f] = await newBaby(fx.a)
    const id = await feedOk(f, [], { formula: OZ })
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(
      f.client,
      'edit_bottle_feed',
      await editArgs(id, { fedAt: iso(Date.now() + 11 * MIN) }),
    )
    expect(r.error).toBe('milk_future_time')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-81 A1 y A2 editan con el mismo esperado: uno entra, el otro milk_edit_conflict', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f1, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f1, [[p.containerId, 3 * OZ]])
    const [e1, e2] = [
      await editArgs(id, { breast: 2 * OZ }),
      await editArgs(id, { breast: 3.5 * OZ }),
    ]
    const r = await Promise.all([
      rpc(f1.client, 'edit_bottle_feed', e1),
      rpc(f2.client, 'edit_bottle_feed', e2),
    ])
    expect(r.map((x) => x.error).sort()).toEqual([null, 'milk_edit_conflict'].sort())
    const won = r[0].error === null ? 2 * OZ : 3.5 * OZ
    expect(Number((await feedingRow(id)).breast_milk_ml)).toBeCloseTo(won, 9)
  })

  it('I-82 reenvío del mismo p_op_id: no-op y devuelve el mismo resultado', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const args = await editArgs(id, { breast: 2 * OZ, leftover: 10 })
    const first = await rpc(f.client, 'edit_bottle_feed', args)
    expect(first.error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (let i = 0; i < 2; i++) expect(await rpc(f.client, 'edit_bottle_feed', args)).toEqual(first)
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    expect(before.edits).toHaveLength(1)
  })

  it('I-83 mismo p_op_id con otra carga: milk_idempotency_conflict', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const args = await editArgs(id, { breast: 2 * OZ })
    await rpc(f.client, 'edit_bottle_feed', args)
    const before = await milkSnapshot(f.babyId)
    for (const variant of [
      { ...args, p_breast_ml: 1.5 * OZ },
      { ...args, p_notes: 'otra' },
      { ...args, p_feeding_id: randomUUID() },
    ]) {
      expect((await rpc(f.client, 'edit_bottle_feed', variant)).error).toBe(
        'milk_idempotency_conflict',
      )
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-84 ABA: e1 A→B, e2 B→A desde el otro teléfono, reenvío tardío de e1: no-op, queda A', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f1, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f1, [[p.containerId, 3 * OZ]])
    const e1 = await editArgs(id, { breast: 2 * OZ })
    expect((await rpc(f1.client, 'edit_bottle_feed', e1)).error).toBeNull()
    const e2 = await editArgs(id, { breast: 3 * OZ })
    expect((await rpc(f2.client, 'edit_bottle_feed', e2)).error).toBeNull()
    const before = await milkSnapshot(f1.babyId)
    expect((await rpc(f1.client, 'edit_bottle_feed', e1)).error).toBeNull()
    expect(await milkSnapshot(f1.babyId)).toEqual(before)
    expect(Number((await feedingRow(id)).breast_milk_ml)).toBeCloseTo(3 * OZ, 9)
  })

  it('I-84b otra edición ya llegó al mismo estado: se registra el op y su reenvío también es no-op', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f1, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f1, [[p.containerId, 3 * OZ]])
    const e1 = await editArgs(id, { breast: 2 * OZ })
    const e2 = await editArgs(id, { breast: 2 * OZ })
    expect((await rpc(f1.client, 'edit_bottle_feed', e1)).error).toBeNull()
    const r2 = await rpc(f2.client, 'edit_bottle_feed', e2)
    expect(r2).toEqual({ data: { returned_ml: 0, lost: [], taken: [] }, error: null })
    expect((await milkSnapshot(f1.babyId)).edits).toHaveLength(2)
    expect(await remaining(p.containerId)).toBeCloseTo(2 * OZ, 9)
  })

  it('I-85 a la baja con M3 desechado: la toma baja, la leche va a lost_ml y lo dice (CL-30)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 3 * OZ, 'M3', at)
    const id = await feedOk(f, [[p.containerId, 2 * OZ]], { at: at + HOUR })
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const r = await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: OZ }))
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ returned_ml: 0, lost: [{ label: 'M3', ml: OZ }], taken: [] })
    const c = await containerRow(p.containerId)
    expect(Number(c.lost_ml)).toBeCloseTo(OZ, 9)
    expect(Number(c.remaining_ml)).toBe(0)
  })

  it('I-86 bajar la porción a 0 y volver a subir del mismo contenedor: se reaviva, sin fila duplicada', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 3 * OZ, 'M2', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, OZ]], { formula: OZ })
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 0 }))).error,
    ).toBeNull()
    expect(await portionsOf(id)).toEqual({})
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 1.5 * OZ }))).error,
    ).toBeNull()
    const { data: rows } = await adminClient()
      .from('milk_drawdowns')
      .select('amount_ml, voided_at')
      .eq('feeding_id', id)
    expect(rows).toHaveLength(1)
    expect(rows![0].voided_at).toBeNull()
    expect(Number(rows![0].amount_ml)).toBeCloseTo(1.5 * OZ, 9)
    expect(await remaining(p.containerId)).toBeCloseTo(1.5 * OZ, 9)
  })

  it('I-87 sobró mayor que el total nuevo: milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(
      f.client,
      'edit_bottle_feed',
      await editArgs(id, { breast: 2 * OZ, leftover: 2 * OZ + 0.01 }),
    )
    expect(r.error).toBe('milk_bad_input')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-88 toma sin desglose: milk_not_inventory', async () => {
    const [f] = await newBaby(fx.a)
    const id = randomUUID()
    await f.client.from('feedings').insert({
      id,
      baby_id: f.babyId,
      logged_by: f.userId,
      feeding_type: 'bottle',
      amount_ml: 90,
      fed_at: iso(Date.now() - HOUR),
    })
    const r = await rpc(f.client, 'edit_bottle_feed', {
      p_op_id: randomUUID(),
      p_feeding_id: id,
      p_fed_at: iso(Date.now() - HOUR),
      p_breast_ml: 30,
      p_formula_ml: 60,
      p_leftover_ml: null,
      p_notes: null,
      p_expected: {
        fed_at: iso(Date.now() - HOUR),
        breast_milk_ml: 0,
        formula_ml: 0,
        leftover_ml: null,
      },
    })
    expect(r.error).toBe('milk_not_inventory')
    expect(await feedingRow(id)).toMatchObject({
      breast_milk_ml: null,
      formula_ml: null,
      amount_ml: 90,
    })
  })

  it('I-89 toma anulada o de la familia B: milk_feeding_gone', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, OZ]])
    const args = await editArgs(id, { breast: 2 * OZ })
    expect((await rpc(fx.b.client, 'edit_bottle_feed', args)).error).toBe('milk_feeding_gone')
    await rpc(f.client, 'void_bottle_feed', { p_feeding_id: id })
    const before = await milkSnapshot(f.babyId)
    expect(
      (await rpc(f.client, 'edit_bottle_feed', { ...args, p_op_id: randomUUID() })).error,
    ).toBe('milk_feeding_gone')
    expect(
      (
        await rpc(f.client, 'edit_bottle_feed', {
          ...args,
          p_op_id: randomUUID(),
          p_feeding_id: randomUUID(),
        })
      ).error,
    ).toBe('milk_feeding_gone')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-90 edición mientras A2 sirve del contenedor candidato: se serializan y el plan se recalcula con los locks', async () => {
    for (let round = 0; round < 3; round++) {
      const [f1, f2] = await newBaby(fx.a, fx.a2)
      const x = await pumpOk(f1, OZ, 'M1', Date.now() - 3 * HOUR)
      const m5 = await pumpOk(f1, 2 * OZ, 'M5', Date.now() - 2 * HOUR)
      const id = await feedOk(f1, [[x.containerId, OZ]], { at: Date.now() - HOUR })
      const e = await editArgs(id, { breast: 2.5 * OZ })
      const [re, rf] = await Promise.all([
        rpc(f1.client, 'edit_bottle_feed', e),
        rpc(f2.client, 'log_bottle_feed', feedArgs(f2, [[m5.containerId, 1.5 * OZ]])),
      ])
      if (re.error === null) {
        expect(rf.error).toBe('milk_overdraw:M5')
        expect(await remaining(m5.containerId)).toBeCloseTo(0.5 * OZ, 9)
      } else {
        // 0,5 oz = 14,78675 ml, redondeado a 4 decimales (ARQ §3.0).
        expect(re.error).toBe('milk_not_enough:14.7868')
        expect(rf.error).toBeNull()
      }
      await assertMilkInvariant(fx.familyIds)
    }
  })

  it('I-91 milk_feeding_edits guarda before, request, result y logged_by; B y anon no lo ven', async () => {
    const [, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f2, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f2, [[p.containerId, 3 * OZ]], { formula: 10 })
    const args = await editArgs(id, { breast: 2 * OZ, notes: 'corregida' })
    const r = await rpc(f2.client, 'edit_bottle_feed', args)
    const { data: row } = await adminClient()
      .from('milk_feeding_edits')
      .select('op_id, feeding_id, family_id, baby_id, request, before, result, logged_by')
      .eq('op_id', args.p_op_id)
      .single()
    expect(row).toMatchObject({
      feeding_id: id,
      family_id: f2.familyId,
      baby_id: f2.babyId,
      logged_by: fx.a2.userId,
      result: r.data,
    })
    expect(row!.before).toMatchObject({ formula_ml: 10, notes: null, leftover_ml: null })
    expect(row!.before.portions).toEqual([
      { container_id: p.containerId, label: 'M1', amount_ml: 3 * OZ },
    ])
    expect(row!.request).toMatchObject({ feeding_id: id, notes: 'corregida' })
    // El padre la lee; la otra familia y anon, no.
    expect(
      (await fx.a.client.from('milk_feeding_edits').select('op_id').eq('feeding_id', id)).data,
    ).toHaveLength(1)
    expect(
      (await fx.b.client.from('milk_feeding_edits').select('op_id').eq('feeding_id', id)).data,
    ).toEqual([])
    expect((await anonClient().from('milk_feeding_edits').select('op_id')).error).not.toBeNull()
    // Nadie la escribe por fuera, ni la corrige.
    const ins = await fx.a.client.from('milk_feeding_edits').insert({ ...row, op_id: randomUUID() })
    expect(ins.error).not.toBeNull()
    const upd = await fx.a.client
      .from('milk_feeding_edits')
      .update({ result: {} })
      .eq('op_id', args.p_op_id)
      .select('op_id')
    expect(upd.error !== null || upd.data!.length === 0).toBe(true)
    expect(
      (
        await adminClient()
          .from('milk_feeding_edits')
          .select('result')
          .eq('op_id', args.p_op_id)
          .single()
      ).data!.result,
    ).toEqual(r.data)
  })

  it('I-92 topes en leche, fórmula y sobró; esperado mal formado: milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    const base = await editArgs(id, { breast: 2 * OZ })
    const before = await milkSnapshot(f.babyId)
    const variants: Record<string, unknown>[] = []
    for (const bad of BAD_AMOUNTS)
      for (const key of ['p_breast_ml', 'p_formula_ml', 'p_leftover_ml'])
        variants.push({ ...base, [key]: bad })
    variants.push(
      { ...base, p_breast_ml: 0, p_formula_ml: 0 },
      { ...base, p_breast_ml: null },
      { ...base, p_fed_at: null },
      { ...base, p_op_id: null },
      { ...base, p_expected: null },
      { ...base, p_expected: [] },
      { ...base, p_expected: { fed_at: base.p_expected.fed_at, breast_milk_ml: 1, formula_ml: 0 } },
      { ...base, p_expected: { ...base.p_expected, fed_at: 'ayer' } },
      { ...base, p_expected: { ...base.p_expected, fed_at: 123 } },
      { ...base, p_expected: { ...base.p_expected, breast_milk_ml: '3' } },
      { ...base, p_expected: { ...base.p_expected, leftover_ml: 'x' } },
    )
    for (const v of variants)
      expect((await rpc(f.client, 'edit_bottle_feed', v)).error, JSON.stringify(v)).toBe(
        'milk_bad_input',
      )
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })
})
