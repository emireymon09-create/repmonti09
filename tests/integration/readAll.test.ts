import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diapersSince, legacySplitInputs, listContainers, listDrawdowns } from '@/lib/db'
import { readAll } from '@/lib/readAll'
import { adminClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'
import { hasLocalDocker, hasMilkV4, psql } from '../helpers/milkV4'

// MAXROWS por el camino real: PostgREST + JWT de un padre, con RLS. El stack
// local no tiene `max_rows` (la nube corta en 1000) y NO se le cambia la
// config: en vez de bajar el tope del servidor, se baja la página a 7, así
// que más de 1000 filas reales salen en ~145 pedidos con `.range()` y tienen
// que llegar TODAS, sin repetir ninguna, en el orden de la consulta.

const ROWS = 1003 // > 1000, y no múltiplo de 7: la última página viene corta
const PAGE = 7
const SINCE = '2026-01-01T00:00:00.000Z'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let milk = false

beforeAll(async () => {
  ;({ a, b, cleanup } = await seedTwoFamilies('readall'))
  const admin = adminClient()
  const base = Date.parse('2026-02-01T00:00:00Z')
  const diapers = Array.from({ length: ROWS }, (_, i) => ({
    baby_id: a.babyId,
    logged_by: a.userId,
    diaper_type: 'wet',
    // Varias filas con la MISMA hora: sin el desempate por id, el orden de
    // las empatadas no es estable entre pedidos y el paginado repetiría y
    // perdería filas.
    changed_at: new Date(base + Math.floor(i / 3) * 60_000).toISOString(),
  }))
  const { error } = await admin.from('diaper_changes').insert(diapers)
  if (error) throw error
  // De la otra familia: no tiene que aparecer nunca.
  const { error: otherErr } = await admin
    .from('diaper_changes')
    .insert({ baby_id: b.babyId, logged_by: b.userId, diaper_type: 'wet', changed_at: SINCE })
  if (otherErr) throw otherErr

  // Contenedores y porciones solo se escriben por las funciones de 0014/0015
  // (las guardas): se siembran como postgres, con la bandera, en el stack
  // local (127.0.0.1). 1003 contenedores de 10 ml, cada uno con una toma de 4.
  milk = (await hasMilkV4()) && hasLocalDocker()
  if (milk) {
    psql(`begin;
      select set_config('amelia.milk_rpc', 'on', true);
      insert into milk_containers (id, family_id, baby_id, label, amount_ml, remaining_ml, stored_at, expires_at)
        select gen_random_uuid(), '${a.familyId}', '${a.babyId}', 'M' || g, 10, 6,
               '2026-02-01'::timestamptz + g * interval '1 minute', now() + interval '1 day'
          from generate_series(1, ${ROWS}) g;
      insert into feedings (id, baby_id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml)
        select gen_random_uuid(), '${a.babyId}', c.stored_at + interval '10 seconds', 'bottle', 4, 4, 0
          from milk_containers c where c.baby_id = '${a.babyId}';
      insert into milk_drawdowns (family_id, baby_id, container_id, feeding_id, amount_ml)
        select '${a.familyId}', '${a.babyId}', c.id, f.id, 4
          from milk_containers c join feedings f
            on f.baby_id = c.baby_id and f.fed_at = c.stored_at + interval '10 seconds'
         where c.baby_id = '${a.babyId}';
      commit;`)
  }
}, 120_000)

afterAll(async () => {
  await cleanup?.()
})

const db = () => a.client.schema('public')

describe('MAXROWS · más de 1000 filas reales por el helper, en páginas de 7', () => {
  it('readAll directo: 1003 pañales, todos, una vez cada uno, en el orden pedido', async () => {
    const { data, error } = await readAll(
      (from, to) =>
        db()
          .from('diaper_changes')
          .select('id, changed_at')
          .eq('baby_id', a.babyId)
          .is('voided_at', null)
          .order('changed_at', { ascending: false })
          .order('id')
          .range(from, to),
      PAGE,
    )
    expect(error).toBeNull()
    expect(data).toHaveLength(ROWS)
    expect(new Set(data.map((r) => r.id)).size).toBe(ROWS)
    const times = data.map((r) => Date.parse(r.changed_at as string))
    expect(times).toEqual([...times].sort((x, y) => y - x))
  }, 60_000)

  it('diapersSince (el total de /diapers) con página 7: 1003, y nada de la otra familia', async () => {
    const r = await diapersSince(a.babyId, SINCE, db(), PAGE)
    expect(r.error).toBeNull()
    expect(r.data).toHaveLength(ROWS)
    expect(new Set(r.data.map((d) => d.id)).size).toBe(ROWS)
    const other = await diapersSince(b.babyId, SINCE, db(), PAGE)
    expect(other.data).toHaveLength(0)
  }, 60_000)

  it('"Lo que hay", porciones y la estimación hacia atrás con página 7: los 1003', async (ctx) => {
    if (!milk) ctx.skip()
    const containers = await listContainers(a.babyId, db(), PAGE)
    expect(containers.error).toBeNull()
    expect(containers.data).toHaveLength(ROWS)
    expect(containers.data.reduce((s, c) => s + c.remaining_ml, 0)).toBe(6 * ROWS)
    const portions = await listDrawdowns(a.babyId, db(), PAGE)
    expect(portions.data).toHaveLength(ROWS)
    expect(portions.data.reduce((s, d) => s + d.amount_ml, 0)).toBe(4 * ROWS)
    const legacy = await legacySplitInputs(a.babyId, db(), PAGE)
    expect(legacy.error).toBeNull()
    // + la toma de 90 ml que seedTwoFamilies le da a cada familia.
    expect(legacy.data.feedings).toHaveLength(ROWS + 1)
    expect(legacy.data.containerSessionIds).toHaveLength(0) // sembrados sin extracción
  }, 60_000)
})
