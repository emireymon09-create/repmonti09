/**
 * Similac stock (0016, V5-01…V5-07), as a pure function.
 *
 * The bottles are rows (`formula_containers`); what was used of the open one is
 * NOT written anywhere (D5-13): it is the `formula_ml` of the live bottle
 * feedings whose time falls inside that bottle's open window
 * `[opened_at, finished_at)` — or `[opened_at, ∞)` while it is still open. So
 * editing the formula of a past bottle moves the count by itself (regla 17),
 * and offline it is free: a queued bottle is a row like any other.
 *
 * Formula never blocks a feeding (regla 14, V5-06): with no bottle open, with
 * the open one expired, or with more used than it held, the feeding is saved
 * all the same. Here that shows as `unassignedMl` (formula given with no bottle
 * open) and `overdrawn` (the open one gave more than it had: shown as 0, with
 * a warning, never negative — D5-16).
 */

import { EMPTY_ML } from '@/lib/milkBottles'
import {
  FORMULA_LOW_WARN_ML,
  FORMULA_OPEN_MAX_MS,
  FORMULA_OPEN_WARN_MS,
  FORMULA_PER_DAY_WINDOW_H,
  FORMULA_PER_DAY_WINDOW_MS,
} from '@/lib/milkParams'
import type { Feeding, FormulaContainer, WithPending } from '@/lib/types'

/** Two amounts closer than this are the same amount. */
const DUST_ML = 1e-9

export type FormulaOpenState = 'ok' | 'expiring' | 'expired'

export type OpenFormula = {
  container: WithPending<FormulaContainer>
  openedAtMs: number
  /** `opened_at + 48 h`: at that exact instant it has expired. */
  expiresAtMs: number
  state: FormulaOpenState
  /** Formula of the bottles given from it, in ml. */
  usedMl: number
  /** What is left in it, never below 0. */
  remainingMl: number
  /** It gave more than it held (`size − used < 0`): shown as 0 plus a warning. */
  overdrawn: boolean
}

export type FormulaStock = {
  /** Closed bottles, oldest added first (what "Abrí una Similac" opens). */
  closed: WithPending<FormulaContainer>[]
  closedMl: number
  /** The open one, or null. */
  open: OpenFormula | null
  /** Closed + what is left in the open one. Never negative. */
  remainingMl: number
  /** The open one is overdrawn (more formula given than it held). */
  overdrawn: boolean
  /** Formula given in the last 72 h, divided by 3 — ml per day. */
  perDayMl: number
  /** How many days `remainingMl` lasts at `perDayMl`; null with no consumption. */
  daysLeft: number | null
  /** `remainingMl ≤ FORMULA_LOW_WARN_OZ` (8 oz). */
  low: boolean
  /** Formula of bottles given while no bottle was open: reported, never subtracted. */
  unassignedMl: number
}

type FormulaFeeding = Pick<Feeding, 'id' | 'fed_at' | 'feeding_type' | 'formula_ml'> & {
  voided_at?: string | null
}

/** The state of an open bottle at `nowMs`: expired at 48 h exactly, expiring from 6 h before. */
export function formulaOpenState(openedAtMs: number, nowMs: number): FormulaOpenState {
  const expiresAtMs = openedAtMs + FORMULA_OPEN_MAX_MS
  if (nowMs >= expiresAtMs) return 'expired'
  if (nowMs >= expiresAtMs - FORMULA_OPEN_WARN_MS) return 'expiring'
  return 'ok'
}

const byAdded = (a: FormulaContainer, b: FormulaContainer) =>
  Date.parse(a.added_at) - Date.parse(b.added_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function formulaStock(input: {
  /** The baby's formula bottles (voided ones are ignored). */
  containers: readonly WithPending<FormulaContainer>[]
  /** The baby's feedings (only live bottles with formula count). */
  feedings: readonly FormulaFeeding[]
  nowMs: number
}): FormulaStock {
  const live = input.containers.filter((c) => !c.voided_at)
  const closed = live.filter((c) => !c.opened_at).sort(byAdded)
  const closedMl = closed.reduce((s, c) => s + Number(c.size_ml), 0)

  // Every bottle that was ever opened has a window. If two overlap (only the
  // queue can do that, two phones offline), a feeding goes to the one opened
  // last before it.
  const windows = live
    .filter((c) => c.opened_at)
    .map((c) => ({
      c,
      from: Date.parse(c.opened_at!),
      to: c.finished_at ? Date.parse(c.finished_at) : Infinity,
      used: 0,
    }))
    .sort((a, b) => b.from - a.from || (a.c.id < b.c.id ? 1 : -1))

  const given = input.feedings.filter(
    (f) => !f.voided_at && f.feeding_type === 'bottle' && Number(f.formula_ml ?? 0) > 0,
  )
  let unassignedMl = 0
  for (const f of given) {
    const at = Date.parse(f.fed_at)
    const w = windows.find((x) => x.from <= at && at < x.to)
    if (w) w.used += Number(f.formula_ml)
    else unassignedMl += Number(f.formula_ml)
  }

  // The open one: opened, not finished. More than one only from the queue —
  // the last opened is the one in use (the server would mark the other replaced).
  const openWindow = windows.find((w) => !w.c.finished_at) ?? null
  let open: OpenFormula | null = null
  if (openWindow) {
    const left = Number(openWindow.c.size_ml) - openWindow.used
    open = {
      container: openWindow.c,
      openedAtMs: openWindow.from,
      expiresAtMs: openWindow.from + FORMULA_OPEN_MAX_MS,
      state: formulaOpenState(openWindow.from, input.nowMs),
      usedMl: openWindow.used,
      remainingMl: Math.max(0, left),
      overdrawn: left < -DUST_ML,
    }
  }

  const remainingMl = closedMl + (open?.remainingMl ?? 0)
  const since = input.nowMs - FORMULA_PER_DAY_WINDOW_MS
  const lastWindowMl = given
    .filter((f) => {
      const at = Date.parse(f.fed_at)
      return at > since && at <= input.nowMs
    })
    .reduce((s, f) => s + Number(f.formula_ml), 0)
  const perDayMl = lastWindowMl / (FORMULA_PER_DAY_WINDOW_H / 24)

  return {
    closed,
    closedMl,
    open,
    remainingMl,
    overdrawn: !!open?.overdrawn,
    perDayMl,
    daysLeft: perDayMl > EMPTY_ML ? remainingMl / perDayMl : null,
    low: remainingMl <= FORMULA_LOW_WARN_ML + DUST_ML,
    unassignedMl,
  }
}

/**
 * From when the screens have to read the bottle feedings for `formulaStock`
 * (lib/db.ts bottleFeedingsSince): the last 72 h (consumption per day), and
 * further back if a bottle still open was opened before that — every feeding
 * of its window counts against it. ISO.
 */
export function formulaReadSince(
  containers: readonly Pick<FormulaContainer, 'opened_at' | 'finished_at' | 'voided_at'>[],
  nowMs: number,
): string {
  let since = nowMs - FORMULA_PER_DAY_WINDOW_MS
  for (const c of containers) {
    if (c.voided_at || !c.opened_at || c.finished_at) continue
    const opened = Date.parse(c.opened_at)
    if (Number.isFinite(opened) && opened < since) since = opened
  }
  return new Date(since).toISOString()
}
