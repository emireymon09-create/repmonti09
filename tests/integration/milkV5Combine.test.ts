import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/supabase'
import {
  DAY,
  FRIDGE_MS,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  discardArgs,
  editArgs,
  feedOk,
  hasLocalDocker,
  liveDiscards,
  milkSnapshot,
  newBaby,
  psql,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import {
  coldPump,
  combineArgs,
  combineOk,
  containerV5,
  hasMilkV5,
  transfersOf,
  uncombineArgs,
  updatePumpArgs,
} from '../helpers/milkV5'

// Inventario v5 (0016): Combinar y Deshacer — milk_combine, milk_uncombine,
// milk_transfers y su interacción con tomas, desechos y ediciones de la
// extracción. I-M1, I-M2 e I-M3 de docs/plan-pruebas-v5.md §2. La invariante
// (INV-1 con transferencias, INV-11) cierra después de cada prueba.

const ready = await hasMilkV5()
const docker = ready && hasLocalDocker()
let fx: V4Families

const total = (c: { remaining_ml: number }) => Number(c.remaining_ml)

describe.skipIf(!ready)('v5 · combinar (I-M1)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-comb')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-M1 M5 (vence antes) + M6 en M6: M6 tiene todo y vence con M5; M5 libre; "Lo que hay" igual', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 2 * OZ, 'M5', 3 * DAY)
    const m6 = await coldPump(f, 3 * OZ, 'M6')
    const before =
      total(await containerV5(m5.containerId)) + total(await containerV5(m6.containerId))
    const exp5 = (await containerV5(m5.containerId)).expires_at
    const { opId, result } = await combineOk(f, m6.containerId, [m5.containerId])
    expect(result).toMatchObject({ target: 'M6', sources: ['M5'] })
    expect(Number(result.moved_ml)).toBeCloseTo(2 * OZ, 9)
    const c5 = await containerV5(m5.containerId)
    const c6 = await containerV5(m6.containerId)
    expect(Number(c5.remaining_ml)).toBe(0)
    expect(c5.released_at).not.toBeNull()
    expect(Number(c6.remaining_ml)).toBeCloseTo(5 * OZ, 9)
    expect(c6.expires_at).toBe(exp5)
    expect(total(c5) + total(c6)).toBeCloseTo(before, 9)
    // amount_ml de cada uno sigue siendo el de su extracción (INV-8).
    expect(Number(c6.amount_ml)).toBeCloseTo(3 * OZ, 9)
    const ts = await transfersOf(opId)
    expect(ts).toHaveLength(1)
    expect(ts[0]).toMatchObject({ from_container_id: m5.containerId, voided_at: null })
    // El número M5 se puede volver a elegir.
    await pumpOk(f, 30, 'M5')
  })

  it('I-M1 tres en uno: los dos orígenes libres, caducidad = la mínima', async () => {
    const [f] = await newBaby(fx.a)
    const a = await coldPump(f, 30, 'M1', 2 * DAY)
    const b = await coldPump(f, 40, 'M2', 3 * DAY)
    const t = await coldPump(f, 50, 'M3')
    const exp = (await containerV5(b.containerId)).expires_at
    const { result } = await combineOk(f, t.containerId, [b.containerId, a.containerId])
    expect(Number(result.moved_ml)).toBe(70)
    expect([...(result.sources as string[])].sort()).toEqual(['M1', 'M2'])
    const c = await containerV5(t.containerId)
    expect(Number(c.remaining_ml)).toBe(120)
    expect(c.expires_at).toBe(exp)
  })

  it('I-M1 rechazos: enfriando, vencido, libre, otro bebé, destino entre orígenes, sin orígenes', async () => {
    const [f] = await newBaby(fx.a)
    const [g] = await newBaby(fx.a)
    const t = await coldPump(f, 50, 'M1')
    const warm = await pumpOk(f, 30, 'M2', Date.now() - 30 * MIN)
    const expired = await pumpOk(f, 30, 'M3', Date.now() - FRIDGE_MS - 10 * MIN)
    const emptied = await coldPump(f, 30, 'M4')
    await feedOk(f, [[emptied.containerId, 30]])
    const otherBaby = await coldPump(g, 30, 'M5')
    const snap = await milkSnapshot(f.babyId)
    const tryCombine = async (sources: string[]) =>
      (await rpc(f.client, 'milk_combine', await combineArgs(f, t.containerId, sources))).error
    expect(await tryCombine([warm.containerId])).toBe('milk_not_cold:M2')
    expect(await tryCombine([expired.containerId])).toBe('milk_container_unusable:M3')
    expect(await tryCombine([emptied.containerId])).toBe('milk_container_unusable:M4')
    expect(await tryCombine([otherBaby.containerId])).toBe('milk_container_unusable:M5')
    expect(await tryCombine([t.containerId])).toBe('milk_bad_input')
    expect(await tryCombine([])).toBe('milk_bad_input')
    // Un id que falta en p_expected → milk_bad_input; uno que no existe → unusable.
    const ghost = randomUUID()
    const base = await combineArgs(f, t.containerId, [warm.containerId])
    const missing = await rpc(f.client, 'milk_combine', {
      ...base,
      p_op_id: randomUUID(),
      p_source_ids: [ghost],
    })
    expect(missing.error).toBe('milk_bad_input')
    const unknown = await rpc(f.client, 'milk_combine', {
      ...base,
      p_op_id: randomUUID(),
      p_source_ids: [ghost],
      // Exactamente destino + orígenes (una clave de más es milk_bad_input, H5).
      p_expected: { [t.containerId]: base.p_expected[t.containerId], [ghost]: 10 },
    })
    expect(unknown.error).toBe('milk_container_unusable')
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })

  it('I-M1 p_expected distinto (otro celular sirvió): milk_combine_conflict y nada cambia', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const t = await coldPump(f, 90, 'M1')
    const s = await coldPump(f, 60, 'M2')
    const args = await combineArgs(f, t.containerId, [s.containerId])
    await feedOk(f2, [[s.containerId, 10]])
    const snap = await milkSnapshot(f.babyId)
    expect((await rpc(f.client, 'milk_combine', args)).error).toBe('milk_combine_conflict')
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })

  it('I-M1 idempotencia: mismo op y carga → mismo resultado sin duplicar; otra carga → conflicto', async () => {
    const [f] = await newBaby(fx.a)
    const t = await coldPump(f, 90, 'M1')
    const s = await coldPump(f, 60, 'M2')
    const s2 = await coldPump(f, 30, 'M3')
    const args = await combineArgs(f, t.containerId, [s.containerId])
    const first = await rpc(f.client, 'milk_combine', args)
    expect(first.error).toBeNull()
    expect(await rpc(f.client, 'milk_combine', args)).toEqual(first)
    expect(await transfersOf(args.p_op_id)).toHaveLength(1)
    expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(150)
    const other = await rpc(f.client, 'milk_combine', {
      ...args,
      p_source_ids: [s2.containerId],
      p_expected: { [t.containerId]: 150, [s2.containerId]: 30 },
    })
    expect(other.error).toBe('milk_idempotency_conflict')
  })

  it('I-M1 dos celulares combinan lo mismo a la vez con ops distintos: uno entra, el otro no', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const t = await coldPump(f, 90, 'M5')
    const s = await coldPump(f, 60, 'M6')
    const a1 = await combineArgs(f, t.containerId, [s.containerId])
    const a2 = await combineArgs(f2, t.containerId, [s.containerId])
    const [r1, r2] = await Promise.all([
      rpc(f.client, 'milk_combine', a1),
      rpc(f2.client, 'milk_combine', a2),
    ])
    const errors = [r1.error, r2.error]
    expect(errors.filter((e) => e === null)).toHaveLength(1)
    expect(errors.find((e) => e !== null)).toMatch(
      /^milk_(combine_conflict|container_unusable:M6)$/,
    )
    expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(150)
  })

  it('I-M1 RLS: la familia B no combina los biberones de A', async () => {
    const [f] = await newBaby(fx.a)
    const t = await coldPump(f, 90, 'M1')
    const s = await coldPump(f, 60, 'M2')
    const args = await combineArgs(f, t.containerId, [s.containerId])
    expect((await rpc(fx.b.client, 'milk_combine', args)).error).toBe('milk_baby_not_found')
    const own = { ...args, p_op_id: randomUUID(), p_baby_id: fx.b.babyId }
    expect((await rpc(fx.b.client, 'milk_combine', own)).error).toBe('milk_container_unusable')
    const { data } = await fx.b.client.from('milk_transfers').select('id')
    expect(data).toEqual([])
    expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(90)
  })
})

describe.skipIf(!ready)('v5 · deshacer (I-M2)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-uncomb')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-M2 vuelve todo: orígenes re-ocupan su número, destino con lo suyo y su caducidad', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5', 3 * DAY)
    const m4 = await coldPump(f, 20, 'M4', 2 * DAY)
    const m6 = await coldPump(f, 90, 'M6')
    const exp6 = (await containerV5(m6.containerId)).expires_at
    const snap = await milkSnapshot(f.babyId)
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId, m4.containerId])
    const args = uncombineArgs(opId)
    const r = await rpc(f.client, 'milk_uncombine', args)
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({ target: 'M6', returned_ml: 80 })
    expect([...(r.data as { sources: string[] }).sources].sort()).toEqual(['M4', 'M5'])
    for (const [p, ml] of [
      [m5, 60],
      [m4, 20],
      [m6, 90],
    ] as const) {
      const c = await containerV5(p.containerId)
      expect(Number(c.remaining_ml), c.label).toBe(ml)
      expect(c.released_at, c.label).toBeNull()
    }
    expect((await containerV5(m6.containerId)).expires_at).toBe(exp6)
    expect((await transfersOf(opId)).every((t) => t.voided_at !== null)).toBe(true)
    // Como antes de combinar (salvo las marcas de tiempo de liberado, nulas otra vez).
    const after = await milkSnapshot(f.babyId)
    expect(after.containers).toEqual(snap.containers)
    // Reenvío de la misma op → mismo resultado; deshacer otra vez (otra op) → no-op.
    expect(await rpc(f.client, 'milk_uncombine', args)).toEqual(r)
    const again = await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))
    expect(again.error).toBeNull()
    expect(again.data).toMatchObject({ returned_ml: 0 })
    // Otra carga con el mismo op → conflicto.
    expect(
      (await rpc(f.client, 'milk_uncombine', { ...args, p_combine_op_id: randomUUID() })).error,
    ).toBe('milk_idempotency_conflict')
  })

  it('I-M2 destino servido después de combinar → milk_combine_used:M6 y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
    // Quedan 90; se sirve 1 oz: quedan 60.4, menos que los 60 recibidos + nada.
    await feedOk(f, [[m6.containerId, 31]])
    const snap = await milkSnapshot(f.babyId)
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))).error).toBe(
      'milk_combine_used:M6',
    )
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })

  it('I-M2 servido pero con lo recibido todavía adentro: se puede deshacer', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
    await feedOk(f, [[m6.containerId, 20]])
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))).error).toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(10)
    expect(Number((await containerV5(m5.containerId)).remaining_ml)).toBe(60)
  })

  it('I-M2 el número del origen ya lo ocupa otra extracción → milk_label_taken:M5', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
    await pumpOk(f, 40, 'M5')
    const snap = await milkSnapshot(f.babyId)
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))).error).toBe(
      'milk_label_taken:M5',
    )
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })

  it('I-M2 combinación inexistente o de otra familia → milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(randomUUID()))).error).toBe(
      'milk_bad_input',
    )
    expect((await rpc(fx.b.client, 'milk_uncombine', uncombineArgs(opId))).error).toBe(
      'milk_bad_input',
    )
    expect((await transfersOf(opId))[0].voided_at).toBeNull()
  })
})

describe.skipIf(!ready)('v5 · combinar e interacción (I-M3)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-inter')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-M3 servir del destino, editar y anular esa toma: la leche vuelve al destino', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    await combineOk(f, m6.containerId, [m5.containerId])
    const feed = await feedOk(f, [[m6.containerId, 50]])
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(40)
    const e = await rpc(f.client, 'edit_bottle_feed', await editArgs(feed, { breast: 30 }))
    expect(e.error).toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(60)
    const v = await rpc(f.client, 'void_bottle_feed', { p_feeding_id: feed })
    expect(v.error).toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(90)
  })

  it('I-M3 anular una toma servida del ORIGEN antes de combinar: esa leche va a lost (D5-19)', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 90, 'M5')
    const m6 = await coldPump(f, 30, 'M6')
    const feed = await feedOk(f, [[m5.containerId, 30]], { at: Date.now() - 30 * MIN })
    await combineOk(f, m6.containerId, [m5.containerId])
    const v = await rpc(f.client, 'void_bottle_feed', { p_feeding_id: feed })
    expect(v.error).toBeNull()
    expect(v.data).toMatchObject({ returned_ml: 0, lost: [{ label: 'M5', ml: 30 }] })
    const c5 = await containerV5(m5.containerId)
    expect(Number(c5.remaining_ml)).toBe(0)
    expect(Number(c5.lost_ml)).toBe(30)
    expect(c5.released_at).not.toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(90)
  })

  it('I-M3 editar la extracción ORIGEN: subir → lost; bajar bajo lo pasado → rechazo; anular → milk_combined', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * HOUR
    const m5 = await pumpOk(f, 60, 'M5', at)
    const m6 = await coldPump(f, 30, 'M6')
    await combineOk(f, m6.containerId, [m5.containerId])
    const up = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: 70, at }),
    )
    expect(up.error).toBeNull()
    const c5 = await containerV5(m5.containerId)
    expect(Number(c5.lost_ml)).toBe(10)
    expect(Number(c5.remaining_ml)).toBe(0)
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(90)
    const down = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: 50, at }),
    )
    expect(down.error).toBe('milk_served_exceeds_amount:M5')
    // Volver a 60 (= lo pasado) sí: la pérdida se va.
    const back = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: 60, at }),
    )
    expect(back.error).toBeNull()
    expect(Number((await containerV5(m5.containerId)).lost_ml)).toBe(0)
    const zero = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: null, at }),
    )
    expect(zero.error).toBe('milk_combined:M5')
    const v = await rpc(f.client, 'void_pumping_session', { p_id: m5.sessionId })
    expect(v.error).toBe('milk_combined:M5')
  })

  it('I-M3 correr la hora del ORIGEN hacia atrás acorta la caducidad del destino (nunca la alarga)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * HOUR
    const m5 = await pumpOk(f, 60, 'M5', at)
    const m6 = await coldPump(f, 30, 'M6', HOUR + 5 * MIN)
    await combineOk(f, m6.containerId, [m5.containerId])
    const earlier = at - DAY
    let r = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: 60, at: earlier }),
    )
    expect(r.error).toBeNull()
    expect(Date.parse((await containerV5(m6.containerId)).expires_at)).toBe(earlier + FRIDGE_MS)
    r = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m5.sessionId, { left: 60, at }),
    )
    expect(r.error).toBeNull()
    expect(Date.parse((await containerV5(m6.containerId)).expires_at)).toBe(earlier + FRIDGE_MS)
  })

  it('I-M3 editar la extracción DESTINO: la caducidad no se alarga; anularla → milk_combined', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5', 2 * DAY)
    const at6 = Date.now() - 3 * HOUR
    const m6 = await pumpOk(f, 30, 'M6', at6)
    await combineOk(f, m6.containerId, [m5.containerId])
    const exp5 = (await containerV5(m5.containerId)).expires_at
    const later = Date.now() - HOUR
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: 40, at: later }),
    )
    expect(r.error).toBeNull()
    const c6 = await containerV5(m6.containerId)
    expect(c6.expires_at).toBe(exp5)
    expect(Number(c6.remaining_ml)).toBe(100)
    expect(Date.parse(c6.fridge_at!)).toBe(later)
    // Bajar el destino por debajo de lo que le queda propio: sale de remaining.
    const low = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: 10, at: later }),
    )
    expect(low.error).toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(70)
    const v = await rpc(f.client, 'void_pumping_session', { p_id: m6.sessionId })
    expect(v.error).toBe('milk_combined:M6')
    const zero = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: null, at: later }),
    )
    expect(zero.error).toBe('milk_combined:M6')
  })

  it.skipIf(!docker)(
    'I-M3 desechar el destino vencido: todo lo que tiene (lo propio y lo recibido)',
    async () => {
      const [f] = await newBaby(fx.a)
      const m5 = await coldPump(f, 60, 'M5')
      const m6 = await coldPump(f, 30, 'M6')
      const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
      // Vencer el destino a mano (la base no deja combinar uno vencido).
      psql(`begin;
      select set_config('amelia.milk_rpc', 'on', true);
      update milk_containers set expires_at = now() - interval '1 minute' where id = '${m6.containerId}';
      commit;`)
      expect(
        (await rpc(f.client, 'discard_container', discardArgs(m6.containerId))).error,
      ).toBeNull()
      const ds = await liveDiscards(m6.containerId)
      expect(Number(ds[0].amount_ml)).toBe(90)
      expect((await containerV5(m6.containerId)).released_at).not.toBeNull()
      // Deshacer ya no se puede.
      expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))).error).toBe(
        'milk_combine_used:M6',
      )
      // El destino combinado como origen de otra combinación más tarde no aplica:
      // está libre. Y la transferencia sigue viva (INV-11 cierra).
      const { data } = await adminClient()
        .from('milk_transfers')
        .select('voided_at')
        .eq('op_id', opId)
      expect(data).toEqual([{ voided_at: null }])
    },
  )

  it('I-M3 bajar la extracción DESTINO por debajo de lo servido: entra si lo recibido lo cubre', async () => {
    // M6 (30 propios) recibe 60 de M5 y se sirven 80. Corregir M6 a 25 deja
    // 25 + 60 = 85 ≥ 80 servidos: la cuenta física cierra (quedan 5). A 15 no
    // (15 + 60 = 75 < 80).
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5')
    const at6 = Date.now() - 2 * HOUR
    const m6 = await pumpOk(f, 30, 'M6', at6)
    await combineOk(f, m6.containerId, [m5.containerId])
    await feedOk(f, [[m6.containerId, 80]])
    const ok = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: 25, at: at6 }),
    )
    expect(ok.error).toBeNull()
    expect(Number((await containerV5(m6.containerId)).remaining_ml)).toBe(5)
    const bad = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: 15, at: at6 }),
    )
    expect(bad.error).toBe('milk_served_exceeds_amount:M6')
  })

  it('I-M3 un destino puede ser origen de otra combinación; deshacer la primera → milk_combine_used', async () => {
    const [f] = await newBaby(fx.a)
    const m1 = await coldPump(f, 20, 'M1')
    const m2 = await coldPump(f, 30, 'M2')
    const m3 = await coldPump(f, 40, 'M3')
    const first = await combineOk(f, m2.containerId, [m1.containerId])
    await combineOk(f, m3.containerId, [m2.containerId])
    expect(Number((await containerV5(m3.containerId)).remaining_ml)).toBe(90)
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(first.opId))).error).toBe(
      'milk_combine_used:M2',
    )
  })
})

describe.skipIf(!ready)('v5 · combinar, correcciones de auditoría (H1, H2, H5)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-audit')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('H1 deshacer después de adelantar la hora del DESTINO: vence según su hora nueva, no la vieja', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await coldPump(f, 60, 'M5', 2 * DAY)
    const at6 = Date.now() - HOUR - 5 * MIN
    const m6 = await pumpOk(f, 90, 'M6', at6)
    const { opId } = await combineOk(f, m6.containerId, [m5.containerId])
    const earlier = at6 - 3 * DAY
    const up = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(m6.sessionId, { left: 90, at: earlier }),
    )
    expect(up.error).toBeNull()
    expect((await rpc(f.client, 'milk_uncombine', uncombineArgs(opId))).error).toBeNull()
    const c6 = await containerV5(m6.containerId)
    expect(Date.parse(c6.stored_at)).toBe(earlier)
    expect(Date.parse(c6.expires_at)).toBe(earlier + FRIDGE_MS)
  })

  it('H2 cadena S→D→E: adelantar la hora de S baja la caducidad de D y también la de E', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * HOUR
    const s = await pumpOk(f, 20, 'M1', at)
    const d = await coldPump(f, 30, 'M2', HOUR + 10 * MIN)
    const e = await coldPump(f, 40, 'M3', HOUR + 5 * MIN)
    await combineOk(f, d.containerId, [s.containerId])
    await combineOk(f, e.containerId, [d.containerId])
    const earlier = at - DAY
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(s.sessionId, { left: 20, at: earlier }),
    )
    expect(r.error).toBeNull()
    expect(Date.parse((await containerV5(d.containerId)).expires_at)).toBe(earlier + FRIDGE_MS)
    expect(Date.parse((await containerV5(e.containerId)).expires_at)).toBe(earlier + FRIDGE_MS)
  })

  it('H2 cadena: si el acortamiento deja a E vencido antes de su propia hora → milk_combined y nada cambia', async () => {
    // D es de hace 3 días (el acortamiento le cabe); E, de hace una hora (no).
    const [f] = await newBaby(fx.a)
    const s = await pumpOk(f, 20, 'M1', Date.now() - 3 * DAY - HOUR)
    const d = await coldPump(f, 30, 'M2', 3 * DAY)
    const e = await coldPump(f, 40, 'M3', HOUR + 5 * MIN)
    await combineOk(f, d.containerId, [s.containerId])
    await combineOk(f, e.containerId, [d.containerId])
    const snap = await milkSnapshot(f.babyId)
    // S a hace 5 días: vence hace 1 día — después de D, antes de que E existiera.
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updatePumpArgs(s.sessionId, { left: 20, at: Date.now() - 5 * DAY }),
    )
    expect(r.error).toBe('milk_combined:M1')
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })

  it('H5 más de 24 orígenes → milk_bad_input; p_expected con una clave de más → milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const t = await coldPump(f, 50, 'M1')
    const s = await coldPump(f, 30, 'M2')
    const many = Array.from({ length: 25 }, () => randomUUID())
    const tooMany = await rpc(f.client, 'milk_combine', {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_target_id: t.containerId,
      p_source_ids: many,
      p_expected: Object.fromEntries([t.containerId, ...many].map((id) => [id, 10])),
    })
    expect(tooMany.error).toBe('milk_bad_input')
    const snap = await milkSnapshot(f.babyId)
    const base = await combineArgs(f, t.containerId, [s.containerId])
    const extra = await rpc(f.client, 'milk_combine', {
      ...base,
      p_expected: { ...base.p_expected, [randomUUID()]: 1 },
    })
    expect(extra.error).toBe('milk_bad_input')
    expect(await milkSnapshot(f.babyId)).toEqual(snap)
  })
})
