import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

// La migración 0016 sobre una base que ya tiene datos de v4 (0015). Como
// milkV4Migration.test.ts: un Postgres EFÍMERO con la misma imagen que
// supabase/docker/docker-compose.yml, SIN red (`--network none`), se le
// aplican 0001–0015 como lo hace scripts/local-stack.sh, se siembra y se aplica
// 0016. Se borra al terminar. Se salta si la imagen no está bajada.

const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.167'
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)
const NAME = `amelia-mig-v5-${randomUUID().slice(0, 8)}`

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

const migration = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8')
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const upTo0015 = files.filter((f) => f < '0016')
const m0016 = files.find((f) => f.startsWith('0016_'))!

/** Igual que apply_migrations de scripts/local-stack.sh: una transacción por archivo. */
const wrapped = (sql: string) => `begin;\n${sql}\ncommit;\n`

const FAMILY = randomUUID()
const BABY = randomUUID()
const ids = {
  m1: randomUUID(), // ocupado, servido en parte, hace 3 h
  m2: randomUUID(), // vencido y desechado ('expired')
  m3: randomUUID(), // ocupado, extraído hace 20 min
  f1: randomUUID(), // toma con desglose y sobró
}

// Datos de v4 (forma de 0015), sembrados como postgres con la bandera de las
// funciones: lo que habrían dejado log_pumping_session / log_bottle_feed /
// discard_container.
function seedV4(extra = ''): string {
  return `
    select set_config('amelia.milk_rpc', 'on', true);
    insert into families (id, name) values ('${FAMILY}', 'mig-v5');
    insert into babies (id, family_id, name, birth_date) values ('${BABY}', '${FAMILY}', 'Bebe', '2026-09-01');
    insert into milk_containers (id, family_id, baby_id, label, amount_ml, remaining_ml, lost_ml, released_at, stored_at, expires_at) values
      ('${ids.m1}', '${FAMILY}', '${BABY}', 'M1', 90, 60, 0, null, now() - interval '3 hours', now() + interval '93 hours'),
      ('${ids.m2}', '${FAMILY}', '${BABY}', 'M2', 40, 0, 0, now() - interval '1 day', now() - interval '6 days', now() - interval '2 days'),
      ('${ids.m3}', '${FAMILY}', '${BABY}', 'M3', 50, 50, 0, null, now() - interval '20 minutes', now() + interval '95 hours');
    insert into feedings (id, baby_id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml, leftover_ml) values
      ('${ids.f1}', '${BABY}', now() - interval '2 hours', 'bottle', 40, 30, 10, 5);
    insert into milk_drawdowns (family_id, baby_id, container_id, feeding_id, amount_ml) values
      ('${FAMILY}', '${BABY}', '${ids.m1}', '${ids.f1}', 30);
    insert into milk_discards (id, family_id, baby_id, container_id, amount_ml, discarded_at, reason) values
      (gen_random_uuid(), '${FAMILY}', '${BABY}', '${ids.m2}', 40, now() - interval '1 day', 'expired');
    ${extra}
    select set_config('amelia.milk_rpc', '', true);
  `
}

describe.skipIf(!available)('v5 · la migración 0016 sobre datos de v4', () => {
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
    for (const f of upTo0015) must(wrapped(migration(f)))
  }, 180_000)

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  })

  it('sobre datos que no cierran: aborta con milk_invariant_broken y no aplica nada', () => {
    // M1 dice tener 70 cuando 90 − 30 servidos = 60.
    const broken = seedV4(`update milk_containers set remaining_ml = 70 where id = '${ids.m1}';`)
    const r = psql(wrapped(broken + migration(m0016)))
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/milk_invariant_broken/)
    expect(r.err).toMatch(/INV-1 cuenta/)
    expect(
      must(`select to_regclass('public.milk_transfers') is null,
                   to_regclass('public.formula_containers') is null,
                   to_regclass('public.milk_ops') is null,
                   not exists (select 1 from information_schema.columns
                                where table_name = 'milk_containers' and column_name = 'fridge_at'),
                   not exists (select 1 from families where id = '${FAMILY}')`).trim(),
    ).toBe('t|t|t|t|t')
  })

  it('sobre datos v4: backfill de fridge_at, desechos intactos, la invariante cierra', () => {
    must(wrapped(seedV4()))
    const before = must(
      `select id || ':' || label || ':' || amount_ml || ':' || remaining_ml || ':' || lost_ml || ':' ||
              coalesce(released_at::text, '-') || ':' || expires_at
         from milk_containers where baby_id = '${BABY}' order by id;
       select id || ':' || container_id || ':' || amount_ml || ':' || reason || ':' || discarded_at
         from milk_discards where baby_id = '${BABY}' order by id;`,
    )
    const r = psql(migration(m0016))
    expect(r.err).not.toMatch(/ERROR/)
    expect(r.ok).toBe(true)
    // Nada cambió de lo que ya había.
    expect(
      must(
        `select id || ':' || label || ':' || amount_ml || ':' || remaining_ml || ':' || lost_ml || ':' ||
                coalesce(released_at::text, '-') || ':' || expires_at
           from milk_containers where baby_id = '${BABY}' order by id;
         select id || ':' || container_id || ':' || amount_ml || ':' || reason || ':' || discarded_at
           from milk_discards where baby_id = '${BABY}' order by id;`,
      ),
    ).toBe(before)
    // fridge_at = stored_at en todos; cold_at nulo; la de hace 3 h ya fría, la de
    // hace 20 min todavía enfriándose.
    expect(
      must(`select label || ':' || (fridge_at = stored_at) || ':' || (cold_at is null) || ':' || milk_is_cold(c, now())
              from milk_containers c where baby_id = '${BABY}' order by label`)
        .trim()
        .split('\n'),
    ).toEqual(['M1:true:true:true', 'M2:true:true:true', 'M3:true:true:false'])
    // El desecho viejo: feeding_id nulo, cumple la forma nueva.
    expect(
      must(`select count(*) from milk_discards
             where baby_id = '${BABY}' and reason = 'expired' and feeding_id is null
               and container_id is not null and voided_at is null`).trim(),
    ).toBe('1')
    // 22 tablas en public, las 22 con RLS.
    expect(
      must(`select count(*) || '|' || count(*) filter (where c.relrowsecurity)
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'`).trim(),
    ).toBe('22|22')
  })
})
