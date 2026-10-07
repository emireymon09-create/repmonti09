import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { adminClient, type SeededFamily } from './supabase'
import { HOUR, MIN, iso, pumpOk, rpc } from './milkV4'

// Ayudantes de las pruebas de integración del inventario v5 (0016): enfriado,
// combinar, biberón empezado y fórmula. Como los de v4, llaman a las RPC por
// PostgREST con el JWT de un padre, sin pasar por lib/.

/** ¿La base tiene 0016? Sin ella las suites v5 se saltan. */
export async function hasMilkV5(): Promise<boolean> {
  try {
    const { error } = await adminClient().from('milk_transfers').select('id').limit(0)
    return !error
  } catch {
    return false
  }
}

/** Extracción ya fría (entró al refri hace 2 h, D5-4: 60 min). */
export const coldPump = (f: SeededFamily, ml: number, label: string, agoMs = 2 * HOUR) =>
  pumpOk(f, ml, label, Date.now() - agoMs)

export type ContainerV5 = {
  id: string
  label: string
  amount_ml: number
  remaining_ml: number
  lost_ml: number
  released_at: string | null
  voided_at: string | null
  stored_at: string
  fridge_at: string | null
  cold_at: string | null
  expires_at: string
}

export async function containerV5(id: string): Promise<ContainerV5> {
  const { data, error } = await adminClient()
    .from('milk_containers')
    .select(
      'id, label, amount_ml, remaining_ml, lost_ml, released_at, voided_at, stored_at, fridge_at, cold_at, expires_at',
    )
    .eq('id', id)
    .single()
  if (error) throw error
  return data as ContainerV5
}

/** `p_expected` como lo vería la pantalla: lo que le queda a cada uno ahora. */
export async function expectedFor(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const id of ids) out[id] = Number((await containerV5(id)).remaining_ml)
  return out
}

export async function combineArgs(
  f: SeededFamily,
  targetId: string,
  sourceIds: string[],
  opId?: string,
) {
  return {
    p_op_id: opId ?? randomUUID(),
    p_baby_id: f.babyId,
    p_target_id: targetId,
    p_source_ids: sourceIds,
    p_expected: await expectedFor([targetId, ...sourceIds]),
  }
}

/** Combina; falla la prueba si no entra. Devuelve el op_id y el resultado. */
export async function combineOk(f: SeededFamily, targetId: string, sourceIds: string[]) {
  const args = await combineArgs(f, targetId, sourceIds)
  const r = await rpc(f.client, 'milk_combine', args)
  expect(r.error, 'milk_combine').toBeNull()
  return { opId: args.p_op_id, result: r.data as Record<string, unknown>, args }
}

export const uncombineArgs = (combineOpId: string, opId?: string) => ({
  p_op_id: opId ?? randomUUID(),
  p_combine_op_id: combineOpId,
})

export async function transfersOf(opId: string) {
  const { data, error } = await adminClient()
    .from('milk_transfers')
    .select('id, from_container_id, to_container_id, amount_ml, target_prev_expires_at, voided_at')
    .eq('op_id', opId)
    .order('from_container_id')
  if (error) throw error
  return data as {
    id: string
    from_container_id: string
    to_container_id: string
    amount_ml: number
    target_prev_expires_at: string
    voided_at: string | null
  }[]
}

export function updatePumpArgs(
  sessionId: string,
  o: { left: number | null; at: number; containerId?: string | null; label?: string | null },
) {
  return {
    p_id: sessionId,
    p_side: 'both',
    p_left_ml: o.left,
    p_right_ml: null,
    p_notes: null,
    p_pumped_at: iso(o.at),
    p_container_id: o.containerId ?? null,
    p_container_label: o.label ?? null,
    p_container_expires_at: null,
  }
}

/** Toma de solo fórmula con sobró, a la hora `at`. */
export async function startedFeed(f: SeededFamily, leftover: number, at: number, formula = 90) {
  const id = randomUUID()
  const r = await rpc(f.client, 'log_bottle_feed', {
    p_id: id,
    p_baby_id: f.babyId,
    p_fed_at: iso(at),
    p_notes: null,
    p_formula_ml: formula,
    p_portions: [],
    p_leftover_ml: leftover,
  })
  expect(r.error, 'log_bottle_feed').toBeNull()
  return id
}

export const startedArgs = (feedingId: string, at?: number | null, id?: string) => ({
  p_id: id ?? randomUUID(),
  p_feeding_id: feedingId,
  p_discarded_at: at === undefined || at === null ? null : iso(at),
})

export async function startedDiscards(feedingId: string) {
  const { data, error } = await adminClient()
    .from('milk_discards')
    .select('id, container_id, feeding_id, amount_ml, discarded_at, reason, voided_at')
    .eq('feeding_id', feedingId)
    .order('created_at')
  if (error) throw error
  return data as {
    id: string
    container_id: string | null
    feeding_id: string
    amount_ml: number
    discarded_at: string
    reason: string
    voided_at: string | null
  }[]
}

export type FormulaRow = {
  id: string
  size_ml: number
  added_at: string
  opened_at: string | null
  finished_at: string | null
  finish_reason: string | null
  voided_at: string | null
}

export async function formulaRows(babyId: string): Promise<FormulaRow[]> {
  const { data, error } = await adminClient()
    .from('formula_containers')
    .select('id, size_ml, added_at, opened_at, finished_at, finish_reason, voided_at')
    .eq('baby_id', babyId)
    .order('added_at')
    .order('id')
  if (error) throw error
  return data as FormulaRow[]
}

export async function formulaAddOk(f: SeededFamily, n = 6, at = Date.now() - HOUR) {
  const ids = Array.from({ length: n }, () => randomUUID())
  const args = {
    p_op_id: randomUUID(),
    p_baby_id: f.babyId,
    p_ids: ids,
    p_size_ml: 236.5882365,
    p_added_at: iso(at),
  }
  const r = await rpc(f.client, 'formula_add', args)
  expect(r.error, 'formula_add').toBeNull()
  return { ids, args }
}

export const formulaOpenArgs = (f: SeededFamily, containerId: string, at: number | null) => ({
  p_op_id: randomUUID(),
  p_baby_id: f.babyId,
  p_container_id: containerId,
  p_opened_at: at === null ? null : iso(at),
})

export { HOUR, MIN }
