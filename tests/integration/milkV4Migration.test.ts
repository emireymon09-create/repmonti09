import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

// La migración 0015 sobre una base que ya tiene datos de v3 (I-104) y sobre
// datos que no cierran (I-105). No se puede probar en el stack local
// compartido, que ya tiene 0015: se levanta un Postgres EFÍMERO con la misma
// imagen que supabase/docker/docker-compose.yml, SIN red (`--network none`: ni
// un puerto abierto, ni en 127.0.0.1), se le aplican 0001–0014 como lo hace
// scripts/local-stack.sh, se siembra y se aplica 0015. Se borra al terminar.
//
// Se salta si no hay Docker o si la imagen no está ya bajada (no hace pull):
// en ese caso I-104/I-105 quedan NO VERIFICADOS.

const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.167'
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)
const NAME = `amelia-mig-v4-${randomUUID().slice(0, 8)}`

function imagePresent(): boolean {
  const r = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  return r.status === 0
}
const available = imagePresent()

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

const migration = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8')
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const upTo0014 = files.filter((f) => f < '0015')
const m0015 = files.find((f) => f.startsWith('0015_'))!

/** Igual que apply_migrations de scripts/local-stack.sh: una transacción por archivo. */
const wrapped = (sql: string) => `begin;\n${sql}\ncommit;\n`

// Datos de v3 (forma de 0014), sembrados como postgres con la bandera de las
// funciones: es lo que habrían dejado log_pumping_session / log_bottle_feed.
const FAMILY = randomUUID()
const BABY = randomUUID()
const ids = {
  m1: randomUUID(), // ocupado, vigente
  m2: randomUUID(), // vaciado por una toma (remaining 0)
  m4: randomUUID(), // vaciado con polvo de redondeo (0,1 ml)
  m9: randomUUID(), // número > N = 6
  m12: randomUUID(), // vencido, con leche
  m3: randomUUID(), // anulado
  s1: randomUUID(),
  f2: randomUUID(),
  f4: randomUUID(),
}

function seedV3(extra = ''): string {
  return `
    select set_config('amelia.milk_rpc', 'on', true);
    insert into families (id, name) values ('${FAMILY}', 'mig-v4');
    insert into babies (id, family_id, name, birth_date) values ('${BABY}', '${FAMILY}', 'Bebe', '2026-09-01');
    insert into pumping_sessions (id, baby_id, pumped_at, side, amount_ml, left_ml, right_ml)
      values ('${ids.s1}', '${BABY}', now() - interval '1 hour', 'both', 90, 60, 30);
    -- Una extracción legada (sin lados ni contenedor): alimenta el pozo de 2B.
    insert into pumping_sessions (baby_id, pumped_at, side, amount_ml)
      values ('${BABY}', now() - interval '2 hours', 'left', 70);
    insert into milk_containers (id, family_id, baby_id, source_session_id, label, amount_ml, remaining_ml, stored_at, expires_at, voided_at) values
      ('${ids.m1}', '${FAMILY}', '${BABY}', '${ids.s1}', 'M1', 90, 90, now() - interval '1 hour', now() + interval '95 hours', null),
      ('${ids.m2}', '${FAMILY}', '${BABY}', null, 'M2', 60, 0, now() - interval '5 hours', now() + interval '91 hours', null),
      ('${ids.m4}', '${FAMILY}', '${BABY}', null, 'M4', 30, 0.1, now() - interval '5 hours', now() + interval '91 hours', null),
      ('${ids.m9}', '${FAMILY}', '${BABY}', null, 'M9', 50, 50, now() - interval '3 hours', now() + interval '93 hours', null),
      ('${ids.m12}', '${FAMILY}', '${BABY}', null, 'M12', 40, 40, now() - interval '10 days', now() - interval '6 days', null),
      ('${ids.m3}', '${FAMILY}', '${BABY}', null, 'M3', 20, 20, now() - interval '3 hours', now() + interval '93 hours', now());
    insert into feedings (id, baby_id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml) values
      ('${ids.f2}', '${BABY}', now() - interval '4 hours', 'bottle', 70, 60, 10),
      ('${ids.f4}', '${BABY}', now() - interval '4 hours', 'bottle', 29.9, 29.9, 0);
    insert into milk_drawdowns (family_id, baby_id, container_id, feeding_id, amount_ml) values
      ('${FAMILY}', '${BABY}', '${ids.m2}', '${ids.f2}', 60),
      ('${FAMILY}', '${BABY}', '${ids.m4}', '${ids.f4}', 29.9);
    ${extra}
    select set_config('amelia.milk_rpc', '', true);
  `
}

describe.skipIf(!available)('v4 · la migración 0015 sobre datos (I-104, I-105)', () => {
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
    // Listo de verdad = acepta conexiones por TCP (durante el init de la imagen
    // solo escucha en el socket) y ya tiene auth.users.
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
    for (const f of upTo0014) must(wrapped(migration(f)))
  }, 180_000)

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  })

  it('I-105 sobre datos que no cierran: aborta con milk_invariant_broken y no aplica nada', () => {
    // Un contenedor que dice tener más de lo que le entró menos lo servido: lo
    // que 0014 nunca escribiría, sembrado a mano. Todo en UNA transacción que
    // se cae entera. (Hasta R-10 esto sembraba remaining 70 de 90, que es lo
    // CONTRARIO: menos de lo que dice la cuenta. Esa forma la deja la reversa
    // en un ocupado con leche perdida, y 0015 ahora la recupera como lost_ml —
    // tests/integration/milkV4Reapply.test.ts. La que tiene que abortar es
    // ésta: leche que no puede existir — M2, de 60 ml y con 60 servidos, que
    // dice tener 20.)
    const broken = seedV3(`
      update milk_containers set remaining_ml = 20 where id = '${ids.m2}';`)
    const r = psql(wrapped(broken + migration(m0015)))
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/milk_invariant_broken/)
    expect(r.err).toMatch(/INV-1 cuenta/)
    // Nada quedó: ni las tablas nuevas, ni las columnas, ni los datos sembrados.
    expect(
      must(`select to_regclass('public.milk_discards') is null,
                   to_regclass('public.milk_feeding_edits') is null,
                   not exists (select 1 from information_schema.columns
                                where table_name = 'milk_containers' and column_name = 'released_at'),
                   not exists (select 1 from families where id = '${FAMILY}'),
                   to_regclass('public.milk_containers_label_live') is not null`).trim(),
    ).toBe('t|t|t|t|t')
  })

  it('I-104 sobre datos v3: libera los vaciados, no renumera ni anula nada, y la invariante cierra', () => {
    must(wrapped(seedV3()))
    const before = must(
      `select id || ':' || label || ':' || amount_ml || ':' || remaining_ml || ':' || (voided_at is not null)
         from milk_containers where baby_id = '${BABY}' order by id`,
    )
    const r = psql(wrapped(migration(m0015)))
    expect(r.err).not.toMatch(/ERROR/)
    expect(r.ok).toBe(true)
    // Nada renumerado, nada anulado, ninguna cantidad tocada.
    expect(
      must(
        `select id || ':' || label || ':' || amount_ml || ':' || remaining_ml || ':' || (voided_at is not null)
           from milk_containers where baby_id = '${BABY}' order by id`,
      ),
    ).toBe(before)
    // Liberados: exactamente los vaciados (< 0,15 ml) no anulados.
    const state = must(
      `select label || ':' || (released_at is not null) || ':' || lost_ml
         from milk_containers where baby_id = '${BABY}' order by label`,
    )
      .trim()
      .split('\n')
    expect(state).toEqual([
      'M1:false:0', // ocupado
      'M12:false:0', // vencido con leche: caducada, sigue ocupando (Desechar disponible)
      'M2:true:0', // vaciado: su número vuelve al selector
      'M3:false:0', // anulado: sin cambio (no ocupa por estar anulado)
      'M4:true:0', // polvo de 0,1 ml: libre, el polvo queda y no cuenta
      'M9:false:0', // número > N: sigue ocupado (D-1)
    ])
    // N nace en 6; el sobró, nulo; los números libres se pueden reusar y los
    // ocupados no (el índice nuevo).
    expect(
      must(`select milk_bottle_count from babies where id = '${BABY}';
            select count(*) from feedings where baby_id = '${BABY}' and leftover_ml is not null;`)
        .trim()
        .split('\n'),
    ).toEqual(['6', '0'])
    expect(
      must(`select indexdef from pg_indexes where indexname = 'milk_containers_label_occupied'`),
    ).toMatch(/WHERE \(\(voided_at IS NULL\) AND \(released_at IS NULL\)\)/)
    expect(must(`select to_regclass('public.milk_containers_label_live') is null`).trim()).toBe('t')
    const reuse = psql(`begin;
      select set_config('amelia.milk_rpc', 'on', true);
      insert into milk_containers (family_id, baby_id, label, amount_ml, remaining_ml, stored_at, expires_at)
        values ('${FAMILY}', '${BABY}', 'M2', 10, 10, now(), now() + interval '1 day');
      rollback;`)
    expect(reuse.ok).toBe(true)
    const dup = psql(`begin;
      select set_config('amelia.milk_rpc', 'on', true);
      insert into milk_containers (family_id, baby_id, label, amount_ml, remaining_ml, stored_at, expires_at)
        values ('${FAMILY}', '${BABY}', 'M9', 10, 10, now(), now() + interval '1 day');
      rollback;`)
    expect(dup.ok).toBe(false)
    expect(dup.err).toMatch(/milk_containers_label_occupied/)
    // La migración quedó registrada como aplicada en una sola pieza: 19 tablas.
    expect(
      must(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`).trim(),
    ).toBe('19')
  })
})
