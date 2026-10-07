import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

// C-4 y C-5 de docs/plan-pruebas-v5.md §3: docs/rollback-leche-v5.sql y
// docs/verificar-antes-v5.sql, en un Postgres EFÍMERO (misma imagen que
// supabase/docker/docker-compose.yml, `--network none`, borrado al terminar),
// como milkV4Reapply.test.ts. Se salta si la imagen no está bajada.
//
// Los datos de v5 se siembran POR LAS RPC, como un padre `authenticated`:
// combinación viva en cadena (M3→M2→M1) con lo servido del destino por encima
// de su propia extracción, combinación viva sin servir (M6→M5), combinación
// deshecha (M8→M7), desecho de biberón empezado, Similac comprada y abierta,
// leche enfriando, "ya está fría" y un desecho de caducada.

const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.167'
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)
const DOCS = new URL('../../docs/', import.meta.url)
const NAME = `amelia-rollback-v5-${randomUUID().slice(0, 8)}`

const available = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0

type PsqlResult = { ok: boolean; out: string; err: string }

function psql(sql: string): PsqlResult {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      NAME,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, encoding: 'utf8' },
  )
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function must(sql: string): string {
  const r = psql(sql)
  if (!r.ok) throw new Error(r.err)
  return r.out
}

/** El esquema `public`, sin las líneas `\restrict` al azar de pg_dump 17.6. */
function schemaDump(): string {
  const out = execFileSync(
    'docker',
    [
      'exec',
      NAME,
      'pg_dump',
      '--schema-only',
      '--schema=public',
      '--no-owner',
      '-U',
      'postgres',
      'postgres',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\n')
    .filter((l) => !/^\\(un)?restrict /.test(l))
    .join('\n')
}

const migration = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8')
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const m0015 = migration(files.find((f) => f.startsWith('0015_'))!)
const m0016 = migration(files.find((f) => f.startsWith('0016_'))!)
const rollback = readFileSync(new URL('rollback-leche-v5.sql', DOCS), 'utf8')
const verify = readFileSync(new URL('verificar-antes-v5.sql', DOCS), 'utf8')

/** Igual que apply_migrations de scripts/local-stack.sh: una transacción por archivo. */
const wrapped = (sql: string) => `begin;\n${sql}\ncommit;\n`

/** La consulta de la invariante sacada del `do` final de la migración: una fila por falla. */
function invariantOf(m: string): string {
  const start = m.indexOf('with srv as (', m.indexOf('INVARIANTE'))
  const end = m.indexOf('select count(*), min(falla', start)
  if (start < 0 || end < 0) throw new Error('no encontré la invariante')
  return `${m.slice(start, end)} select falla || ' ' || id::text from fallas;`
}
const inv0015 = invariantOf(m0015)
const inv0016 = invariantOf(m0016)

const FAMILY = randomUUID()
const USER = randomUUID()
const BABY = randomUUID()
const id = () => randomUUID()
const C = {
  M1: id(),
  M2: id(),
  M3: id(),
  M4: id(),
  M5: id(),
  M6: id(),
  M7: id(),
  M8: id(),
  M9: id(),
  M10: id(),
}
const F1 = id()
const F2 = id()
const FORMULA = Array.from({ length: 6 }, id)

const asParent = `
  select set_config('request.jwt.claims',
    json_build_object('sub', '${USER}', 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', '${USER}', true);
  set local role authenticated;`
const asParentTx = (sql: string) => must(`begin;\n${asParent}\n${sql}\ncommit;`)

const pump = (label: keyof typeof C, ml: number, ago: string, fridge = 'null') =>
  `select log_pumping_session(p_id => '${id()}', p_baby_id => '${BABY}', p_side => 'left',
     p_left_ml => ${ml}, p_right_ml => null, p_notes => null,
     p_pumped_at => now() - interval '${ago}', p_container_id => '${C[label]}',
     p_container_label => '${label}', p_fridge_at => ${fridge});`

const combine = (op: string, target: keyof typeof C, sources: (keyof typeof C)[]) => {
  const rem = (k: keyof typeof C) =>
    `(select remaining_ml from milk_containers where id = '${C[k]}')`
  const expected = [target, ...sources].map((k) => `'${C[k]}', ${rem(k)}`).join(', ')
  return `select milk_combine('${op}', '${BABY}', '${C[target]}',
            array[${sources.map((k) => `'${C[k]}'`).join(', ')}]::uuid[],
            jsonb_build_object(${expected}));`
}

/** label → amount|remaining|lost|liberado|servido vivo */
const containers = () =>
  must(`select c.label || ':' || trim_scale(c.amount_ml) || '|' || trim_scale(c.remaining_ml) || '|' ||
               trim_scale(c.lost_ml) || '|' || (c.released_at is not null) || '|' ||
               trim_scale(coalesce((select sum(d.amount_ml) from milk_drawdowns d
                                     where d.container_id = c.id and d.voided_at is null), 0))
          from milk_containers c where c.baby_id = '${BABY}' and c.voided_at is null
         order by substring(c.label from 2)::int`)
    .trim()
    .split('\n')

const onHand = () =>
  Number(
    must(`select coalesce(sum(remaining_ml), 0) from milk_containers
           where baby_id = '${BABY}' and voided_at is null and released_at is null
             and remaining_ml >= 0.15`).trim(),
  )

/** El resultado de verificar-antes-v5.sql: [0016 presente, objetos true, objetos total]. */
function verifyRun(): [string, number, number] {
  const r = psql(verify)
  if (!r.ok) throw new Error(r.err)
  const lines = r.out.split('\n')
  const mig = lines.find((l) => l.startsWith('0016_milk_phase3_4'))!.split('|')[1]
  const start = lines.findIndex((l) => l.startsWith('columna milk_containers.fridge_at'))
  const objs = lines.slice(start, start + 21).map((l) => l.split('|').pop())
  return [mig, objs.filter((x) => x === 't').length, objs.length]
}

describe.skipIf(!available)('v5 · reversa de 0016 y verificación previa (C-4, C-5)', () => {
  let dump0015 = ''
  let dump0016 = ''

  beforeAll(() => {
    execFileSync('docker', [
      'run',
      '-d',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--name',
      NAME,
      '-e',
      'POSTGRES_PASSWORD=efimera-solo-local',
      '-e',
      'JWT_SECRET=efimera-solo-local-efimera-solo-local',
      IMAGE,
    ])
    const until = Date.now() + 90_000
    for (;;) {
      const ready =
        spawnSync('docker', ['exec', NAME, 'pg_isready', '-U', 'postgres', '-h', 'localhost'], {
          stdio: 'ignore',
        }).status === 0 && psql(`select to_regclass('auth.users') is not null`).out.trim() === 't'
      if (ready) break
      if (Date.now() > until) throw new Error('el Postgres efímero no arrancó')
      execFileSync('sleep', ['1'])
    }
    for (const f of files.filter((f) => f < '0016')) must(wrapped(migration(f)))
    dump0015 = schemaDump()
  }, 180_000)

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  })

  it('C-5 en 0001–0015: 0016 false y sus 21 objetos false; es solo lectura', () => {
    expect(verifyRun()).toEqual(['f', 0, 21])
    const w = psql(`begin transaction read only; update babies set name = name; rollback;`)
    expect(w.ok).toBe(false)
    expect(w.err).toMatch(/read-only transaction/)
  })

  it('0016 + datos v5 por las RPC: invariante de 0016 = 0; C-5 da 21/21', () => {
    must(m0016)
    dump0016 = schemaDump()
    must(`
      insert into auth.users (id, email, aud, role)
        values ('${USER}', 'rb5-${USER}@example.test', 'authenticated', 'authenticated');
      insert into families (id, name) values ('${FAMILY}', 'rollback-v5');
      insert into family_members (family_id, user_id) values ('${FAMILY}', '${USER}');
      insert into babies (id, family_id, name, birth_date)
        values ('${BABY}', '${FAMILY}', 'Bebe', '2026-09-01');`)
    asParentTx(`
      ${pump('M1', 120, '5 hours')}
      ${pump('M2', 60, '4 hours')}
      ${pump('M3', 50, '4 hours')}
      ${pump('M5', 40, '4 hours')}
      ${pump('M6', 30, '4 hours')}
      ${pump('M7', 40, '4 hours')}
      ${pump('M8', 20, '4 hours')}
      ${pump('M10', 25, '5 days')}
      ${pump('M4', 40, '10 minutes', 'now()')}
      ${pump('M9', 30, '20 minutes')}
      select log_bottle_feed('${F1}', '${BABY}', now() - interval '3 hours', null, 0,
        jsonb_build_array(jsonb_build_object('container_id', '${C.M1}', 'amount_ml', 30)), 10);
      select discard_started_bottle('${id()}', '${F1}', null);
      select discard_container('${id()}', '${C.M10}', null);
      ${combine(id(), 'M2', ['M3'])}
      ${combine(id(), 'M1', ['M2'])}
      select log_bottle_feed('${F2}', '${BABY}', now(), null, 20,
        jsonb_build_array(jsonb_build_object('container_id', '${C.M1}', 'amount_ml', 150)), null);
      ${combine(id(), 'M5', ['M6'])}`)
    const op4 = id()
    asParentTx(combine(op4, 'M7', ['M8']))
    asParentTx(`
      select milk_uncombine('${id()}', '${op4}');
      select milk_mark_cold('${id()}', '${C.M9}', now());
      select formula_add('${id()}', '${BABY}',
        array[${FORMULA.map((x) => `'${x}'`).join(', ')}]::uuid[], 236.588, now() - interval '1 day');
      select formula_open('${id()}', '${BABY}', '${FORMULA[0]}', now() - interval '2 hours');`)

    expect(must(inv0016).trim()).toBe('')
    // M1 = 120 propios − 30 (F1) + 110 recibidos − 150 (F2) = 50; M5 = 40 + 30.
    expect(containers()).toEqual([
      'M1:120|50|0|false|180',
      'M2:60|0|0|true|0',
      'M3:50|0|0|true|0',
      'M4:40|40|0|false|0',
      'M5:40|70|0|false|0',
      'M6:30|0|0|true|0',
      'M7:40|40|0|false|0',
      'M8:20|20|0|false|0',
      'M9:30|30|0|false|0',
      'M10:25|0|0|true|0',
    ])
    expect(onHand()).toBe(250)
    expect(
      must(`select (select count(*) from milk_transfers where voided_at is null) || '|' ||
                   (select count(*) from milk_discards where reason = 'started_bottle_expired') || '|' ||
                   (select count(*) from formula_containers where opened_at is not null) || '|' ||
                   (select count(*) from milk_containers c where not milk_is_cold(c, now()))`).trim(),
    ).toBe('3|1|1|1')
    expect(verifyRun()).toEqual(['t', 21, 21])
  })

  it('C-4 la reversa: invariante de 0015 = 0, esquema = 0001–0015, qué pierde', () => {
    const r = psql(rollback)
    // Los NOTICE quedan en la salida de la prueba: es la evidencia de §4.
    console.log(r.err)
    expect(r.ok).toBe(true)
    expect(r.err).not.toMatch(/ERROR/)
    expect(r.err).toMatch(/3 combinación\(es\) viva\(s\)/)
    expect(r.err).toMatch(/antes 250 ml, después 220 ml/)

    expect(must(inv0015).trim()).toBe('')
    expect(schemaDump()).toBe(dump0015)
    // M1: lo servido por encima de su extracción pasa a M2 (60) y M3 (50);
    // "Lo que hay" de M1 no cambia. M5 pierde los 30 que recibió y no se
    // sirvieron; M6 los tiene como perdidos. M7/M8 (deshecha) sin cambio.
    expect(containers()).toEqual([
      'M1:120|50|0|false|70',
      'M2:60|0|0|true|60',
      'M3:50|0|0|true|50',
      'M4:40|40|0|false|0',
      'M5:40|40|0|false|0',
      'M6:30|0|30|true|0',
      'M7:40|40|0|false|0',
      'M8:20|20|0|false|0',
      'M9:30|30|0|false|0',
      'M10:25|0|0|true|0',
    ])
    expect(onHand()).toBe(220)
    // La toma F2 no cambia: 150 de leche + 20 de fórmula, ahora de M1/M2/M3.
    expect(
      must(`select f.amount_ml || '|' || f.breast_milk_ml || '|' || f.formula_ml || '|' ||
                   (select string_agg(c.label || '=' || trim_scale(d.amount_ml), ',' order by c.label)
                      from milk_drawdowns d join milk_containers c on c.id = d.container_id
                     where d.feeding_id = f.id and d.voided_at is null)
              from feedings f where f.id = '${F2}'`).trim(),
    ).toBe('170|150|20|M1=40,M2=60,M3=50')
    // Desecho de caducada intacto; el del empezado, borrado; el sobró queda.
    expect(
      must(`select (select count(*) from milk_discards where voided_at is null) || '|' ||
                   (select leftover_ml from feedings where id = '${F1}')`).trim(),
    ).toBe('1|10')
    expect(verifyRun()).toEqual(['f', 0, 21])
  })

  it('C-4 re-ejecutable: la segunda corrida no da error y deja lo mismo', () => {
    const before = containers()
    const r = psql(rollback)
    expect(r.ok).toBe(true)
    expect(r.err).toMatch(/0016 ya no está/)
    expect(schemaDump()).toBe(dump0015)
    expect(containers()).toEqual(before)
    expect(must(inv0015).trim()).toBe('')
  })

  it('después de la reversa, las RPC de 0015 (app 0.13.0) andan y la invariante sigue en 0', () => {
    asParentTx(`
      select log_bottle_feed('${id()}', '${BABY}', now(), null, 0,
        jsonb_build_array(jsonb_build_object('container_id', '${C.M5}', 'amount_ml', 10)), null);
      select void_bottle_feed('${F2}', null);
      select log_pumping_session('${id()}', '${BABY}', 'right', null, 45, null, now(),
        '${id()}', 'M11', null);`)
    expect(must(inv0015).trim()).toBe('')
  })

  it('0016 vuelve a entrar sobre lo que dejó la reversa: esquema = el de 0016, invariante 0', () => {
    const r = psql(m0016)
    expect(r.err).not.toMatch(/ERROR/)
    expect(r.ok).toBe(true)
    expect(schemaDump()).toBe(dump0016)
    expect(must(inv0016).trim()).toBe('')
    expect(verifyRun()).toEqual(['t', 21, 21])
  })
})
