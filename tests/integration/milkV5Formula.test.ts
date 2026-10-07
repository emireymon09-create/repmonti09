import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/supabase'
import { formulaStock } from '@/lib/formulaStock'
import type { FormulaContainer } from '@/lib/types'
import {
  DAY,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  editArgs,
  feedOk,
  iso,
  newBaby,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import {
  formulaAddOk,
  formulaOpenArgs,
  formulaRows,
  hasMilkV5,
  startedFeed,
} from '../helpers/milkV5'

// Inventario v5 (0016): Similac — formula_add, formula_open, formula_finish y
// formula_void. I-F1 de docs/plan-pruebas-v5.md §2. La abierta vence a las
// 48 h exactas según now() de la BASE.

const ready = await hasMilkV5()
let fx: V4Families
const BOTTLE = 236.5882365

const finishArgs = (id: string, reason: string, at: number | null = null) => ({
  p_op_id: randomUUID(),
  p_container_id: id,
  p_reason: reason,
  p_at: at === null ? null : iso(at),
})

describe.skipIf(!ready)('v5 · fórmula (I-F1)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-formula')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-F1 formula_add: 6 cerradas; reenvío no-op; misma op con otra carga → conflicto', async () => {
    const [f] = await newBaby(fx.a)
    const { args } = await formulaAddOk(f, 6)
    const rows = await formulaRows(f.babyId)
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r).toMatchObject({ opened_at: null, finished_at: null, voided_at: null })
      expect(Number(r.size_ml)).toBe(BOTTLE)
    }
    const again = await rpc(f.client, 'formula_add', args)
    expect(again).toEqual({ data: { added: 6 }, error: null })
    // Orden distinto de los mismos ids: misma carga canónica.
    const shuffled = await rpc(f.client, 'formula_add', {
      ...args,
      p_ids: [...args.p_ids].reverse(),
    })
    expect(shuffled.error).toBeNull()
    const other = await rpc(f.client, 'formula_add', { ...args, p_size_ml: 100 })
    expect(other.error).toBe('milk_idempotency_conflict')
    expect(await formulaRows(f.babyId)).toHaveLength(6)
    // Un id ya usado en otra operación: conflicto, nada entra.
    const reuse = await rpc(f.client, 'formula_add', {
      ...args,
      p_op_id: randomUUID(),
      p_ids: [args.p_ids[0], randomUUID()],
    })
    expect(reuse.error).toBe('milk_idempotency_conflict')
    expect(await formulaRows(f.babyId)).toHaveLength(6)
  })

  it('I-F1 formula_add rechaza: 0 o 25 botellas, ids repetidos, tamaño inválido, compra del futuro', async () => {
    const [f] = await newBaby(fx.a)
    const base = {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_ids: [randomUUID()],
      p_size_ml: BOTTLE,
      p_added_at: iso(Date.now()),
    }
    const id = randomUUID()
    const cases: [Record<string, unknown>, string][] = [
      [{ p_ids: [] }, 'milk_bad_input'],
      [{ p_ids: Array.from({ length: 25 }, () => randomUUID()) }, 'milk_bad_input'],
      [{ p_ids: [id, id] }, 'milk_bad_input'],
      [{ p_size_ml: 0 }, 'milk_bad_input'],
      [{ p_size_ml: 'NaN' }, 'milk_bad_input'],
      [{ p_size_ml: 100000 }, 'milk_bad_input'],
      [{ p_added_at: iso(Date.now() + 11 * MIN) }, 'milk_future_time'],
    ]
    for (const [patch, code] of cases) {
      const r = await rpc(f.client, 'formula_add', { ...base, ...patch, p_op_id: randomUUID() })
      expect(r.error, JSON.stringify(patch).slice(0, 60)).toBe(code)
    }
    // 24 sí entra.
    const ok = await rpc(f.client, 'formula_add', {
      ...base,
      p_ids: Array.from({ length: 24 }, () => randomUUID()),
    })
    expect(ok.error).toBeNull()
    expect(await formulaRows(f.babyId)).toHaveLength(24)
  })

  it('I-F1 formula_open: abre la cerrada; otra abre y reemplaza; sin cerrada crea una de 8 oz', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 2)
    const t1 = Date.now() - 3 * HOUR
    const r1 = await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], t1))
    expect(r1.error).toBeNull()
    expect(r1.data).toMatchObject({ opened: ids[0], created: false, replaced: null })
    const t2 = Date.now() - HOUR
    const r2 = await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[1], t2))
    expect(r2.data).toMatchObject({ opened: ids[1], replaced: ids[0] })
    const byId = new Map((await formulaRows(f.babyId)).map((r) => [r.id, r]))
    expect(byId.get(ids[0])).toMatchObject({ finish_reason: 'replaced' })
    expect(Date.parse(byId.get(ids[0])!.finished_at!)).toBe(t2)
    expect(Date.parse(byId.get(ids[1])!.opened_at!)).toBe(t2)
    // Sin cerradas: crea una abierta de 8 oz con el id del dispositivo.
    const fresh = randomUUID()
    const r3 = await rpc(f.client, 'formula_open', formulaOpenArgs(f, fresh, null))
    expect(r3.data).toMatchObject({ opened: fresh, created: true, replaced: ids[1] })
    const created = (await formulaRows(f.babyId)).find((r) => r.id === fresh)!
    expect(Number(created.size_ml)).toBe(BOTTLE)
    expect(created.finished_at).toBeNull()
    // Abrir de nuevo una que ya está abierta (otra op) → milk_bad_input; el
    // reenvío de la misma op devuelve lo mismo.
    const args = formulaOpenArgs(f, fresh, null)
    expect((await rpc(f.client, 'formula_open', args)).error).toBe('milk_bad_input')
    const replay = formulaOpenArgs(f, ids[0], null)
    expect((await rpc(f.client, 'formula_open', replay)).error).toBe('milk_bad_input') // terminada
    const open = (await formulaRows(f.babyId)).filter((r) => r.opened_at && !r.finished_at)
    expect(open.map((r) => r.id)).toEqual([fresh])
  })

  it('I-F1 opened_at del futuro se acota a now()+10 min; reenvío de la misma op = mismo resultado', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 1)
    const args = formulaOpenArgs(f, ids[0], Date.now() + 5 * HOUR)
    const t0 = Date.now()
    const r = await rpc(f.client, 'formula_open', args)
    expect(r.error).toBeNull()
    const at = Date.parse((await formulaRows(f.babyId))[0].opened_at!)
    expect(at).toBeGreaterThanOrEqual(t0 + 10 * MIN - 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 10 * MIN + 1000)
    expect(await rpc(f.client, 'formula_open', args)).toEqual(r)
  })

  it('I-F1 dos celulares abren a la vez (dos cerradas distintas): una sola abierta', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const { ids } = await formulaAddOk(f, 2)
    const [r1, r2] = await Promise.all([
      rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], null)),
      rpc(f2.client, 'formula_open', formulaOpenArgs(f2, ids[1], null)),
    ])
    expect(r1.error).toBeNull()
    expect(r2.error).toBeNull()
    const rows = await formulaRows(f.babyId)
    expect(rows.filter((r) => r.opened_at && !r.finished_at)).toHaveLength(1)
    expect(rows.filter((r) => r.finish_reason === 'replaced')).toHaveLength(1)
    // Y dos que CREAN a la vez (sin cerradas): igual una sola abierta.
    const [g] = await newBaby(fx.a)
    const [c1, c2] = await Promise.all([
      rpc(g.client, 'formula_open', formulaOpenArgs(g, randomUUID(), null)),
      rpc(fx.a2.client, 'formula_open', formulaOpenArgs(g, randomUUID(), null)),
    ])
    expect([c1.error, c2.error]).toEqual([null, null])
    expect((await formulaRows(g.babyId)).filter((r) => r.opened_at && !r.finished_at)).toHaveLength(
      1,
    )
  })

  it('I-F1 formula_finish expired: a 47h59m → milk_not_expired:formula; a 48h+1s → entra', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 2, Date.now() - 72 * HOUR)
    const young = Date.now() - (47 * HOUR + 59 * MIN)
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], young))
    const r = await rpc(f.client, 'formula_finish', finishArgs(ids[0], 'expired'))
    expect(r.error).toBe('milk_not_expired:formula')
    expect((await formulaRows(f.babyId)).find((x) => x.id === ids[0])!.finished_at).toBeNull()

    const old = Date.now() - (48 * HOUR + 1000)
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[1], old))
    // Reemplazó a la anterior (que abrió más tarde): termina a SU hora de apertura.
    const prev = (await formulaRows(f.babyId)).find((x) => x.id === ids[0])!
    expect(prev.finish_reason).toBe('replaced')
    expect(prev.finished_at).toBe(prev.opened_at)
    // Hora del teléfono anterior al vencimiento → se acota a opened_at + 48 h.
    const ok = await rpc(f.client, 'formula_finish', finishArgs(ids[1], 'expired', old))
    expect(ok.error).toBeNull()
    const row = (await formulaRows(f.babyId)).find((x) => x.id === ids[1])!
    expect(row.finish_reason).toBe('expired')
    expect(Date.parse(row.finished_at!)).toBe(old + 48 * HOUR)
    // Ya terminada → no-op (otra op).
    const again = await rpc(f.client, 'formula_finish', finishArgs(ids[1], 'empty'))
    expect(again.error).toBeNull()
    expect(again.data).toMatchObject({ reason: 'expired' })
  })

  it('I-F1 formula_finish empty siempre; cerrada o motivo raro → milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 2)
    expect((await rpc(f.client, 'formula_finish', finishArgs(ids[0], 'empty'))).error).toBe(
      'milk_bad_input',
    )
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], Date.now() - MIN))
    expect((await rpc(f.client, 'formula_finish', finishArgs(ids[0], 'replaced'))).error).toBe(
      'milk_bad_input',
    )
    const r = await rpc(f.client, 'formula_finish', finishArgs(ids[0], 'empty'))
    expect(r.error).toBeNull()
    expect((await formulaRows(f.babyId)).find((x) => x.id === ids[0])).toMatchObject({
      finish_reason: 'empty',
    })
  })

  it('I-F1 formula_void: cerrada y abierta se anulan; terminada no; anulada → no-op', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 3)
    const v = (id: string) =>
      rpc(f.client, 'formula_void', { p_op_id: randomUUID(), p_container_id: id })
    expect((await v(ids[0])).error).toBeNull()
    expect((await v(ids[0])).error).toBeNull()
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[1], null))
    expect((await v(ids[1])).error).toBeNull()
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[2], null))
    await rpc(f.client, 'formula_finish', finishArgs(ids[2], 'empty'))
    expect((await v(ids[2])).error).toBe('milk_bad_input')
    const rows = new Map((await formulaRows(f.babyId)).map((r) => [r.id, r]))
    expect(rows.get(ids[0])!.voided_at).not.toBeNull()
    expect(rows.get(ids[1])!.voided_at).not.toBeNull()
    expect(rows.get(ids[2])!.voided_at).toBeNull()
  })

  it('I-F1 RLS: la familia B no ve, no abre, no termina ni anula las botellas de A', async () => {
    const [f] = await newBaby(fx.a)
    const { ids } = await formulaAddOk(f, 2)
    const { data } = await fx.b.client.from('formula_containers').select('id').in('id', ids)
    expect(data).toEqual([])
    const b = fx.b
    expect((await rpc(b.client, 'formula_open', formulaOpenArgs(f, ids[0], null))).error).toBe(
      'milk_baby_not_found',
    )
    expect((await rpc(b.client, 'formula_open', formulaOpenArgs(b, ids[0], null))).error).toBe(
      'milk_bad_input',
    )
    expect((await rpc(b.client, 'formula_finish', finishArgs(ids[0], 'empty'))).error).toBe(
      'milk_bad_input',
    )
    expect(
      (await rpc(b.client, 'formula_void', { p_op_id: randomUUID(), p_container_id: ids[1] }))
        .error,
    ).toBe('milk_bad_input')
    const add = await rpc(b.client, 'formula_add', {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_ids: [randomUUID()],
      p_size_ml: BOTTLE,
      p_added_at: iso(Date.now()),
    })
    expect(add.error).toBe('milk_baby_not_found')
    expect((await formulaRows(f.babyId)).every((r) => !r.opened_at && !r.voided_at)).toBe(true)
  })

  it('I-F1 la fórmula nunca bloquea una toma: sin inventario y con la abierta vencida, la toma entra', async () => {
    const [f] = await newBaby(fx.a)
    await startedFeed(f, 0, Date.now() - HOUR, 120)
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, randomUUID(), Date.now() - 50 * HOUR))
    await startedFeed(f, 0, Date.now() - MIN, 120)
  })

  it('H4 horas viejas: compra o apertura de hace más de 30 días, o -infinity → milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const old = Date.now() - 31 * DAY
    const add = (at: string) =>
      rpc(f.client, 'formula_add', {
        p_op_id: randomUUID(),
        p_baby_id: f.babyId,
        p_ids: [randomUUID()],
        p_size_ml: BOTTLE,
        p_added_at: at,
      })
    expect((await add(iso(old))).error).toBe('milk_bad_input')
    expect((await add('-infinity')).error).toBe('milk_bad_input')
    const open = (at: string) =>
      rpc(f.client, 'formula_open', {
        p_op_id: randomUUID(),
        p_baby_id: f.babyId,
        p_container_id: randomUUID(),
        p_opened_at: at,
      })
    expect((await open(iso(old))).error).toBe('milk_bad_input')
    expect((await open('-infinity')).error).toBe('milk_bad_input')
    expect(await formulaRows(f.babyId)).toEqual([])
    // 29 días sí entra.
    expect((await add(iso(Date.now() - 29 * DAY))).error).toBeNull()
  })

  it('H4 abrir una cerrada con una hora anterior a su compra: opened_at = added_at', async () => {
    const [f] = await newBaby(fx.a)
    const addedAt = Date.now() - HOUR
    const { ids } = await formulaAddOk(f, 1, addedAt)
    const r = await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], addedAt - 2 * HOUR))
    expect(r.error).toBeNull()
    const [row] = await formulaRows(f.babyId)
    expect(Date.parse(row.opened_at!)).toBe(addedAt)
  })

  it('V5-03 editar la fórmula de una toma (1 → 2 oz) dentro de la abierta: lo que queda baja 1 oz', async () => {
    const [f] = await newBaby(fx.a)
    const r = await rpc(
      f.client,
      'formula_open',
      formulaOpenArgs(f, randomUUID(), Date.now() - 3 * HOUR),
    )
    expect(r.error).toBeNull()
    const feed = await feedOk(f, [], { formula: OZ, at: Date.now() - HOUR })
    const stock = async () => {
      const [{ data: feedings, error: e1 }, { data: containers, error: e2 }] = await Promise.all([
        adminClient()
          .from('feedings')
          .select('id, fed_at, feeding_type, formula_ml, voided_at')
          .eq('baby_id', f.babyId),
        adminClient().from('formula_containers').select('*').eq('baby_id', f.babyId),
      ])
      expect(e1).toBeNull()
      expect(e2).toBeNull()
      return formulaStock({
        containers: containers as FormulaContainer[],
        feedings: feedings!,
        nowMs: Date.now(),
      })
    }
    const before = await stock()
    expect(before.open!.usedMl).toBeCloseTo(OZ, 9)
    expect(before.remainingMl).toBeCloseTo(BOTTLE - OZ, 9)
    const e = await rpc(f.client, 'edit_bottle_feed', await editArgs(feed, { formula: 2 * OZ }))
    expect(e.error).toBeNull()
    const after = await stock()
    expect(after.open!.usedMl).toBeCloseTo(2 * OZ, 9)
    expect(before.remainingMl - after.remainingMl).toBeCloseTo(OZ, 9)
  })

  it('formula_add doble a la vez con ops distintos: filas = suma, sin choque', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const args = (n: number) => ({
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_ids: Array.from({ length: n }, () => randomUUID()),
      p_size_ml: BOTTLE,
      p_added_at: iso(Date.now() - HOUR),
    })
    const [r1, r2] = await Promise.all([
      rpc(f.client, 'formula_add', args(3)),
      rpc(f2.client, 'formula_add', args(4)),
    ])
    expect(r1).toEqual({ data: { added: 3 }, error: null })
    expect(r2).toEqual({ data: { added: 4 }, error: null })
    expect(await formulaRows(f.babyId)).toHaveLength(7)
  })
})
