import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

// R-10: v4 → docs/rollback-leche-v4.sql → (días de v3) → 0015 de nuevo, sin
// tocar nada a mano. Y, con la misma base, R-01 (esquema idéntico a 0001–0014
// tras la reversa), R-02 (la reversa dos veces) y R-12 (rollback-leche.sql
// después deja 0001–0013), en cada vuelta del ciclo.
//
// Mismo montaje que milkV4Migration.test.ts: un Postgres EFÍMERO con la imagen
// de supabase/docker/docker-compose.yml, `--network none` (ni un puerto, ni en
// 127.0.0.1), borrado al terminar. Se salta si no hay Docker o si la imagen no
// está bajada (no hace pull): en ese caso R-10 queda NO VERIFICADO.
//
// Los datos de v4 se siembran POR LAS RPC, como un padre `authenticated` (no a
// mano): son exactamente los estados que la reversa no podía devolver.

const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.167'
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)
const DOCS = new URL('../../docs/', import.meta.url)
const NAME = `amelia-reapply-v4-${randomUUID().slice(0, 8)}`

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

/** El esquema `public` como lo compara R-01, sin las líneas `\restrict` al azar de pg_dump 17.6. */
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
const rollbackV4 = readFileSync(new URL('rollback-leche-v4.sql', DOCS), 'utf8')
const rollbackV3 = readFileSync(new URL('rollback-leche.sql', DOCS), 'utf8')

/** Igual que apply_migrations de scripts/local-stack.sh: una transacción por archivo. */
const wrapped = (sql: string) => `begin;\n${sql}\ncommit;\n`

// La consulta de la invariante (ARQ §2.4) sacada del `do` final de 0015, para
// no tener una segunda copia que se desfase: devuelve una fila por falla.
const invariantSql = (() => {
  const start = m0015.indexOf('with srv as (')
  const end = m0015.indexOf('select count(*), min(falla')
  if (start < 0 || end < 0) throw new Error('no encontré la invariante en 0015')
  return `${m0015.slice(start, end)} select falla || ' ' || id::text from fallas;`
})()

const FAMILY = randomUUID()
const USER = randomUUID()

const asParent = `
  select set_config('request.jwt.claims',
    json_build_object('sub', '${USER}', 'role', 'authenticated')::text, true);
  -- El auth.uid() que trae la imagen sin GoTrue lee la forma vieja del claim.
  select set_config('request.jwt.claim.sub', '${USER}', true);
  set local role authenticated;`

/** Una transacción como el padre (lo que hace PostgREST con su JWT). */
const asParentTx = (sql: string) => must(`begin;\n${asParent}\n${sql}\ncommit;`)

/** "Lo que hay": leche en contenedores ocupados (vivos y con ≥ 0,15 ml), por bebé. */
const onHand = (baby: string) =>
  Number(
    must(
      `select coalesce(sum(remaining_ml), 0) from milk_containers
        where baby_id = '${baby}' and voided_at is null and remaining_ml >= 0.15`,
    ).trim(),
  )

const reapply = () => psql(wrapped(m0015))

/**
 * Cada prueba arranca de 0001–0015 con su propio bebé. Si la anterior dejó la
 * base en otro punto del ciclo (revertida, o en 0013 tras R-12), se vuelve a
 * subir; y si la dejó revertida con datos que 0015 no acepta (lo que pasa
 * ANTES de la corrección), se vacía la leche: la prueba que sigue mide lo suyo,
 * no hereda la falla de la otra.
 */
function ensure0015() {
  if (must(`select to_regclass('public.milk_containers') is null`).trim() === 't')
    must(wrapped(migration(files.find((f) => f.startsWith('0014_'))!)))
  const has0015 = () =>
    must(`select exists (select 1 from information_schema.columns
            where table_name = 'milk_containers' and column_name = 'released_at')`).trim() === 't'
  if (has0015()) return
  if (!reapply().ok) {
    must(`truncate milk_drawdowns, milk_containers, feedings, pumping_sessions cascade;`)
    must(wrapped(m0015))
  }
  if (!has0015()) throw new Error('no pude dejar la base en 0015')
}

describe.skipIf(!available)(
  'v4 · volver a v4 después de la reversa (R-10, con R-01/R-02/R-12)',
  () => {
    let schema0013 = ''
    let schema0014 = ''

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
      // Las referencias de R-01 y R-12, sacadas de la MISMA base antes de 0014 y
      // de 0015: 0001–0013 y 0001–0014 de cero.
      for (const f of files.filter((f) => f < '0014')) must(wrapped(migration(f)))
      schema0013 = schemaDump()
      must(wrapped(migration(files.find((f) => f.startsWith('0014_'))!)))
      schema0014 = schemaDump()
      must(wrapped(m0015))
      must(`
      insert into auth.users (id, email, aud, role)
        values ('${USER}', 'reapply-${USER}@example.test', 'authenticated', 'authenticated');
      insert into families (id, name) values ('${FAMILY}', 'reapply-v4');
      insert into family_members (family_id, user_id) values ('${FAMILY}', '${USER}');`)
    }, 180_000)

    afterAll(() => {
      spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
    })

    it('el caso mínimo: M3 servido entero, M3 reusado, reversa → 0015 vuelve a entrar', () => {
      ensure0015()
      const baby = randomUUID()
      const [s1, c1, s2, c2, f1] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ]
      must(`insert into babies (id, family_id, name, birth_date)
            values ('${baby}', '${FAMILY}', 'Minimo', '2026-09-01');`)
      asParentTx(`
      select log_pumping_session('${s1}', '${baby}', 'left', 30, null, null,
        now() - interval '3 hours', '${c1}', 'M3', null);
      select log_bottle_feed('${f1}', '${baby}', now() - interval '2 hours', null, 0,
        '[{"container_id": "${c1}", "amount_ml": 30}]'::jsonb, null);
      select log_pumping_session('${s2}', '${baby}', 'left', 40, null, null,
        now() - interval '1 hour', '${c2}', 'M3', null);`)
      must(rollbackV4)
      expect(schemaDump()).toBe(schema0014) // R-01

      // La reaplicación de verdad (no begin/rollback): si entra, queda puesta.
      const r = reapply()
      expect(r.err).not.toMatch(/milk_invariant_broken/)
      expect(r.ok).toBe(true)
      expect(must(invariantSql).trim()).toBe('')
      // El M3 viejo vuelve como LIBERADO (no anulado), con su porción; el nuevo
      // sigue ocupado con sus 40 ml.
      expect(
        must(
          `select label || ':' || (voided_at is null) || ':' || (released_at is not null) || ':' ||
                remaining_ml || ':' || lost_ml
           from milk_containers where baby_id = '${baby}' order by stored_at`,
        )
          .trim()
          .split('\n'),
      ).toEqual(['M3:true:true:0:0', 'M3:true:false:40:0'])
      expect(onHand(baby)).toBe(40)
    })

    it('B-1 tras la reversa, corregir en v3 la nota o la hora de una extracción cuyo biberón la reversa anuló no resucita leche', () => {
      // El ataque de la auditoría (run3.sql): M2 de 80 ml, 20 servidos y 60
      // desechados; M3 servido entero y su número reusado. La reversa anula los
      // dos contenedores viejos. Después, la app v3 corrige la nota y la hora de
      // esas extracciones con los argumentos que manda su lib/db.ts
      // (updatePumpingSession): los lados que tiene la fila sin tocar, y un
      // contenedor nuevo si no ve uno vivo y el total es > 0.
      ensure0015()
      const baby = randomUUID()
      const id = () => randomUUID()
      const s = { m2: id(), m3a: id(), m3b: id() }
      const c = { m2: id(), m3a: id(), m3b: id() }
      must(`insert into babies (id, family_id, name, birth_date)
            values ('${baby}', '${FAMILY}', 'B1', '2026-09-01');`)
      const portion = (cid: string, ml: number) =>
        `'[{"container_id": "${cid}", "amount_ml": ${ml}}]'::jsonb`
      asParentTx(`
      select log_pumping_session('${s.m2}', '${baby}', 'right', null, 80, null, now() - interval '5 days', '${c.m2}', 'M2', null);
      select log_bottle_feed('${id()}', '${baby}', now() - interval '4 days 12 hours', null, 0, ${portion(c.m2, 20)}, null);
      select discard_container('${id()}', '${c.m2}', null);
      select log_pumping_session('${s.m3a}', '${baby}', 'left', 30, null, null, now() - interval '5 hours', '${c.m3a}', 'M3', null);
      select log_bottle_feed('${id()}', '${baby}', now() - interval '4 hours', null, 0, ${portion(c.m3a, 30)}, null);
      select log_pumping_session('${s.m3b}', '${baby}', 'left', 40, null, null, now() - interval '3 hours', '${c.m3b}', 'M3', null);`)
      expect(must(invariantSql).trim()).toBe('')
      expect(onHand(baby)).toBe(40)

      expect(psql(rollbackV4).ok).toBe(true)
      expect(schemaDump()).toBe(schema0014) // R-01
      expect(onHand(baby)).toBe(40)
      const containersAfterRollback = must(
        `select count(*) from milk_containers where baby_id = '${baby}'`,
      ).trim()

      // Lo que manda v3 al guardar la edición, armado desde la fila como lo
      // hace su pantalla (campos de lados sin tocar = lo que tiene la fila).
      const v3Edit = (session: string, notes: string, at: string, label: string) => {
        const [left, right] = must(
          `select coalesce(left_ml::text, 'null') || ' ' || coalesce(right_ml::text, 'null')
             from pumping_sessions where id = '${session}'`,
        )
          .trim()
          .split(' ')
        const total = (left === 'null' ? 0 : Number(left)) + (right === 'null' ? 0 : Number(right))
        const live =
          must(
            `select count(*) from milk_containers
              where source_session_id = '${session}' and voided_at is null`,
          ).trim() !== '0'
        const container = total > 0 && !live ? `'${id()}', '${label}'` : 'null, null'
        asParentTx(`
        select update_pumping_session('${session}', 'right', ${left}, ${right}, '${notes}',
          ${at}, ${container}, null);`)
      }
      v3Edit(s.m2, 'nota corregida', `now() - interval '5 days'`, 'M9')
      v3Edit(s.m2, 'nota', `now() - interval '1 hour'`, 'M9')
      v3Edit(s.m3a, 'nota', `now() - interval '2 hours'`, 'M8')

      // Ni un contenedor nuevo, ni un ml más en "Lo que hay"; la nota y la
      // hora sí cambiaron, y el total de cada extracción queda.
      expect(must(`select count(*) from milk_containers where baby_id = '${baby}'`).trim()).toBe(
        containersAfterRollback,
      )
      expect(onHand(baby)).toBe(40)
      expect(
        must(
          `select amount_ml || ':' || notes || ':' || (pumped_at > now() - interval '2 hours')
             from pumping_sessions where id = '${s.m2}'`,
        ).trim(),
      ).toBe('80:nota:true')

      // Y v4 vuelve a entrar sobre eso, con la invariante en 0.
      expect(reapply().ok).toBe(true)
      expect(must(invariantSql).trim()).toBe('')
      expect(onHand(baby)).toBe(40)
    })

    it('datos reales de v4 + días de v3: reversa → 0015 entra, INV 0 y "Lo que hay" no se mueve', () => {
      ensure0015()
      const baby = randomUUID()
      const id = () => randomUUID()
      const s = { m3a: id(), m3b: id(), m2: id(), m7a: id(), m7b: id(), m1: id(), m5: id() }
      const c = { m3a: id(), m3b: id(), m2: id(), m7a: id(), m7b: id(), m1: id(), m5: id() }
      const f = { a: id(), m2: id(), m7x: id(), m7y: id(), m7b: id(), m1: id(), v3: id() }
      must(`insert into babies (id, family_id, name, birth_date)
            values ('${baby}', '${FAMILY}', 'Completo', '2026-09-01');`)
      const portion = (cid: string, ml: number) =>
        `'[{"container_id": "${cid}", "amount_ml": ${ml}}]'::jsonb`
      asParentTx(`
      -- Número reusado: M3 viejo servido entero, M3 nuevo ocupado.
      select log_pumping_session('${s.m3a}', '${baby}', 'left', 30, null, null, now() - interval '5 hours', '${c.m3a}', 'M3', null);
      select log_bottle_feed('${f.a}', '${baby}', now() - interval '4 hours', null, 0, ${portion(c.m3a, 30)}, null);
      select log_pumping_session('${s.m3b}', '${baby}', 'left', 40, null, null, now() - interval '3 hours', '${c.m3b}', 'M3', null);
      -- Desechado DESPUÉS de servir: M2 de 60 ml, 20 servidos antes de caducar.
      select log_pumping_session('${s.m2}', '${baby}', 'both', 30, 30, null, now() - interval '100 hours', '${c.m2}', 'M2', null);
      select log_bottle_feed('${f.m2}', '${baby}', now() - interval '99 hours', null, 10, ${portion(c.m2, 20)}, 5);
      select discard_container('${id()}', '${c.m2}', null);
      -- Ocupado con leche perdida (el NOTICE de la reversa): M7 viejo servido en
      -- dos tomas y liberado; M7 nuevo ocupa el número; se anula una toma del
      -- viejo (su leche va a lost: el número está tomado); se sirve entero el
      -- nuevo; se anula la otra toma del viejo, que ahora sí re-ocupa el número.
      select log_pumping_session('${s.m7a}', '${baby}', 'left', 50, null, null, now() - interval '6 hours', '${c.m7a}', 'M7', null);
      select log_bottle_feed('${f.m7x}', '${baby}', now() - interval '5 hours 30 minutes', null, 0, ${portion(c.m7a, 25)}, null);
      select log_bottle_feed('${f.m7y}', '${baby}', now() - interval '5 hours 20 minutes', null, 0, ${portion(c.m7a, 25)}, null);
      select log_pumping_session('${s.m7b}', '${baby}', 'left', 60, null, null, now() - interval '2 hours', '${c.m7b}', 'M7', null);
      select void_bottle_feed('${f.m7x}', null);
      select log_bottle_feed('${f.m7b}', '${baby}', now() - interval '90 minutes', null, 0, ${portion(c.m7b, 60)}, null);
      select void_bottle_feed('${f.m7y}', null);
      -- Uno común: ocupado, servido en parte, toma editada con sobró.
      select log_pumping_session('${s.m1}', '${baby}', 'right', null, 50, null, now() - interval '1 hour', '${c.m1}', 'M1', null);
      select log_bottle_feed('${f.m1}', '${baby}', now() - interval '30 minutes', null, 0, ${portion(c.m1, 10)}, 2);`)
      expect(must(invariantSql).trim()).toBe('')
      const stateV4 = must(
        `select label || ':' || (voided_at is null) || ':' || (released_at is not null) || ':' || remaining_ml || ':' || lost_ml
         from milk_containers where baby_id = '${baby}' order by stored_at`,
      )
        .trim()
        .split('\n')
      // Lo que la reversa no podía devolver, presente de verdad.
      expect(stateV4).toEqual([
        'M2:true:true:0:0', // desechado después de servir
        'M7:true:false:25:25', // ocupado con lost (R-05)
        'M3:true:true:0:0', // M3 viejo, servido entero
        'M3:true:false:40:0',
        'M7:true:true:0:0', // M7 nuevo, servido entero
        'M1:true:false:40:0',
      ])
      const onHandV4 = onHand(baby)
      expect(onHandV4).toBe(25 + 40 + 40)

      // ---- reversa (dos veces: R-02), esquema idéntico a 0001–0014 (R-01)
      const rb1 = psql(rollbackV4)
      expect(rb1.ok).toBe(true)
      expect(rb1.err).toMatch(/ocupado con leche perdida: M7/)
      expect(schemaDump()).toBe(schema0014)
      expect(psql(rollbackV4).ok).toBe(true)
      expect(schemaDump()).toBe(schema0014)
      // Lo que v3 ve: los tres servidos de arriba, anulados con porciones vivas.
      expect(
        must(`select count(*) from milk_containers c where c.baby_id = '${baby}' and c.voided_at is not null
              and exists (select 1 from milk_drawdowns d where d.container_id = c.id and d.voided_at is null)`).trim(),
      ).toBe('3')
      expect(onHand(baby)).toBe(onHandV4)

      // ---- "días después", con la app v3 (RPC de 0014): una toma y una extracción.
      asParentTx(`
      select log_bottle_feed('${f.v3}', '${baby}', now() - interval '10 minutes', null, 0, ${portion(c.m3b, 10)});
      select log_pumping_session('${s.m5}', '${baby}', 'left', 20, null, null, now() - interval '5 minutes', '${c.m5}', 'M5', null);`)
      const onHandV3 = onHand(baby)
      expect(onHandV3).toBe(onHandV4 - 10 + 20)

      // ---- 0015 de nuevo: en seco primero (como lo correría alguien a mano), después de verdad.
      const dry = psql(`begin;\n${m0015}\nrollback;`)
      expect(dry.err).not.toMatch(/milk_invariant_broken/)
      expect(dry.ok).toBe(true)
      const r = reapply()
      expect(r.err).not.toMatch(/ERROR/)
      expect(r.ok).toBe(true)
      expect(must(invariantSql).trim()).toBe('')
      expect(onHand(baby)).toBe(onHandV3)
      expect(
        must(
          `select label || ':' || (voided_at is null) || ':' || (released_at is not null) || ':' || remaining_ml || ':' || lost_ml
           from milk_containers where baby_id = '${baby}' order by stored_at`,
        )
          .trim()
          .split('\n'),
      ).toEqual([
        // El desecho se perdió con la reversa (está escrito): su leche vuelve como
        // perdida, nunca a "Lo que hay".
        'M2:true:true:0:40',
        'M7:true:false:25:25', // la leche perdida, recuperada exacta
        'M3:true:true:0:0',
        'M3:true:false:30:0', // 40 − 10 de la toma de v3
        'M7:true:true:0:0',
        'M1:true:false:40:0',
        'M5:true:false:20:0', // la extracción de v3
      ])
      // Las tomas no cambian: mismo desglose, mismas porciones vivas.
      expect(
        must(
          `select count(*) from milk_drawdowns where baby_id = '${baby}' and voided_at is null`,
        ).trim(),
      ).toBe('5')

      // ---- y el ciclo se puede repetir: reversa otra vez → 0001–0014 (R-01),
      //      y rollback-leche.sql encadenado → 0001–0013 (R-12), dos veces.
      expect(psql(rollbackV4).ok).toBe(true)
      expect(schemaDump()).toBe(schema0014)
      expect(psql(rollbackV3).ok).toBe(true)
      expect(schemaDump()).toBe(schema0013)
      expect(psql(rollbackV3).ok).toBe(true)
      expect(schemaDump()).toBe(schema0013)
    })
  },
)
