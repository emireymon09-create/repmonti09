import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/supabase'
import {
  FRIDGE_MS,
  HOUR,
  MIN,
  OZ,
  assertMilkInvariant,
  discardArgs,
  feedOk,
  feedingRow,
  hasLocalDocker,
  hasMilkV4,
  iso,
  milkSnapshot,
  newBaby,
  psql,
  pumpArgs,
  pumpOk,
  rpc,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'

// Inventario v4 (0015): la guarda de tomas, las columnas nuevas, N en babies y
// el esquema (RLS, grants, funciones). Casos I-93…I-103 e I-106 de
// docs/plan-pruebas-v4.md. I-104/I-105 (la migración sobre datos v3) están en
// milkV4Migration.test.ts.

const ready = await hasMilkV4()
const docker = ready && hasLocalDocker()
let fx: V4Families

describe.skipIf(!ready)('v4 · guarda de tomas, columnas y N (I-93…I-100, I-106)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-schema')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-93 UPDATE directo solo de la hora de una toma con desglose, a una hora válida: entra', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M1', Date.now() - 2 * HOUR)
    const id = await feedOk(f, [[p.containerId, 30]], { formula: 10 })
    const at = iso(Date.now() - HOUR)
    const { error } = await f.client.from('feedings').update({ fed_at: at }).eq('id', id)
    expect(error).toBeNull()
    expect(Date.parse((await feedingRow(id)).fed_at)).toBe(Date.parse(at))
    // Lo que manda updateFeeding de v0.12.1 (tipo y total iguales) también.
    const row = await feedingRow(id)
    const at2 = iso(Date.now() - 30 * MIN)
    const r2 = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: row.amount_ml, fed_at: at2 })
      .eq('id', id)
    expect(r2.error).toBeNull()
  })

  it('I-94 UPDATE directo de la hora a cuando su leche vencía / antes de la extracción / al futuro: rechazado', async () => {
    const [f] = await newBaby(fx.a)
    const stored = Date.now() - FRIDGE_MS - 2 * HOUR
    const p = await pumpOk(f, 90, 'M3', stored)
    const id = await feedOk(f, [[p.containerId, 30]], { at: stored + HOUR })
    const before = await milkSnapshot(f.babyId)
    const cases: [number, string][] = [
      [Date.now() - 30 * MIN, 'milk_container_unusable:M3'],
      [stored - HOUR, 'milk_container_unusable:M3'],
      [Date.now() + 11 * MIN, 'milk_future_time'],
    ]
    for (const [at, code] of cases) {
      const { error } = await f.client
        .from('feedings')
        .update({ fed_at: iso(at) })
        .eq('id', id)
      expect(error?.message, iso(at)).toBe(code)
    }
    expect(await milkSnapshot(f.babyId)).toEqual(before)
  })

  it('I-95 UPDATE directo del sobró de una toma con desglose: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const p = await pumpOk(f, 90, 'M1', Date.now() - HOUR)
    const id = await feedOk(f, [[p.containerId, 30]], { leftover: 5 })
    for (const leftover of [10, null]) {
      const { error } = await f.client
        .from('feedings')
        .update({ leftover_ml: leftover })
        .eq('id', id)
      expect(error?.message, String(leftover)).toBe('milk_rpc_only')
    }
    expect((await feedingRow(id)).leftover_ml).toBe(5)
  })

  it('I-96 sobró en una toma legada por UPDATE directo: entra; bajar el total por debajo da 23514 (D-11b)', async () => {
    const [f] = await newBaby(fx.a)
    const id = randomUUID()
    await f.client.from('feedings').insert({
      id,
      baby_id: f.babyId,
      logged_by: f.userId,
      feeding_type: 'bottle',
      amount_ml: 90,
      fed_at: iso(Date.now() - HOUR),
    })
    expect(
      (await f.client.from('feedings').update({ leftover_ml: 20 }).eq('id', id)).error,
    ).toBeNull()
    const { error } = await f.client.from('feedings').update({ amount_ml: 15 }).eq('id', id)
    expect(error?.code).toBe('23514')
    expect(error?.message).toMatch(/feedings_leftover_le_amount/)
    expect(await feedingRow(id)).toMatchObject({ amount_ml: 90, leftover_ml: 20 })
    // Sobró > total de entrada, y topes.
    for (const bad of [91, -1, 100000, 'NaN', 'Infinity']) {
      const r = await f.client.from('feedings').update({ leftover_ml: bad }).eq('id', id)
      expect(r.error, String(bad)).not.toBeNull()
    }
    // Pasar a nursing una toma legada con sobró (v0.12.1): entra (ARQ §3.11).
    const r = await f.client
      .from('feedings')
      .update({ feeding_type: 'nursing', amount_ml: null })
      .eq('id', id)
    expect(r.error).toBeNull()
    expect(await feedingRow(id)).toMatchObject({ amount_ml: null, leftover_ml: 20 })
    // Un alta directa sin desglose y con sobró también entra (estadística).
    const id2 = randomUUID()
    const ins = await f.client.from('feedings').insert({
      id: id2,
      baby_id: f.babyId,
      logged_by: f.userId,
      feeding_type: 'bottle',
      amount_ml: 60,
      leftover_ml: 10,
      fed_at: iso(Date.now() - HOUR),
    })
    expect(ins.error).toBeNull()
  })

  it('I-97 milk_bottle_count: default 6; 0, 31, 2.5, NaN, texto rechazados; 1 y 30 entran', async () => {
    const [f] = await newBaby(fx.a)
    const read = async () =>
      (await adminClient().from('babies').select('milk_bottle_count').eq('id', f.babyId).single())
        .data!.milk_bottle_count
    expect(await read()).toBe(6)
    for (const bad of [0, 31, -1, 2.5, 'NaN', 'seis', null]) {
      const { error } = await f.client
        .from('babies')
        .update({ milk_bottle_count: bad })
        .eq('id', f.babyId)
      expect(error, String(bad)).not.toBeNull()
    }
    expect(await read()).toBe(6)
    for (const ok of [1, 30]) {
      const { error } = await f.client
        .from('babies')
        .update({ milk_bottle_count: ok })
        .eq('id', f.babyId)
      expect(error).toBeNull()
      expect(await read()).toBe(ok)
    }
  })

  it('I-98 N=4 guardado por A1 lo lee A2', async () => {
    const [f1, f2] = await newBaby(fx.a, fx.a2)
    const { error } = await f1.client
      .from('babies')
      .update({ milk_bottle_count: 4, milk_fridge_days: 4 })
      .eq('id', f1.babyId)
    expect(error).toBeNull()
    const { data } = await f2.client
      .from('babies')
      .select('milk_bottle_count')
      .eq('id', f2.babyId)
      .single()
    expect(data!.milk_bottle_count).toBe(4)
  })

  it('I-99 la familia B no cambia el N de A (0 filas) ni registra en su bebé', async () => {
    const [f] = await newBaby(fx.a)
    const { data, error } = await fx.b.client
      .from('babies')
      .update({ milk_bottle_count: 2 })
      .eq('id', f.babyId)
      .select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])
    const { data: row } = await adminClient()
      .from('babies')
      .select('milk_bottle_count')
      .eq('id', f.babyId)
      .single()
    expect(row!.milk_bottle_count).toBe(6)
    const r = await rpc(
      fx.b.client,
      'log_pumping_session',
      pumpArgs(fx.b, { left: 10, label: 'M1', babyId: f.babyId }),
    )
    expect(r.error).toBe('milk_baby_not_found')
  })

  it('I-100 más de 100 contenedores (liberados incluidos) se leen todos, sin tope de filas', async () => {
    const [f] = await newBaby(fx.a)
    const n = 105
    // Cada extracción se vacía con una toma, así su número queda libre y se
    // reusa: la tabla crece aunque N sea 6 (AJ-18).
    for (let i = 0; i < n; i++) {
      const p = await pumpOk(f, 10, `M${(i % 6) + 1}`, Date.now() - 2 * HOUR)
      await feedOk(f, [[p.containerId, 10]], { at: Date.now() - HOUR })
    }
    const { data: containers, error } = await f.client
      .from('milk_containers')
      .select('id, released_at')
      .eq('baby_id', f.babyId)
      .is('voided_at', null)
    expect(error).toBeNull()
    expect(containers).toHaveLength(n)
    expect(containers!.every((c) => c.released_at !== null)).toBe(true)
    const { data: feeds } = await f.client
      .from('feedings')
      .select('id')
      .eq('baby_id', f.babyId)
      .eq('feeding_type', 'bottle')
    expect(feeds).toHaveLength(n)
  }, 60_000)

  it('I-106 lactancia, pañal y sueño entran con el inventario en cualquier estado', async () => {
    const [f] = await newBaby(fx.a)
    // Un inventario "raro": ocupado, vencido, desechado y con leche perdida.
    await pumpOk(f, 30, 'M1')
    const exp = await pumpOk(f, 30, 'M2', Date.now() - FRIDGE_MS - HOUR)
    await rpc(f.client, 'discard_container', discardArgs(exp.containerId))
    const now = iso(Date.now())
    const nursing = await f.client
      .from('nursing_sessions')
      .insert({ baby_id: f.babyId, side: 'left', started_at: now, logged_by: f.userId })
      .select('id')
      .single()
    expect(nursing.error).toBeNull()
    expect(
      (
        await f.client
          .from('nursing_sessions')
          .update({ ended_at: iso(Date.now() + MIN) })
          .eq('id', nursing.data!.id)
      ).error,
    ).toBeNull()
    expect(
      (
        await f.client
          .from('diaper_changes')
          .insert({ baby_id: f.babyId, diaper_type: 'wet', changed_at: now, logged_by: f.userId })
      ).error,
    ).toBeNull()
    expect(
      (
        await f.client
          .from('sleep_sessions')
          .insert({ baby_id: f.babyId, started_at: now, logged_by: f.userId })
      ).error,
    ).toBeNull()
    // Una toma de pecho (feedings sin desglose) también.
    expect(
      (
        await f.client.from('feedings').insert({
          baby_id: f.babyId,
          feeding_type: 'nursing',
          fed_at: now,
          logged_by: f.userId,
        })
      ).error,
    ).toBeNull()
  })
})

describe.skipIf(!docker)('v4 · esquema por SQL (I-101…I-103, I-106)', () => {
  it('I-101 22 tablas en public (19 hasta 0015 + 3 de 0016), todas con RLS; grants de las dos nuevas sin anon ni DELETE', () => {
    expect(
      psql(`select count(*), count(*) filter (where c.relrowsecurity)
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'`).trim(),
      // 0016 (v5) suma milk_ops, milk_transfers y formula_containers.
    ).toBe('22|22')
    const grants = psql(`
      select table_name || ':' || grantee || ':' || string_agg(privilege_type, ',' order by privilege_type)
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name in ('milk_discards', 'milk_feeding_edits')
         and grantee in ('anon', 'authenticated', 'PUBLIC')
       group by table_name, grantee order by 1`)
      .trim()
      .split('\n')
    expect(grants).toEqual([
      'milk_discards:authenticated:INSERT,SELECT,UPDATE',
      'milk_feeding_edits:authenticated:INSERT,SELECT',
    ])
    // Las policies: select/insert/update con WITH CHECK en desechos; select/insert en ediciones.
    const policies = psql(`
      select tablename || ':' || cmd || ':' || (with_check is not null)
        from pg_policies where schemaname = 'public'
         and tablename in ('milk_discards', 'milk_feeding_edits') order by 1`)
      .trim()
      .split('\n')
    expect(policies).toEqual([
      'milk_discards:INSERT:true',
      'milk_discards:SELECT:false',
      'milk_discards:UPDATE:true',
      'milk_feeding_edits:INSERT:true',
      'milk_feeding_edits:SELECT:false',
    ])
  })

  it('I-102 cada función nueva o recreada: security invoker, search_path=public, sin EXECUTE de anon/public', () => {
    const rows = psql(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' ||
             p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' ||
             -- PUBLIC aparece en el ACL como '=X/dueño' (sin rol antes del '=').
             has_function_privilege('anon', p.oid, 'execute') || '|' ||
             coalesce(p.proacl::text ~ '[{,]=X/', false) || '|' ||
             has_function_privilege('authenticated', p.oid, 'execute')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in (
         'milk_discarded_ml', 'milk_rebalance', 'discard_container', 'log_bottle_feed',
         'void_bottle_feed', 'edit_bottle_feed', 'milk_create_container',
         'log_pumping_session', 'update_pumping_session', 'void_pumping_session',
         'milk_guard_feedings')
       order by 1`)
      .trim()
      .split('\n')
    expect(rows).toHaveLength(11)
    for (const row of rows) {
      const [sig, secdef, config, anon, pub] = row.split('|')
      // Un boolean concatenado a texto se escribe 'true'/'false'.
      expect(secdef, sig).toBe('false')
      expect(config, sig).toBe('search_path=public')
      expect(anon, sig).toBe('false')
      expect(pub, sig).toBe('false')
    }
    // Las que llama la app (y las internas que corren como el padre): ejecutables por authenticated.
    for (const row of rows.filter((r) => !r.startsWith('milk_guard_feedings')))
      expect(row.split('|')[5], row).toBe('true')
  })

  it('I-103 una sola versión de log_bottle_feed y de void_bottle_feed (sin PGRST203)', () => {
    expect(
      psql(`select proname || ':' || count(*) from pg_proc
             where proname in ('log_bottle_feed', 'void_bottle_feed', 'edit_bottle_feed', 'discard_container')
             group by proname order by 1`)
        .trim()
        .split('\n'),
    ).toEqual([
      'discard_container:1',
      'edit_bottle_feed:1',
      'log_bottle_feed:1',
      'void_bottle_feed:1',
    ])
    expect(
      psql(
        `select pg_get_function_result(oid) from pg_proc where proname = 'void_bottle_feed'`,
      ).trim(),
    ).toBe('jsonb')
  })

  it('I-106 ningún trigger de leche cuelga de nursing_sessions, diaper_changes ni sleep_sessions', () => {
    expect(
      psql(`select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
             where not t.tgisinternal
               and c.relname in ('nursing_sessions', 'diaper_changes', 'sleep_sessions')
               and t.tgfoid::regproc::text like 'milk%'`).trim(),
    ).toBe('0')
  })

  it('INV-1 por SQL (la cuenta de ARQ §2.4) y la invariante completa: 0 fallas en toda la base', async () => {
    // La misma consulta que corre la migración en su `do` final, sobre lo que
    // dejaron todas las pruebas de este archivo y las anteriores.
    const sql = psql(`select count(*) from milk_containers c
       where c.voided_at is null and abs(c.amount_ml
         - coalesce((select sum(amount_ml) from milk_drawdowns d where d.container_id = c.id and d.voided_at is null), 0)
         - coalesce((select sum(amount_ml) from milk_discards x where x.container_id = c.id and x.voided_at is null), 0)
         - c.lost_ml - c.remaining_ml
         -- 0016 (QA-4): lo que el contenedor pasó a otro en una combinación,
         -- menos lo que recibió.
         - coalesce((select sum(amount_ml) from milk_transfers t where t.from_container_id = c.id and t.voided_at is null), 0)
         + coalesce((select sum(amount_ml) from milk_transfers t where t.to_container_id = c.id and t.voided_at is null), 0)) > 1e-9`)
    expect(sql.trim()).toBe('0')
    await assertMilkInvariant()
  })
})

// Compatibilidad: la app v4 sobre lo que dejó v0.12.1 (C-22, C-23).
describe.skipIf(!ready)('v4 · lo de v0.12.1 editado por v4 (C-22, C-23)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv4-c22')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('C-22 toma legada 2 → 2,5 oz + sobró, nota de extracción legada, y borrar las dos: entra, inventario igual', async () => {
    const [f] = await newBaby(fx.a)
    await pumpOk(f, 60, 'M1')
    const before = (await milkSnapshot(f.babyId)).containers
    const fid = randomUUID()
    const sid = randomUUID()
    await f.client.from('feedings').insert({
      id: fid,
      baby_id: f.babyId,
      logged_by: f.userId,
      feeding_type: 'bottle',
      amount_ml: 2 * OZ,
      fed_at: iso(Date.now() - HOUR),
    })
    await f.client.from('pumping_sessions').insert({
      id: sid,
      baby_id: f.babyId,
      logged_by: f.userId,
      side: 'both',
      amount_ml: 80,
      notes: null,
      pumped_at: iso(Date.now() - 2 * HOUR),
    })
    expect(
      (
        await f.client
          .from('feedings')
          .update({ amount_ml: 2.5 * OZ, leftover_ml: 0.5 * OZ })
          .eq('id', fid)
      ).error,
    ).toBeNull()
    const note = await rpc(f.client, 'update_pumping_session', {
      p_id: sid,
      p_side: 'both',
      p_left_ml: null,
      p_right_ml: null,
      p_notes: 'nota',
      p_pumped_at: iso(Date.now() - 2 * HOUR),
    })
    expect(note.error).toBeNull()
    expect((await rpc(f.client, 'void_bottle_feed', { p_feeding_id: fid })).data).toEqual({
      returned_ml: 0,
      lost: [],
    })
    expect((await rpc(f.client, 'void_pumping_session', { p_id: sid })).error).toBeNull()
    expect((await milkSnapshot(f.babyId)).containers).toEqual(before)
  })

  it('C-23 v4 da lados a una extracción legada eligiendo M2: nace M2 ocupado', async () => {
    const [f] = await newBaby(fx.a)
    const sid = randomUUID()
    await f.client.from('pumping_sessions').insert({
      id: sid,
      baby_id: f.babyId,
      logged_by: f.userId,
      side: 'left',
      amount_ml: 80,
      notes: null,
      pumped_at: iso(Date.now() - HOUR),
    })
    const cid = randomUUID()
    const r = await rpc(f.client, 'update_pumping_session', {
      p_id: sid,
      p_side: 'both',
      p_left_ml: 50,
      p_right_ml: 40,
      p_notes: null,
      p_pumped_at: iso(Date.now() - HOUR),
      p_container_id: cid,
      p_container_label: 'M2',
    })
    expect(r.error).toBeNull()
    const { data } = await adminClient()
      .from('milk_containers')
      .select('label, amount_ml, remaining_ml, released_at')
      .eq('id', cid)
      .single()
    expect(data).toEqual({ label: 'M2', amount_ml: 90, remaining_ml: 90, released_at: null })
  })
})
