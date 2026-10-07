import { describe, expect, it } from 'vitest'
import {
  canUncombine,
  combinationsOf,
  combineExpected,
  combineProblem,
  combinedExpiry,
  combinedMl,
  isCombinable,
} from '@/lib/milkCombine'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { MilkContainer, MilkTransfer } from '@/lib/types'

// U-M1 (docs/plan-pruebas-v5.md §1): las reglas de milk_combine y
// milk_uncombine (0016) en TypeScript — fría, vigente, mismo bebé, destino ≠
// origen; p_expected; la caducidad del más viejo; si se puede deshacer y por
// qué no. Reloj inyectado; corre bajo cuatro TZ.

const OZ = ML_PER_FL_OZ
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const MON = Date.parse('2026-10-05T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function box(label: string, over: Partial<MilkContainer & { baby_id: string }> = {}) {
  const stored = over.stored_at ? Date.parse(over.stored_at) : MON
  return {
    id: `c-${label}`,
    baby_id: 'b1',
    source_session_id: `s-${label}`,
    label,
    amount_ml: 3 * OZ,
    remaining_ml: 3 * OZ,
    stored_at: iso(stored),
    location: 'fridge' as const,
    expires_at: iso(stored + 4 * DAY),
    voided_at: null,
    released_at: null,
    lost_ml: 0,
    fridge_at: iso(stored),
    cold_at: null,
    ...over,
  }
}
function transfer(
  op: string,
  from: string,
  to: string,
  ml: number,
  over: Partial<MilkTransfer> = {},
) {
  return {
    id: `${op}:${from}`,
    op_id: op,
    from_container_id: `c-${from}`,
    to_container_id: `c-${to}`,
    amount_ml: ml,
    target_prev_expires_at: iso(MON + 5 * DAY),
    created_at: iso(NOW - HOUR),
    voided_at: null,
    ...over,
  }
}

describe('U-M1 combineProblem — las reglas de milk_combine', () => {
  it('M5 (vence lunes) + M6 (vence martes) en M6: se puede (caso límite 5)', () => {
    const m5 = box('M5')
    const m6 = box('M6', { stored_at: iso(MON + DAY) })
    expect(combineProblem(m6, [m5], NOW)).toBeNull()
    expect(combinedExpiry(m6, [m5])).toBe(m5.expires_at)
    expect(combinedMl(m6, [m5])).toBeCloseTo(6 * OZ, 9)
    expect(combineExpected(m6, [m5])).toEqual({ 'c-M6': 3 * OZ, 'c-M5': 3 * OZ })
  })

  it('entrada: sin destino, sin orígenes, repetidos, destino entre los orígenes', () => {
    const a = box('M1')
    const b = box('M2')
    expect(combineProblem(null, [a], NOW)).toEqual({ problem: 'bad_input', reason: 'no_target' })
    expect(combineProblem(a, [], NOW)).toEqual({ problem: 'bad_input', reason: 'no_sources' })
    expect(combineProblem(a, [b, b], NOW)).toEqual({ problem: 'bad_input', reason: 'duplicate' })
    expect(combineProblem(a, [b, a], NOW)).toEqual({
      problem: 'bad_input',
      reason: 'target_in_sources',
    })
  })

  it('con M6 enfriando → milk_not_cold:M6 con la hora en que estará lista (caso límite 6)', () => {
    const warm = box('M6', { stored_at: iso(NOW - 20 * MIN) })
    const p = combineProblem(box('M5'), [warm], NOW)
    expect(p).toEqual({
      problem: 'not_cold',
      label: 'M6',
      readyAtMs: NOW + 40 * MIN,
      code: 'milk_not_cold:M6',
    })
    // A la hora exacta ya está fría.
    expect(combineProblem(box('M5'), [warm], NOW + 40 * MIN)).toBeNull()
    // "Ya está fría" la habilita antes.
    expect(combineProblem(box('M5'), [{ ...warm, cold_at: iso(NOW - MIN) }], NOW)).toBeNull()
  })

  it('vencido, libre, anulado u otro bebé → milk_container_unusable:M#', () => {
    const t = box('M7', { stored_at: iso(NOW - 2 * DAY) })
    const expired = box('M1', { stored_at: iso(NOW - 4 * DAY) })
    expect(combineProblem(t, [expired], NOW)?.problem).toBe('unusable')
    expect(combineProblem(t, [expired], NOW - 1)).toBeNull()
    expect(combineProblem(t, [box('M2', { released_at: iso(NOW) })], NOW)).toMatchObject({
      code: 'milk_container_unusable:M2',
    })
    expect(combineProblem(t, [box('M3', { voided_at: iso(NOW) })], NOW)).toMatchObject({
      code: 'milk_container_unusable:M3',
    })
    expect(combineProblem(t, [box('M4', { baby_id: 'b2' })], NOW)).toMatchObject({
      code: 'milk_container_unusable:M4',
    })
  })

  it('como el loop del servidor: por id, inutilizable antes que tibio en cada uno', () => {
    const warmA = box('M1', { id: 'a', stored_at: iso(NOW - 5 * MIN) })
    const freeB = box('M2', { id: 'b', released_at: iso(NOW) })
    expect(combineProblem(box('M9', { id: 'z' }), [freeB, warmA], NOW)).toMatchObject({
      code: 'milk_not_cold:M1',
    })
    const warmAndFree = box('M3', { id: 'a', stored_at: iso(NOW - 5 * MIN), released_at: iso(NOW) })
    expect(combineProblem(box('M9', { id: 'z' }), [warmAndFree], NOW)).toMatchObject({
      code: 'milk_container_unusable:M3',
    })
  })

  it('destino anotado "en el futuro" con un origen que vence antes → inutilizable el destino', () => {
    const src = box('M1', { stored_at: iso(NOW - 4 * DAY + 5 * MIN) }) // vence en 5 min
    const t = box('M2', {
      stored_at: iso(NOW + 8 * MIN),
      fridge_at: iso(NOW + 8 * MIN),
      cold_at: iso(NOW - MIN),
    })
    expect(combineProblem(t, [src], NOW)).toMatchObject({ code: 'milk_container_unusable:M2' })
  })

  it('isCombinable: ocupado, con leche, vigente y frío', () => {
    expect(isCombinable(box('M1'), NOW)).toBe(true)
    expect(isCombinable(box('M1', { remaining_ml: 0.1 }), NOW)).toBe(false)
    expect(isCombinable(box('M1', { stored_at: iso(NOW - 10 * MIN) }), NOW)).toBe(false)
  })
})

describe('U-M1 combinationsOf y canUncombine — milk_uncombine', () => {
  const t = box('M6', { remaining_ml: 6 * OZ, amount_ml: 3 * OZ })
  const s = box('M5', { remaining_ml: 0, released_at: iso(NOW - HOUR) })
  const rows = [transfer('op1', 'M5', 'M6', 3 * OZ)]

  it('agrupa por op_id, más nueva primero, deshechas marcadas', () => {
    const list = combinationsOf([
      ...rows,
      transfer('op0', 'M1', 'M2', OZ, {
        created_at: iso(NOW - DAY),
        voided_at: iso(NOW - 2 * HOUR),
      }),
    ])
    expect(list.map((c) => [c.opId, c.undone, c.movedMl])).toEqual([
      ['op1', false, 3 * OZ],
      ['op0', true, 0],
    ])
    expect(list[0].targetId).toBe('c-M6')
    expect(list[0].sourceIds).toEqual(['c-M5'])
  })

  it('se puede mientras el destino conserva lo que recibió', () => {
    expect(canUncombine('op1', rows, [t, s])).toEqual({ ok: true, noop: false, returnedMl: 3 * OZ })
  })

  it('destino servido por debajo de lo recibido → milk_combine_used:M6 (caso límite 8, regla de 0016)', () => {
    // La regla del servidor es "le queda menos de lo que recibió": M6 tenía
    // 3 oz propias + 3 recibidas; servir 1 oz deja 5 ≥ 3 y TODAVÍA se puede
    // (como I-M2: 30 + 60, se sirven 31 → 59 < 60).
    expect(canUncombine('op1', rows, [{ ...t, remaining_ml: 5 * OZ }, s]).ok).toBe(true)
    const used = { ...t, remaining_ml: 3 * OZ - 1e-6 }
    expect(canUncombine('op1', rows, [used, s])).toEqual({
      ok: false,
      problem: 'used',
      label: 'M6',
      code: 'milk_combine_used:M6',
    })
    // Exactamente lo recibido todavía alcanza.
    expect(canUncombine('op1', rows, [{ ...t, remaining_ml: 3 * OZ }, s]).ok).toBe(true)
    expect(canUncombine('op1', rows, [{ ...t, released_at: iso(NOW) }, s]).ok).toBe(false)
  })

  it('con M5 ya ocupado por otra extracción → milk_label_taken:M5 (caso límite 9)', () => {
    const other = box('M5', { id: 'c-M5b' })
    expect(canUncombine('op1', rows, [t, s, other])).toEqual({
      ok: false,
      problem: 'label_taken',
      label: 'M5',
      code: 'milk_label_taken:M5',
    })
  })

  it('ya deshecha → no-op; desconocida → unknown', () => {
    const undone = [{ ...rows[0], voided_at: iso(NOW) }]
    expect(canUncombine('op1', undone, [t, s])).toEqual({ ok: true, noop: true, returnedMl: 0 })
    expect(canUncombine('nope', rows, [t, s])).toEqual({ ok: false, problem: 'unknown' })
  })
})
