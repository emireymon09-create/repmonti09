import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/supabase'
import {
  FRIDGE_MS,
  MIN,
  assertMilkInvariant,
  discardArgs,
  editArgs,
  feedingRow,
  iso,
  liveDiscards,
  newBaby,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import { hasMilkV5, startedArgs, startedDiscards, startedFeed } from '../helpers/milkV5'

// Inventario v5 (0016): el biberón empezado — discard_started_bottle y la
// sincronización con el sobró de la toma (trigger). I-B1 de
// docs/plan-pruebas-v5.md §2. Quién decide que pasó la hora es now() de la
// BASE; la hora guardada se acota a [fed_at + 60 min, now()].

const ready = await hasMilkV5()
let fx: V4Families

describe.skipIf(!ready)('v5 · biberón empezado (I-B1)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-started')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-B1 a los 59 min: milk_not_expired:started y nada se escribe; a los 61 min, una fila con el sobró', async () => {
    const [f] = await newBaby(fx.a)
    const young = await startedFeed(f, 30, Date.now() - 59 * MIN)
    const r = await rpc(f.client, 'discard_started_bottle', startedArgs(young))
    expect(r.error).toBe('milk_not_expired:started')
    expect(await startedDiscards(young)).toEqual([])

    const fedAt = Date.now() - 61 * MIN
    const old = await startedFeed(f, 30, fedAt)
    const args = startedArgs(old)
    const t0 = Date.now()
    expect((await rpc(f.client, 'discard_started_bottle', args)).error).toBeNull()
    const t1 = Date.now()
    const ds = await startedDiscards(old)
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({
      id: args.p_id,
      reason: 'started_bottle_expired',
      container_id: null,
      feeding_id: old,
      voided_at: null,
    })
    expect(Number(ds[0].amount_ml)).toBe(30)
    const at = Date.parse(ds[0].discarded_at)
    expect(at).toBeGreaterThanOrEqual(t0 - 1000)
    expect(at).toBeLessThanOrEqual(t1 + 1000)
  })

  it('I-B1 hora guardada acotada: anterior al límite → fed_at + 60 min; futura → now()', async () => {
    const [f] = await newBaby(fx.a)
    const fedAt = Date.now() - 3 * 60 * MIN
    const early = await startedFeed(f, 20, fedAt)
    await rpc(f.client, 'discard_started_bottle', startedArgs(early, fedAt))
    expect(Date.parse((await startedDiscards(early))[0].discarded_at)).toBe(fedAt + 60 * MIN)
    const late = await startedFeed(f, 20, fedAt)
    const t0 = Date.now()
    await rpc(f.client, 'discard_started_bottle', startedArgs(late, Date.now() + 5 * 60 * MIN))
    const at = Date.parse((await startedDiscards(late))[0].discarded_at)
    expect(at).toBeGreaterThanOrEqual(t0 - 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('I-B1 reenvío: mismo p_id → no-op; mismo p_id con otra toma → conflicto; otro id → no-op', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const feed = await startedFeed(f, 30, Date.now() - 2 * 60 * MIN)
    const other = await startedFeed(f, 30, Date.now() - 2 * 60 * MIN)
    const args = startedArgs(feed)
    expect((await rpc(f.client, 'discard_started_bottle', args)).error).toBeNull()
    expect((await rpc(f.client, 'discard_started_bottle', args)).error).toBeNull()
    expect(
      (await rpc(f.client, 'discard_started_bottle', { ...args, p_feeding_id: other })).error,
    ).toBe('milk_idempotency_conflict')
    expect((await rpc(f2.client, 'discard_started_bottle', startedArgs(feed))).error).toBeNull()
    expect(await startedDiscards(feed)).toHaveLength(1)
    expect(await startedDiscards(other)).toEqual([])
  })

  it('I-B1 dos teléfonos a la vez con ids distintos: una sola fila viva', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const feed = await startedFeed(f, 30, Date.now() - 2 * 60 * MIN)
    const [r1, r2] = await Promise.all([
      rpc(f.client, 'discard_started_bottle', startedArgs(feed)),
      rpc(f2.client, 'discard_started_bottle', startedArgs(feed)),
    ])
    expect(r1.error).toBeNull()
    expect(r2.error).toBeNull()
    expect((await startedDiscards(feed)).filter((d) => !d.voided_at)).toHaveLength(1)
  })

  it('I-B1 toma que no sirve para esto: milk_bad_input (sin sobró, sobró 0, anulada, lactancia, ajena)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * 60 * MIN
    const noLeftover = randomUUID()
    expect(
      (
        await rpc(f.client, 'log_bottle_feed', {
          p_id: noLeftover,
          p_baby_id: f.babyId,
          p_fed_at: iso(at),
          p_notes: null,
          p_formula_ml: 60,
          p_portions: [],
          p_leftover_ml: null,
        })
      ).error,
    ).toBeNull()
    const zero = await startedFeed(f, 0, at)
    const voided = await startedFeed(f, 30, at)
    expect((await rpc(f.client, 'void_bottle_feed', { p_feeding_id: voided })).error).toBeNull()
    const { data: nursing, error } = await f.client
      .from('feedings')
      .insert({
        baby_id: f.babyId,
        feeding_type: 'nursing',
        fed_at: iso(at),
        leftover_ml: 10,
        amount_ml: 20,
        logged_by: f.userId,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    for (const id of [noLeftover, zero, voided, nursing!.id, randomUUID()]) {
      const r = await rpc(f.client, 'discard_started_bottle', startedArgs(id))
      expect(r.error, id).toBe('milk_bad_input')
    }
    // La familia B no ve la toma de A.
    const mine = await startedFeed(f, 30, at)
    expect((await rpc(fx.b.client, 'discard_started_bottle', startedArgs(mine))).error).toBe(
      'milk_bad_input',
    )
    expect(await startedDiscards(mine)).toEqual([])
  })

  it('I-B1 editar el sobró sincroniza el desecho; sobró nulo lo anula; anular la toma también', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * 60 * MIN
    const feed = await startedFeed(f, 30, at)
    await rpc(f.client, 'discard_started_bottle', startedArgs(feed))
    // Edición completa (regla 17): 30 → 45.
    let r = await rpc(f.client, 'edit_bottle_feed', await editArgs(feed, { leftover: 45 }))
    expect(r.error).toBeNull()
    expect(Number((await startedDiscards(feed))[0].amount_ml)).toBe(45)
    // Sin sobró → el desecho se anula.
    r = await rpc(f.client, 'edit_bottle_feed', await editArgs(feed, { leftover: null }))
    expect(r.error).toBeNull()
    expect((await startedDiscards(feed))[0].voided_at).not.toBeNull()

    // Anular la toma anula su desecho.
    const feed2 = await startedFeed(f, 30, at)
    await rpc(f.client, 'discard_started_bottle', startedArgs(feed2))
    expect((await rpc(f.client, 'void_bottle_feed', { p_feeding_id: feed2 })).error).toBeNull()
    expect((await startedDiscards(feed2))[0].voided_at).not.toBeNull()
    expect((await feedingRow(feed2)).voided_at).not.toBeNull()
  })

  it('I-B1 la app vieja edita el sobró de una toma SIN desglose por UPDATE directo: entra y sincroniza', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 2 * 60 * MIN
    const { data, error } = await f.client
      .from('feedings')
      .insert({
        baby_id: f.babyId,
        feeding_type: 'bottle',
        fed_at: iso(at),
        amount_ml: 90,
        leftover_ml: 30,
        logged_by: f.userId,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    const id = data!.id as string
    expect((await rpc(f.client, 'discard_started_bottle', startedArgs(id))).error).toBeNull()
    const up = await f.client.from('feedings').update({ leftover_ml: 20 }).eq('id', id)
    expect(up.error).toBeNull()
    expect(Number((await startedDiscards(id))[0].amount_ml)).toBe(20)
    // La bandera no quedó prendida: un UPDATE directo a un desecho sigue rechazado.
    const direct = await f.client
      .from('milk_discards')
      .update({ amount_ml: 5 })
      .eq('feeding_id', id)
    expect(direct.error?.message).toBe('milk_rpc_only')
    const zero = await f.client.from('feedings').update({ leftover_ml: 0 }).eq('id', id)
    expect(zero.error).toBeNull()
    expect((await startedDiscards(id))[0].voided_at).not.toBeNull()
    // Lactancia: la app vieja cambia el tipo de una toma con desecho vivo.
    const { data: d2 } = await f.client
      .from('feedings')
      .insert({
        baby_id: f.babyId,
        feeding_type: 'bottle',
        fed_at: iso(at),
        amount_ml: 90,
        leftover_ml: 30,
        logged_by: f.userId,
      })
      .select('id')
      .single()
    await rpc(f.client, 'discard_started_bottle', startedArgs(d2!.id as string))
    const toNursing = await f.client
      .from('feedings')
      .update({ feeding_type: 'nursing' })
      .eq('id', d2!.id)
    expect(toNursing.error).toBeNull()
    expect((await startedDiscards(d2!.id as string))[0].voided_at).not.toBeNull()
  })

  it('I-B1 las filas "expired" de biberones siguen igual y conviven con las empezadas', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 40, 'M3', Date.now() - FRIDGE_MS - 10 * MIN)
    expect((await rpc(f.client, 'discard_container', discardArgs(p.containerId))).error).toBeNull()
    const feed = await startedFeed(f, 30, Date.now() - 2 * 60 * MIN)
    expect((await rpc(f.client, 'discard_started_bottle', startedArgs(feed))).error).toBeNull()
    const exp = await liveDiscards(p.containerId)
    expect(exp).toHaveLength(1)
    expect(exp[0]).toMatchObject({ reason: 'expired', voided_at: null })
    const { data } = await adminClient()
      .from('milk_discards')
      .select('reason, container_id, feeding_id')
      .eq('baby_id', f.babyId)
      .order('reason')
    expect(data).toEqual([
      { reason: 'expired', container_id: p.containerId, feeding_id: null },
      { reason: 'started_bottle_expired', container_id: null, feeding_id: feed },
    ])
  })

  it('H6 la app vieja pasa la toma a otro bebé: el desecho del biberón empezado se anula', async () => {
    const [f] = await newBaby(fx.a)
    const [g] = await newBaby(fx.a)
    const at = Date.now() - 2 * 60 * MIN
    const { data, error } = await f.client
      .from('feedings')
      .insert({
        baby_id: f.babyId,
        feeding_type: 'bottle',
        fed_at: iso(at),
        amount_ml: 90,
        leftover_ml: 30,
        logged_by: f.userId,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    const id = data!.id as string
    expect((await rpc(f.client, 'discard_started_bottle', startedArgs(id))).error).toBeNull()
    const moved = await f.client.from('feedings').update({ baby_id: g.babyId }).eq('id', id)
    expect(moved.error).toBeNull()
    expect((await startedDiscards(id))[0].voided_at).not.toBeNull()
  })
})
