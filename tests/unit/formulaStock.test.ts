import { describe, expect, it } from 'vitest'
import { formulaOpenState, formulaStock } from '@/lib/formulaStock'
import { FORMULA_BOTTLE_ML } from '@/lib/milkParams'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { Feeding, FormulaContainer } from '@/lib/types'

// U-F1 (docs/plan-pruebas-v5.md §1): el stock de Similac derivado de las tomas
// (D5-13). Bordes exactos: 48 h, aviso 6 h antes, ≤ 8 oz, 72 h. Reloj
// inyectado; corre bajo cuatro TZ.

const OZ = ML_PER_FL_OZ
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** "Ahora": jueves 8 oct 2026, 12:00 UTC. */
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

let n = 0
function bottle(over: Partial<FormulaContainer> = {}): FormulaContainer {
  n += 1
  return {
    id: `fc-${String(n).padStart(3, '0')}`,
    size_ml: FORMULA_BOTTLE_ML,
    added_at: iso(NOW - 5 * DAY),
    opened_at: null,
    finished_at: null,
    finish_reason: null,
    voided_at: null,
    ...over,
  }
}
function feed(
  at: number,
  formulaOz: number,
  over: Partial<Feeding> & { voided_at?: string | null } = {},
) {
  n += 1
  return {
    id: `f-${n}`,
    fed_at: iso(at),
    feeding_type: 'bottle' as const,
    amount_ml: formulaOz * OZ,
    notes: null,
    breast_milk_ml: 0,
    formula_ml: formulaOz * OZ,
    leftover_ml: null,
    voided_at: null as string | null,
    ...over,
  }
}

describe('U-F1 formulaStock — cerradas, abierta, restante', () => {
  it('5 cerradas + 1 abierta con 3.2 oz (V5-04, el texto de la spec)', () => {
    const open = bottle({ opened_at: iso(NOW - 10 * HOUR) })
    const closed = Array.from({ length: 5 }, () => bottle())
    const s = formulaStock({
      containers: [open, ...closed],
      feedings: [feed(NOW - 8 * HOUR, 2.8), feed(NOW - 3 * HOUR, 2)],
      nowMs: NOW,
    })
    expect(s.closed).toHaveLength(5)
    expect(s.closedMl).toBeCloseTo(5 * 8 * OZ, 9)
    expect(s.open?.container.id).toBe(open.id)
    expect(s.open?.usedMl).toBeCloseTo(4.8 * OZ, 9)
    expect(s.open?.remainingMl).toBeCloseTo(3.2 * OZ, 9)
    expect(s.remainingMl).toBeCloseTo(43.2 * OZ, 9)
    expect(s.overdrawn).toBe(false)
    expect(s.low).toBe(false)
    expect(s.unassignedMl).toBe(0)
  })

  it('las cerradas salen de la más vieja agregada a la más nueva (la que se abre)', () => {
    const a = bottle({ added_at: iso(NOW - 2 * DAY) })
    const b = bottle({ added_at: iso(NOW - 3 * DAY) })
    expect(
      formulaStock({ containers: [a, b], feedings: [], nowMs: NOW }).closed.map((c) => c.id),
    ).toEqual([b.id, a.id])
  })

  it('anuladas no cuentan; terminadas solo como ventana del pasado', () => {
    const done = bottle({
      opened_at: iso(NOW - 3 * DAY),
      finished_at: iso(NOW - 2 * DAY),
      finish_reason: 'empty',
    })
    const voided = bottle({ voided_at: iso(NOW - DAY) })
    const s = formulaStock({
      containers: [done, voided],
      feedings: [feed(NOW - 2.5 * DAY, 3)],
      nowMs: NOW,
    })
    expect(s.closed).toHaveLength(0)
    expect(s.open).toBeNull()
    expect(s.remainingMl).toBe(0)
    expect(s.unassignedMl).toBe(0) // fue dentro de la ventana de la terminada
  })
})

describe('U-F1 consumo derivado de las tomas (V5-03, regla 17)', () => {
  it('solo tomas bottle vivas con fórmula > 0 dentro de [opened_at, finished_at)', () => {
    const open = bottle({ opened_at: iso(NOW - 6 * HOUR) })
    const s = formulaStock({
      containers: [open],
      feedings: [
        feed(NOW - 6 * HOUR, 1), // en el borde de apertura: cuenta
        feed(NOW - 2 * HOUR, 1, { voided_at: iso(NOW) }), // anulada
        feed(NOW - 2 * HOUR, 1, { feeding_type: 'nursing' }), // no es biberón
        feed(NOW - 2 * HOUR, 0), // sin fórmula
        feed(NOW - 7 * HOUR, 2), // antes de abrir: sin botella abierta
      ],
      nowMs: NOW,
    })
    expect(s.open?.usedMl).toBeCloseTo(1 * OZ, 9)
    expect(s.unassignedMl).toBeCloseTo(2 * OZ, 9)
  })

  it('editar la fórmula de una toma de 1 a 2 oz baja la abierta 1 oz más (caso límite 14)', () => {
    const open = bottle({ opened_at: iso(NOW - 6 * HOUR) })
    const f = feed(NOW - HOUR, 1)
    const before = formulaStock({ containers: [open], feedings: [f], nowMs: NOW })
    const after = formulaStock({
      containers: [open],
      feedings: [{ ...f, formula_ml: 2 * OZ }],
      nowMs: NOW,
    })
    expect(before.open!.remainingMl - after.open!.remainingMl).toBeCloseTo(1 * OZ, 9)
  })

  it('reemplazada: lo de antes va a la vieja, lo de después a la nueva (borde exacto a la nueva)', () => {
    const swap = NOW - 5 * HOUR
    const old = bottle({
      opened_at: iso(NOW - 30 * HOUR),
      finished_at: iso(swap),
      finish_reason: 'replaced',
    })
    const cur = bottle({ opened_at: iso(swap) })
    const s = formulaStock({
      containers: [old, cur],
      feedings: [feed(swap - 1, 3), feed(swap, 2)],
      nowMs: NOW,
    })
    expect(s.open?.container.id).toBe(cur.id)
    expect(s.open?.usedMl).toBeCloseTo(2 * OZ, 9)
  })
})

describe('U-F1 stock negativo, bajo y por día', () => {
  it('más fórmula que la que tenía: se muestra 0 y la bandera (D5-16, regla 14)', () => {
    const open = bottle({ opened_at: iso(NOW - 6 * HOUR) })
    const s = formulaStock({
      containers: [open],
      feedings: [feed(NOW - 5 * HOUR, 5), feed(NOW - HOUR, 5)],
      nowMs: NOW,
    })
    expect(s.open?.remainingMl).toBe(0)
    expect(s.open?.overdrawn).toBe(true)
    expect(s.overdrawn).toBe(true)
    expect(s.remainingMl).toBe(0)
    expect(s.low).toBe(true)
  })

  it('aviso bajo ≤ 8 oz exactos (una botella cerrada sola avisa)', () => {
    expect(formulaStock({ containers: [bottle()], feedings: [], nowMs: NOW }).low).toBe(true)
    const two = formulaStock({ containers: [bottle(), bottle()], feedings: [], nowMs: NOW })
    expect(two.low).toBe(false)
    const open = bottle({ opened_at: iso(NOW - HOUR) })
    const s = formulaStock({
      containers: [open, bottle()],
      feedings: [feed(NOW - 10 * MIN, 0.01)],
      nowMs: NOW,
    })
    expect(s.remainingMl).toBeCloseTo(15.99 * OZ, 9)
    expect(s.low).toBe(false)
    const s2 = formulaStock({
      containers: [open, bottle()],
      feedings: [feed(NOW - 10 * MIN, 8)],
      nowMs: NOW,
    })
    expect(s2.low).toBe(true)
  })

  it('por día = fórmula de las últimas 72 h / 3, con el borde de 72 h afuera', () => {
    const s = formulaStock({
      containers: [],
      feedings: [
        feed(NOW - 72 * HOUR, 9), // justo en el borde: afuera
        feed(NOW - 72 * HOUR + 1, 3),
        feed(NOW - DAY, 3),
        feed(NOW, 3),
        feed(NOW + MIN, 30), // en el futuro: afuera
      ],
      nowMs: NOW,
    })
    expect(s.perDayMl).toBeCloseTo(3 * OZ, 9)
    expect(s.daysLeft).toBe(0)
    expect(formulaStock({ containers: [bottle()], feedings: [], nowMs: NOW }).daysLeft).toBeNull()
  })
})

describe('U-F1 caducidad de la abierta (V5-05, V5-07, caso límite 2)', () => {
  const opened = NOW - 10 * HOUR
  it('vence a las 48 h exactas; a 47:59:59.999 todavía no', () => {
    expect(formulaOpenState(opened, opened + 48 * HOUR - 1)).toBe('expiring')
    expect(formulaOpenState(opened, opened + 48 * HOUR)).toBe('expired')
    expect(formulaOpenState(opened, opened + 48 * HOUR + 1)).toBe('expired')
  })
  it('"vence pronto" desde 6 h antes exactas', () => {
    expect(formulaOpenState(opened, opened + 42 * HOUR - 1)).toBe('ok')
    expect(formulaOpenState(opened, opened + 42 * HOUR)).toBe('expiring')
  })
  it('formulaStock lo informa con su hora de vencimiento', () => {
    const open = bottle({ opened_at: iso(opened) })
    const s = formulaStock({ containers: [open], feedings: [], nowMs: opened + 48 * HOUR })
    expect(s.open?.state).toBe('expired')
    expect(s.open?.expiresAtMs).toBe(opened + 48 * HOUR)
  })
  it('dos abiertas (solo por la cola): manda la última abierta', () => {
    const a = bottle({ opened_at: iso(NOW - 3 * HOUR) })
    const b = bottle({ opened_at: iso(NOW - 2 * HOUR) })
    const s = formulaStock({ containers: [a, b], feedings: [feed(NOW - HOUR, 1)], nowMs: NOW })
    expect(s.open?.container.id).toBe(b.id)
    expect(s.open?.usedMl).toBeCloseTo(OZ, 9)
  })
})
