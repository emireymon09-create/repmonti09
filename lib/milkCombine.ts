/**
 * "Combinar" biberones (0016, V5-30…V5-35), as pure functions: what the screen
 * checks before sending `milk_combine` / `milk_uncombine`, and what the
 * offline view expects the server to answer. The server has the last word
 * (its own `now()`, and `p_expected` against what another phone did).
 *
 * The rules, the same as `milk_combine`:
 *   · one target and at least one source, no source twice, the target not
 *     among the sources;
 *   · all of the same baby, occupied (not voided, not released), not expired
 *     and cold at the instant asked (`atMs`) — checked container by container
 *     in id order, unusable before cooling, as the server's loop does;
 *   · each source pours ALL it has into the target and is left free; the
 *     target expires when the oldest of them does.
 */

import { EMPTY_ML } from '@/lib/milkBottles'
import { coldReadyAt, isCold } from '@/lib/milkCooling'
import type { MilkCombination, MilkContainer, MilkTransfer, WithPending } from '@/lib/types'

type Combinable = MilkContainer & { baby_id?: string }

export type CombineProblem =
  | { problem: 'bad_input'; reason: 'no_target' | 'no_sources' | 'duplicate' | 'target_in_sources' }
  | { problem: 'unusable'; label: string; code: string }
  | { problem: 'not_cold'; label: string; readyAtMs: number; code: string }

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Why this combination would be refused at `atMs`, or null when it would go
 * through. `code` is the server's (`milk_container_unusable:M#`,
 * `milk_not_cold:M#`), so lib/db.ts `milkErrorText` words it the same.
 */
export function combineProblem(
  target: Combinable | null | undefined,
  sources: readonly Combinable[],
  atMs: number,
): CombineProblem | null {
  if (!target) return { problem: 'bad_input', reason: 'no_target' }
  if (sources.length < 1) return { problem: 'bad_input', reason: 'no_sources' }
  const ids = sources.map((s) => s.id)
  if (new Set(ids).size !== ids.length) return { problem: 'bad_input', reason: 'duplicate' }
  if (ids.includes(target.id)) return { problem: 'bad_input', reason: 'target_in_sources' }

  const baby = target.baby_id
  for (const c of [target, ...sources].sort(byId)) {
    if (
      (baby !== undefined && c.baby_id !== undefined && c.baby_id !== baby) ||
      c.voided_at ||
      c.released_at ||
      Date.parse(c.expires_at) <= atMs
    )
      return { problem: 'unusable', label: c.label, code: `milk_container_unusable:${c.label}` }
    if (!isCold(c, atMs))
      return {
        problem: 'not_cold',
        label: c.label,
        readyAtMs: coldReadyAt(c),
        code: `milk_not_cold:${c.label}`,
      }
  }
  // CHECK expires_at > stored_at: a target stored "in the future" (the
  // 10-minute tolerance) with a source that expires before that.
  if (Date.parse(combinedExpiry(target, sources)) <= Date.parse(target.stored_at))
    return {
      problem: 'unusable',
      label: target.label,
      code: `milk_container_unusable:${target.label}`,
    }
  return null
}

/** `p_expected`: what the screen saw left in each one, `{id: remaining_ml}`. */
export function combineExpected(
  target: Pick<MilkContainer, 'id' | 'remaining_ml'>,
  sources: readonly Pick<MilkContainer, 'id' | 'remaining_ml'>[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of [target, ...sources]) out[c.id] = Number(c.remaining_ml)
  return out
}

/** The target's expiry after combining: the earliest of all of them (V5-31). ISO. */
export function combinedExpiry(
  target: Pick<MilkContainer, 'expires_at'>,
  sources: readonly Pick<MilkContainer, 'expires_at'>[],
): string {
  let min = target.expires_at
  for (const s of sources) if (Date.parse(s.expires_at) < Date.parse(min)) min = s.expires_at
  return new Date(Date.parse(min)).toISOString()
}

/** What the target holds after combining, in ml. */
export function combinedMl(
  target: Pick<MilkContainer, 'remaining_ml'>,
  sources: readonly Pick<MilkContainer, 'remaining_ml'>[],
): number {
  return sources.reduce((s, c) => s + Number(c.remaining_ml), Number(target.remaining_ml))
}

/**
 * The combinations, newest first, from the transfers (voided ones included —
 * they are the undone combinations). One per `op_id`.
 */
export function combinationsOf(transfers: readonly WithPending<MilkTransfer>[]): MilkCombination[] {
  const byOp = new Map<string, WithPending<MilkTransfer>[]>()
  for (const t of transfers) byOp.set(t.op_id, [...(byOp.get(t.op_id) ?? []), t])
  const out: MilkCombination[] = []
  for (const [opId, rows] of byOp) {
    const live = rows.filter((t) => !t.voided_at)
    out.push({
      opId,
      targetId: rows[0].to_container_id,
      sourceIds: rows.map((t) => t.from_container_id).sort(),
      movedMl: live.reduce((s, t) => s + Number(t.amount_ml), 0),
      createdAt: rows.reduce(
        (min, t) => (Date.parse(t.created_at) < Date.parse(min) ? t.created_at : min),
        rows[0].created_at,
      ),
      undone: live.length === 0,
      pending: rows.some((t) => t.pending),
    })
  }
  return out.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.opId < b.opId ? 1 : -1),
  )
}

export type UncombineCheck =
  | { ok: true; noop: boolean; returnedMl: number }
  | { ok: false; problem: 'used' | 'label_taken'; label: string; code: string }
  | { ok: false; problem: 'unknown' }

/**
 * Whether "Deshacer" would go through, as `milk_uncombine` decides it:
 *   · already undone → a no-op (ok);
 *   · the target no longer holds what it received (served, discarded,
 *     emptied, voided) → `milk_combine_used:M#`;
 *   · the number of a source is held by another occupied container →
 *     `milk_label_taken:M#` (the first by source id).
 */
export function canUncombine(
  combineOpId: string,
  transfers: readonly MilkTransfer[],
  containers: readonly MilkContainer[],
): UncombineCheck {
  const rows = transfers.filter((t) => t.op_id === combineOpId)
  if (rows.length === 0) return { ok: false, problem: 'unknown' }
  const live = rows.filter((t) => !t.voided_at)
  const liveMl = live.reduce((s, t) => s + Number(t.amount_ml), 0)
  if (live.length === 0) return { ok: true, noop: true, returnedMl: 0 }

  const find = (id: string) => containers.find((c) => c.id === id)
  const target = find(rows[0].to_container_id)
  if (
    !target ||
    target.voided_at ||
    target.released_at ||
    Number(target.remaining_ml) < liveMl - 1e-9
  ) {
    const label = target?.label ?? '?'
    return { ok: false, problem: 'used', label, code: `milk_combine_used:${label}` }
  }
  const sources = live
    .map((t) => find(t.from_container_id))
    .filter((c): c is MilkContainer => !!c)
    .sort(byId)
  for (const s of sources) {
    const taken = containers.some(
      (o) => o.id !== s.id && o.label === s.label && !o.voided_at && !o.released_at,
    )
    if (taken)
      return {
        ok: false,
        problem: 'label_taken',
        label: s.label,
        code: `milk_label_taken:${s.label}`,
      }
  }
  return { ok: true, noop: false, returnedMl: liveMl }
}

/** A container that may be offered as part of a combination at `atMs` (occupied, good, cold, with milk). */
export function isCombinable(c: MilkContainer, atMs: number): boolean {
  return (
    !c.voided_at &&
    !c.released_at &&
    Number(c.remaining_ml) >= EMPTY_ML &&
    Date.parse(c.expires_at) > atMs &&
    isCold(c, atMs)
  )
}
