import { describe, expect, it } from 'vitest'
import { recipe, recipeContainers, recipeSummary, splitAcrossFeeds } from '@/lib/milkRecipe'
import { formulaStock, type FormulaStock } from '@/lib/formulaStock'
import { FORMULA_BOTTLE_ML } from '@/lib/milkParams'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { BottlePlan } from '@/lib/milk'
import type { FormulaContainer, MilkContainer } from '@/lib/types'

// U-R1 (docs/plan-pruebas-v5.md §1): la receta — 3.5 oz, solo leche fría y
// vigente, la más vieja primero, "si llora" a 119/120 min desde el FIN de la
// última toma, fórmula fija, reparto entre tomas, la que se enfría informada,
// avisos de Similac. Reloj inyectado; corre bajo cuatro TZ.

const OZ = ML_PER_FL_OZ
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-08T15:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function box(label: string, oz: number, storedMs: number, over: Partial<MilkContainer> = {}) {
  return {
    id: `c-${label}`,
    source_session_id: `s-${label}`,
    label,
    amount_ml: oz * OZ,
    remaining_ml: oz * OZ,
    stored_at: iso(storedMs),
    location: 'fridge' as const,
    expires_at: iso(storedMs + 4 * DAY),
    voided_at: null,
    released_at: null,
    lost_ml: 0,
    fridge_at: iso(storedMs),
    cold_at: null,
    ...over,
  }
}
function openBottle(openedMs: number, over: Partial<FormulaContainer> = {}): FormulaContainer {
  return {
    id: 'fc-open',
    size_ml: FORMULA_BOTTLE_ML,
    added_at: iso(openedMs - DAY),
    opened_at: iso(openedMs),
    finished_at: null,
    finish_reason: null,
    voided_at: null,
    ...over,
  }
}
const stockOf = (containers: FormulaContainer[]): FormulaStock =>
  formulaStock({ containers, feedings: [], nowMs: NOW })
/** Una abierta hace 2 h y dos cerradas: sin avisos. */
const GOOD = stockOf([
  openBottle(NOW - 2 * HOUR),
  { ...openBottle(0), id: 'c1', opened_at: null },
  { ...openBottle(0), id: 'c2', opened_at: null },
])

const base = { nowMs: NOW, lastFeedingEndMs: null, cry: false, formula: GOOD }

describe('U-R1 recipe — total y razón', () => {
  it('sin leche fría → 3.5 oz de Similac (caso límite 11)', () => {
    const r = recipe({ ...base, containers: [] })
    expect(r.reason).toBe('full')
    expect(r.portions).toEqual([])
    expect(r.formulaMl).toBeCloseTo(3.5 * OZ, 9)
    expect(r.totalMl).toBeCloseTo(3.5 * OZ, 9)
    expect(recipeSummary(r, 'es')).toBe('3.5 oz de Similac')
  })

  it('con 2 oz fría → 2 oz leche + 1.5 oz Similac (caso límite 11)', () => {
    const r = recipe({ ...base, containers: [box('M2', 2, NOW - DAY)] })
    expect(r.portions).toEqual([{ containerId: 'c-M2', label: 'M2', ml: 2 * OZ }])
    expect(r.formulaMl).toBeCloseTo(1.5 * OZ, 9)
    expect(recipeSummary(r, 'es')).toBe('2 oz de leche + 1.5 oz de Similac')
    expect(recipeSummary(r, 'en')).toBe('2 oz breast milk + 1.5 oz Similac')
  })

  it('solo leche: sin parte de fórmula en el texto', () => {
    const r = recipe({ ...base, containers: [box('M2', 5, NOW - DAY)] })
    expect(r.formulaMl).toBe(0)
    expect(r.formulaWarning).toBeNull()
    expect(recipeSummary(r, 'en')).toBe('3.5 oz breast milk')
  })

  it('"si llora" a 119 min del FIN de la última toma → 1 oz; a 120 → completa (caso límite 10)', () => {
    const c = [box('M1', 5, NOW - DAY)]
    const at119 = recipe({ ...base, cry: true, containers: c, lastFeedingEndMs: NOW - 119 * MIN })
    expect(at119.reason).toBe('cry_top_up')
    expect(at119.totalMl).toBeCloseTo(OZ, 9)
    const justUnder = recipe({
      ...base,
      cry: true,
      containers: c,
      lastFeedingEndMs: NOW - 120 * MIN + 1,
    })
    expect(justUnder.reason).toBe('cry_top_up')
    const at120 = recipe({ ...base, cry: true, containers: c, lastFeedingEndMs: NOW - 120 * MIN })
    expect(at120.reason).toBe('full')
    expect(at120.totalMl).toBeCloseTo(3.5 * OZ, 9)
  })

  it('"si llora" sin toma previa → completa; apagado → completa aunque haya comido recién', () => {
    expect(recipe({ ...base, cry: true, containers: [] }).reason).toBe('full')
    expect(
      recipe({ ...base, cry: false, containers: [], lastFeedingEndMs: NOW - MIN }).reason,
    ).toBe('full')
  })

  it('un objetivo propio reemplaza los 3.5 oz; nunca un total ≤ 0', () => {
    expect(recipe({ ...base, containers: [], targetMl: 4 * OZ }).totalMl).toBeCloseTo(4 * OZ, 9)
    expect(recipe({ ...base, containers: [], targetMl: 0 }).totalMl).toBeCloseTo(3.5 * OZ, 9)
    expect(recipe({ ...base, containers: [], targetMl: -1 }).totalMl).toBeGreaterThan(0)
  })
})

describe('U-R1 recipe — qué leche', () => {
  it('solo fría y vigente, la más vieja primero (byAge)', () => {
    const old = box('M4', 1, NOW - 3 * DAY)
    const mid = box('M1', 1.5, NOW - 2 * DAY)
    const expired = box('M2', 3, NOW - 4 * DAY) // vence justo ahora
    const freed = box('M3', 3, NOW - 3.5 * DAY, { released_at: iso(NOW - HOUR) })
    const r = recipe({ ...base, containers: [mid, expired, freed, old] })
    expect(r.portions.map((p) => [p.label, p.ml / OZ])).toEqual([
      ['M4', 1],
      ['M1', 1.5],
    ])
    expect(r.formulaMl).toBeCloseTo(1 * OZ, 9)
    expect(recipeContainers([mid, expired, freed, old], NOW).map((c) => c.label)).toEqual([
      'M4',
      'M1',
    ])
  })

  it('la que se enfría no entra: se informa con su hora (V5-41)', () => {
    const warm = box('M5', 1.5, NOW - 20 * MIN)
    const warm2 = box('M6', 1, NOW - 50 * MIN)
    const r = recipe({ ...base, containers: [warm, warm2, box('M1', 1, NOW - DAY)] })
    expect(r.portions.map((p) => p.label)).toEqual(['M1'])
    expect(r.coolingMl).toBeCloseTo(2.5 * OZ, 9)
    expect(r.coolingReadyAtMs).toBe(NOW + 10 * MIN)
    expect(r.formulaMl).toBeCloseTo(2.5 * OZ, 9)
  })

  it('"Ya está fría" la habilita antes de la hora', () => {
    const marked = box('M5', 4, NOW - 20 * MIN, { cold_at: iso(NOW - 5 * MIN) })
    const r = recipe({ ...base, containers: [marked] })
    expect(r.portions.map((p) => p.label)).toEqual(['M5'])
    expect(r.coolingMl).toBe(0)
    expect(r.coolingReadyAtMs).toBeNull()
  })
})

describe('U-R1 recipe — fórmula fija y reparto (V5-43)', () => {
  it('fija 1 oz: la leche es 3.5 − 1 = 2.5 oz', () => {
    const r = recipe({ ...base, containers: [box('M1', 5, NOW - DAY)], fixedFormulaMl: OZ })
    expect(r.portions[0].ml).toBeCloseTo(2.5 * OZ, 9)
    expect(r.formulaMl).toBeCloseTo(OZ, 9)
    expect(r.totalMl).toBeCloseTo(3.5 * OZ, 9)
  })

  it('fija + faltante de leche: la fórmula cubre las dos', () => {
    const r = recipe({ ...base, containers: [box('M1', 1, NOW - DAY)], fixedFormulaMl: OZ })
    expect(r.formulaMl).toBeCloseTo(2.5 * OZ, 9)
  })

  it('fija mayor que el objetivo: el biberón es la fija, sin leche', () => {
    const r = recipe({ ...base, containers: [box('M1', 5, NOW - DAY)], fixedFormulaMl: 4 * OZ })
    expect(r.portions).toEqual([])
    expect(r.formulaMl).toBeCloseTo(4 * OZ, 9)
    expect(r.totalMl).toBeCloseTo(4 * OZ, 9)
  })

  it('"La leche alcanza para N tomas así"', () => {
    const r = recipe({
      ...base,
      containers: [box('M1', 3, NOW - 2 * DAY), box('M2', 3, NOW - DAY), box('M3', 1, NOW - DAY)],
      fixedFormulaMl: OZ,
    })
    // 7 oz frías, 2.5 oz de leche por toma → 2 tomas completas.
    expect(r.coldMl).toBeCloseTo(7 * OZ, 9)
    expect(r.feedsCovered).toBe(2)
  })

  it('splitAcrossFeeds: completas, el resto, y nada sin leche por toma', () => {
    expect(splitAcrossFeeds(7 * OZ, 2.5 * OZ)).toEqual({
      fullFeeds: 2,
      feeds: [2.5 * OZ, 2.5 * OZ, 7 * OZ - 5 * OZ],
      restMl: 7 * OZ - 5 * OZ,
    })
    expect(splitAcrossFeeds(5 * OZ, 2.5 * OZ).fullFeeds).toBe(2)
    expect(splitAcrossFeeds(5 * OZ, 2.5 * OZ).feeds).toHaveLength(2)
    expect(splitAcrossFeeds(5 * OZ, 0)).toEqual({ fullFeeds: 0, feeds: [], restMl: 5 * OZ })
    expect(splitAcrossFeeds(0, 2.5 * OZ)).toEqual({ fullFeeds: 0, feeds: [], restMl: 0 })
  })
})

describe('U-R1 recipe — avisos de Similac (V5-05, V5-44)', () => {
  const noMilk = { ...base, containers: [] as MilkContainer[] }
  it('sin abierta → none_open (caso límite 12), y la receta igual propone fórmula', () => {
    const r = recipe({ ...noMilk, formula: stockOf([]) })
    expect(r.formulaWarning).toBe('none_open')
    expect(r.formulaMl).toBeGreaterThan(0)
  })
  it('vencida a las 48 h exactas; vence pronto desde 6 h antes', () => {
    expect(
      recipe({ ...noMilk, formula: stockOf([openBottle(NOW - 48 * HOUR)]) }).formulaWarning,
    ).toBe('expired')
    expect(
      recipe({ ...noMilk, formula: stockOf([openBottle(NOW - 48 * HOUR + 1)]) }).formulaWarning,
    ).toBe('expiring')
    expect(
      recipe({ ...noMilk, formula: stockOf([openBottle(NOW - 42 * HOUR)]) }).formulaWarning,
    ).toBe('expiring')
    expect(
      recipe({ ...noMilk, formula: stockOf([openBottle(NOW - 42 * HOUR + 1)]) }).formulaWarning,
    ).toBe('low') // vigente, pero solo esa botella: ≤ 8 oz
  })
  it('poca → low; sin stock conocido → sin aviso; sin fórmula en la receta → sin aviso', () => {
    expect(recipe({ ...noMilk, formula: GOOD }).formulaWarning).toBeNull()
    expect(recipe({ ...noMilk, formula: null }).formulaWarning).toBeNull()
    const milk = recipe({ ...base, formula: stockOf([]), containers: [box('M1', 5, NOW - DAY)] })
    expect(milk.formulaWarning).toBeNull()
  })
})

describe('U-R1 recipe — compatible con BottleBuilder (BottlePlan)', () => {
  it('portions + formulaMl = totalMl, como suggestPlan', () => {
    const r = recipe({ ...base, containers: [box('M1', 1.25, NOW - DAY)] })
    const plan: BottlePlan = r
    expect(plan.portions.reduce((s, p) => s + p.ml, 0) + plan.formulaMl).toBeCloseTo(
      plan.totalMl,
      9,
    )
  })
})
