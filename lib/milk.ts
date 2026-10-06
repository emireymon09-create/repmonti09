/**
 * The milk inventory, as pure functions (0014, 4 oct 2026).
 *
 * No clock, no database, no React: every function takes what it needs and
 * gives back a value, so the rules the family asked for can be tested under
 * four timezones without a browser (tests/unit/milk.test.ts). The pages read
 * the rows through lib/db.ts and do their arithmetic here.
 *
 * The rules, in short (docs/spec-feeding-v3.md §1 has them in full):
 *   · a pumping session with an amount fills one container, M1, M2…;
 *   · a container is usable while it isn't voided, has milk left and hasn't
 *     expired;
 *   · a bottle is breast-milk portions (container + amount) plus formula,
 *     and formula has NO inventory — it is just a number on the feeding;
 *   · the suggested bottle is the last bottle's total (3 oz before there was
 *     ever one), served oldest container first, the shortfall as formula;
 *   · the stash is what is left in usable containers, breast milk only.
 *
 * v4 (0015, docs/arquitectura-v4.md §7.1): the containers are physical
 * bottles M1…MN that are reused. Their states, the selector, discarding, the
 * accounting and the full edit of a bottle live in lib/milkBottles.ts; the
 * estimate for old bottles in lib/milkEstimate.ts. Here: what was already
 * here, a container that was emptied or discarded no longer counts
 * (`released_at`), the offline view of the new queued calls, and the oz/ml
 * conversion of a typed amount (extracted so every field converts the same
 * way, AJ-16).
 */

import { ML_PER_FL_OZ, formatMilkOz } from '@/lib/format'
import { translate, type Lang } from '@/lib/i18n'
import type { PendingWrite } from '@/lib/queue'
import {
  EMPTY_ML,
  byAge,
  hasLiveDiscard,
  isOccupied,
  labelNumber,
  planBottleEdit,
  rebalance,
  residueParts,
  type LostReason,
  type RebalanceCause,
} from '@/lib/milkBottles'
import type {
  Feeding,
  MilkContainer,
  MilkDiscard,
  MilkDrawdown,
  MilkLocation,
  MilkRules,
  PumpingSession,
  VolumeUnit,
  WithPending,
} from '@/lib/types'

/**
 * What the bottle suggestion starts at when no bottle was ever logged. NOT a
 * standard: the moment there is one bottle, the suggestion is that bottle's
 * total, and nothing else in the app reads this number.
 */
export const DEFAULT_FIRST_SUGGESTION_ML = 3 * ML_PER_FL_OZ

/** The pediatrician's numbers; the same defaults as the columns in 0014. */
export const DEFAULT_MILK_RULES: MilkRules = {
  milk_room_hours: 4,
  milk_fridge_days: 4,
  milk_freezer_months: 6,
}

const HOUR_MS = 3_600_000

// ------------------------------------------------------------- expiry

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * When a container stored at `storedAtIso` stops being usable.
 *
 * Fridge: exactly N days of 24 h. Freezer: N calendar months, same day and
 * time — and when the target month has no such day (Aug 31 + 6 months), the
 * last day of that month (Feb 28): always earlier, never later. All in UTC,
 * so the answer is the same on every phone whatever its timezone.
 */
export function containerExpiresAt(
  storedAtIso: string,
  location: MilkLocation,
  rules: MilkRules,
): string {
  const stored = new Date(storedAtIso)
  if (location === 'fridge') {
    return new Date(stored.getTime() + rules.milk_fridge_days * 24 * HOUR_MS).toISOString()
  }
  const months = Math.trunc(rules.milk_freezer_months)
  const total = stored.getUTCMonth() + months
  const year = stored.getUTCFullYear() + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12
  const day = Math.min(stored.getUTCDate(), daysInUtcMonth(year, month))
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      stored.getUTCHours(),
      stored.getUTCMinutes(),
      stored.getUTCSeconds(),
      stored.getUTCMilliseconds(),
    ),
  ).toISOString()
}

// ------------------------------------------------------------- usable

/** Moved to lib/milkBottles.ts (0015); re-exported so nothing that imports it here breaks. */
export { EMPTY_ML }

/**
 * Not voided, not released (emptied or discarded, 0015), milk left, and not
 * expired at `atMs` (expiry is exclusive). The stash, the usable list and the
 * suggestion all go through this (V4-36).
 */
export function isUsable(c: MilkContainer, atMs: number): boolean {
  return (
    !c.voided_at && !c.released_at && c.remaining_ml >= EMPTY_ML && Date.parse(c.expires_at) > atMs
  )
}

/** The containers a bottle can come from at `atMs`, oldest first. */
export function usableContainers<T extends MilkContainer>(containers: T[], atMs: number): T[] {
  return containers.filter((c) => isUsable(c, atMs)).sort(byAge)
}

/**
 * The containers that hold a bottle (not voided, not released), oldest first
 * — what Milk lists (0015: an emptied or discarded one is not on the shelf).
 */
export function activeContainers<T extends MilkContainer>(containers: T[]): T[] {
  return containers.filter(isOccupied).sort(byAge)
}

/**
 * @deprecated v4 (X-1): the number is chosen with the bottle selector
 * (`bottleSlots`, lib/milkBottles.ts). Kept until the pages stop using it.
 *
 * The tape for the next container: one more than the highest M label among
 * the LIVE containers it is given (lib/db.ts passes the non-voided ones, and
 * the server only refuses a label a live container has). Gaps below the top
 * are not filled. A voided container's label can come back — if M5 was a
 * session logged by mistake, the next real one is M5 again, which is what
 * the tape on that bottle may already say (docs/spec-feeding-v3.md S-20).
 */
export function nextContainerLabel(labels: (string | null | undefined)[]): string {
  const highest = labels.reduce<number>((max, label) => Math.max(max, labelNumber(label) ?? 0), 0)
  return `M${highest + 1}`
}

/** The tapes that are taken: those of the containers that are not voided. */
function liveLabels(containers: MilkContainer[]): string[] {
  return containers.filter((c) => !c.voided_at).map((c) => c.label)
}

/** @deprecated v4 (X-1). What the tape field starts with: the next number after the live ones. */
export function suggestContainerLabel(containers: MilkContainer[]): string {
  return nextContainerLabel(liveLabels(containers))
}

/**
 * @deprecated v4 (X-1): nobody types a tape any more.
 *
 * A tape someone typed (5 oct 2026: they can skip ahead — "if I wrote M5 and
 * skipped the sequence, log it"). Upper or lower case M, spaces around or
 * after it, leading zeros dropped: `m 5`, `M05` → `M5`. M0, anything else,
 * or more than six digits is a `format` problem; nothing at all is `empty`.
 * Every label it accepts matches the server's `^M[1-9][0-9]*$`.
 */
export type TapeCheck = { ok: true; label: string } | { ok: false; problem: 'empty' | 'format' }

const TAPE_MAX_DIGITS = 6

export function normalizeTapeLabel(text: string): TapeCheck {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, problem: 'empty' }
  const match = /^[Mm]\s*([0-9]+)$/.exec(trimmed)
  const digits = match?.[1].replace(/^0+/, '') ?? ''
  if (!digits || digits.length > TAPE_MAX_DIGITS) return { ok: false, problem: 'format' }
  return { ok: true, label: `M${digits}` }
}

/**
 * @deprecated v4 (X-1): `bottleSlots` says which bottles are taken.
 *
 * A live container (queued ones included) already has this tape. The server
 * refuses it too (`milk_label_taken`); checking here says so before sending,
 * and offline. A voided container's tape is free again (S-20).
 */
export function tapeInUse(label: string, containers: MilkContainer[]): boolean {
  return liveLabels(containers).includes(label)
}

/** Breast milk left in usable containers, in ml. The page shows it in oz. */
export function stashMl(containers: MilkContainer[], atMs: number): number {
  return usableContainers(containers, atMs).reduce((sum, c) => sum + c.remaining_ml, 0)
}

// ------------------------------------------------------------- suggestion

/**
 * How much to suggest for the next bottle: the total of the last bottle
 * logged (legacy or new, queued or not), or the 3 oz starting value when
 * there never was one. A different amount affects only that one bottle —
 * the next suggestion simply follows it.
 */
export function suggestedTotalMl(feedings: (Feeding & { voided_at?: string | null })[]): number {
  let last: Feeding | null = null
  for (const f of feedings) {
    if (f.feeding_type !== 'bottle' || f.voided_at) continue
    if (f.amount_ml == null || !(f.amount_ml > 0)) continue
    if (!last || Date.parse(f.fed_at) > Date.parse(last.fed_at)) last = f
  }
  return last ? Number(last.amount_ml) : DEFAULT_FIRST_SUGGESTION_ML
}

export type PlanPortion = { containerId: string; label: string; ml: number }
export type BottlePlan = { portions: PlanPortion[]; formulaMl: number; totalMl: number }

/**
 * Serve `totalMl` from the oldest usable containers first, as many as it
 * takes; whatever the milk doesn't cover is formula. Only a suggestion —
 * the person can pick any container and any amounts.
 */
export function suggestPlan(
  totalMl: number,
  containers: MilkContainer[],
  atMs: number,
): BottlePlan {
  if (!(totalMl > 0)) return { portions: [], formulaMl: 0, totalMl: 0 }
  const portions: PlanPortion[] = []
  let left = totalMl
  for (const c of usableContainers(containers, atMs)) {
    // Not `left <= 0`: 3 oz − 1 oz − 2 oz leaves ~1e-14 ml of float dust,
    // which would add a phantom "M3 · 0 oz" portion.
    if (left <= EMPTY_ML) break
    const ml = Math.min(c.remaining_ml, left)
    portions.push({ containerId: c.id, label: c.label, ml })
    left -= ml
  }
  // Below a hundredth of a millilitre there is nothing to pour.
  const formulaMl = left > EMPTY_ML ? left : 0
  return { portions, formulaMl, totalMl }
}

/**
 * A typed portion, in ml. When the number typed is exactly what the screen
 * shows the container has left, it means "all of it": the exact millilitres
 * are used, so the rounding of the display (1.75 oz shown for 51.7536 ml)
 * neither leaves 0.004 ml stranded nor asks the server for 0.004 ml more
 * than there is — which it would rightly refuse.
 */
export function portionMl(
  value: number,
  unit: VolumeUnit,
  container: Pick<MilkContainer, 'remaining_ml'> | null,
): number {
  if (container) {
    const rem = container.remaining_ml
    const shown = unit === 'oz' ? Number((rem / ML_PER_FL_OZ).toFixed(2)) : Math.round(rem)
    if (Math.abs(value - shown) < 1e-9) return rem
  }
  return unit === 'oz' ? value * ML_PER_FL_OZ : value
}

// ------------------------------------------------------------- feedings

/**
 * A bottle logged through the inventory: it has a breakdown (breast milk
 * and formula) written by the server. v4 (2A): it is edited whole through
 * `edit_bottle_feed` (`planBottleEdit` says what that does); never with a
 * direct UPDATE. A bottle from before 0014 has neither and stays editable
 * the old way (type, total, time, and now "sobró").
 */
export function isInventoryBottleFeed(f: Feeding): boolean {
  return f.feeding_type === 'bottle' && (f.breast_milk_ml != null || f.formula_ml != null)
}

/**
 * "M3 1.75 oz + M4 0.5 oz + formula 0.75 oz": where a bottle came from, then
 * " · 1 oz left over" when that is known. Null
 * for a feeding with no breakdown — there is nothing to say beyond its total.
 */
export function describeBottle(
  feeding: Feeding,
  drawdowns: MilkDrawdown[],
  lang: Lang = 'en',
): string | null {
  if (!isInventoryBottleFeed(feeding)) return null
  const parts = drawdowns
    .filter((d) => d.feeding_id === feeding.id && !d.voided_at)
    .sort((a, b) => (labelNumber(a.label) ?? 0) - (labelNumber(b.label) ?? 0))
    .map((d) => `${d.label ?? '?'} ${formatMilkOz(d.amount_ml)}`)
  const formula = Number(feeding.formula_ml ?? 0)
  if (formula > 0 || parts.length === 0) {
    parts.push(translate(lang, 'bottle.formulaPart', { amount: formatMilkOz(formula) }))
  }
  const line = parts.join(' + ')
  // "Sobró" (V4-44), when it is known: statistics, it took nothing back.
  if (feeding.leftover_ml == null) return line
  const leftover = formatMilkOz(Number(feeding.leftover_ml))
  return `${line} · ${translate(lang, 'bottle.leftoverPart', { amount: leftover })}`
}

// ------------------------------------------------------------- rules

export type MilkRulesInput = { room: string; fridge: string; freezer: string }
export type MilkRulesProblem = 'empty' | 'number' | 'whole' | 'range'
export type MilkRulesField = keyof MilkRulesInput

/** What each rule may be. Months are whole: "1.5 calendar months" is not a date. */
export const MILK_RULE_LIMITS: Record<MilkRulesField, { max: number; whole: boolean }> = {
  room: { max: 24, whole: false },
  fridge: { max: 30, whole: false },
  freezer: { max: 24, whole: true },
}

/**
 * The three rules, checked together before anything is saved. An empty field
 * is a problem, never a 0 — a fridge rule of 0 days would expire every bottle
 * the moment it was stored.
 */
export function validateMilkRules(input: MilkRulesInput):
  | { rules: MilkRules; problem?: undefined; field?: undefined }
  | {
      rules?: undefined
      problem: MilkRulesProblem
      field: MilkRulesField
    } {
  const values = {} as Record<MilkRulesField, number>
  for (const field of ['room', 'fridge', 'freezer'] as MilkRulesField[]) {
    const raw = input[field].trim()
    if (raw === '') return { problem: 'empty', field }
    const n = Number(raw)
    if (!Number.isFinite(n)) return { problem: 'number', field }
    const limit = MILK_RULE_LIMITS[field]
    if (limit.whole && n > 0 && !Number.isInteger(n)) return { problem: 'whole', field }
    if (!(n > 0) || n > limit.max) return { problem: 'range', field }
    values[field] = n
  }
  return {
    rules: {
      milk_room_hours: values.room,
      milk_fridge_days: values.fridge,
      milk_freezer_months: values.freezer,
    },
  }
}

// ------------------------------------------------------------- offline

/** The arguments of log_pumping_session (0014), as lib/db.ts queues them. */
export type PumpingArgs = {
  p_id: string
  p_baby_id: string
  p_side: string
  p_left_ml: number | null
  p_right_ml: number | null
  p_notes: string | null
  p_pumped_at: string
  p_container_id: string | null
  p_container_label: string | null
  p_container_expires_at: string | null
}

/** The arguments of log_bottle_feed (0014; 0015 adds `p_leftover_ml`), as lib/db.ts queues them. */
export type BottleFeedArgs = {
  p_id: string
  p_baby_id: string
  p_fed_at: string
  p_notes: string | null
  p_formula_ml: number
  p_portions: { container_id: string; amount_ml: number }[]
  /** "Sobró" (0015, D-10). Statistics only; null or left out = not known. */
  p_leftover_ml?: number | null
}

/** The arguments of discard_container (0015, §3.5). `p_id` is the discard's own id. */
export type DiscardArgs = {
  p_id: string
  p_container_id: string
  p_discarded_at: string | null
}

/**
 * The arguments of edit_bottle_feed (0015, §3.8): the FINAL state asked for,
 * plus what the screen saw when it opened the panel (`p_expected`, regla 21).
 * `p_op_id` is this edit's own id (the idempotency of a replay, AJ-3).
 */
export type EditBottleArgs = {
  p_op_id: string
  p_feeding_id: string
  p_fed_at: string
  p_breast_ml: number
  p_formula_ml: number
  p_leftover_ml: number | null
  p_notes: string | null
  p_expected: {
    fed_at: string
    breast_milk_ml: number | null
    formula_ml: number | null
    leftover_ml: number | null
  }
}

type Pending<T> = WithPending<T>

/** What the offline view of the inventory comes to (§7.3). */
export type PendingInventory = {
  containers: Pending<MilkContainer>[]
  drawdowns: Pending<MilkDrawdown>[]
  discards: Pending<MilkDiscard>[]
  /**
   * Milk that, by what this phone knows, did not go back to its container
   * (D-9) — the screen says it "según lo que sabe este teléfono".
   */
  lost: { writeId: string; containerId: string; label: string; ml: number; reason: LostReason }[]
  /**
   * Queued writes this phone could not show, because by what it knows the
   * server will refuse them (an edit with not enough milk, a discard before
   * expiry…). Nothing of them is applied; the server decides on sync.
   */
  unapplied: { writeId: string; fn: string; problem: string }[]
}

/**
 * Fold what is still queued on this device into the last containers,
 * portions and discards the server returned, so the stash, the selector and
 * the suggestion already count a bottle given — a session pumped, a container
 * discarded, a bottle edited — with no connection. Every row the queue
 * touched is marked `pending` ("not synced yet").
 *
 * The queue is applied in order, oldest first, the way it will replay, and
 * every change in a container goes through `rebalance` — the same rule as
 * `milk_rebalance` on the server (docs/arquitectura-v4.md §7.3). A write the
 * server already has is not applied twice: a bottle whose portions the
 * server returned, a container or a discard it already lists, a container
 * already discarded, a bottle already in the edited state. Edits and voids
 * set values rather than add them, so applying one again changes nothing.
 * A write this phone expects the server to refuse is not applied at all and
 * is listed in `unapplied`.
 *
 * The three-argument form (no discards) is the one of v3 and still works.
 * Inputs are not changed: they are what the next refresh starts from.
 */
export function applyPendingInventory(
  containers: MilkContainer[],
  drawdowns: MilkDrawdown[],
  pending: PendingWrite[],
): PendingInventory
export function applyPendingInventory(
  containers: MilkContainer[],
  drawdowns: MilkDrawdown[],
  discards: MilkDiscard[],
  pending: PendingWrite[],
): PendingInventory
export function applyPendingInventory(
  containers: MilkContainer[],
  drawdowns: MilkDrawdown[],
  discardsOrPending: MilkDiscard[] | PendingWrite[],
  maybePending?: PendingWrite[],
): PendingInventory {
  const pending = (maybePending ?? discardsOrPending) as PendingWrite[]
  const discards = (maybePending ? discardsOrPending : []) as MilkDiscard[]
  let cs: Pending<MilkContainer>[] = containers.map((c) => ({ ...c }))
  let ds: Pending<MilkDrawdown>[] = drawdowns.map((d) => ({ ...d }))
  let dc: Pending<MilkDiscard>[] = discards.map((d) => ({ ...d }))
  const lost: PendingInventory['lost'] = []
  const unapplied: PendingInventory['unapplied'] = []
  const byId = (id: string | null | undefined) => cs.find((c) => c.id === id)

  /** Run the server's rule on one container and keep what it says, marked pending. */
  const settle = (
    c: Pending<MilkContainer>,
    cause: RebalanceCause,
    residueMl: number,
    atIso: string,
    writeId: string,
  ) => {
    const r = rebalance(c, cause, residueMl, cs, dc, atIso)
    cs = cs.map((x) => (x.id === c.id ? { ...r.container, pending: true } : x))
    dc = r.discards.map((d, i) =>
      d.amount_ml !== dc[i].amount_ml || d.voided_at !== dc[i].voided_at
        ? { ...d, pending: true }
        : d,
    )
    if (r.lostMl > 0) {
      lost.push({ writeId, containerId: c.id, label: c.label, ml: r.lostMl, reason: r.lostReason! })
    }
  }
  const voidDiscardsOf = (containerId: string, at: string) => {
    dc = dc.map((d) =>
      d.container_id === containerId && !d.voided_at ? { ...d, voided_at: at, pending: true } : d,
    )
  }

  const ordered = pending.slice().sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
  for (const write of ordered) {
    const op = write.op
    if (op.kind !== 'rpc') continue
    const at = write.queuedAt

    if (op.fn === 'log_pumping_session' || op.fn === 'update_pumping_session') {
      const a = op.args as Partial<PumpingArgs> & { p_id: string }
      const total = Number(a.p_left_ml ?? 0) + Number(a.p_right_ml ?? 0)
      const current = cs.find((c) => c.source_session_id === a.p_id && !c.voided_at)
      if (current && op.fn === 'update_pumping_session') {
        const served = Math.max(0, current.amount_ml - residueParts(current, dc))
        if (total > 0 && total < served - SERVED_EPSILON_ML) {
          unapplied.push({ writeId: write.id, fn: op.fn, problem: 'milk_served_exceeds_amount' })
          current.pending = true
        } else if (total > 0) {
          const moved: Pending<MilkContainer> = {
            ...current,
            amount_ml: total,
            stored_at: a.p_pumped_at ?? current.stored_at,
            expires_at: a.p_container_expires_at ?? current.expires_at,
          }
          cs = cs.map((x) => (x.id === current.id ? moved : x))
          settle(moved, 'amount', Math.max(0, total - served), at, write.id)
        } else if (served > SERVED_EPSILON_ML) {
          unapplied.push({ writeId: write.id, fn: op.fn, problem: 'milk_already_served' })
          current.pending = true
        } else {
          current.voided_at = at
          current.pending = true
          voidDiscardsOf(current.id, at)
        }
      } else if (current) {
        current.pending = true
      } else if (total > 0 && a.p_container_id && a.p_container_label) {
        const known = byId(a.p_container_id)
        if (known) known.pending = true
        else {
          cs.push({
            id: a.p_container_id,
            source_session_id: a.p_id,
            label: a.p_container_label,
            amount_ml: total,
            remaining_ml: total,
            stored_at: a.p_pumped_at ?? at,
            location: 'fridge',
            expires_at: a.p_container_expires_at ?? at,
            voided_at: null,
            released_at: null,
            lost_ml: 0,
            pending: true,
          })
        }
      }
      continue
    }

    if (op.fn === 'void_pumping_session') {
      const a = op.args as { p_id: string; p_voided_at?: string }
      for (const c of cs) {
        if (c.source_session_id === a.p_id && !c.voided_at) {
          c.voided_at = a.p_voided_at ?? at
          c.pending = true
          voidDiscardsOf(c.id, c.voided_at)
        }
      }
      continue
    }

    if (op.fn === 'discard_container') {
      const a = op.args as unknown as DiscardArgs
      const listed = dc.find((d) => d.id === a.p_id)
      if (listed) {
        listed.pending = true
        continue
      }
      const c = byId(a.p_container_id)
      // Already discarded (by the other phone), emptied, voided or unknown:
      // the server makes it a no-op too (V4-34, AJ-15).
      if (!c || c.voided_at || c.released_at || hasLiveDiscard(c, dc)) continue
      const when = a.p_discarded_at ?? at
      if (Date.parse(c.expires_at) > Date.parse(when)) {
        // For this phone it has not expired: the server decides (D-6).
        unapplied.push({ writeId: write.id, fn: op.fn, problem: 'milk_not_expired' })
        continue
      }
      if (c.remaining_ml >= EMPTY_ML) {
        dc.push({
          id: a.p_id,
          container_id: c.id,
          amount_ml: c.remaining_ml,
          discarded_at: when,
          reason: 'expired',
          label: c.label,
          voided_at: null,
          pending: true,
        })
      }
      c.remaining_ml = 0
      c.released_at = at
      c.pending = true
      continue
    }

    if (op.fn === 'log_bottle_feed') {
      const a = op.args as unknown as BottleFeedArgs
      const already = ds.filter((d) => d.feeding_id === a.p_id && !d.voided_at)
      if (already.length > 0) {
        for (const d of already) d.pending = true
        continue
      }
      for (const portion of a.p_portions ?? []) {
        const c = byId(portion.container_id)
        if (c) {
          // Never more than it has: a stale list overdraws, and the server
          // will say so (milk_overdraw); the screen just shows it empty.
          const take = Math.min(portion.amount_ml, c.remaining_ml)
          settle(c, 'serve', residueParts(c, dc) - take, at, write.id)
        }
        ds.push({
          id: `${a.p_id}:${portion.container_id}`,
          feeding_id: a.p_id,
          container_id: portion.container_id,
          amount_ml: portion.amount_ml,
          label: c?.label ?? null,
          voided_at: null,
          pending: true,
        })
      }
      continue
    }

    if (op.fn === 'void_bottle_feed') {
      const a = op.args as { p_feeding_id: string; p_voided_at?: string }
      for (const d of ds) {
        if (d.feeding_id !== a.p_feeding_id || d.voided_at) continue
        const c = byId(d.container_id)
        if (c) {
          // Never more than the container ever had (a stale list).
          const residue = Math.min(c.amount_ml, residueParts(c, dc) + d.amount_ml)
          settle(c, 'return', residue, at, write.id)
        } else {
          lost.push({
            writeId: write.id,
            containerId: d.container_id,
            label: d.label ?? '?',
            ml: d.amount_ml,
            reason: 'unknown',
          })
        }
        d.voided_at = a.p_voided_at ?? at
        d.pending = true
      }
      continue
    }

    if (op.fn === 'edit_bottle_feed') {
      const a = op.args as unknown as EditBottleArgs
      const mine = ds.filter((d) => d.feeding_id === a.p_feeding_id && !d.voided_at)
      // What the bottle has now, as far as this phone knows (INV-6: the
      // breakdown IS its portions). Already in the asked state → Δ = 0.
      const plan = planBottleEdit(
        {
          id: a.p_feeding_id,
          fed_at: a.p_fed_at,
          feeding_type: 'bottle',
          breast_milk_ml: mine.reduce((s, d) => s + d.amount_ml, 0),
          formula_ml: a.p_formula_ml,
          leftover_ml: a.p_leftover_ml,
        },
        ds,
        cs,
        dc,
        {
          fed_at: a.p_fed_at,
          breast_milk_ml: a.p_breast_ml,
          formula_ml: a.p_formula_ml,
          leftover_ml: a.p_leftover_ml,
        },
        Date.parse(at),
      )
      if (!plan.ok) {
        unapplied.push({ writeId: write.id, fn: op.fn, problem: plan.problem })
        for (const d of mine) d.pending = true
        continue
      }
      const touched = new Set(
        [...plan.returned, ...plan.lost, ...plan.taken].map((m) => m.containerId),
      )
      cs = plan.containers.map((c) =>
        touched.has(c.id) ? { ...c, pending: true } : (c as Pending<MilkContainer>),
      )
      ds = plan.drawdowns.map((d) =>
        d.feeding_id === a.p_feeding_id ? { ...d, pending: true } : (d as Pending<MilkDrawdown>),
      )
      dc = plan.discards as Pending<MilkDiscard>[]
      for (const l of plan.lost) lost.push({ writeId: write.id, ...l })
    }
  }

  return { containers: cs, drawdowns: ds, discards: dc, lost, unapplied }
}

// ------------------------------------------------------------- typing

/**
 * One amount field, as typed: empty is "nothing" (null), never 0; anything
 * that isn't a finite number of zero or more is a problem the page shows.
 */
export function parseAmountMl(
  raw: string,
  unit: VolumeUnit,
): { ml: number | null; problem?: undefined } | { ml?: undefined; problem: 'number' } {
  const text = raw.trim().replace(',', '.')
  if (text === '') return { ml: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return { problem: 'number' }
  return { ml: unit === 'oz' ? n * ML_PER_FL_OZ : n }
}

/**
 * An amount as a field shows it, in `unit`: up to two decimals in oz, whole
 * ml; nothing for zero or less. The rule the bottle builder always used.
 */
export function amountText(ml: number, unit: VolumeUnit): string {
  if (!(ml > 0)) return ''
  return unit === 'oz' ? String(Number((ml / ML_PER_FL_OZ).toFixed(2))) : String(Math.round(ml))
}

/**
 * What a typed amount says after its oz/ml toggle is switched (D-19, AJ-16):
 * converted, so the number keeps meaning the same milk — never re-read in the
 * other unit. Extracted from the bottle builder so the left and right fields
 * of Milk and the "Sobró" field do exactly the same. Empty stays empty;
 * something that isn't a number is left as typed (the field shows the
 * problem).
 *
 * Back and forth never drifts: oz is shown with two decimals and ml whole —
 * unless the whole ml would come back as another ounce figure (3 oz → 89 ml →
 * 3.01 oz), and then the ml get one decimal (88.7 ml → 3 oz). So any 0.01 oz
 * and any whole ml survive a round trip exactly (tests/unit/milkPending.test.ts).
 */
export function convertAmountText(text: string, from: VolumeUnit, to: VolumeUnit): string {
  if (from === to) return text
  const parsed = parseAmountMl(text, from)
  if (parsed.ml == null) return text
  const out = amountText(parsed.ml, to)
  if (to === 'ml' && out !== '' && amountText(Number(out), 'oz') !== amountText(parsed.ml, 'oz')) {
    return String(Number(parsed.ml.toFixed(1)))
  }
  return out
}

/**
 * A pumping total above 0 but under EMPTY_ML (0.15 ml): dust, not milk (M-1).
 * As a bottle it would be an occupied container with less than EMPTY_ML —
 * the server refuses it (`milk_bad_input`, 0015), so the screen does first.
 */
export function isDustMl(totalMl: number): boolean {
  return totalMl > 0 && totalMl < EMPTY_ML
}

/**
 * The left and right fields of a pumping session, each in its own unit
 * (V4-01): empty is "nothing" (null, never 0), the total is their sum, and a
 * bottle has to be chosen only when that total is above 0 (V4-04, CL-2). A
 * total that is only dust is a `tiny` problem (M-1), never a bottle.
 */
export function readPumpingSides(
  left: { text: string; unit: VolumeUnit },
  right: { text: string; unit: VolumeUnit },
):
  | {
      leftMl: number | null
      rightMl: number | null
      totalMl: number
      needsBottle: boolean
      problem?: undefined
    }
  | { problem: 'number'; field: 'left' | 'right' }
  | { problem: 'tiny' } {
  const l = parseAmountMl(left.text, left.unit)
  if (l.problem) return { problem: 'number', field: 'left' }
  const r = parseAmountMl(right.text, right.unit)
  if (r.problem) return { problem: 'number', field: 'right' }
  const totalMl = (l.ml ?? 0) + (r.ml ?? 0)
  if (isDustMl(totalMl)) return { problem: 'tiny' }
  return { leftMl: l.ml, rightMl: r.ml, totalMl, needsBottle: totalMl > 0 }
}

/**
 * An amount for an edit field: ounces with up to two decimals, as the page
 * shows them. `keepMl` returns the exact stored ml when the field was left as
 * it was prefilled — re-deriving it from the rounded text would move a
 * stored 150 ml to 150.8 ml on a save that changed nothing.
 */
export function ozText(ml: number | null | undefined): string {
  return ml == null ? '' : String(Number((ml / ML_PER_FL_OZ).toFixed(2)))
}

export function keepMl(
  text: string,
  prefilled: string,
  storedMl: number | null | undefined,
): ReturnType<typeof parseAmountMl> {
  if (text.trim() === prefilled.trim()) return { ml: storedMl ?? null }
  return parseAmountMl(text, 'oz')
}

// ------------------------------------------------------------- pumping edits

/** Below this, what was served from a container is rounding, not milk. */
export const SERVED_EPSILON_ML = 0.01

/** Logged before left and right existed (0014): a total, no sides. */
export function isLegacyPumping(row: PumpingSession): boolean {
  return row.left_ml == null && row.right_ml == null && row.amount_ml != null
}

/**
 * @deprecated v4: counts a discard as served. Use `containerBalance`
 * (lib/milkBottles.ts). Kept until the pages stop using it.
 *
 * How much of a container already went into bottles (0 for none).
 */
export function servedMl(c: MilkContainer | undefined): number {
  return c ? Math.max(0, c.amount_ml - c.remaining_ml) : 0
}

// ------------------------------------------------------------- tapes offline

/**
 * The tapes that are taken, or null when this device can't know them.
 *
 * QA, 6 oct 2026: opened offline with no read and no saved copy of /pumping,
 * the list was empty and the field offered M1 while M1…M10 were on the shelf;
 * the queued session was then refused on sync (`milk_label_taken:M1`). An
 * empty list and an unknown one are not the same thing, and only the first
 * one can suggest anything.
 *
 *   · `live`: what the page shows (queued containers folded in) — always
 *     counted, it is real even when the server list is unknown;
 *   · `readKnown`: a container read worked, or the page has its own saved
 *     copy — then `live` IS the list and `saved` is ignored;
 *   · `saved`: another page's saved copy (Today, Feeding, History read the
 *     same full list): good enough to suggest from when this page has
 *     nothing, and as stale as any saved copy — the server still has the
 *     last word;
 *   · `justSaved`: a tape taken a moment ago, before the next read.
 */
export function takenTapes(opts: {
  live: MilkContainer[]
  readKnown: boolean
  saved: MilkContainer[] | null
  justSaved: string | null
}): string[] | null {
  const { live, readKnown, saved, justSaved } = opts
  if (!readKnown && !saved) return null
  const from = readKnown ? live : [...(saved ?? []), ...live]
  const taken = liveLabels(from)
  return justSaved ? [...taken, justSaved] : taken
}

/** What the tape field offers: the next number, or nothing when the list is unknown. */
export function suggestTape(taken: string[] | null): string | null {
  return taken ? nextContainerLabel(taken) : null
}

/**
 * The newest of the saved copies (lib/lastSeen.ts) that really carries a
 * container list. A copy saved by an older build, or by a page that never
 * reads containers, has no `containers` array and says nothing.
 */
export function newestSavedContainers(
  copies: ({ savedAt: string; rows: Record<string, unknown> } | null)[],
): { savedAt: string; containers: MilkContainer[] } | null {
  let best: { savedAt: string; containers: MilkContainer[] } | null = null
  for (const copy of copies) {
    if (!copy || !Array.isArray(copy.rows?.containers)) continue
    if (best && Date.parse(copy.savedAt) <= Date.parse(best.savedAt)) continue
    best = { savedAt: copy.savedAt, containers: copy.rows.containers as MilkContainer[] }
  }
  return best
}

// ------------------------------------------------------------- stale inventory

/**
 * A bottle refused because the containers on screen were out of date (the
 * other phone served from one, it ran out or expired): the page has to read
 * what there is again, or it keeps offering the same impossible bottle
 * (QA, 6 oct 2026: "M16 · 1 oz left" while 0.25 was left, until a reload).
 */
export function rereadsInventory(error: string | null): boolean {
  if (!error) return false
  return /^milk_(overdraw|container_unusable)(:|$)/.test(error.trim())
}

// ------------------------------------------------------------- deleting a session

/**
 * The confirmation for deleting a pumping session. Only a session with a
 * container takes milk out of what there is; a legacy one (a total from
 * before 0014) or one with no amount never had a container.
 */
export function pumpingRemoveConfirmKey(
  row: PumpingSession,
  container: MilkContainer | undefined,
): 'milk.removeConfirm' | 'milk.removeConfirmLegacy' | 'milk.removeConfirmNoMilk' {
  if (container && !container.voided_at) return 'milk.removeConfirm'
  return isLegacyPumping(row) ? 'milk.removeConfirmLegacy' : 'milk.removeConfirmNoMilk'
}
