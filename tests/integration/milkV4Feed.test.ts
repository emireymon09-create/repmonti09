import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient, type SeededFamily } from '../helpers/supabase'
import {
  BAD_AMOUNTS,
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
  liveDiscards,
  milkSnapshot,
  newBaby,
  pumpArgs,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Inventario v4 (0015): la toma de biberón — log_bottle_feed (siete
// argumentos, el último con default) y void_bottle_feed (devuelve jsonb).
// Casos I-51…I-73 de docs/plan-pruebas-v4.md.

const ready = await hasMilkV4()
let fx: V4Families

const occupied = async (babyId: string, label: string) =>
  (
    await adminClient()
      .from('milk_containers')
      .select('id')
      .eq('baby_id', babyId)
      .eq('label', label)
      .is('voided_at', null)
      .is('released_at', null)
  ).data!

describe.skipIf(!ready)('v4 · log_bottle_feed (I-51…I-65)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-feed')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-51 3 oz de M3 con "sobró 1 oz": M3 baja 3 oz, sobró guardado, nada desechado', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 3 * OZ]], { leftover: OZ })
    expect(await feedingRow(id)).toMatchObject({ leftover_ml: OZ, voided_at: null })
    expect(Number((await feedingRow(id)).amount_ml)).toBeCloseTo(3 * OZ, 9)
    expect(Number((await containerRow(p.containerId)).remaining_ml)).toBeCloseTo(OZ, 9)
    expect((await milkSnapshot(f.babyId)).discards).toEqual([])
  })

  it('I-52 sobró mayor que lo servido: milk_bad_input y nada escrito', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(
      f.client,
      'log_bottle_feed',
      feedArgs(f, [[p.containerId, 2 * OZ]], { formula: OZ, leftover: 3 * OZ + 0.001 }),
    )
    expect(r.error).toBe('milk_bad_input')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    // Igual al total sí (CL-20: "más de lo que se sirvió").
    await feedOk(f, [[p.containerId, 2 * OZ]], { formula: OZ, leftover: 3 * OZ })
  })

  it('I-53 la llamada de seis argumentos de la app v3: entra, sobró nulo', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 2 * OZ, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, OZ]], { sixArgs: true, formula: 10 })
    expect((await feedingRow(id)).leftover_ml).toBeNull()
  })

  it('I-54 la toma deja M3 con 0,1 ml: M3 queda libre', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    await feedOk(f, [[p.containerId, 59.9]])
    const c = await containerRow(p.containerId)
    expect(c.released_at).not.toBeNull()
    expect(Number(c.remaining_ml)).toBeCloseTo(0.1, 9)
    // Sin descontar nada que no se sirvió.
    expect(Number(c.lost_ml)).toBe(0)
  })

  it('I-55 servir de un liberado o de un desechado: milk_overdraw:M# (AJ-6, D-22)', async () => {
    const [f] = await newBaby(fx.a)
    const freed = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    await feedOk(f, [[freed.containerId, 59.9]])
    const at = Date.now() - FRIDGE_MS - HOUR
    const dis = await pumpOk(f, 60, 'M4', at)
    await rpc(f.client, 'discard_container', discardArgs(dis.containerId))
    const before = await milkSnapshot(f.babyId)
    // Del liberado, aun pidiendo menos que el polvo que le queda.
    const r1 = await rpc(f.client, 'log_bottle_feed', feedArgs(f, [[freed.containerId, 0.05]]))
    expect(r1.error).toBe('milk_overdraw:M3')
    // Del desechado, con una hora en que todavía no vencía (la toma offline).
    const r2 = await rpc(
      f.client,
      'log_bottle_feed',
      feedArgs(f, [[dis.containerId, 10]], { at: at + 10 * MIN }),
    )
    expect(r2.error).toBe('milk_overdraw:M4')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-56 vencido a la hora de la toma, anulado o de otro bebé: milk_container_unusable:M#', async () => {
    const [f] = await newBaby(fx.a)
    const [sib] = await newBaby(fx.a)
    const expired = await pumpOk(f, 60, 'M1', Date.now() - FRIDGE_MS - HOUR)
    const voided = await pumpOk(f, 60, 'M2')
    await rpc(f.client, 'void_pumping_session', { p_id: voided.sessionId })
    const other = await pumpOk(sib, 60, 'M9')
    const before = await milkSnapshot(f.babyId)
    for (const [id, label] of [
      [expired.containerId, 'M1'],
      [voided.containerId, 'M2'],
      [other.containerId, 'M9'],
    ]) {
      const r = await rpc(f.client, 'log_bottle_feed', feedArgs(f, [[id, 10]]))
      expect(r.error, label).toBe(`milk_container_unusable:${label}`)
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-57 hora de la toma: +11 min según la base → milk_future_time; +9 min → entra', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    const before = await milkSnapshot(f.babyId)
    const late = feedArgs(f, [[p.containerId, 10]], { at: Date.now() + 11 * MIN })
    expect((await rpc(f.client, 'log_bottle_feed', late)).error).toBe('milk_future_time')
    // Solo fórmula también: la regla es de la hora, no de la leche.
    const lateFormula = feedArgs(f, [], { at: Date.now() + 11 * MIN, formula: 30 })
    expect((await rpc(f.client, 'log_bottle_feed', lateFormula)).error).toBe('milk_future_time')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    await feedOk(f, [[p.containerId, 10]], { at: Date.now() + 9 * MIN })
  })

  it('I-58 toma de las 2 a.m. de leche que venció a las 8, enviada a las 9: entra', async () => {
    const [f] = await newBaby(fx.a)
    // Venció hace 1 h; la toma fue hace 7 h, cuando servía.
    const p = await pumpOk(f, 60, 'M3', Date.now() - FRIDGE_MS - HOUR)
    await feedOk(f, [[p.containerId, 30]], { at: Date.now() - 7 * HOUR })
    expect(Number((await containerRow(p.containerId)).remaining_ml)).toBe(30)
  })

  it('I-59 reenvío con la misma carga (sobró incluido): no-op', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const args = feedArgs(f, [[p.containerId, 60]], { formula: 20, leftover: 15 })
    expect((await rpc(f.client, 'log_bottle_feed', args)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (let i = 0; i < 3; i++)
      expect((await rpc(f.client, 'log_bottle_feed', args)).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-60 mismo id, otro sobró: milk_idempotency_conflict', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const args = feedArgs(f, [[p.containerId, 60]], { leftover: 15 })
    await rpc(f.client, 'log_bottle_feed', args)
    const before = await milkSnapshot(f.babyId)
    for (const leftover of [16, null]) {
      const r = await rpc(f.client, 'log_bottle_feed', { ...args, p_leftover_ml: leftover })
      expect(r.error, String(leftover)).toBe('milk_idempotency_conflict')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-61 el reenvío del alta después de una edición completa: no-op (AJ-8)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 4 * OZ, 'M3', Date.now() - HOUR)
    const args = feedArgs(f, [[p.containerId, 3 * OZ]], { formula: OZ })
    await rpc(f.client, 'log_bottle_feed', args)
    const e = await editArgs(args.p_id as string, { breast: 2 * OZ, leftover: OZ / 2 })
    expect((await rpc(f.client, 'edit_bottle_feed', e)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    expect((await rpc(f.client, 'log_bottle_feed', args)).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-62 A1 y A2 sirven el último 1 oz de M3 a la vez: uno entra, el otro milk_overdraw:M3', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f1, OZ, 'M3', Date.now() - HOUR)
    const r = await Promise.all([
      rpc(f1.client, 'log_bottle_feed', feedArgs(f1, [[p.containerId, OZ]])),
      rpc(f2.client, 'log_bottle_feed', feedArgs(f2, [[p.containerId, OZ]])),
    ])
    expect(r.map((x) => x.error).sort()).toEqual([null, 'milk_overdraw:M3'].sort())
    expect((await containerRow(p.containerId)).released_at).not.toBeNull()
  })

  it('I-63 solo fórmula sin leche en la heladera: entra (la fórmula nunca bloquea)', async () => {
    const [f] = await newBaby(fx.a)
    const id = await feedOk(f, [], { formula: 3 * OZ })
    expect(await feedingRow(id)).toMatchObject({ breast_milk_ml: 0, leftover_ml: null })
  })

  it('I-64 topes en fórmula, porciones y sobró: milk_bad_input y nada escrito', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const before = await milkSnapshot(f.babyId)
    for (const bad of BAD_AMOUNTS) {
      const variants: Record<string, unknown>[] = [
        { ...feedArgs(f, [[p.containerId, 10]]), p_formula_ml: bad },
        { ...feedArgs(f, [[p.containerId, 10]]), p_leftover_ml: bad },
      ]
      if (typeof bad === 'number') variants.push(feedArgs(f, [[p.containerId, bad]]))
      else
        variants.push({
          ...feedArgs(f, []),
          p_portions: [{ container_id: p.containerId, amount_ml: bad }],
        })
      for (const v of variants)
        expect((await rpc(f.client, 'log_bottle_feed', v)).error, JSON.stringify(v)).toBe(
          'milk_bad_input',
        )
    }
    // Porción repetida, porción en cero, porción mal formada, nada de nada.
    for (const portions of [
      [
        { container_id: p.containerId, amount_ml: 5 },
        { container_id: p.containerId, amount_ml: 5 },
      ],
      [{ container_id: p.containerId, amount_ml: 0 }],
      [{ container_id: 'no-es-uuid', amount_ml: 5 }],
      [],
    ]) {
      const r = await rpc(f.client, 'log_bottle_feed', { ...feedArgs(f, []), p_portions: portions })
      expect(r.error, JSON.stringify(portions)).toBe('milk_bad_input')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-65 contenedor de la familia B: milk_container_unusable', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(fx.b.client, 'log_bottle_feed', feedArgs(fx.b, [[p.containerId, 10]]))
    expect(r.error).toBe('milk_container_unusable')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })
})

describe.skipIf(!ready)('v4 · void_bottle_feed (I-66…I-73)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-vfeed')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  const voidFeed = (f: SeededFamily, id: string) =>
    rpc(f.client, 'void_bottle_feed', { p_feeding_id: id })

  it('I-66 devuelve a M3 ocupado: remaining sube y el jsonb lo dice', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 60]], { formula: 10 })
    const r = await voidFeed(f, id)
    expect(r).toEqual({ data: { returned_ml: 60, lost: [] }, error: null })
    expect(Number((await containerRow(p.containerId)).remaining_ml)).toBe(90)
    expect((await feedingRow(id)).voided_at).not.toBeNull()
  })

  it('I-67 M3 vaciado y su número libre: la leche vuelve y lo re-ocupa (CL-9)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 59.9]])
    expect((await containerRow(p.containerId)).released_at).not.toBeNull()
    const r = await voidFeed(f, id)
    expect(r.error).toBeNull()
    expect((r.data as { lost: unknown[] }).lost).toEqual([])
    const c = await containerRow(p.containerId)
    expect(c.released_at).toBeNull()
    expect(Number(c.remaining_ml)).toBe(60)
  })

  it('I-68 M3 vaciado y su número reusado: la toma se anula, la leche va a lost_ml y lo dice (CL-10)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 59.9]])
    const reuse = await pumpOk(f, 40, 'M3')
    const r = await voidFeed(f, id)
    expect(r).toEqual({ data: { returned_ml: 0, lost: [{ label: 'M3', ml: 59.9 }] }, error: null })
    const c = await containerRow(p.containerId)
    expect(Number(c.lost_ml)).toBe(59.9)
    expect(c.released_at).not.toBeNull()
    expect((await feedingRow(id)).voided_at).not.toBeNull()
    // Nunca dos M3 ocupados; el nuevo no recibió nada.
    expect((await occupied(f.babyId, 'M3')).map((c) => c.id)).toEqual([reuse.containerId])
    expect(Number((await containerRow(reuse.containerId)).remaining_ml)).toBe(40)
  })

  it('I-69 M3 desechado: la leche va a lost_ml y lo desechado no cambia (D-9)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 90, 'M3', at)
    const id = await feedOk(f, [[p.containerId, 30]], { at: at + HOUR })
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const r = await voidFeed(f, id)
    expect(r).toEqual({ data: { returned_ml: 0, lost: [{ label: 'M3', ml: 30 }] }, error: null })
    expect(Number((await liveDiscards(p.containerId))[0].amount_ml)).toBe(60)
    expect(Number((await containerRow(p.containerId)).lost_ml)).toBe(30)
  })

  it('I-70 M3 vencido (ocupado): la leche vuelve y queda como caducada', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 90, 'M3', at)
    const id = await feedOk(f, [[p.containerId, 30]], { at: at + HOUR })
    const r = await voidFeed(f, id)
    expect(r).toEqual({ data: { returned_ml: 30, lost: [] }, error: null })
    const c = await containerRow(p.containerId)
    expect(Number(c.remaining_ml)).toBe(90)
    expect(c.released_at).toBeNull()
    expect(Date.parse(c.expires_at)).toBeLessThan(Date.now())
  })

  it('I-70b una toma de dos biberones, uno re-ocupable y otro reusado: el jsonb separa', async () => {
    const [f] = await newBaby(fx.a)
    const x = await pumpOk(f, 30, 'M1', Date.now() - 2 * HOUR)
    const y = await pumpOk(f, 30, 'M2', Date.now() - HOUR)
    const id = await feedOk(f, [
      [x.containerId, 30],
      [y.containerId, 20],
    ])
    await pumpOk(f, 50, 'M1')
    const r = await voidFeed(f, id)
    expect(r).toEqual({ data: { returned_ml: 20, lost: [{ label: 'M1', ml: 30 }] }, error: null })
  })

  it('I-71 dos veces o inexistente: no-op con {"returned_ml":0,"lost":[]}', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 30]])
    await voidFeed(f, id)
    const before = await milkSnapshot(f.babyId)
    for (const target of [id, randomUUID()])
      expect(await voidFeed(f, target)).toEqual({
        data: { returned_ml: 0, lost: [] },
        error: null,
      })
    // La familia B no la ve: también no-op.
    expect((await voidFeed(fx.b, id)).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-72 A1 anula una toma mientras A2 crea un M3 nuevo: nunca dos M3 ocupados', async () => {
    for (let round = 0; round < 4; round++) {
      const [f1, f2] = await newBaby(fx.a, fx.a2)
      const p = await pumpOk(f1, 60, 'M3', Date.now() - HOUR)
      const id = await feedOk(f1, [[p.containerId, 59.9]])
      const [v, n] = await Promise.all([
        voidFeed(f1, id),
        rpc(f2.client, 'log_pumping_session', pumpArgs(f2, { left: 40, label: 'M3' })),
      ])
      expect(v.error).toBeNull()
      const lost = (v.data as { lost: { label: string }[] }).lost
      if (n.error === null) {
        // Llegó primero la extracción nueva: la leche de la toma no vuelve.
        expect(lost).toEqual([{ label: 'M3', ml: 59.9 }])
      } else {
        // Llegó primero la anulación: M3 se re-ocupó y la extracción nueva choca.
        expect(n.error).toBe('milk_label_taken:M3')
        expect(lost).toEqual([])
      }
      expect(await occupied(f1.babyId, 'M3')).toHaveLength(1)
      await assertMilkInvariant(fx.familyIds)
    }
  })

  it('I-73 UPDATE directo {voided_at} de una toma con desglose: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M3', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 30]])
    const before = await milkSnapshot(f.babyId)
    const { error } = await f.client
      .from('feedings')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', id)
    expect(error?.message).toBe('milk_rpc_only')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })
})
