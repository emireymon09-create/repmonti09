/**
 * The milk inventory, as pure functions (0013, 4 oct 2026).
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
 */

import { ML_PER_FL_OZ, formatMilkOz } from '@/lib/format'
import { translate, type Lang } from '@/lib/i18n'
import type { PendingWrite } from '@/lib/queue'
import type {
  Feeding,
  MilkContainer,
  MilkDrawdown,
  MilkLocation,
  MilkRules,
  VolumeUnit,
  WithPending,
} from '@/lib/types'

/**
 * What the bottle suggestion starts at when no bottle was ever logged. NOT a
 * standard: the moment there is one bottle, the suggestion is that bottle's
 * total, and nothing else in the app reads this number.
 */
export const DEFAULT_FIRST_SUGGESTION_ML = 3 * ML_PER_FL_OZ

/** The pediatrician's numbers; the same defaults as the columns in 0013. */
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

/**
 * Below this a container is empty: what float arithmetic leaves behind after
 * a portion is taken offline, and anything the screen would show as "0 oz"
 * (two decimals of an ounce are ~0.3 ml; half of that rounds to 0). It must
 * not be offered, counted, or end up as a portion.
 */
export const EMPTY_ML = 0.15

/** Not voided, milk left, and not expired at `atMs` (expiry is exclusive). */
export function isUsable(c: MilkContainer, atMs: number): boolean {
  return !c.voided_at && c.remaining_ml >= EMPTY_ML && Date.parse(c.expires_at) > atMs
}

function labelNumber(label: string | null | undefined): number | null {
  const match = /^M([1-9][0-9]*)$/.exec(label ?? '')
  return match ? Number(match[1]) : null
}

/** Oldest first — stored earlier, then the lower M number. */
function byAge(a: MilkContainer, b: MilkContainer): number {
  return (
    Date.parse(a.stored_at) - Date.parse(b.stored_at) ||
    (labelNumber(a.label) ?? 0) - (labelNumber(b.label) ?? 0)
  )
}

/** The containers a bottle can come from at `atMs`, oldest first. */
export function usableContainers<T extends MilkContainer>(containers: T[], atMs: number): T[] {
  return containers.filter((c) => isUsable(c, atMs)).sort(byAge)
}

/** Everything still on the list (not voided), oldest first — Milk shows these. */
export function activeContainers<T extends MilkContainer>(containers: T[]): T[] {
  return containers.filter((c) => !c.voided_at).sort(byAge)
}

/**
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
    if (left <= 0) break
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
 * and formula) written by the server. Only its time can be edited; to change
 * what was in it, it is deleted — which gives the milk back — and logged
 * again. A bottle from before 0013 has neither and stays fully editable.
 */
export function isInventoryBottleFeed(f: Feeding): boolean {
  return f.feeding_type === 'bottle' && (f.breast_milk_ml != null || f.formula_ml != null)
}

/**
 * "M3 1.75 oz + M4 0.5 oz + formula 0.75 oz": where a bottle came from. Null
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
  return parts.join(' + ')
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

/** The arguments of log_pumping_session (0013), as lib/db.ts queues them. */
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

/** The arguments of log_bottle_feed (0013), as lib/db.ts queues them. */
export type BottleFeedArgs = {
  p_id: string
  p_baby_id: string
  p_fed_at: string
  p_notes: string | null
  p_formula_ml: number
  p_portions: { container_id: string; amount_ml: number }[]
}

type Pending<T> = WithPending<T>

/**
 * Fold what is still queued on this device into the last containers and
 * portions the server returned, so the stash and the suggestion already
 * count a bottle given — or a session pumped — with no connection. Every
 * container or portion the queue touched is marked `pending` ("not synced
 * yet").
 *
 * The queue is applied in order, oldest first, the way it will replay.
 * A write the server already has is not applied twice: a bottle whose
 * portions the server returned, or a container it already lists. Edits and
 * voids set values rather than add them, so applying one again changes
 * nothing.
 *
 * Inputs are not changed: they are what the next refresh starts from.
 */
export function applyPendingInventory(
  containers: MilkContainer[],
  drawdowns: MilkDrawdown[],
  pending: PendingWrite[],
): { containers: Pending<MilkContainer>[]; drawdowns: Pending<MilkDrawdown>[] } {
  const cs: Pending<MilkContainer>[] = containers.map((c) => ({ ...c }))
  const ds: Pending<MilkDrawdown>[] = drawdowns.map((d) => ({ ...d }))
  const byId = (id: string | null | undefined) => cs.find((c) => c.id === id)

  const ordered = pending.slice().sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
  for (const write of ordered) {
    const op = write.op
    if (op.kind !== 'rpc') continue

    if (op.fn === 'log_pumping_session' || op.fn === 'update_pumping_session') {
      const a = op.args as Partial<PumpingArgs> & { p_id: string }
      const total = Number(a.p_left_ml ?? 0) + Number(a.p_right_ml ?? 0)
      const current = cs.find((c) => c.source_session_id === a.p_id && !c.voided_at)
      if (current && op.fn === 'update_pumping_session') {
        if (total > 0) {
          const served = current.amount_ml - current.remaining_ml
          current.amount_ml = total
          current.remaining_ml = Math.max(0, total - served)
          if (a.p_pumped_at) current.stored_at = a.p_pumped_at
          if (a.p_container_expires_at) current.expires_at = a.p_container_expires_at
        } else {
          current.voided_at = write.queuedAt
        }
        current.pending = true
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
            stored_at: a.p_pumped_at ?? write.queuedAt,
            location: 'fridge',
            expires_at: a.p_container_expires_at ?? write.queuedAt,
            voided_at: null,
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
          c.voided_at = a.p_voided_at ?? write.queuedAt
          c.pending = true
        }
      }
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
          c.remaining_ml = Math.max(0, c.remaining_ml - portion.amount_ml)
          c.pending = true
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
          c.remaining_ml = Math.min(c.amount_ml, c.remaining_ml + d.amount_ml)
          c.pending = true
        }
        d.voided_at = a.p_voided_at ?? write.queuedAt
        d.pending = true
      }
    }
  }

  return { containers: cs, drawdowns: ds }
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
