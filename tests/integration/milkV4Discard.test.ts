import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient, anonClient, type SeededFamily } from '../helpers/supabase'
import {
  FRIDGE_MS,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  containerRow,
  discardArgs,
  feedArgs,
  feedOk,
  hasLocalDocker,
  hasMilkV4,
  iso,
  liveDiscards,
  milkSnapshot,
  newBaby,
  psql,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Inventario v4 (0015): "Desechar" leche caducada — discard_container.
// Casos I-37…I-50 de docs/plan-pruebas-v4.md. Quién decide que venció es
// now() de la BASE (D-15); la hora guardada es la del teléfono acotada a
// [expires_at, now()].

const ready = await hasMilkV4()
const docker = ready && hasLocalDocker()
let fx: V4Families

const expiredContainer = (f: SeededFamily, ml: number, label: string) =>
  pumpOk(f, ml, label, Date.now() - FRIDGE_MS - 10 * MIN)

describe.skipIf(!ready)('v4 · discard_container (I-37…I-48)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-disc')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-37 M3 vencido con 1,5 oz: una fila de 1,5 oz "expired", M3 en 0 y libre', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 1.5 * OZ, 'M3')
    const args = discardArgs(p.containerId)
    expect((await rpc(f.client, 'discard_container', args)).error).toBeNull()
    const ds = await liveDiscards(p.containerId)
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({ id: args.p_id, reason: 'expired', voided_at: null })
    expect(ds[0].logged_by).toBe(fx.a.userId)
    expect(Number(ds[0].amount_ml)).toBeCloseTo(1.5 * OZ, 9)
    const c = await containerRow(p.containerId)
    expect(Number(c.remaining_ml)).toBe(0)
    expect(c.released_at).not.toBeNull()
    expect(c.voided_at).toBeNull()
  })

  it('I-38 vencido y servido en parte: solo se tira lo que queda; la toma no cambia', async () => {
    const [f] = await newBaby(fx.a)
    const at = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 3 * OZ, 'M3', at)
    const feedId = await feedOk(f, [[p.containerId, OZ]], { at: at + HOUR })
    expect((await rpc(f.client, 'discard_container', discardArgs(p.containerId))).error).toBeNull()
    expect(Number((await liveDiscards(p.containerId))[0].amount_ml)).toBeCloseTo(2 * OZ, 9)
    const { data } = await adminClient()
      .from('milk_drawdowns')
      .select('amount_ml, voided_at')
      .eq('feeding_id', feedId)
      .single()
    expect(data).toMatchObject({ voided_at: null })
    expect(Number(data!.amount_ml)).toBeCloseTo(OZ, 9)
  })

  it('I-39 vigente según la base (teléfono adelantado): milk_not_expired:M3 y nada cambia', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 40, 'M3', Date.now() - HOUR)
    const before = await milkSnapshot(f.babyId)
    const future = Date.now() + FRIDGE_MS + HOUR
    for (const at of [future, null]) {
      const r = await rpc(f.client, 'discard_container', discardArgs(p.containerId, at))
      expect(r.error).toBe('milk_not_expired:M3')
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-40 la hora guardada se acota a [expires_at, now()]: anterior → expires_at; futura o nula → now()', async () => {
    const [f] = await newBaby(fx.a)
    const early = await expiredContainer(f, 30, 'M1')
    const late = await expiredContainer(f, 30, 'M2')
    const none = await expiredContainer(f, 30, 'M4')
    const t0 = Date.now()
    await rpc(f.client, 'discard_container', discardArgs(early.containerId, t0 - FRIDGE_MS * 2))
    await rpc(f.client, 'discard_container', discardArgs(late.containerId, t0 + 5 * HOUR))
    await rpc(f.client, 'discard_container', discardArgs(none.containerId, null))
    const t1 = Date.now()
    const atOf = async (id: string) => Date.parse((await liveDiscards(id))[0].discarded_at)
    expect(await atOf(early.containerId)).toBe(
      Date.parse((await containerRow(early.containerId)).expires_at),
    )
    // now() de la base, en este mismo servidor: entre antes y después de llamar
    // (1 s de margen por el redondeo del reloj de cada lado).
    for (const id of [late.containerId, none.containerId]) {
      const at = await atOf(id)
      expect(at).toBeGreaterThanOrEqual(t0 - 1000)
      expect(at).toBeLessThanOrEqual(t1 + 1000)
    }
  })

  it('I-41 reenvío con el mismo p_id: no-op, una sola fila', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    const args = discardArgs(p.containerId)
    for (let i = 0; i < 3; i++)
      expect((await rpc(f.client, 'discard_container', args)).error).toBeNull()
    expect(await liveDiscards(p.containerId)).toHaveLength(1)
  })

  it('I-42 mismo p_id, otro contenedor: milk_idempotency_conflict', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    const q = await expiredContainer(f, 30, 'M4')
    const args = discardArgs(p.containerId)
    await rpc(f.client, 'discard_container', args)
    const before = await milkSnapshot(f.babyId)
    const r = await rpc(f.client, 'discard_container', { ...args, p_container_id: q.containerId })
    expect(r.error).toBe('milk_idempotency_conflict')
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-43 A1 y A2 desechan M3 a la vez con ids distintos: una fila, ninguno ve error', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const p = await expiredContainer(f1, 30, 'M3')
    const r = await Promise.all([
      rpc(f1.client, 'discard_container', discardArgs(p.containerId)),
      rpc(f2.client, 'discard_container', discardArgs(p.containerId)),
    ])
    expect(r.map((x) => x.error)).toEqual([null, null])
    expect(await liveDiscards(p.containerId)).toHaveLength(1)
  })

  it('I-44 ya desechado, libre o anulado: no-op', async () => {
    const [f] = await newBaby(fx.a)
    const discarded = await expiredContainer(f, 30, 'M1')
    await rpc(f.client, 'discard_container', discardArgs(discarded.containerId))
    const freed = await pumpOk(f, OZ, 'M2', Date.now() - FRIDGE_MS - HOUR)
    await feedOk(f, [[freed.containerId, OZ]], { at: Date.now() - FRIDGE_MS - 30 * MIN })
    const voided = await expiredContainer(f, 30, 'M4')
    await rpc(f.client, 'void_pumping_session', { p_id: voided.sessionId })
    const before = await milkSnapshot(f.babyId)
    for (const p of [discarded, freed, voided]) {
      expect(
        (await rpc(f.client, 'discard_container', discardArgs(p.containerId))).error,
      ).toBeNull()
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-45 contenedor de la familia B o inexistente: milk_container_unusable', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    const before = await milkSnapshot(f.babyId)
    expect((await rpc(fx.b.client, 'discard_container', discardArgs(p.containerId))).error).toBe(
      'milk_container_unusable',
    )
    expect((await rpc(f.client, 'discard_container', discardArgs(randomUUID()))).error).toBe(
      'milk_container_unusable',
    )
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-45b sin id o sin contenedor: milk_bad_input', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    for (const args of [
      { ...discardArgs(p.containerId), p_id: null },
      { ...discardArgs(p.containerId), p_container_id: null },
    ]) {
      expect((await rpc(f.client, 'discard_container', args)).error).toBe('milk_bad_input')
    }
    expect(await liveDiscards(p.containerId)).toEqual([])
  })

  it('I-46 desechar mientras A2 sirve de M3 (sin conexión, antes de vencer): se serializan (D-22)', async () => {
    for (let round = 0; round < 3; round++) {
      const [f1, f2] = await newBaby(fx.a, fx.a2)
      const at = Date.now() - FRIDGE_MS - HOUR
      const p = await pumpOk(f1, 3 * OZ, 'M3', at)
      const feed = feedArgs(f2, [[p.containerId, 2 * OZ]], { at: at + 30 * MIN })
      const [d, s] = await Promise.all([
        rpc(f1.client, 'discard_container', discardArgs(p.containerId)),
        rpc(f2.client, 'log_bottle_feed', feed),
      ])
      expect(d.error).toBeNull()
      const ds = await liveDiscards(p.containerId)
      if (s.error === null) {
        // Sirvió primero: el desecho es lo que quedó.
        expect(Number(ds[0].amount_ml)).toBeCloseTo(OZ, 9)
      } else {
        // Desechó primero: la toma recibe el sobregiro, visible.
        expect(s.error).toBe('milk_overdraw:M3')
        expect(Number(ds[0].amount_ml)).toBeCloseTo(3 * OZ, 9)
      }
      await assertMilkInvariant(fx.familyIds)
    }
  })

  it('I-47 INSERT y UPDATE directos en milk_discards: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    const ins = await f.client.from('milk_discards').insert({
      id: randomUUID(),
      family_id: f.familyId,
      baby_id: f.babyId,
      container_id: p.containerId,
      amount_ml: 30,
      discarded_at: iso(Date.now()),
    })
    expect(ins.error?.message).toBe('milk_rpc_only')
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const [d] = await liveDiscards(p.containerId)
    for (const patch of [{ amount_ml: 1 }, { voided_at: iso(Date.now()) }]) {
      const { error } = await f.client.from('milk_discards').update(patch).eq('id', d.id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    // Ni service_role: la guarda es un trigger, no RLS.
    const { error } = await adminClient()
      .from('milk_discards')
      .update({ amount_ml: 1 })
      .eq('id', d.id)
    expect(error?.message).toBe('milk_rpc_only')
    expect(Number((await liveDiscards(p.containerId))[0].amount_ml)).toBe(30)
  })

  it('I-48 anon: no lee, no inserta, no ejecuta', async () => {
    const [f] = await newBaby(fx.a)
    const p = await expiredContainer(f, 30, 'M3')
    const anon = anonClient()
    expect((await anon.from('milk_discards').select('id')).error).not.toBeNull()
    expect(
      (
        await anon.from('milk_discards').insert({
          id: randomUUID(),
          family_id: f.familyId,
          baby_id: f.babyId,
          container_id: p.containerId,
          amount_ml: 30,
          discarded_at: iso(Date.now()),
        })
      ).error,
    ).not.toBeNull()
    expect((await rpc(anon, 'discard_container', discardArgs(p.containerId))).error).not.toBeNull()
    expect(await liveDiscards(p.containerId)).toEqual([])
    // La familia B no ve los desechos de A.
    await rpc(f.client, 'discard_container', discardArgs(p.containerId))
    const { data } = await fx.b.client.from('milk_discards').select('id').eq('baby_id', f.babyId)
    expect(data).toEqual([])
  })
})

// Los dos bordes que no se pueden armar por HTTP: `now()` exactamente igual a
// expires_at (dentro de UNA transacción now() es constante) y la zona horaria
// de la sesión de la base. psql dentro del contenedor local, en una transacción
// que se deshace: no deja nada.
describe.skipIf(!docker)('v4 · bordes de caducidad por SQL (I-49, I-50)', () => {
  let f: SeededFamily
  let done: () => Promise<void>
  beforeAll(async () => {
    const s = await seedV4('mv4-edge')
    f = s.a
    done = s.cleanup
  })
  afterAll(async () => {
    await done()
  })

  const asParent = (userId: string) => `
    select set_config('request.jwt.claims',
      json_build_object('sub', '${userId}', 'role', 'authenticated')::text, true);
    set local role authenticated;`

  it('I-49 now() = expires_at exacto: se puede desechar (la caducidad es exclusiva)', () => {
    const [sid, cid, did] = [randomUUID(), randomUUID(), randomUUID()]
    const out = psql(`
      begin;
      ${asParent(f.userId)}
      select log_pumping_session('${sid}', '${f.babyId}', 'both', 30, null, null,
        now() - interval '96 hours', '${cid}', 'M3', null);
      select (select expires_at from milk_containers where id = '${cid}') = now();
      select discard_container('${did}', '${cid}', null);
      select count(*) from milk_discards where id = '${did}' and container_id = '${cid}';
      select released_at is not null and remaining_ml = 0 from milk_containers where id = '${cid}';
      rollback;
    `)
    const lines = out.split('\n').filter((l) => l.trim() !== '')
    // set_config, log_pumping (vacía), expires = now, discard (vacía), 1 fila, liberado.
    expect(lines.slice(-3)).toEqual(['t', '1', 't'])
  })

  it('I-50 con la sesión en America/Los_Angeles, guardada antes del cambio de horario: vence a +96 h exactas', () => {
    const [sid, cid] = [randomUUID(), randomUUID()]
    // El horario de verano de EE. UU. termina el domingo 1 nov 2026 a las 2:00.
    const out = psql(`
      begin;
      set local timezone = 'America/Los_Angeles';
      ${asParent(f.userId)}
      select log_pumping_session('${sid}', '${f.babyId}', 'both', 30, null, null,
        '2026-10-30 21:00 America/Los_Angeles'::timestamptz, '${cid}', 'M4', null);
      select extract(epoch from expires_at - stored_at)::bigint,
             to_char(expires_at, 'YYYY-MM-DD HH24:MI')
        from milk_containers where id = '${cid}';
      rollback;
    `)
    const last = out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .at(-1)
    // 96 h exactas, que en la hora del hogar son las 20:00 (no las 21:00):
    // "4 días" no son 4 días de calendario.
    expect(last).toBe(`${96 * 3600}|2026-11-03 20:00`)
  })
})
