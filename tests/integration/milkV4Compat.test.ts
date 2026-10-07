import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient, type SeededFamily } from '../helpers/supabase'
import {
  FRIDGE_MS,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  containerRow,
  discardArgs,
  editArgs,
  feedOk,
  feedingRow,
  hasMilkV4,
  iso,
  liveDiscards,
  milkSnapshot,
  newBaby,
  pumpArgs,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Compatibilidad de 0015 con las dos apps que van a seguir corriendo cacheadas
// en los teléfonos (docs/arquitectura-v4.md §9): v0.12.1 (producción, escribe
// DIRECTO las tablas) y v3 (llama a las RPC de 0014 con sus nombres de
// argumentos). Las formas de las llamadas son las de
// docs/compatibilidad-leche.md §1 y las de tests/integration/milk.test.ts.
// Casos C-03…C-19 de docs/plan-pruebas-v4.md que se prueban en la base.
//
// Lo central: la app vieja nunca rompe lo nuevo (desglose, sobró, ediciones,
// biberones elegidos, desechos): recibe milk_rpc_only y la base no cambia.

const ready = await hasMilkV4()
let fx: V4Families

/** El alta de logPumping de v0.12.1, tal cual. */
const oldPumpRow = (f: SeededFamily, amountMl: number | null, side = 'both') => ({
  id: randomUUID(),
  baby_id: f.babyId,
  logged_by: f.userId,
  side,
  amount_ml: amountMl,
  notes: null as string | null,
  pumped_at: iso(Date.now() - HOUR),
})

/** El alta de logFeeding de v0.12.1 (biberón): sin desglose. */
const oldFeedRow = (f: SeededFamily, amountMl: number) => ({
  id: randomUUID(),
  baby_id: f.babyId,
  logged_by: f.userId,
  feeding_type: 'bottle',
  amount_ml: amountMl,
  fed_at: iso(Date.now() - HOUR),
})

describe.skipIf(!ready)('v4 · app v0.12.1 sobre 0015 (C-03…C-12)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-c0121')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('C-03 alta, reenvío, edición y borrado de una extracción legada: entran, sin contenedor ni biberón ocupado', async () => {
    const [f] = await newBaby(fx.a)
    const row = oldPumpRow(f, 90, 'left')
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    for (let i = 0; i < 2; i++)
      expect(
        (
          await f.client
            .from('pumping_sessions')
            .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        ).error,
      ).toBeNull()
    expect(
      (
        await f.client
          .from('pumping_sessions')
          .update({
            side: 'right',
            amount_ml: 95,
            notes: 'n',
            pumped_at: iso(Date.now() - 2 * HOUR),
          })
          .eq('id', row.id)
      ).error,
    ).toBeNull()
    expect((await milkSnapshot(f.babyId)).containers).toEqual([])
    // No ocupa ningún biberón: M1 se puede elegir.
    await pumpOk(f, 30, 'M1')
    expect(
      (
        await f.client
          .from('pumping_sessions')
          .update({ voided_at: iso(Date.now()) })
          .eq('id', row.id)
      ).error,
    ).toBeNull()
  })

  it('C-04 alta de biberón de v0.12.1: toma legada (sin desglose ni sobró), "lo que hay" igual', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M1')
    const row = oldFeedRow(f, 3 * OZ)
    expect((await f.client.from('feedings').insert(row)).error).toBeNull()
    expect(
      (await f.client.from('feedings').upsert(row, { onConflict: 'id', ignoreDuplicates: true }))
        .error,
    ).toBeNull()
    expect(await feedingRow(row.id)).toMatchObject({
      breast_milk_ml: null,
      formula_ml: null,
      leftover_ml: null,
    })
    expect(Number((await containerRow(p.containerId)).remaining_ml)).toBe(90)
  })

  it('C-05 borrar o cambiar la cantidad/tipo de una toma con desglose (v4, con sobró): milk_rpc_only y la base igual', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M1', Date.now() - 2 * HOUR)
    const id = await feedOk(f, [[p.containerId, 60]], { formula: 20, leftover: 10 })
    const before = await milkSnapshot(f.babyId)
    for (const patch of [
      { voided_at: iso(Date.now()) },
      { feeding_type: 'bottle', amount_ml: 100, fed_at: iso(Date.now() - HOUR) },
      { feeding_type: 'nursing', amount_ml: null },
      { amount_ml: 85 },
    ]) {
      const { error } = await f.client.from('feedings').update(patch).eq('id', id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('C-06 cambiar solo la hora (updateFeeding de v0.12.1): válida entra; con la leche vencida, milk_container_unusable:M#', async () => {
    const [f] = await newBaby(fx.a)
    const stored = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 90, 'M4', stored)
    const id = await feedOk(f, [[p.containerId, 30]], { formula: 10, at: stored + HOUR })
    const amount = (await feedingRow(id)).amount_ml
    const ok = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: amount, fed_at: iso(stored + 2 * HOUR) })
      .eq('id', id)
    expect(ok.error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    const bad = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: amount, fed_at: iso(Date.now() - MIN) })
      .eq('id', id)
    expect(bad.error?.message).toBe('milk_container_unusable:M4')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('C-07 borrar o editar una toma editada con edit_bottle_feed: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M1', Date.now() - 2 * HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]])
    expect(
      (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 2 * OZ, leftover: 5 })))
        .error,
    ).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (const patch of [
      { voided_at: iso(Date.now()) },
      { amount_ml: 3 * OZ },
      { leftover_ml: null },
    ]) {
      const { error } = await f.client.from('feedings').update(patch).eq('id', id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('C-08 borrar o editar una extracción creada con el selector: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 60, 'M2')
    const before = await milkSnapshot(f.babyId)
    for (const patch of [
      { voided_at: iso(Date.now()) },
      { amount_ml: 100 },
      { side: 'left', amount_ml: 60 },
      { pumped_at: iso(Date.now() - HOUR) },
    ]) {
      const { error } = await f.client.from('pumping_sessions').update(patch).eq('id', p.sessionId)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('C-09 borrar o editar una extracción desechada o libre: milk_rpc_only y el desecho intacto', async () => {
    const [f] = await newBaby(fx.a)
    const dis = await pumpOk(f, 60, 'M3', Date.now() - FRIDGE_MS - HOUR)
    await rpc(f.client, 'discard_container', discardArgs(dis.containerId))
    const free = await pumpOk(f, 30, 'M4', Date.now() - HOUR)
    await feedOk(f, [[free.containerId, 30]])
    const before = await milkSnapshot(f.babyId)
    for (const p of [dis, free]) {
      for (const patch of [{ voided_at: iso(Date.now()) }, { amount_ml: 10 }]) {
        const { error } = await f.client
          .from('pumping_sessions')
          .update(patch)
          .eq('id', p.sessionId)
        expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
      }
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    expect(Number((await liveDiscards(dis.containerId))[0].amount_ml)).toBe(60)
  })

  it('C-10/C-11 bajar el total de una toma legada por debajo del sobró (23514) o pasarla a nursing (entra): ver I-96', async () => {
    const [f] = await newBaby(fx.a)
    const row = oldFeedRow(f, 90)
    await f.client.from('feedings').insert(row)
    await f.client.from('feedings').update({ leftover_ml: 30 }).eq('id', row.id)
    const low = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: 20, fed_at: row.fed_at })
      .eq('id', row.id)
    expect(low.error?.code).toBe('23514')
    expect((await feedingRow(row.id)).amount_ml).toBe(90)
    const nursing = await f.client
      .from('feedings')
      .update({ feeding_type: 'nursing', amount_ml: null, fed_at: row.fed_at })
      .eq('id', row.id)
    expect(nursing.error).toBeNull()
  })

  it('C-12 cola offline de v0.12.1 (extracción + biberón + pañal) reenviada dos veces: 3 filas, sin duplicados', async () => {
    const [f] = await newBaby(fx.a)
    const pump = oldPumpRow(f, 80)
    const feed = oldFeedRow(f, 90)
    const diaper = {
      id: randomUUID(),
      baby_id: f.babyId,
      logged_by: f.userId,
      diaper_type: 'wet',
      changed_at: iso(Date.now()),
    }
    for (let i = 0; i < 2; i++) {
      for (const [table, row] of [
        ['pumping_sessions', pump],
        ['feedings', feed],
        ['diaper_changes', diaper],
      ] as const) {
        const { error } = await f.client
          .from(table)
          .upsert(row as Record<string, unknown>, { onConflict: 'id', ignoreDuplicates: true })
        expect(error, `${table} ${i}`).toBeNull()
      }
    }
    const admin = adminClient()
    for (const [table, id] of [
      ['pumping_sessions', pump.id],
      ['feedings', feed.id],
      ['diaper_changes', diaper.id],
    ] as const)
      expect((await admin.from(table).select('id').eq('id', id)).data).toHaveLength(1)
    expect((await milkSnapshot(f.babyId)).containers).toEqual([])
  })
})

describe.skipIf(!ready)(
  'v4 · app v3 (RPC de 0014 con sus argumentos) sobre 0015 (C-14…C-19)',
  () => {
    beforeAll(async () => {
      fx = await seedV4('mv4-cv3')
    })
    afterAll(async () => {
      await fx.cleanup()
    })
    afterEach(async () => {
      await assertMilkInvariant(fx.familyIds)
    })

    /** La llamada de log_pumping_session de v3 (lib/db.ts): diez argumentos con nombre. */
    const v3Pump = (f: SeededFamily, ml: number, label: string, at = Date.now()) =>
      pumpArgs(f, { left: ml, right: null, label, at })

    /** La de log_bottle_feed de v3: seis argumentos, sin p_leftover_ml. */
    const v3Feed = (
      f: SeededFamily,
      portions: [string, number][],
      formula = 0,
      at = Date.now(),
    ) => ({
      p_id: randomUUID(),
      p_baby_id: f.babyId,
      p_fed_at: iso(at),
      p_notes: null,
      p_formula_ml: formula,
      p_portions: portions.map(([container_id, amount_ml]) => ({ container_id, amount_ml })),
    })

    it('C-14 cinta M15 con N=6: entra (D-1)', async () => {
      const [f] = await newBaby(fx.a)
      expect((await rpc(f.client, 'log_pumping_session', v3Pump(f, 30, 'M15'))).error).toBeNull()
    })

    it('C-15 cinta de un contenedor ocupado: milk_label_taken:M# (el código que v3 traduce, AJ-1)', async () => {
      const [f] = await newBaby(fx.a)
      await pumpOk(f, 30, 'M2')
      expect((await rpc(f.client, 'log_pumping_session', v3Pump(f, 30, 'M2'))).error).toBe(
        'milk_label_taken:M2',
      )
    })

    it('C-16 servir y anular con seis argumentos con M3 reusado: v3 sin error, la leche va a lost_ml', async () => {
      const [f] = await newBaby(fx.a)
      const p = v3Pump(f, 60, 'M3', Date.now() - HOUR)
      expect((await rpc(f.client, 'log_pumping_session', p)).error).toBeNull()
      const feed = v3Feed(f, [[p.p_container_id!, 60]])
      expect((await rpc(f.client, 'log_bottle_feed', feed)).error).toBeNull()
      expect((await rpc(f.client, 'log_pumping_session', v3Pump(f, 40, 'M3'))).error).toBeNull()
      // v3 ignora el cuerpo; solo mira el error.
      expect(
        (await rpc(f.client, 'void_bottle_feed', { p_feeding_id: feed.p_id })).error,
      ).toBeNull()
      expect(Number((await containerRow(p.p_container_id!)).lost_ml)).toBe(60)
      // Y el reenvío de su cola (misma carga, seis argumentos) es no-op.
      expect((await rpc(f.client, 'log_bottle_feed', feed)).error).toBeNull()
    })

    it('C-17 v3 cambia la hora de una toma con desglose ({fed_at}): se re-valida', async () => {
      const [f] = await newBaby(fx.a)
      const stored = Date.now() - FRIDGE_MS - 2 * HOUR
      const p = await pumpOk(f, 60, 'M5', stored)
      const id = await feedOk(f, [[p.containerId, 30]], { at: stored + HOUR, sixArgs: true })
      expect(
        (
          await f.client
            .from('feedings')
            .update({ fed_at: iso(stored + 3 * HOUR) })
            .eq('id', id)
        ).error,
      ).toBeNull()
      expect(
        (
          await f.client
            .from('feedings')
            .update({ fed_at: iso(Date.now()) })
            .eq('id', id)
        ).error?.message,
      ).toBe('milk_container_unusable:M5')
    })

    it('C-19 v3 cambia la división de una extracción desechada (mismo total): entra, el desecho intacto', async () => {
      const [f] = await newBaby(fx.a)
      const at = Date.now() - FRIDGE_MS - HOUR
      const p = await pumpOk(f, 60, 'M6', at)
      await rpc(f.client, 'discard_container', discardArgs(p.containerId))
      const r = await rpc(f.client, 'update_pumping_session', {
        p_id: p.sessionId,
        p_side: 'both',
        p_left_ml: 20,
        p_right_ml: 40,
        p_notes: null,
        p_pumped_at: iso(at),
      })
      expect(r.error).toBeNull()
      const [d] = await liveDiscards(p.containerId)
      expect(Number(d.amount_ml)).toBe(60)
      expect(d.voided_at).toBeNull()
    })

    it('C-20 lo que la cola v4 manda (desechar, editar) funciona si la app vuelve a v3 con la base en 0015', async () => {
      const [f] = await newBaby(fx.a)
      const p = await pumpOk(f, 60, 'M1', Date.now() - FRIDGE_MS - HOUR)
      expect(
        (await rpc(f.client, 'discard_container', discardArgs(p.containerId))).error,
      ).toBeNull()
      const q = await pumpOk(f, 90, 'M2', Date.now() - HOUR)
      const id = await feedOk(f, [[q.containerId, 60]])
      expect(
        (await rpc(f.client, 'edit_bottle_feed', await editArgs(id, { breast: 30 }))).error,
      ).toBeNull()
    })
  },
)
