import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  HOUR,
  MIN,
  assertMilkInvariant,
  hasLocalDocker,
  iso,
  newBaby,
  psql,
  pumpArgs,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import { combineArgs, containerV5, hasMilkV5 } from '../helpers/milkV5'

// Inventario v5 (0016): enfriado — fridge_at, cold_at, milk_mark_cold y
// milk_is_cold. I-C1 de docs/plan-pruebas-v5.md §2. Fría a la hora t ⇔
// cold_at <= t o coalesce(fridge_at, stored_at) + 60 min <= t.

const ready = await hasMilkV5()
const docker = ready && hasLocalDocker()
let fx: V4Families

const markArgs = (containerId: string, at: number | null, opId?: string) => ({
  p_op_id: opId ?? randomUUID(),
  p_container_id: containerId,
  p_cold_at: at === null ? null : iso(at),
})

describe.skipIf(!ready)('v5 · enfriado (I-C1)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-cool')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-C1 app vieja (10 argumentos, sin p_fridge_at): fridge_at = pumped_at', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - 20 * MIN
    const p = await pumpOk(f, 60, 'M1', at)
    expect(Object.keys(p.args)).toHaveLength(10)
    const c = await containerV5(p.containerId)
    expect(Date.parse(c.fridge_at!)).toBe(at)
    expect(Date.parse(c.stored_at)).toBe(at)
    expect(c.cold_at).toBeNull()
  })

  it('I-C1 p_fridge_at se acota a [pumped_at, now()+10 min]', async () => {
    const [f] = await newBaby(fx.a)
    const pumped = Date.now() - HOUR
    const cases: [string, number, (got: number, t0: number, t1: number) => void][] = [
      ['M1', pumped + 30 * MIN, (got) => expect(got).toBe(pumped + 30 * MIN)],
      ['M2', pumped - 30 * MIN, (got) => expect(got).toBe(pumped)],
      [
        'M3',
        Date.now() + 5 * HOUR,
        (got, t0, t1) => {
          expect(got).toBeGreaterThanOrEqual(t0 + 10 * MIN - 1000)
          expect(got).toBeLessThanOrEqual(t1 + 10 * MIN + 1000)
        },
      ],
    ]
    for (const [label, fridge, check] of cases) {
      const args = { ...pumpArgs(f, { left: 50, label, at: pumped }), p_fridge_at: iso(fridge) }
      const t0 = Date.now()
      expect((await rpc(f.client, 'log_pumping_session', args)).error, label).toBeNull()
      const t1 = Date.now()
      const c = await containerV5(args.p_container_id as string)
      check(Date.parse(c.fridge_at!), t0, t1)
      // La caducidad no se mueve con el enfriado (V5-22).
      expect(Date.parse(c.expires_at)).toBe(pumped + 4 * 24 * HOUR)
    }
  })

  it('I-C1 milk_mark_cold: acotada a [fridge_at, now()], idempotente, ya fría → no-op', async () => {
    const [f, f2] = await newBaby(fx.a, fx.a2)
    const pumped = Date.now() - 20 * MIN
    const early = await pumpOk(f, 50, 'M1', pumped)
    const late = await pumpOk(f, 50, 'M2', pumped)
    const none = await pumpOk(f, 50, 'M3', pumped)
    // Antes de entrar al refri → fridge_at.
    const a1 = markArgs(early.containerId, pumped - HOUR)
    const r1 = await rpc(f.client, 'milk_mark_cold', a1)
    expect(r1.error).toBeNull()
    expect(Date.parse((await containerV5(early.containerId)).cold_at!)).toBe(pumped)
    expect(r1.data).toMatchObject({ label: 'M1' })
    // Del futuro o nula → now() de la base.
    const t0 = Date.now()
    expect(
      (await rpc(f.client, 'milk_mark_cold', markArgs(late.containerId, t0 + HOUR))).error,
    ).toBeNull()
    expect(
      (await rpc(f.client, 'milk_mark_cold', markArgs(none.containerId, null))).error,
    ).toBeNull()
    const t1 = Date.now()
    for (const id of [late.containerId, none.containerId]) {
      const at = Date.parse((await containerV5(id)).cold_at!)
      expect(at).toBeGreaterThanOrEqual(t0 - 1000)
      expect(at).toBeLessThanOrEqual(t1 + 1000)
    }
    // Reenvío: mismo resultado; otra carga con el mismo op → conflicto.
    const again = await rpc(f.client, 'milk_mark_cold', a1)
    expect(again).toEqual(r1)
    const other = await rpc(f.client, 'milk_mark_cold', { ...a1, p_container_id: late.containerId })
    expect(other.error).toBe('milk_idempotency_conflict')
    // El otro teléfono la marca de nuevo (op distinto): no-op, cold_at igual.
    const before = (await containerV5(early.containerId)).cold_at
    expect(
      (await rpc(f2.client, 'milk_mark_cold', markArgs(early.containerId, null))).error,
    ).toBeNull()
    expect((await containerV5(early.containerId)).cold_at).toBe(before)
  })

  it('I-C1 anulado o de otra familia: milk_container_unusable; la otra familia no lo cambia', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 50, 'M1', Date.now() - 10 * MIN)
    const rb = await rpc(fx.b.client, 'milk_mark_cold', markArgs(p.containerId, null))
    expect(rb.error).toBe('milk_container_unusable')
    expect((await containerV5(p.containerId)).cold_at).toBeNull()
    expect((await rpc(f.client, 'void_pumping_session', { p_id: p.sessionId })).error).toBeNull()
    const rv = await rpc(f.client, 'milk_mark_cold', markArgs(p.containerId, null))
    expect(rv.error).toBe('milk_container_unusable')
  })

  it('I-C1 borde de 60 min: a 59 min Combinar rechaza milk_not_cold; a 61 min o confirmada, entra', async () => {
    const [f] = await newBaby(fx.a)
    const warm = await pumpOk(f, 40, 'M1', Date.now() - 59 * MIN)
    const cold = await pumpOk(f, 40, 'M2', Date.now() - 61 * MIN)
    const r = await rpc(
      f.client,
      'milk_combine',
      await combineArgs(f, cold.containerId, [warm.containerId]),
    )
    expect(r.error).toBe('milk_not_cold:M1')
    expect(
      (await rpc(f.client, 'milk_mark_cold', markArgs(warm.containerId, null))).error,
    ).toBeNull()
    const ok = await rpc(
      f.client,
      'milk_combine',
      await combineArgs(f, cold.containerId, [warm.containerId]),
    )
    expect(ok.error).toBeNull()
  })

  it.skipIf(!docker)(
    'I-C1 milk_is_cold al milisegundo: fridge_at + 60 min exactas es fría; −1 ms no',
    () => {
      // Una fila armada en memoria (jsonb_populate_record): no toca la base.
      const row = (patch: string) =>
        `jsonb_populate_record(null::milk_containers, to_jsonb(m) || ${patch})`
      const sql = `with m as (select * from milk_containers limit 1)
      select milk_is_cold(${row(`jsonb_build_object('fridge_at', '2026-10-07T10:00:00Z', 'cold_at', null)`)},
                          '2026-10-07T11:00:00Z') || '|' ||
             milk_is_cold(${row(`jsonb_build_object('fridge_at', '2026-10-07T10:00:00Z', 'cold_at', null)`)},
                          '2026-10-07T10:59:59.999Z') || '|' ||
             -- confirmada a las 10:30: fría desde las 10:30
             milk_is_cold(${row(`jsonb_build_object('fridge_at', '2026-10-07T10:00:00Z', 'cold_at', '2026-10-07T10:30:00Z')`)},
                          '2026-10-07T10:30:00Z') || '|' ||
             milk_is_cold(${row(`jsonb_build_object('fridge_at', '2026-10-07T10:00:00Z', 'cold_at', '2026-10-07T10:30:00Z')`)},
                          '2026-10-07T10:29:59.999Z') || '|' ||
             -- fridge_at nulo cae en stored_at
             milk_is_cold(${row(`jsonb_build_object('fridge_at', null, 'cold_at', null, 'stored_at', '2026-10-07T10:00:00Z')`)},
                          '2026-10-07T11:00:00Z') || '|' ||
             milk_is_cold(${row(`jsonb_build_object('fridge_at', null, 'cold_at', null, 'stored_at', '2026-10-07T10:00:00Z')`)},
                          '2026-10-07T10:59:59.999Z')
        from m`
      expect(psql(sql).trim()).toBe('true|false|true|false|true|false')
    },
  )
})
