/**
 * "Enfriando" (0016, V5-20…V5-23): milk just pumped goes into the fridge and
 * is not cold for a while.
 *
 * Pure: every instant comes in as a parameter. The rule is the one of
 * `milk_is_cold` in 0016, to the millisecond:
 *
 *   cold at t  ⇔  cold_at ≤ t  or  coalesce(fridge_at, stored_at) + 60 min ≤ t
 *
 * Cooling is a warning, not a lock (D5-6): a bottle may still be served from
 * milk that is cooling (with the mark on screen); the recipe does not propose
 * it, and combining refuses it. The expiry does NOT move: it still runs from
 * `stored_at` (= pumped_at, V5-22).
 */

import { containerState, type ContainerState } from '@/lib/milkBottles'
import { COOLING_MS } from '@/lib/milkParams'
import type { MilkContainer, MilkDiscard } from '@/lib/types'

type Coolable = Pick<MilkContainer, 'stored_at' | 'fridge_at' | 'cold_at'>

/**
 * The instant it is cold from: the earlier of "someone checked it" (`cold_at`)
 * and "an hour in the fridge" (`fridge_at`, or `stored_at` for a row from
 * before 0016). In ms.
 */
export function coldReadyAt(c: Coolable): number {
  const byTime = Date.parse(c.fridge_at ?? c.stored_at) + COOLING_MS
  if (!c.cold_at) return byTime
  return Math.min(Date.parse(c.cold_at), byTime)
}

/** Cold at `atMs` — the same answer as `milk_is_cold(c, t)`. Inclusive: at the exact instant it is cold. */
export function isCold(c: Coolable, atMs: number): boolean {
  return coldReadyAt(c) <= atMs
}

export type CoolingState = { state: 'cooling' | 'cold'; readyAtMs: number }

/** "Enfriando · lista ~15:20" or cold, with the instant it is (or was) ready. */
export function coolingState(c: Coolable, atMs: number): CoolingState {
  const readyAtMs = coldReadyAt(c)
  return { state: readyAtMs <= atMs ? 'cold' : 'cooling', readyAtMs }
}

export type ShelfState = ContainerState | 'cooling'

/**
 * `containerState` (lib/milkBottles.ts) plus 'cooling' for an occupied
 * container that is not cold yet. A separate function on purpose: the bottle
 * selector and "Desechar" read `containerState`, and a sixth state there
 * would make a cooling bottle look free to them.
 */
export function shelfState(
  c: MilkContainer,
  discards: readonly MilkDiscard[],
  atMs: number,
): ShelfState {
  const state = containerState(c, discards, atMs)
  if (state === 'occupied' && !isCold(c, atMs)) return 'cooling'
  return state
}
