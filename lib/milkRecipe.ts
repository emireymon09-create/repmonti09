/**
 * The recipe of the next bottle (0016, V5-40…V5-44): "2.5 oz leche + 1 oz
 * Similac". Replaces v3's suggestion (`suggestedTotalMl` + `suggestPlan` in
 * lib/milk.ts, "the last bottle's total"), which stays until the pages move.
 *
 * Pure: `nowMs` comes in, and so does the end of the last feeding (the page
 * takes it from `lastFeedingEvent`, lib/kpis.ts — the END, as "hace X" uses
 * since v0.10.1).
 *
 *   · total: `RECIPE_TARGET_OZ` (3.5 oz). "Si llora" (off by default): less
 *     than 120 min since the END of the last feeding → only
 *     `RECIPE_CRY_EXTRA_OZ` (1 oz); 120 min or more, or no feeding yet → the
 *     full one;
 *   · milk: only usable AND cold containers, oldest first (`byAge`), up to
 *     the total minus the fixed formula; what is cooling is reported, never
 *     proposed (D5-6);
 *   · formula: the fixed amount, plus whatever the milk does not cover. It
 *     comes from the open Similac; with none open, an expired one, one about
 *     to expire, or little left, the recipe says so — it never blocks (V5-44).
 *
 * It only pre-fills the bottle builder: everything stays editable.
 */

import { formatMilkOz } from '@/lib/format'
import { translate, type Lang } from '@/lib/i18n'
import { isUsable, type BottlePlan, type PlanPortion } from '@/lib/milk'
import { EMPTY_ML, byAge } from '@/lib/milkBottles'
import { coldReadyAt, isCold } from '@/lib/milkCooling'
import { RECIPE_CRY_EXTRA_ML, RECIPE_CRY_WINDOW_MS, RECIPE_TARGET_ML } from '@/lib/milkParams'
import type { FormulaStock } from '@/lib/formulaStock'
import type { MilkContainer } from '@/lib/types'

export type RecipeReason = 'full' | 'cry_top_up'
export type FormulaWarning = null | 'none_open' | 'expired' | 'expiring' | 'low'

export type Recipe = BottlePlan & {
  reason: RecipeReason
  /** Usable milk that is still cooling: not in the recipe. */
  coolingMl: number
  /** When the first of it is cold (ms), or null with none cooling. */
  coolingReadyAtMs: number | null
  /** Usable cold milk, all of it (what `feedsCovered` divides). */
  coldMl: number
  formulaWarning: FormulaWarning
  /** How many full feeds like this one the cold milk covers. */
  feedsCovered: number
}

/** Float dust: closer than this is the same amount. */
const DUST_ML = 1e-9

/** The containers the recipe takes from at `nowMs`: usable and cold, oldest first. */
export function recipeContainers<T extends MilkContainer>(
  containers: readonly T[],
  nowMs: number,
): T[] {
  return containers.filter((c) => isUsable(c, nowMs) && isCold(c, nowMs)).sort(byAge)
}

/**
 * The milk split across feeds of `milkPerFeedMl`: as many full ones as it
 * covers, then what is left (if it is milk at all). `fullFeeds` is "la leche
 * alcanza para N tomas así". With nothing per feed, there is nothing to split.
 */
export function splitAcrossFeeds(
  milkMl: number,
  milkPerFeedMl: number,
): { fullFeeds: number; feeds: number[]; restMl: number } {
  if (!(milkMl > EMPTY_ML) || !(milkPerFeedMl > EMPTY_ML)) {
    return { fullFeeds: 0, feeds: [], restMl: Math.max(0, milkMl || 0) }
  }
  const fullFeeds = Math.floor((milkMl + DUST_ML) / milkPerFeedMl)
  const restMl = Math.max(0, milkMl - fullFeeds * milkPerFeedMl)
  const feeds: number[] = Array.from({ length: fullFeeds }, () => milkPerFeedMl)
  if (restMl >= EMPTY_ML) feeds.push(restMl)
  return { fullFeeds, feeds, restMl: restMl < EMPTY_ML ? 0 : restMl }
}

export function recipe(input: {
  nowMs: number
  /** End of the last feeding of any kind (ms), or null if there never was one. */
  lastFeedingEndMs: number | null
  /** "Si llora" is on. */
  cry: boolean
  containers: readonly MilkContainer[]
  /** formulaStock() of now, or null when it is unknown (then no warning). */
  formula: FormulaStock | null
  /** "Fórmula fija" (ml); null or 0 = not fixed. */
  fixedFormulaMl?: number | null
  /** A full feed (ml); defaults to RECIPE_TARGET_OZ. */
  targetMl?: number | null
}): Recipe {
  const fullMl = input.targetMl != null && input.targetMl > 0 ? input.targetMl : RECIPE_TARGET_ML
  const topUp =
    input.cry &&
    input.lastFeedingEndMs != null &&
    input.nowMs - input.lastFeedingEndMs < RECIPE_CRY_WINDOW_MS
  const reason: RecipeReason = topUp ? 'cry_top_up' : 'full'
  const wantedMl = topUp ? RECIPE_CRY_EXTRA_ML : fullMl
  const fixedInput =
    input.fixedFormulaMl != null && input.fixedFormulaMl > 0 ? input.fixedFormulaMl : 0
  // The fixed formula splits the milk across FULL feeds. A "si llora" top-up
  // is cold milk first, formula only for what the milk does not cover (QA-1).
  const fixedMl = topUp ? 0 : fixedInput

  const cold = recipeContainers(input.containers, input.nowMs)
  const coldMl = cold.reduce((s, c) => s + Number(c.remaining_ml), 0)
  const cooling = input.containers.filter(
    (c) => isUsable(c, input.nowMs) && !isCold(c, input.nowMs),
  )
  const coolingMl = cooling.reduce((s, c) => s + Number(c.remaining_ml), 0)
  const coolingReadyAtMs = cooling.length ? Math.min(...cooling.map((c) => coldReadyAt(c))) : null

  // Milk: the total minus the fixed formula, oldest cold container first.
  const portions: PlanPortion[] = []
  let left = Math.max(0, wantedMl - fixedMl)
  for (const c of cold) {
    if (left <= EMPTY_ML) break
    const ml = Math.min(Number(c.remaining_ml), left)
    portions.push({ containerId: c.id, label: c.label, ml })
    left -= ml
  }
  const milkMl = portions.reduce((s, p) => s + p.ml, 0)
  // Formula: what was fixed, and the shortfall of the milk on top. A fixed
  // amount above the target makes the bottle that big (it is what was asked).
  const shortfall = Math.max(0, wantedMl - fixedMl - milkMl)
  const formulaRaw = fixedMl + (shortfall > EMPTY_ML ? shortfall : 0)
  const formulaMl = formulaRaw > EMPTY_ML ? formulaRaw : 0

  let formulaWarning: FormulaWarning = null
  if (formulaMl > 0 && input.formula) {
    const open = input.formula.open
    if (!open) formulaWarning = 'none_open'
    else if (open.state === 'expired') formulaWarning = 'expired'
    else if (open.state === 'expiring') formulaWarning = 'expiring'
    else if (input.formula.low) formulaWarning = 'low'
  }

  const milkPerFeedMl = Math.max(0, fullMl - fixedInput)
  return {
    portions,
    formulaMl,
    totalMl: milkMl + formulaMl,
    reason,
    coolingMl,
    coolingReadyAtMs,
    coldMl,
    formulaWarning,
    feedsCovered: splitAcrossFeeds(coldMl, milkPerFeedMl).fullFeeds,
  }
}

/** "2.5 oz breast milk + 1 oz Similac" — the short line of Today. */
export function recipeSummary(
  r: Pick<BottlePlan, 'portions' | 'formulaMl'>,
  lang: Lang = 'en',
): string {
  const milkMl = r.portions.reduce((s, p) => s + p.ml, 0)
  const parts: string[] = []
  if (milkMl > 0) parts.push(translate(lang, 'recipe.milkPart', { amount: formatMilkOz(milkMl) }))
  if (r.formulaMl > 0 || parts.length === 0)
    parts.push(translate(lang, 'recipe.formulaPart', { amount: formatMilkOz(r.formulaMl) }))
  return parts.join(' + ')
}
