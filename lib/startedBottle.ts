/**
 * The started bottle (0016, V5-10…V5-12): what the baby left in the last
 * bottle ("Sobró", `feedings.leftover_ml`) is good for an hour from the time
 * of that feeding. Past it: "Ya no sirve" + "Desechar"
 * (`discard_started_bottle`, a `milk_discards` row with reason
 * 'started_bottle_expired' and the feeding's id).
 *
 * Pure: the instant comes in as `nowMs`. The phone's clock only paints; that
 * the hour has passed is the DATABASE's call (`milk_not_expired:started`).
 */

import { BOTTLE_STARTED_MAX_MS } from '@/lib/milkParams'
import type { Feeding, MilkDiscard, WithPending } from '@/lib/types'

export type StartedBottle = {
  feedingId: string
  leftoverMl: number
  fedAtMs: number
  /** `fed_at + 60 min`: at that exact instant it is no longer good. */
  usableUntilMs: number
  expired: boolean
  /** The feeding is still only in this phone's queue. */
  pending: boolean
}

type StartedFeeding = WithPending<
  Pick<Feeding, 'id' | 'fed_at' | 'feeding_type' | 'leftover_ml'> & { voided_at?: string | null }
>

/**
 * The LAST live bottle with a leftover above 0, unless that leftover was
 * already thrown out (a live 'started_bottle_expired' discard of it, queued
 * ones included) — then there is nothing to offer. An older leftover never
 * comes back once a newer one exists: the bottle on the counter is the last
 * one (a decision, see the report of H3).
 */
export function startedBottle(input: {
  feedings: readonly StartedFeeding[]
  discards: readonly MilkDiscard[]
  nowMs: number
}): StartedBottle | null {
  let last: StartedFeeding | null = null
  for (const f of input.feedings) {
    if (f.voided_at || f.feeding_type !== 'bottle') continue
    if (!(Number(f.leftover_ml ?? 0) > 0)) continue
    const at = Date.parse(f.fed_at)
    if (!last || at > Date.parse(last.fed_at) || (at === Date.parse(last.fed_at) && f.id > last.id))
      last = f
  }
  if (!last) return null
  const thrown = input.discards.some(
    (d) => !d.voided_at && d.reason === 'started_bottle_expired' && d.feeding_id === last!.id,
  )
  if (thrown) return null
  const fedAtMs = Date.parse(last.fed_at)
  const usableUntilMs = fedAtMs + BOTTLE_STARTED_MAX_MS
  return {
    feedingId: last.id,
    leftoverMl: Number(last.leftover_ml),
    fedAtMs,
    usableUntilMs,
    expired: input.nowMs >= usableUntilMs,
    pending: !!last.pending,
  }
}
