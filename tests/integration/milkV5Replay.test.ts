import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sendOpWith } from '@/lib/db'
import type { RpcOp } from '@/lib/queue'
import { adminClient } from '../helpers/supabase'
import {
  HOUR,
  assertMilkInvariant,
  feedOk,
  iso,
  newBaby,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import {
  coldPump,
  combineArgs,
  containerV5,
  formulaRows,
  hasMilkV5,
  startedDiscards,
  startedFeed,
  transfersOf,
} from '../helpers/milkV5'

// Inventario v5 (0016): la cola offline reenvía cada RPC nueva tal cual
// (sendOpWith de lib/db.ts, modo 'replay', kind 'rpc'). I-O1 de
// docs/plan-pruebas-v5.md §2: el reenvío — también dos a la vez, como dos
// pestañas — no duplica nada. Y dos operaciones distintas que compiten por la
// misma leche (regla 21) dejan la cuenta cerrada.

const ready = await hasMilkV5()
let fx: V4Families

const op = (fn: string, args: Record<string, unknown>, id: string): RpcOp => ({
  kind: 'rpc',
  fn,
  args,
  table: 'milk_containers',
  id,
  effect: 'update',
})

/** Manda la misma op tres veces: una sola y dos "pestañas" a la vez. */
async function replay3(f: { client: ReturnType<typeof adminClient> }, o: RpcOp) {
  const db = f.client.schema('public')
  const first = await sendOpWith(db, o, 'replay')
  const [a, b] = await Promise.all([sendOpWith(db, o, 'replay'), sendOpWith(db, o, 'replay')])
  for (const r of [first, a, b]) expect(r.error, o.fn).toBeNull()
  return [first, a, b]
}

describe.skipIf(!ready)('v5 · reenvío por la cola (I-O1)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-replay')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-O1 combinar, deshacer y "ya está fría" reenviados: mismo resultado, nada duplicado', async () => {
    const [f] = await newBaby(fx.a)
    const t = await coldPump(f, 90, 'M1')
    const s = await coldPump(f, 60, 'M2')
    const warm = await coldPump(f, 30, 'M3', 10 * 60_000)
    const cargs = await combineArgs(f, t.containerId, [s.containerId])
    const [c1, c2, c3] = await replay3(f, op('milk_combine', cargs, t.containerId))
    expect(c2.data).toEqual(c1.data)
    expect(c3.data).toEqual(c1.data)
    expect(await transfersOf(cargs.p_op_id)).toHaveLength(1)
    expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(150)

    const uargs = { p_op_id: randomUUID(), p_combine_op_id: cargs.p_op_id }
    const [u1, u2] = await replay3(f, op('milk_uncombine', uargs, t.containerId))
    expect(u2.data).toEqual(u1.data)
    expect(u1.data).toMatchObject({ returned_ml: 60 })
    expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(90)
    expect(Number((await containerV5(s.containerId)).remaining_ml)).toBe(60)

    const margs = { p_op_id: randomUUID(), p_container_id: warm.containerId, p_cold_at: null }
    const [m1, m2] = await replay3(f, op('milk_mark_cold', margs, warm.containerId))
    expect(m2.data).toEqual(m1.data)
    const { count } = await adminClient()
      .from('milk_ops')
      .select('op_id', { count: 'exact', head: true })
      .eq('baby_id', f.babyId)
    expect(count).toBe(3)
  })

  it('I-O1 biberón empezado y Similac reenviados: una fila de cada cosa', async () => {
    const [f] = await newBaby(fx.a)
    const feed = await startedFeed(f, 30, Date.now() - 2 * HOUR)
    const dargs = { p_id: randomUUID(), p_feeding_id: feed, p_discarded_at: null }
    await replay3(f, op('discard_started_bottle', dargs, feed))
    expect(await startedDiscards(feed)).toHaveLength(1)

    const ids = [randomUUID(), randomUUID()]
    const add = {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_ids: ids,
      p_size_ml: 236.5882365,
      p_added_at: iso(Date.now() - HOUR),
    }
    await replay3(f, op('formula_add', add, ids[0]))
    expect(await formulaRows(f.babyId)).toHaveLength(2)
    const open = {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_container_id: ids[0],
      p_opened_at: iso(Date.now() - HOUR),
    }
    const [o1, o2] = await replay3(f, op('formula_open', open, ids[0]))
    expect(o2.data).toEqual(o1.data)
    const fin = { p_op_id: randomUUID(), p_container_id: ids[0], p_reason: 'empty', p_at: null }
    await replay3(f, op('formula_finish', fin, ids[0]))
    const vo = { p_op_id: randomUUID(), p_container_id: ids[1] }
    await replay3(f, op('formula_void', vo, ids[1]))
    const rows = new Map((await formulaRows(f.babyId)).map((r) => [r.id, r]))
    expect(rows.get(ids[0])).toMatchObject({ finish_reason: 'empty' })
    expect(rows.get(ids[1])!.voided_at).not.toBeNull()
  })

  it('I-O1 combinar y servir del origen a la vez (dos teléfonos): uno de los dos gana, la cuenta cierra', async () => {
    for (let i = 0; i < 4; i++) {
      const [f, f2] = await newBaby(fx.a, fx.a2)
      const t = await coldPump(f, 90, 'M1')
      const s = await coldPump(f, 60, 'M2')
      const cargs = await combineArgs(f, t.containerId, [s.containerId])
      const [comb, feed] = await Promise.all([
        rpc(f.client, 'milk_combine', cargs),
        rpc(f2.client, 'log_bottle_feed', {
          p_id: randomUUID(),
          p_baby_id: f2.babyId,
          p_fed_at: iso(Date.now()),
          p_notes: null,
          p_formula_ml: 0,
          p_portions: [{ container_id: s.containerId, amount_ml: 40 }],
          p_leftover_ml: null,
        }),
      ])
      const ok = [comb.error, feed.error].filter((e) => e === null)
      expect(ok.length, JSON.stringify([comb.error, feed.error])).toBeGreaterThanOrEqual(1)
      if (comb.error) expect(comb.error).toBe('milk_combine_conflict')
      if (feed.error) expect(feed.error).toMatch(/^milk_overdraw:M2$/)
      await assertMilkInvariant(fx.familyIds)
    }
  })

  it('I-O1 deshacer y anular una toma del destino a la vez: sin abrazo mortal, la cuenta cierra', async () => {
    for (let i = 0; i < 4; i++) {
      const [f, f2] = await newBaby(fx.a, fx.a2)
      const t = await coldPump(f, 90, 'M1')
      const s = await coldPump(f, 60, 'M2')
      const feed = await feedOk(f, [[t.containerId, 30]], { at: Date.now() - HOUR })
      const cargs = await combineArgs(f, t.containerId, [s.containerId])
      expect((await rpc(f.client, 'milk_combine', cargs)).error).toBeNull()
      const [un, vo] = await Promise.all([
        rpc(f.client, 'milk_uncombine', { p_op_id: randomUUID(), p_combine_op_id: cargs.p_op_id }),
        rpc(f2.client, 'void_bottle_feed', { p_feeding_id: feed }),
      ])
      expect(un.error).toBeNull()
      expect(vo.error).toBeNull()
      expect(Number((await containerV5(t.containerId)).remaining_ml)).toBe(90)
      expect(Number((await containerV5(s.containerId)).remaining_ml)).toBe(60)
    }
  })
})
