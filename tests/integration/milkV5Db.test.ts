import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  feedOk,
  iso,
  newBaby,
  pumpOk,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import { hasMilkV5 } from '../helpers/milkV5'
import type { SeededFamily } from '../helpers/supabase'
import {
  addFormulaOp,
  bottleFeedingsSince,
  combineMilkOp,
  combineResultOf,
  discardStartedBottleOp,
  finishFormulaOp,
  listContainers,
  listDiscards,
  listDrawdowns,
  listFormulaContainers,
  listTransfers,
  logPumpingOp,
  markMilkColdOp,
  milkErrorText,
  milkV5Reads,
  openFormulaOp,
  sendOpWith,
  uncombineMilkOp,
  voidFormulaOp,
} from '@/lib/db'
import { applyPendingInventory, DEFAULT_MILK_RULES } from '@/lib/milk'
import { discardedTotalMl } from '@/lib/milkBottles'
import { canUncombine, combinationsOf } from '@/lib/milkCombine'
import { isCold } from '@/lib/milkCooling'
import { formulaStock } from '@/lib/formulaStock'
import { startedBottle } from '@/lib/startedBottle'
import type { PendingWrite, RpcOp } from '@/lib/queue'

// La capa de datos de la leche v5 (H3) por el camino REAL de lib/db.ts: las ops
// que arma la app (markMilkColdOp, combineMilkOp, uncombineMilkOp,
// discardStartedBottleOp, addFormulaOp, openFormulaOp, finishFormulaOp,
// voidFormulaOp, logPumpingOp con p_fridge_at) mandadas con sendOpWith como lo
// hace la cola — también reenviadas — y las lecturas nuevas (listTransfers,
// listFormulaContainers, bottleFeedingsSince, listDiscards con feeding_id) con el
// cliente de un padre: PostgREST + JWT + RLS. Y que la vista sin conexión
// (applyPendingInventory) dice lo mismo que la base después.

const ready = await hasMilkV5()
let fx: V4Families

const db = (f: SeededFamily) => f.client.schema('public')

async function send(f: SeededFamily, op: RpcOp, mode: 'write' | 'replay' = 'write') {
  return sendOpWith(db(f), op, mode)
}

describe.skipIf(!ready)('v5 · lib/db.ts por el camino real (H3)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-db')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('logPumpingOp manda la hora de "Registrar" y listContainers la trae; "Ya está fría" la confirma', async () => {
    const [f] = await newBaby(fx.a)
    const pumped = Date.now() - 30 * MIN
    const fridge = Date.now() - 2 * MIN
    const built = logPumpingOp(
      f.babyId,
      null,
      { left_ml: 60, right_ml: null, notes: null, pumped_at: iso(pumped) },
      { rules: DEFAULT_MILK_RULES },
      'M1',
      undefined,
      iso(fridge),
    )!
    expect((await send(f, built.op)).error).toBeNull()
    const [c] = (await listContainers(f.babyId, f.client)).data
    expect(Date.parse(c.fridge_at!)).toBe(fridge)
    expect(c.cold_at).toBeNull()
    expect(isCold(c, Date.now())).toBe(false)

    const cold = markMilkColdOp(c, iso(Date.now() - MIN))
    expect((await send(f, cold)).error).toBeNull()
    expect((await send(f, cold, 'replay')).error).toBeNull()
    const [after] = (await listContainers(f.babyId, f.client)).data
    expect(after.cold_at).not.toBeNull()
    expect(isCold(after, Date.now())).toBe(true)
  })

  it('combinar y deshacer: la vista sin conexión predice lo que la base hace', async () => {
    const [f] = await newBaby(fx.a)
    const m5 = await pumpOk(f, 60, 'M5', Date.now() - 3 * HOUR)
    const m6 = await pumpOk(f, 30, 'M6', Date.now() - 2 * HOUR)
    const before = (await listContainers(f.babyId, f.client)).data
    const t = before.find((c) => c.id === m6.containerId)!
    const s = before.find((c) => c.id === m5.containerId)!
    const op = combineMilkOp(f.babyId, t, [s])
    const opId = op.args.p_op_id as string

    // Lo que este teléfono mostraría si quedara en cola…
    const queued: PendingWrite = {
      id: 'w1',
      schema: 'public',
      label: 'Combine milk',
      queuedAt: new Date().toISOString(),
      op,
    }
    const local = applyPendingInventory(before, [], [], [queued], [])

    // …y lo que hace la base.
    const r = await send(f, op)
    expect(r.error).toBeNull()
    expect(combineResultOf(r.data)).toEqual({
      target: 'M6',
      moved_ml: 60,
      returned_ml: 0,
      sources: ['M5'],
    })
    expect((await send(f, op, 'replay')).data).toEqual(r.data)
    const server = (await listContainers(f.babyId, f.client)).data
    for (const c of server) {
      const mine = local.containers.find((x) => x.id === c.id)!
      expect(mine.remaining_ml).toBeCloseTo(c.remaining_ml, 9)
      expect(!!mine.released_at).toBe(!!c.released_at)
      expect(Date.parse(mine.expires_at)).toBe(Date.parse(c.expires_at))
    }
    const transfers = (await listTransfers(f.babyId, f.client)).data
    expect(transfers).toHaveLength(1)
    expect(combinationsOf(transfers)).toMatchObject([
      { opId, targetId: m6.containerId, sourceIds: [m5.containerId], movedMl: 60, undone: false },
    ])
    expect(canUncombine(opId, transfers, server)).toEqual({ ok: true, noop: false, returnedMl: 60 })

    const undo = uncombineMilkOp(opId, m6.containerId)
    const u = await send(f, undo)
    expect(u.error).toBeNull()
    expect(combineResultOf(u.data)).toMatchObject({ target: 'M6', returned_ml: 60 })
    const back = (await listContainers(f.babyId, f.client)).data
    expect(back.find((c) => c.id === m5.containerId)!.remaining_ml).toBe(60)
    expect(back.find((c) => c.id === m6.containerId)!.remaining_ml).toBe(30)
    const after = (await listTransfers(f.babyId, f.client)).data
    expect(after[0].voided_at).not.toBeNull()
    expect(combinationsOf(after)[0].undone).toBe(true)
  })

  it('combinar con uno enfriando: la base dice milk_not_cold:M#, y la app lo dice en palabras', async () => {
    const [f] = await newBaby(fx.a)
    await pumpOk(f, 60, 'M1', Date.now() - 3 * HOUR)
    const warm = logPumpingOp(
      f.babyId,
      null,
      { left_ml: 30, right_ml: null, notes: null, pumped_at: iso(Date.now() - 5 * MIN) },
      { rules: DEFAULT_MILK_RULES },
      'M2',
    )!
    expect((await send(f, warm.op)).error).toBeNull()
    const cs = (await listContainers(f.babyId, f.client)).data
    const r = await send(
      f,
      combineMilkOp(
        f.babyId,
        cs.find((c) => c.label === 'M1')!,
        [cs.find((c) => c.label === 'M2')!],
      ),
    )
    expect(r.error).toBe('milk_not_cold:M2')
    expect(milkErrorText(r.error, 'es')).toMatch(/^M2 todavía se está enfriando/)
  })

  it('el biberón empezado: desechar pasada la hora, leerlo con feeding_id, y no sumarlo a "Leche desechada"', async () => {
    const [f] = await newBaby(fx.a)
    const fedAt = Date.now() - 2 * HOUR
    const feedingId = await feedOk(f, [], { formula: 90, leftover: 20, at: fedAt })
    const feedings = (await bottleFeedingsSince(f.babyId, iso(fedAt - HOUR), f.client)).data
    expect(feedings.map((x) => x.id)).toEqual([feedingId])
    const offered = startedBottle({ feedings, discards: [], nowMs: Date.now() })
    expect(offered).toMatchObject({ feedingId, leftoverMl: 20, expired: true })

    const op = discardStartedBottleOp(f.babyId, null, {
      feedingId,
      leftoverMl: offered!.leftoverMl,
      fedAt: feedings[0].fed_at,
    })
    expect((await send(f, op)).error).toBeNull()
    expect((await send(f, op, 'replay')).error).toBeNull()
    const discards = (await listDiscards(f.babyId, f.client)).data
    expect(discards).toEqual([
      expect.objectContaining({
        container_id: null,
        feeding_id: feedingId,
        amount_ml: 20,
        reason: 'started_bottle_expired',
        label: null,
      }),
    ])
    expect(discardedTotalMl(discards)).toBe(0)
    expect(startedBottle({ feedings, discards, nowMs: Date.now() })).toBeNull()
  })

  it('el biberón empezado antes de la hora: milk_not_expired:started, en palabras', async () => {
    const [f] = await newBaby(fx.a)
    const fedAt = Date.now() - 10 * MIN
    const feedingId = await feedOk(f, [], { formula: 90, leftover: 20, at: fedAt })
    const r = await send(
      f,
      discardStartedBottleOp(f.babyId, null, { feedingId, leftoverMl: 20, fedAt: iso(fedAt) }),
    )
    expect(r.error).toBe('milk_not_expired:started')
    expect(milkErrorText(r.error, 'en')).toMatch(/started bottle is still good/)
  })

  it('Similac: compra, abrir la más vieja, desechar antes de 48 h (rechazo), anular una cerrada', async () => {
    const [f] = await newBaby(fx.a)
    const add = addFormulaOp(f.babyId, { count: 3, addedAt: iso(Date.now() - HOUR) })
    expect((await send(f, add)).error).toBeNull()
    expect((await send(f, add, 'replay')).error).toBeNull()
    let list = (await listFormulaContainers(f.babyId, f.client)).data
    expect(list).toHaveLength(3)

    let stock = formulaStock({ containers: list, feedings: [], nowMs: Date.now() })
    const open = openFormulaOp(f.babyId, stock.closed[0])
    expect((await send(f, open)).error).toBeNull()
    await feedOk(f, [], { formula: OZ })
    const feedings = (await bottleFeedingsSince(f.babyId, iso(Date.now() - 3 * HOUR), f.client))
      .data
    list = (await listFormulaContainers(f.babyId, f.client)).data
    stock = formulaStock({ containers: list, feedings, nowMs: Date.now() })
    expect(stock.closed).toHaveLength(2)
    expect(stock.open?.container.id).toBe(open.id)
    expect(stock.open?.usedMl).toBeCloseTo(OZ, 9)
    expect(stock.remainingMl).toBeCloseTo(23 * OZ, 2)

    const early = await send(f, finishFormulaOp({ id: open.id }, 'expired'))
    expect(early.error).toBe('milk_not_expired:formula')
    expect(milkErrorText(early.error, 'es')).toMatch(/no cumplió 48 h abierta/)

    expect((await send(f, voidFormulaOp(stock.closed[0]))).error).toBeNull()
    const reads = await milkV5Reads(f.babyId, f.client)
    expect(reads.formula.error).toBeNull()
    expect(reads.formula.data).toHaveLength(2)
    expect(reads.transfers.data).toEqual([])
  })

  it('RLS: la otra familia no lee transferencias, fórmula ni desechos de este bebé', async () => {
    const [f, other] = await newBaby(fx.a, fx.b)
    await send(f, addFormulaOp(f.babyId, { count: 1 }))
    const m1 = await pumpOk(f, 60, 'M1', Date.now() - 3 * HOUR)
    const m2 = await pumpOk(f, 30, 'M2', Date.now() - 3 * HOUR)
    const cs = (await listContainers(f.babyId, f.client)).data
    await send(
      f,
      combineMilkOp(
        f.babyId,
        cs.find((c) => c.id === m2.containerId)!,
        [cs.find((c) => c.id === m1.containerId)!],
      ),
    )
    expect((await listTransfers(f.babyId, other.client)).data).toEqual([])
    expect((await listFormulaContainers(f.babyId, other.client)).data).toEqual([])
    expect((await listDiscards(f.babyId, other.client)).data).toEqual([])
    expect((await listDrawdowns(f.babyId, other.client)).data).toEqual([])
    // Y no puede combinar los de este bebé.
    const r = await send(other, combineMilkOp(f.babyId, cs[0], [cs[1]]))
    expect(r.error).toMatch(/^milk_baby_not_found$/)
  })
})
