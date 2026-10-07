import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { adminClient } from '../helpers/supabase'
import {
  assertMilkInvariant,
  hasLocalDocker,
  newBaby,
  psql,
  seedV4,
  type V4Families,
} from '../helpers/milkV4'
import { hasMilkV5 } from '../helpers/milkV5'
import { milkInvariantFailures } from '../helpers/milkInvariant'

// Inventario v5 (0016): esquema y guardas. I-S1 e I-S2 de
// docs/plan-pruebas-v5.md §2.

const ready = await hasMilkV5()
const docker = ready && hasLocalDocker()
let fx: V4Families

const NEW_TABLES = ['formula_containers', 'milk_ops', 'milk_transfers']
const NEW_FUNCTIONS = [
  'discard_started_bottle',
  'formula_add',
  'formula_bottle_ml',
  'formula_finish',
  'formula_open',
  'formula_open_max_hours',
  'formula_void',
  'log_pumping_session',
  'milk_combine',
  'milk_cooling_minutes',
  'milk_create_container',
  'milk_is_cold',
  'milk_mark_cold',
  'milk_rebalance',
  'milk_started_bottle_minutes',
  'milk_sync_started_discard',
  'milk_transferred_in_ml',
  'milk_transferred_out_ml',
  'milk_uncombine',
  'update_pumping_session',
  'void_pumping_session',
]

describe.skipIf(!docker)('v5 · esquema por SQL (I-S1)', () => {
  it('I-S1 columnas nuevas y constantes espejo', () => {
    expect(
      psql(`select string_agg(column_name || ':' || is_nullable, ',' order by column_name)
              from information_schema.columns
             where table_schema = 'public' and table_name = 'milk_containers'
               and column_name in ('fridge_at', 'cold_at')`).trim(),
    ).toBe('cold_at:YES,fridge_at:YES')
    expect(
      psql(`select string_agg(column_name || ':' || is_nullable, ',' order by column_name)
              from information_schema.columns
             where table_schema = 'public' and table_name = 'milk_discards'
               and column_name in ('container_id', 'feeding_id')`).trim(),
    ).toBe('container_id:YES,feeding_id:YES')
    expect(
      psql(`select milk_cooling_minutes() || '|' || milk_started_bottle_minutes() || '|' ||
                   formula_open_max_hours() || '|' || formula_bottle_ml()`).trim(),
    ).toBe('60|60|48|236.5882365')
    // Ningún contenedor quedó sin hora de refri (backfill).
    expect(psql(`select count(*) from milk_containers where fridge_at is null`).trim()).toBe('0')
    // La CHECK remaining ≤ amount se quitó a propósito (destino de combinar).
    expect(
      psql(`select count(*) from pg_constraint
             where conname = 'milk_containers_remaining_le_amount'`).trim(),
    ).toBe('0')
  })

  it('I-S1 las tres tablas nuevas con RLS, grants sin anon ni DELETE, policies con WITH CHECK', () => {
    expect(
      psql(`select string_agg(c.relname || ':' || c.relrowsecurity, ',' order by c.relname)
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname in (${NEW_TABLES.map((t) => `'${t}'`).join(',')})`).trim(),
    ).toBe('formula_containers:true,milk_ops:true,milk_transfers:true')
    const grants = psql(`
      select table_name || ':' || grantee || ':' || string_agg(privilege_type, ',' order by privilege_type)
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name in (${NEW_TABLES.map((t) => `'${t}'`).join(',')})
         and grantee in ('anon', 'authenticated', 'PUBLIC')
       group by table_name, grantee order by 1`)
      .trim()
      .split('\n')
    expect(grants).toEqual([
      'formula_containers:authenticated:INSERT,SELECT,UPDATE',
      'milk_ops:authenticated:INSERT,SELECT',
      'milk_transfers:authenticated:INSERT,SELECT,UPDATE',
    ])
    const policies = psql(`
      select tablename || ':' || cmd || ':' || (with_check is not null)
        from pg_policies where schemaname = 'public'
         and tablename in (${NEW_TABLES.map((t) => `'${t}'`).join(',')}) order by 1`)
      .trim()
      .split('\n')
    expect(policies).toEqual([
      'formula_containers:INSERT:true',
      'formula_containers:SELECT:false',
      'formula_containers:UPDATE:true',
      'milk_ops:INSERT:true',
      'milk_ops:SELECT:false',
      'milk_transfers:INSERT:true',
      'milk_transfers:SELECT:false',
      'milk_transfers:UPDATE:true',
    ])
    // La guarda en cada tabla nueva.
    expect(
      psql(`select string_agg(c.relname || ':' || t.tgfoid::regproc::text, ',' order by c.relname)
              from pg_trigger t join pg_class c on c.oid = t.tgrelid
             where not t.tgisinternal and c.relname in (${NEW_TABLES.map((t) => `'${t}'`).join(',')})`).trim(),
    ).toBe(
      'formula_containers:milk_guard_inventory,milk_ops:milk_guard_inventory,milk_transfers:milk_guard_inventory',
    )
  })

  it('I-S1 cada función nueva o recreada: security invoker, search_path=public, EXECUTE solo authenticated', () => {
    const rows = psql(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' ||
             p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' ||
             has_function_privilege('anon', p.oid, 'execute') || '|' ||
             coalesce(p.proacl::text ~ '[{,]=X/', false) || '|' ||
             has_function_privilege('authenticated', p.oid, 'execute')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in (${NEW_FUNCTIONS.map((f) => `'${f}'`).join(',')})
       order by 1`)
      .trim()
      .split('\n')
    // Una versión de cada una: sin sobrecargas (PGRST203).
    expect(rows).toHaveLength(NEW_FUNCTIONS.length)
    for (const row of rows) {
      const [sig, secdef, config, anon, pub, auth] = row.split('|')
      expect(secdef, sig).toBe('false')
      expect(config, sig).toBe('search_path=public')
      expect(anon, sig).toBe('false')
      expect(pub, sig).toBe('false')
      expect(auth, sig).toBe('true')
    }
    // log_pumping_session tiene 11 parámetros, el último con default.
    expect(
      psql(
        `select pronargs || '|' || pronargdefaults from pg_proc where proname = 'log_pumping_session'`,
      ).trim(),
    ).toBe('11|4')
  })

  it('I-S1 ninguna función de leche ejecutable por anon (también las de 0014/0015)', () => {
    expect(
      psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and (p.proname like 'milk%' or p.proname like 'formula%' or p.proname like '%pumping%'
                    or p.proname like '%bottle%' or p.proname like 'discard%')
               and has_function_privilege('anon', p.oid, 'execute')`).trim(),
    ).toBe('')
  })

  it('I-S1 índices únicos parciales de desechos y fórmula', () => {
    expect(
      psql(`select string_agg(indexname || ':' || (indexdef ~ 'UNIQUE')::text, ',' order by indexname)
              from pg_indexes where schemaname = 'public'
               and indexname in ('milk_discards_one_live', 'milk_discards_one_live_feeding',
                                 'formula_containers_one_open')`).trim(),
    ).toBe(
      'formula_containers_one_open:true,milk_discards_one_live:true,milk_discards_one_live_feeding:true',
    )
  })

  it('I-S1 la invariante SQL completa de 0016: 0 fallas en toda la base', async () => {
    // El mismo bloque `do` que corre la migración al final.
    const fs = await import('node:fs')
    const mig = fs.readFileSync(
      new URL('../../supabase/migrations/0016_milk_phase3_4.sql', import.meta.url),
      'utf8',
    )
    const block = mig.slice(mig.indexOf('do $$\ndeclare\n  v_n int;'), mig.lastIndexOf('$$;') + 3)
    expect(block).toContain('milk_invariant_broken')
    expect(() => psql(block)).not.toThrow()
    expect(await milkInvariantFailures()).toEqual([])
  })
})

describe.skipIf(!ready)('v5 · guardas (I-S2)', () => {
  beforeAll(async () => {
    fx = await seedV4('mv5-schema')
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await assertMilkInvariant(fx.familyIds)
  })

  it('I-S2 INSERT/UPDATE directo a milk_transfers, milk_ops y formula_containers: milk_rpc_only', async () => {
    const [f] = await newBaby(fx.a)
    const c = f.client
    const r1 = await c.from('milk_ops').insert({
      op_id: randomUUID(),
      family_id: f.familyId,
      baby_id: f.babyId,
      kind: 'combine',
      request: {},
      result: {},
    })
    expect(r1.error?.message).toBe('milk_rpc_only')
    const r2 = await c.from('formula_containers').insert({
      id: randomUUID(),
      family_id: f.familyId,
      baby_id: f.babyId,
      size_ml: 236,
      added_at: new Date().toISOString(),
    })
    expect(r2.error?.message).toBe('milk_rpc_only')
    const r3 = await c.from('milk_transfers').insert({
      op_id: randomUUID(),
      family_id: f.familyId,
      baby_id: f.babyId,
      from_container_id: randomUUID(),
      to_container_id: randomUUID(),
      amount_ml: 10,
      target_prev_expires_at: new Date().toISOString(),
    })
    expect(r3.error?.message).toBe('milk_rpc_only')
    // UPDATE: una botella creada por la RPC, tocada por fuera.
    const id = randomUUID()
    const add = await c.rpc('formula_add', {
      p_op_id: randomUUID(),
      p_baby_id: f.babyId,
      p_ids: [id],
      p_size_ml: 236,
      p_added_at: new Date().toISOString(),
    })
    expect(add.error).toBeNull()
    const r4 = await c
      .from('formula_containers')
      .update({ opened_at: new Date().toISOString() })
      .eq('id', id)
    expect(r4.error?.message).toBe('milk_rpc_only')
    // anon no lee nada.
    const { data } = await adminClient().from('formula_containers').select('id').eq('id', id)
    expect(data).toHaveLength(1)
  })

  it.skipIf(!docker)(
    'I-S2 milk_discards con forma inválida: rechazo de la CHECK (aun con la bandera)',
    () => {
      // Ids inventados: la CHECK se evalúa antes que las FK, así que lo que
      // rechaza la fila es la forma, no la falta de bebé o de contenedor.
      const u = () => `'${randomUUID()}'`
      const shapes = [
        `'expired', ${u()}, ${u()}`, // caducada con toma
        `'expired', null, null`, // caducada sin biberón
        `'started_bottle_expired', ${u()}, ${u()}`, // empezado con biberón
        `'started_bottle_expired', null, null`, // empezado sin toma
        `'manual', ${u()}, null`, // motivo desconocido
      ]
      for (const shape of shapes) {
        const sql = `begin;
        select set_config('amelia.milk_rpc', 'on', true);
        insert into milk_discards (id, family_id, baby_id, reason, container_id, feeding_id, amount_ml, discarded_at)
          values (gen_random_uuid(), ${u()}, ${u()}, ${shape}, 10, now());
        rollback;`
        expect(() => psql(sql), shape).toThrow(/milk_discards_(shape|reason_check)/)
      }
    },
  )
})
