import { expect } from 'vitest'
import { adminClient } from './supabase'

// La invariante contable y de estado del inventario de leche (0015), en
// TypeScript (docs/arquitectura-v4.md §2.4).
//
// Por qué existe una copia: PostgREST no corre SQL libre, así que las pruebas
// de integración no pueden ejecutar la consulta de §2.4. Se reconstruye acá con
// lecturas de service_role (salta RLS) y la misma aritmética. La consulta SQL
// es la que corre la migración en su `do` final y la que corren QA y la
// auditoría con `pnpm db:psql`. Las dos tienen que tener los mismos chequeos:
// U-42 compara esta lista con los IDs del SQL de la migración.
export const MILK_INVARIANT_CHECKS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5',
  'INV-6',
  'INV-8',
  'INV-9',
] as const
// INV-7 (sobró ≤ total) es una constraint de la tabla, no una consulta: los
// "nueve chequeos" de §2.4 son estos ocho más la constraint.

const TOL = 1e-9
const EMPTY_ML = 0.15

type Failure = { check: (typeof MILK_INVARIANT_CHECKS)[number]; id: string; detail: string }

type Container = {
  id: string
  baby_id: string
  label: string
  amount_ml: number
  remaining_ml: number
  lost_ml: number
  released_at: string | null
  voided_at: string | null
  source_session_id: string | null
}

async function readAll<T>(table: string, columns: string, familyIds?: string[]): Promise<T[]> {
  let q = adminClient().from(table).select(columns)
  if (familyIds) {
    // feedings y pumping_sessions no tienen family_id: se filtran por bebé.
    q =
      table === 'feedings' || table === 'pumping_sessions'
        ? q.in('baby_id', await babiesOf(familyIds))
        : q.in('family_id', familyIds)
  }
  const { data, error } = await q
  if (error) throw new Error(`${table}: ${error.message}`)
  return (data ?? []) as T[]
}

async function babiesOf(familyIds: string[]): Promise<string[]> {
  const { data, error } = await adminClient().from('babies').select('id').in('family_id', familyIds)
  if (error) throw new Error(`babies: ${error.message}`)
  return (data ?? []).map((b) => b.id as string)
}

const n = (x: unknown) => Number(x ?? 0)

/** Las fallas de la invariante (vacío = cierra). Sin `familyIds`, toda la base. */
export async function milkInvariantFailures(familyIds?: string[]): Promise<Failure[]> {
  const [containers, drawdowns, discards, feedings, sessions] = await Promise.all([
    readAll<Container>(
      'milk_containers',
      'id, baby_id, label, amount_ml, remaining_ml, lost_ml, released_at, voided_at, source_session_id',
      familyIds,
    ),
    readAll<{
      container_id: string
      feeding_id: string
      amount_ml: number
      voided_at: string | null
    }>('milk_drawdowns', 'container_id, feeding_id, amount_ml, voided_at', familyIds),
    readAll<{ container_id: string; amount_ml: number; voided_at: string | null }>(
      'milk_discards',
      'container_id, amount_ml, voided_at',
      familyIds,
    ),
    readAll<{
      id: string
      amount_ml: number | null
      breast_milk_ml: number | null
      formula_ml: number | null
      voided_at: string | null
    }>('feedings', 'id, amount_ml, breast_milk_ml, formula_ml, voided_at', familyIds),
    readAll<{ id: string; amount_ml: number | null; voided_at: string | null }>(
      'pumping_sessions',
      'id, amount_ml, voided_at',
      familyIds,
    ),
  ])

  const served = new Map<string, number>()
  const servedByFeeding = new Map<string, number>()
  for (const d of drawdowns) {
    if (d.voided_at) continue
    served.set(d.container_id, (served.get(d.container_id) ?? 0) + n(d.amount_ml))
    servedByFeeding.set(d.feeding_id, (servedByFeeding.get(d.feeding_id) ?? 0) + n(d.amount_ml))
  }
  const discarded = new Map<string, number>()
  for (const d of discards) {
    if (d.voided_at) continue
    discarded.set(d.container_id, (discarded.get(d.container_id) ?? 0) + n(d.amount_ml))
  }
  const feedingById = new Map(feedings.map((f) => [f.id, f]))
  const sessionById = new Map(sessions.map((s) => [s.id, s]))

  const out: Failure[] = []
  const occupied = new Map<string, number>()
  for (const c of containers) {
    const s = served.get(c.id)
    const d = discarded.get(c.id)
    if (!c.voided_at) {
      const gap = n(c.amount_ml) - (s ?? 0) - (d ?? 0) - n(c.lost_ml) - n(c.remaining_ml)
      if (Math.abs(gap) > TOL)
        out.push({ check: 'INV-1', id: c.id, detail: `${c.label}: diferencia ${gap}` })
    }
    if (!c.voided_at && !c.released_at) {
      const key = `${c.baby_id}|${c.label}`
      occupied.set(key, (occupied.get(key) ?? 0) + 1)
    }
    if (d !== undefined && (c.voided_at || !c.released_at || n(c.remaining_ml) !== 0))
      out.push({ check: 'INV-3', id: c.id, detail: `${c.label}: desecho incoherente` })
    if (c.voided_at && (s !== undefined || d !== undefined))
      out.push({ check: 'INV-4', id: c.id, detail: `${c.label}: anulado con vivos` })
    if (!c.voided_at && !c.released_at && n(c.remaining_ml) < EMPTY_ML)
      out.push({ check: 'INV-5', id: c.id, detail: `${c.label}: ocupado vacío` })
    const ps = c.source_session_id ? sessionById.get(c.source_session_id) : undefined
    if (!c.voided_at && ps && !ps.voided_at && n(ps.amount_ml) !== n(c.amount_ml))
      out.push({ check: 'INV-8', id: c.id, detail: `${c.label}: sesión ${ps.amount_ml}` })
  }
  for (const [key, count] of occupied)
    if (count > 1) out.push({ check: 'INV-2', id: key, detail: `${count} ocupados` })
  for (const f of feedings) {
    if (f.voided_at || (f.breast_milk_ml === null && f.formula_ml === null)) continue
    const p = servedByFeeding.get(f.id) ?? 0
    if (
      Math.abs(n(f.breast_milk_ml) - p) > TOL ||
      Math.abs(n(f.amount_ml) - n(f.breast_milk_ml) - n(f.formula_ml)) > TOL
    )
      out.push({ check: 'INV-6', id: f.id, detail: `porciones ${p}` })
  }
  for (const d of drawdowns) {
    if (d.voided_at) continue
    const f = feedingById.get(d.feeding_id)
    if (f?.voided_at) out.push({ check: 'INV-9', id: d.feeding_id, detail: 'porción huérfana' })
  }
  return out
}

/** Falla la prueba si la invariante no cierra para estas familias. */
export async function assertMilkInvariant(familyIds?: string[]): Promise<void> {
  expect(await milkInvariantFailures(familyIds)).toEqual([])
}
