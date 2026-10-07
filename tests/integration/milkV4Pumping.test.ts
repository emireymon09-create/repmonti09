import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient, type SeededFamily } from '../helpers/supabase'
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
  feedOk,
  hasMilkV4,
  iso,
  liveDiscards,
  milkSnapshot,
  newBaby,
  pumpArgs,
  portionsOf,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Inventario v4 (0015): extracciones — log/update/void_pumping_session.
// Casos I-01…I-36 de docs/plan-pruebas-v4.md. Cada prueba con escritura termina
// con la invariante de ARQ §2.4 (afterEach). Cada una con su propio bebé, así
// "lo que hay" y los números ocupados no dependen del orden de la suite.

const ready = await hasMilkV4()
let fx: V4Families

const occupiedLabels = async (babyId: string) =>
  (
    await adminClient()
      .from('milk_containers')
      .select('label')
      .eq('baby_id', babyId)
      .is('voided_at', null)
      .is('released_at', null)
  ).data!.map((c) => c.label as string)

const sessionRow = async (id: string) =>
  (
    await adminClient()
      .from('pumping_sessions')
      .select('id, amount_ml, left_ml, right_ml, side, notes, pumped_at, voided_at, logged_by')
      .eq('id', id)
      .maybeSingle()
  ).data

const updateArgs = (
  sessionId: string,
  left: number | null,
  right: number | null,
  at: number | string,
  extra: Record<string, unknown> = {},
) => ({
  p_id: sessionId,
  p_side: 'both',
  p_left_ml: left,
  p_right_ml: right,
  p_notes: 'editada',
  p_pumped_at: typeof at === 'string' ? at : iso(at),
  ...extra,
})

/** Contenedor vencido (por la base) con `ml`, sin servir. */
async function expiredContainer(f: SeededFamily, ml: number, label: string) {
  return pumpOk(f, ml, label, Date.now() - FRIDGE_MS - 10 * MIN)
}

describe.skipIf(!ready)('v4 · log_pumping_session (I-01…I-15)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-pump')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-01 izq 59,147 / der 60 en M3 libre: sesión 119,147 y M3 ocupado', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 59.147, right: 60, label: 'M3' })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    expect(await sessionRow(args.p_id)).toMatchObject({
      amount_ml: 119.147,
      left_ml: 59.147,
      right_ml: 60,
    })
    const c = await containerRow(args.p_container_id!)
    expect(c).toMatchObject({
      label: 'M3',
      amount_ml: 119.147,
      remaining_ml: 119.147,
      lost_ml: 0,
      released_at: null,
    })
    // Entra al refri a la hora de la extracción (D-3) y vence a +96 h exactas.
    expect(Date.parse(c.stored_at)).toBe(Date.parse(args.p_pumped_at))
    expect(Date.parse(c.expires_at) - Date.parse(c.stored_at)).toBe(FRIDGE_MS)
  })

  it('I-02 sin cantidad (nulos o 0 y 0) y sin biberón: sesión sin total y sin contenedor', async () => {
    const [f] = await newBaby(fx.a)
    for (const [left, right] of [
      [null, null],
      [0, 0],
    ] as const) {
      const args = pumpArgs(f, { left, right })
      expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
      expect((await sessionRow(args.p_id))!.amount_ml).toBeNull()
    }
    expect((await milkSnapshot(f.babyId)).containers).toEqual([])
  })

  it('I-03 cantidad sin biberón elegido: milk_bad_input y nada escrito', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 30 })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBe('milk_bad_input')
    expect(await sessionRow(args.p_id)).toBeNull()
    // Con id de contenedor pero sin número, tampoco.
    const args2 = pumpArgs(f, { left: 30, containerId: randomUUID() })
    expect((await rpc(f.client, 'log_pumping_session', args2)).error).toBe('milk_bad_input')
    expect((await milkSnapshot(f.babyId)).sessions).toEqual([])
  })

  it('I-04 M3 ocupado: milk_label_taken:M3 y nada escrito', async () => {
    const [f] = await newBaby(fx.a)
    await pumpOk(f, 40, 'M3')
    const before = await milkSnapshot(f.babyId)
    const args = pumpArgs(f, { left: 20, label: 'M3' })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBe('milk_label_taken:M3')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-05 M3 vaciado por una toma: el número se reusa (uno libre y uno ocupado)', async () => {
    const [f] = await newBaby(fx.a)
    const first = await pumpOk(f, 60, 'M3', Date.now() - HOUR)
    // Deja 0,1 ml: polvo de redondeo, por debajo de EMPTY_ML.
    await feedOk(f, [[first.containerId, 59.9]])
    const freed = await containerRow(first.containerId)
    expect(freed.released_at).not.toBeNull()
    expect(Number(freed.remaining_ml)).toBeCloseTo(0.1, 9)
    const second = await pumpOk(f, 50, 'M3')
    expect((await containerRow(second.containerId)).released_at).toBeNull()
    const { data: all } = await adminClient()
      .from('milk_containers')
      .select('id, released_at')
      .eq('baby_id', f.babyId)
      .eq('label', 'M3')
      .is('voided_at', null)
    expect(all!.map((c) => c.released_at === null).sort()).toEqual([false, true])
  })

  it('I-06 M3 desechado: el número se reusa', async () => {
    const [f] = await newBaby(fx.a)
    const old = await expiredContainer(f, 45, 'M3')
    expect(
      (await rpc(f.client, 'discard_container', discardArgs(old.containerId))).error,
    ).toBeNull()
    await pumpOk(f, 30, 'M3')
    expect(await occupiedLabels(f.babyId)).toEqual(['M3'])
  })

  it('I-07 M9 con N=6 y números grandes entran (D-1); formatos inválidos no', async () => {
    const [f] = await newBaby(fx.a)
    // N es de la pantalla: el servidor no valida número ≤ N (D-1, D-2).
    for (const label of ['M9', 'M1234567']) await pumpOk(f, 10, label)
    for (const bad of ['M0', 'm3', 'M', 'M03', 'X3', 'M 3', 'M-1']) {
      const args = pumpArgs(f, { left: 10, label: bad })
      expect((await rpc(f.client, 'log_pumping_session', args)).error, bad).toBe('milk_bad_input')
    }
    expect((await occupiedLabels(f.babyId)).sort()).toEqual(['M1234567', 'M9'])
  })

  it('I-08 reenvío con el mismo id y la misma carga: no-op', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 30, right: 10, label: 'M2' })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (let i = 0; i < 3; i++)
      expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    expect(before.sessions).toHaveLength(1)
    expect(before.containers).toHaveLength(1)
  })

  it('I-09 mismo id con otro biberón: milk_idempotency_conflict', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 30, label: 'M2' })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    const other = { ...args, p_container_label: 'M4' }
    expect((await rpc(f.client, 'log_pumping_session', other)).error).toBe(
      'milk_idempotency_conflict',
    )
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-10 mismo id con otro bebé o con otro container_id: milk_idempotency_conflict', async () => {
    const [f] = await newBaby(fx.a)
    const [sib] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 30, label: 'M2' })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (const variant of [
      { ...args, p_baby_id: sib.babyId },
      { ...args, p_container_id: randomUUID() },
    ]) {
      expect((await rpc(f.client, 'log_pumping_session', variant)).error).toBe(
        'milk_idempotency_conflict',
      )
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    expect((await milkSnapshot(sib.babyId)).sessions).toEqual([])
  })

  it('I-10b el reenvío del alta sin cantidad sigue siendo no-op después de que una edición le dio biberón', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: null, right: null })
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    const upd = updateArgs(args.p_id, 30, null, args.p_pumped_at, {
      p_container_id: randomUUID(),
      p_container_label: 'M5',
    })
    expect((await rpc(f.client, 'update_pumping_session', upd)).error).toBeNull()
    expect((await rpc(f.client, 'log_pumping_session', args)).error).toBeNull()
    expect(await occupiedLabels(f.babyId)).toEqual(['M5'])
  })

  it('I-11 A1 y A2 eligen M3 a la vez: uno entra, el otro milk_label_taken:M3', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const r = await Promise.all([
      rpc(f1.client, 'log_pumping_session', pumpArgs(f1, { left: 30, label: 'M3' })),
      rpc(f2.client, 'log_pumping_session', pumpArgs(f2, { left: 40, label: 'M3' })),
    ])
    expect(r.map((x) => x.error).sort()).toEqual([null, 'milk_label_taken:M3'].sort())
    expect(await occupiedLabels(f1.babyId)).toEqual(['M3'])
    expect((await milkSnapshot(f1.babyId)).sessions).toHaveLength(1)
  })

  it('I-12 la familia B con el bebé de A: milk_baby_not_found', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(fx.b, { left: 30, label: 'M1', babyId: f.babyId })
    expect((await rpc(fx.b.client, 'log_pumping_session', args)).error).toBe('milk_baby_not_found')
    expect((await milkSnapshot(f.babyId)).sessions).toEqual([])
  })

  it('I-13 el actor es auth.uid(): logged_by de quien llama; un p_logged_by extra no existe', async () => {
    const [, f2] = await newBaby(fx.a, fx.a2)
    const p = await pumpOk(f2, 25, 'M1')
    expect((await sessionRow(p.sessionId))!.logged_by).toBe(fx.a2.userId)
    const { data } = await adminClient()
      .from('milk_containers')
      .select('logged_by')
      .eq('id', p.containerId)
      .single()
    expect(data!.logged_by).toBe(fx.a2.userId)
    const forged = { ...pumpArgs(f2, { left: 10, label: 'M2' }), p_logged_by: fx.a.userId }
    const r = await rpc(f2.client, 'log_pumping_session', forged)
    expect(r.error).toMatch(/Could not find the function/)
    expect(await sessionRow(forged.p_id)).toBeNull()
  })

  it('I-14 topes en izquierdo y derecho: milk_bad_input (y un texto, error de tipo), nada escrito', async () => {
    const [f] = await newBaby(fx.a)
    for (const bad of BAD_AMOUNTS) {
      for (const side of ['p_left_ml', 'p_right_ml'] as const) {
        const args = { ...pumpArgs(f, { left: 10, label: 'M1' }), [side]: bad }
        expect((await rpc(f.client, 'log_pumping_session', args)).error, `${side}=${bad}`).toBe(
          'milk_bad_input',
        )
      }
    }
    // 99 999 + 99 999: cada lado pasa, el total no.
    const big = pumpArgs(f, { left: 99999, right: 99999, label: 'M1' })
    expect((await rpc(f.client, 'log_pumping_session', big)).error).toBe('milk_bad_input')
    // Un texto que no es número no llega a la función: PostgREST/Postgres lo
    // rechaza al convertir el argumento (22P02). No es milk_bad_input, pero es
    // un rechazo y no escribe nada.
    const text = { ...pumpArgs(f, { left: 10, label: 'M1' }), p_left_ml: 'abc' }
    expect((await rpc(f.client, 'log_pumping_session', text)).error).not.toBeNull()
    expect((await milkSnapshot(f.babyId)).sessions).toEqual([])
  })

  it('I-14b total entre 0 y 0,15 ml (polvo: 0,1, 1e-30, 0,149, 0,05 + 0,05): milk_bad_input y nada escrito; 0,15 entra (M-1)', async () => {
    const [f] = await newBaby(fx.a)
    for (const [left, right] of [
      [0.1, null],
      [1e-30, null],
      [0.149, null],
      [0.05, 0.05],
      [null, 0.1],
    ] as const) {
      const args = pumpArgs(f, { left, right, label: 'M4' })
      expect((await rpc(f.client, 'log_pumping_session', args)).error, `${left}/${right}`).toBe(
        'milk_bad_input',
      )
    }
    expect((await milkSnapshot(f.babyId)).sessions).toEqual([])
    // El borde: 0,15 ml ya es un biberón ocupado (INV-5 pide ≥ 0,15).
    const ok = await pumpOk(f, 0.15, 'M4')
    expect((await containerRow(ok.containerId)).released_at).toBeNull()
  })

  it('I-14c hora de extracción más de 10 min en el futuro según la base: milk_future_time; +5 min entra; el reenvío del alta sigue siendo no-op (m-2)', async () => {
    const [f] = await newBaby(fx.a)
    const future = pumpArgs(f, { left: 30, label: 'M2', at: Date.now() + 11 * MIN })
    expect((await rpc(f.client, 'log_pumping_session', future)).error).toBe('milk_future_time')
    const empty = pumpArgs(f, { at: Date.now() + 11 * MIN })
    expect((await rpc(f.client, 'log_pumping_session', empty)).error).toBe('milk_future_time')
    expect((await milkSnapshot(f.babyId)).sessions).toEqual([])
    const soon = pumpArgs(f, { left: 30, label: 'M2', at: Date.now() + 5 * MIN })
    expect((await rpc(f.client, 'log_pumping_session', soon)).error).toBeNull()
    expect((await rpc(f.client, 'log_pumping_session', soon)).error).toBeNull()
  })

  it('I-15b milk_rebalance llamada directa por un padre (PostgREST): milk_rpc_only y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 2 * OZ, 'M3')
    const feed = await feedOk(f, [[p.containerId, OZ]])
    expect(feed).toBeTruthy()
    const before = await milkSnapshot(f.babyId)
    for (const cause of ['serve', 'return', 'amount']) {
      const r = await rpc(f.client, 'milk_rebalance', {
        p_container_id: p.containerId,
        p_cause: cause,
      })
      expect(r.error, cause).toBe('milk_rpc_only')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-15 anon: no ejecuta y nada se escribe', async () => {
    const [f] = await newBaby(fx.a)
    const args = pumpArgs(f, { left: 10, label: 'M1' })
    expect((await rpc(anonClient(), 'log_pumping_session', args)).error).not.toBeNull()
    expect(await sessionRow(args.p_id)).toBeNull()
  })
})

describe.skipIf(!ready)('v4 · update_pumping_session (I-16…I-31)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-upd')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  /** M2 con 3 oz de las que se sirvieron 2 (el ejemplo de la regla 19). */
  async function papaExample(f: SeededFamily, at = Date.now() - HOUR) {
    const p = await pumpOk(f, 3 * OZ, 'M2', at)
    const feedId = await feedOk(f, [[p.containerId, 2 * OZ]], { at: at + 10 * MIN })
    return { ...p, at, feedId }
  }

  it('I-16 bajar por debajo de lo servido: milk_served_exceeds_amount:M2 y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const p = await papaExample(f)
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 1.5 * OZ, null, p.at),
    )
    expect(r.error).toBe('milk_served_exceeds_amount:M2')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-17 subir a 3,5 oz: le quedan 1,5 oz', async () => {
    const [f] = await newBaby(fx.a)
    const p = await papaExample(f)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 3.5 * OZ, null, p.at),
    )
    expect(r.error).toBeNull()
    const c = await containerRow(p.containerId)
    expect(Number(c.amount_ml)).toBeCloseTo(3.5 * OZ, 9)
    expect(Number(c.remaining_ml)).toBeCloseTo(1.5 * OZ, 9)
  })

  it('I-18 mover la hora 2 días: stored_at y expires_at se corren; la toma no se re-valida (D-7)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await papaExample(f, Date.now() - 3 * DAY)
    const later = p.at + 2 * DAY
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 3 * OZ, null, later),
    )
    expect(r.error).toBeNull()
    const c = await containerRow(p.containerId)
    expect(Date.parse(c.stored_at)).toBe(later)
    expect(Date.parse(c.expires_at)).toBe(later + FRIDGE_MS)
    // La toma, anterior a la hora nueva de la extracción, sigue viva.
    const { data } = await adminClient()
      .from('feedings')
      .select('voided_at')
      .eq('id', p.feedId)
      .single()
    expect(data!.voided_at).toBeNull()
  })

  it('I-19 cambiar la división 2/1 → 1/2 con el mismo total: le queda lo mismo', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const p = await pumpOk(f, 2 * OZ, 'M4', at)
    await rpc(f.client, 'update_pumping_session', updateArgs(p.sessionId, 2 * OZ, 1 * OZ, at))
    await feedOk(f, [[p.containerId, OZ]])
    const before = await containerRow(p.containerId)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 1 * OZ, 2 * OZ, at),
    )
    expect(r.error).toBeNull()
    expect(await containerRow(p.containerId)).toEqual(before)
  })

  it('I-20 total 0 con leche servida: milk_already_served:M2', async () => {
    const [f] = await newBaby(fx.a)
    const p = await papaExample(f)
    const before = await milkSnapshot(f.babyId)
    for (const [l, r] of [
      [0, 0],
      [null, null],
    ] as const) {
      const res = await rpc(f.client, 'update_pumping_session', updateArgs(p.sessionId, l, r, p.at))
      expect(res.error).toBe('milk_already_served:M2')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-21 total 0 sin servir y desechada: se anulan contenedor y desecho (la desechada baja)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 45, 'M6')
    expect((await rpc(f.client, 'discard_container', discardArgs(p.containerId))).error).toBeNull()
    expect(await liveDiscards(p.containerId)).toHaveLength(1)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 0, 0, p.args.p_pumped_at),
    )
    expect(r.error).toBeNull()
    expect((await containerRow(p.containerId)).voided_at).not.toBeNull()
    expect((await liveDiscards(p.containerId)).every((d) => d.voided_at !== null)).toBe(true)
    expect((await sessionRow(p.sessionId))!.amount_ml).toBeNull()
  })

  it('I-22 desechada, subir 1 oz: el desecho crece 1 oz y sigue libre (D-8)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 2 * OZ, 'M6')
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 3 * OZ, null, p.args.p_pumped_at),
    )
    expect(r.error).toBeNull()
    const [d] = await liveDiscards(p.containerId)
    expect(Number(d.amount_ml)).toBeCloseTo(3 * OZ, 9)
    const c = await containerRow(p.containerId)
    expect(c.released_at).not.toBeNull()
    expect(Number(c.remaining_ml)).toBe(0)
  })

  it('I-23 desechada y servida en parte, bajar hasta lo servido: el desecho se anula, queda libre sin desecho', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 3 * OZ, 'M7', at)
    await feedOk(f, [[p.containerId, OZ]], { at: at + HOUR })
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    expect(Number((await liveDiscards(p.containerId))[0].amount_ml)).toBeCloseTo(2 * OZ, 9)
    const r = await rpc(f.client, 'update_pumping_session', updateArgs(p.sessionId, OZ, null, at))
    expect(r.error).toBeNull()
    expect((await liveDiscards(p.containerId)).filter((d) => !d.voided_at)).toEqual([])
    const c = await containerRow(p.containerId)
    expect(c).toMatchObject({ voided_at: null, remaining_ml: 0, lost_ml: 0 })
    expect(c.released_at).not.toBeNull()
    // Bajar por debajo de lo servido sigue prohibido.
    const below = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, OZ / 2, null, at),
    )
    expect(below.error).toBe('milk_served_exceeds_amount:M7')
  })

  it('I-23b desechada y servida en parte, bajar SIN llegar a lo servido: el desecho se achica justo lo bajado y sigue libre', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 3 * OZ, 'M7', at)
    const feedId = await feedOk(f, [[p.containerId, OZ]], { at: at + HOUR })
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const [d0] = await liveDiscards(p.containerId)
    expect(Number(d0.amount_ml)).toBeCloseTo(2 * OZ, 9)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 2 * OZ, null, at),
    )
    expect(r.error).toBeNull()
    const live = (await liveDiscards(p.containerId)).filter((d) => !d.voided_at)
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(d0.id)
    expect(Number(live[0].amount_ml)).toBeCloseTo(OZ, 9)
    const c = await containerRow(p.containerId)
    expect(c).toMatchObject({ voided_at: null, remaining_ml: 0, lost_ml: 0 })
    expect(Number(c.amount_ml)).toBeCloseTo(2 * OZ, 9)
    expect(c.released_at).not.toBeNull()
    // La toma no cambia.
    expect(await portionsOf(feedId)).toEqual({ M7: OZ })
  })

  it('I-24b libre con leche perdida (número reusado), bajar: lost_ml se achica justo lo bajado y "lo que hay" no cambia', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const old = await pumpOk(f, 2 * OZ, 'M3', at)
    const feedId = await feedOk(f, [[old.containerId, 2 * OZ]])
    const reuse = await pumpOk(f, 40, 'M3')
    // La toma se anula con el número tomado: su leche va a lost_ml (D-9).
    expect((await rpc(f.client, 'void_bottle_feed', { p_feeding_id: feedId })).error).toBeNull()
    expect(Number((await containerRow(old.containerId)).lost_ml)).toBeCloseTo(2 * OZ, 9)
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(old.sessionId, 1.5 * OZ, null, at),
    )
    expect(r.error).toBeNull()
    const c = await containerRow(old.containerId)
    expect(Number(c.lost_ml)).toBeCloseTo(1.5 * OZ, 9)
    expect(Number(c.remaining_ml)).toBe(0)
    expect(c.released_at).not.toBeNull()
    expect(Number((await containerRow(reuse.containerId)).remaining_ml)).toBe(40)
    expect(await occupiedLabels(f.babyId)).toEqual(['M3'])
  })

  it('I-24 libre con su número reusado, subir: va a lost_ml y "lo que hay" no cambia (D-9)', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const old = await pumpOk(f, 2 * OZ, 'M3', at)
    await feedOk(f, [[old.containerId, 2 * OZ]])
    const reuse = await pumpOk(f, 40, 'M3')
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(old.sessionId, 3 * OZ, null, at),
    )
    expect(r.error).toBeNull()
    const c = await containerRow(old.containerId)
    expect(Number(c.lost_ml)).toBeCloseTo(OZ, 9)
    expect(c.released_at).not.toBeNull()
    expect(Number(c.remaining_ml)).toBe(0)
    expect(Number((await containerRow(reuse.containerId)).remaining_ml)).toBe(40)
    expect(await occupiedLabels(f.babyId)).toEqual(['M3'])
  })

  it('I-25 libre con su número libre, subir: lo re-ocupa con la diferencia', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const old = await pumpOk(f, 2 * OZ, 'M3', at)
    await feedOk(f, [[old.containerId, 2 * OZ]])
    expect((await containerRow(old.containerId)).released_at).not.toBeNull()
    const r = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(old.sessionId, 3 * OZ, null, at),
    )
    expect(r.error).toBeNull()
    const c = await containerRow(old.containerId)
    expect(c.released_at).toBeNull()
    expect(Number(c.remaining_ml)).toBeCloseTo(OZ, 9)
    expect(Number(c.lost_ml)).toBe(0)
  })

  it('I-26 sesión sin contenedor gana cantidad: nace en M4 libre; con M5 ocupado, milk_label_taken:M5', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - HOUR
    const empty = pumpArgs(f, { at })
    await rpc(f.client, 'log_pumping_session', empty)
    const taken = await pumpOk(f, 20, 'M5')
    const empty2 = pumpArgs(f, { at })
    await rpc(f.client, 'log_pumping_session', empty2)
    const ok = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(empty.p_id, 30, null, at, {
        p_container_id: randomUUID(),
        p_container_label: 'M4',
      }),
    )
    expect(ok.error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    const no = await rpc(
      f.client,
      'update_pumping_session',
      updateArgs(empty2.p_id, 30, null, at, {
        p_container_id: randomUUID(),
        p_container_label: 'M5',
      }),
    )
    expect(no.error).toBe('milk_label_taken:M5')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    expect((await occupiedLabels(f.babyId)).sort()).toEqual(['M4', 'M5'])
    expect(taken.containerId).toBeTruthy()
  })

  it('I-27 sesión legada: solo hora y nota, el total queda', async () => {
    const [f] = await newBaby(fx.a)
    const id = randomUUID()
    expect(
      (
        await f.client.from('pumping_sessions').insert({
          id,
          baby_id: f.babyId,
          logged_by: f.userId,
          side: 'left',
          amount_ml: 90,
          notes: null,
          pumped_at: iso(Date.now() - 2 * HOUR),
        })
      ).error,
    ).toBeNull()
    const at = Date.now() - HOUR
    const r = await rpc(f.client, 'update_pumping_session', updateArgs(id, null, null, at))
    expect(r.error).toBeNull()
    const s = await sessionRow(id)
    expect(s).toMatchObject({ amount_ml: 90, side: 'left', notes: 'editada', left_ml: null })
    expect(Date.parse(s!.pumped_at)).toBe(at)
    expect((await milkSnapshot(f.babyId)).containers).toEqual([])
  })

  it('I-28 reenvío del mismo pedido: no-op', async () => {
    const [f] = await newBaby(fx.a)
    const p = await papaExample(f)
    const args = updateArgs(p.sessionId, 4 * OZ, null, p.at)
    expect((await rpc(f.client, 'update_pumping_session', args)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (let i = 0; i < 2; i++)
      expect((await rpc(f.client, 'update_pumping_session', args)).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-29 A1 edita la extracción mientras A2 sirve del mismo contenedor: se serializan', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const at = Date.now() - HOUR
    const p = await pumpOk(f1, 3 * OZ, 'M2', at)
    const results = await Promise.all([
      rpc(f1.client, 'update_pumping_session', updateArgs(p.sessionId, 1 * OZ, null, at)),
      rpc(f2.client, 'log_bottle_feed', {
        p_id: randomUUID(),
        p_baby_id: f2.babyId,
        p_fed_at: iso(Date.now()),
        p_notes: null,
        p_formula_ml: 0,
        p_portions: [{ container_id: p.containerId, amount_ml: 2 * OZ }],
        p_leftover_ml: null,
      }),
    ])
    // O baja primero y la toma no alcanza, o sirve primero y la extracción ya
    // no puede bajar por debajo de lo servido. Nunca las dos.
    const errors = results.map((r) => r.error)
    expect(errors.filter((e) => e === null)).toHaveLength(1)
    expect(errors.find((e) => e !== null)).toMatch(/^milk_(overdraw|served_exceeds_amount):M2$/)
  })

  it('I-30 la familia B sobre una sesión de A: milk_session_gone', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M1')
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(
      fx.b.client,
      'update_pumping_session',
      updateArgs(p.sessionId, 60, null, Date.now()),
    )
    expect(r.error).toBe('milk_session_gone')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-31b total entre 0 y 0,15 ml: milk_bad_input y nada cambia, con biberón y sin él (M-1)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M1')
    const empty = pumpArgs(f)
    expect((await rpc(f.client, 'log_pumping_session', empty)).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    for (const ml of [0.1, 1e-30, 0.149]) {
      expect(
        (
          await rpc(
            f.client,
            'update_pumping_session',
            updateArgs(p.sessionId, ml, null, p.args.p_pumped_at),
          )
        ).error,
        `con biberón ${ml}`,
      ).toBe('milk_bad_input')
      expect(
        (
          await rpc(
            f.client,
            'update_pumping_session',
            updateArgs(empty.p_id, null, ml, empty.p_pumped_at, {
              p_container_id: randomUUID(),
              p_container_label: 'M2',
            }),
          )
        ).error,
        `sin biberón ${ml}`,
      ).toBe('milk_bad_input')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-31c hora más de 10 min en el futuro: milk_future_time y nada cambia, también en una legada (m-2)', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M1')
    const legacy = randomUUID()
    expect(
      (
        await f.client.from('pumping_sessions').insert({
          id: legacy,
          baby_id: f.babyId,
          logged_by: f.userId,
          side: 'left',
          amount_ml: 50,
          pumped_at: iso(Date.now() - HOUR),
        })
      ).error,
    ).toBeNull()
    const before = await milkSnapshot(f.babyId)
    const at = Date.now() + 11 * MIN
    expect(
      (await rpc(f.client, 'update_pumping_session', updateArgs(p.sessionId, 30, null, at))).error,
    ).toBe('milk_future_time')
    expect(
      (await rpc(f.client, 'update_pumping_session', updateArgs(legacy, null, null, at))).error,
    ).toBe('milk_future_time')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
    const soon = Date.now() + 5 * MIN
    expect(
      (await rpc(f.client, 'update_pumping_session', updateArgs(p.sessionId, 30, null, soon)))
        .error,
    ).toBeNull()
  })

  it('I-31 topes: milk_bad_input y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M1')
    const before = await milkSnapshot(f.babyId)
    for (const bad of BAD_AMOUNTS) {
      for (const side of ['p_left_ml', 'p_right_ml'] as const) {
        const args = { ...updateArgs(p.sessionId, 30, null, Date.now()), [side]: bad }
        expect((await rpc(f.client, 'update_pumping_session', args)).error, `${side}=${bad}`).toBe(
          'milk_bad_input',
        )
      }
    }
    const big = updateArgs(p.sessionId, 99999, 99999, Date.now())
    expect((await rpc(f.client, 'update_pumping_session', big)).error).toBe('milk_bad_input')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })
})

describe.skipIf(!ready)('v4 · void_pumping_session (I-32…I-36)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-void')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-32 sin servir: sesión y contenedor anulados; el número queda libre', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M3')
    expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    expect((await sessionRow(p.sessionId))!.voided_at).not.toBeNull()
    expect((await containerRow(p.containerId)).voided_at).not.toBeNull()
    await pumpOk(f, 20, 'M3')
  })

  it('I-33 servida (ocupada, libre o desechada): milk_already_served:M#', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const occupied = await pumpOk(f, 3 * OZ, 'M1', Date.now() - HOUR)
    await feedOk(f, [[occupied.containerId, OZ]])
    const freed = await pumpOk(f, OZ, 'M2', Date.now() - HOUR)
    await feedOk(f, [[freed.containerId, OZ]])
    const discarded = await pumpOk(f, 3 * OZ, 'M3', at)
    await feedOk(f, [[discarded.containerId, OZ]], { at: at + HOUR })
    await rpc(f.client, 'discard_container', discardArgs(discarded.containerId))
    const before = await milkSnapshot(f.babyId)
    for (const [p, label] of [
      [occupied, 'M1'],
      [freed, 'M2'],
      [discarded, 'M3'],
    ] as const) {
      expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBe(
        `milk_already_served:${label}`,
      )
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-34 desechada sin servir: se anula también el desecho', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 40, 'M4')
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    const ds = await liveDiscards(p.containerId)
    expect(ds).toHaveLength(1)
    expect(ds[0].voided_at).not.toBeNull()
    expect((await containerRow(p.containerId)).voided_at).not.toBeNull()
  })

  it('I-35 dos veces: no-op', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M5')
    expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    const before = await milkSnapshot(f.babyId)
    expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    expect((await rpc(f.client, 'void_pumping_session', { p_id: randomUUID() })).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-36 la familia B: no-op (no la ve) y A intacta', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 30, 'M6')
    const before = await milkSnapshot(f.babyId)
    expect((await rpc(fx.b.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })
})
