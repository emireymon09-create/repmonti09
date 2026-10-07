/**
 * Estimating the breast milk / formula split of old bottles (2B, D-14,
 * docs/arquitectura-v4.md §5).
 *
 * Pure and with no clock at all: every time comes from the rows. Nothing is
 * written — not the feeding, not the containers, not the queue — and "Lo que
 * hay" does not move: it is computed when the screen reads, and shown as
 * "≈ … (estimado)".
 *
 * The rule, "milk 0 unless there is evidence": a pool made ONLY of legacy
 * pumping sessions (no container — before 0014, or from the v0.12.1 app),
 * each good for `fridgeDays × 24 h` from its `pumped_at`. Walking the history
 * in time order, each bottle with no breakdown takes from the pool, oldest
 * session first, only what had not expired at the bottle's time, never more
 * than its own total. What the pool doesn't cover is formula. Milk from
 * containers is not in the pool: real portions already account for it.
 *
 * The one bias, written down: milk that was logged and thrown away without
 * saying so is counted as drunk — bounded by what was pumped.
 */

import type { Feeding, PumpingSession } from '@/lib/types'

export type LegacySplit = { breastMl: number; formulaMl: number; estimated: true }

const DAY_MS = 24 * 3_600_000
const DUST_ML = 1e-9

export function estimateLegacySplit(input: {
  /** The baby's live feedings (bottles with and without breakdown; others are ignored). */
  feedings: Pick<
    Feeding,
    'id' | 'fed_at' | 'feeding_type' | 'amount_ml' | 'breast_milk_ml' | 'formula_ml'
  >[]
  /** The baby's live pumping sessions (those without an amount are ignored). */
  pumping: Pick<PumpingSession, 'id' | 'pumped_at' | 'amount_ml'>[]
  /** Ids of sessions that filled a container (live, free or discarded). */
  sessionsWithContainer: ReadonlySet<string>
  /** The fridge rule in force, in days (`milk_fridge_days`). */
  fridgeDays: number
}): Map<string, LegacySplit> {
  type Event =
    | { kind: 0; at: number; id: string; ml: number; expires: number }
    | { kind: 1; at: number; id: string; ml: number }
  const events: Event[] = []
  for (const p of input.pumping) {
    const ml = Number(p.amount_ml ?? 0)
    if (!(ml > 0) || input.sessionsWithContainer.has(p.id)) continue
    const at = Date.parse(p.pumped_at)
    events.push({ kind: 0, at, id: p.id, ml, expires: at + input.fridgeDays * DAY_MS })
  }
  for (const f of input.feedings) {
    const ml = Number(f.amount_ml ?? 0)
    if (f.feeding_type !== 'bottle' || !(ml > 0)) continue
    if (f.breast_milk_ml != null || f.formula_ml != null) continue
    events.push({ kind: 1, at: Date.parse(f.fed_at), id: f.id, ml })
  }
  // By time; on a tie the pumping goes in first; then by id — so the answer
  // does not depend on the order the rows came in.
  events.sort((a, b) => a.at - b.at || a.kind - b.kind || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const pool: { id: string; at: number; left: number; expires: number }[] = []
  const out = new Map<string, LegacySplit>()
  for (const e of events) {
    if (e.kind === 0) {
      pool.push({ id: e.id, at: e.at, left: e.ml, expires: e.expires })
      continue
    }
    let need = e.ml
    let taken = 0
    // The pool is already oldest first: events were sorted the same way.
    for (const p of pool) {
      if (need <= DUST_ML) break
      if (p.left <= DUST_ML || p.expires <= e.at) continue
      const take = Math.min(p.left, need)
      p.left -= take
      need -= take
      taken += take
    }
    const breastMl = need <= DUST_ML ? e.ml : taken
    out.set(e.id, { breastMl, formulaMl: Math.max(0, e.ml - breastMl), estimated: true })
  }
  return out
}
