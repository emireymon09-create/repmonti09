import { describe, expect, it } from 'vitest'
import { coldReadyAt, coolingState, isCold, shelfState } from '@/lib/milkCooling'
import { containerState } from '@/lib/milkBottles'
import { containerExpiresAt, DEFAULT_MILK_RULES } from '@/lib/milk'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { MilkContainer } from '@/lib/types'

// U-C1 (docs/plan-pruebas-v5.md §1): "Enfriando" — fría a fridge_at + 60 min
// exactos (no a −1 ms), "Ya está fría" gana, fridge_at nulo cae en stored_at,
// y la caducidad de 4 días NO se mueve por el enfriado (V5-22). Reloj
// inyectado; corre bajo cuatro TZ.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Lunes 5 oct 2026, 10:00 UTC. */
const PUMPED = Date.parse('2026-10-05T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function box(over: Partial<MilkContainer> = {}): MilkContainer {
  return {
    id: 'c-M2',
    source_session_id: 's-M2',
    label: 'M2',
    amount_ml: 3 * ML_PER_FL_OZ,
    remaining_ml: 3 * ML_PER_FL_OZ,
    stored_at: iso(PUMPED),
    location: 'fridge',
    expires_at: iso(PUMPED + 4 * DAY),
    voided_at: null,
    released_at: null,
    lost_ml: 0,
    fridge_at: iso(PUMPED),
    cold_at: null,
    ...over,
  }
}

describe('U-C1 isCold / coldReadyAt — milk_is_cold de 0016', () => {
  it('fría a fridge_at + 60 min exactos; a −1 ms todavía se enfría (caso límite 3)', () => {
    const c = box()
    expect(isCold(c, PUMPED + 60 * MIN - 1)).toBe(false)
    expect(isCold(c, PUMPED + 60 * MIN)).toBe(true)
    expect(isCold(c, PUMPED + 60 * MIN + 1)).toBe(true)
    expect(coldReadyAt(c)).toBe(PUMPED + 60 * MIN)
  })

  it('fridge_at es la hora de "Registrar", no la de la extracción (D5-5)', () => {
    const c = box({ fridge_at: iso(PUMPED + 20 * MIN) })
    expect(isCold(c, PUMPED + 79 * MIN)).toBe(false)
    expect(isCold(c, PUMPED + 80 * MIN)).toBe(true)
  })

  it('fridge_at nulo (fila de antes de 0016 o app vieja) cae en stored_at', () => {
    const c = box({ fridge_at: null })
    expect(coldReadyAt(c)).toBe(PUMPED + HOUR)
    expect(isCold(c, PUMPED + HOUR - 1)).toBe(false)
    const missing = box()
    delete missing.fridge_at
    expect(coldReadyAt(missing)).toBe(PUMPED + HOUR)
  })

  it('"Ya está fría" a las 10:30 → fría desde 10:30, no antes', () => {
    const c = box({ cold_at: iso(PUMPED + 30 * MIN) })
    expect(isCold(c, PUMPED + 30 * MIN - 1)).toBe(false)
    expect(isCold(c, PUMPED + 30 * MIN)).toBe(true)
    expect(coldReadyAt(c)).toBe(PUMPED + 30 * MIN)
  })

  it('un cold_at posterior a la hora no la retrasa: gana lo que llegue primero', () => {
    const c = box({ cold_at: iso(PUMPED + 2 * HOUR) })
    expect(coldReadyAt(c)).toBe(PUMPED + HOUR)
    expect(isCold(c, PUMPED + HOUR)).toBe(true)
  })

  it('coolingState: "Enfriando · lista ~11:00" y después fría, con la misma hora', () => {
    expect(coolingState(box(), PUMPED + 15 * MIN)).toEqual({
      state: 'cooling',
      readyAtMs: PUMPED + HOUR,
    })
    expect(coolingState(box(), PUMPED + HOUR)).toEqual({ state: 'cold', readyAtMs: PUMPED + HOUR })
  })
})

describe('U-C1 la caducidad no se mueve por el enfriado (V5-22, caso límite 4)', () => {
  it('4 días y 0 ms desde stored_at → caducada aunque esté fría', () => {
    const c = box({ fridge_at: iso(PUMPED + 50 * MIN), cold_at: iso(PUMPED + 55 * MIN) })
    // El servidor calcula expires_at desde stored_at; la app igual.
    expect(containerExpiresAt(c.stored_at, 'fridge', DEFAULT_MILK_RULES)).toBe(c.expires_at)
    expect(containerState(c, [], PUMPED + 4 * DAY - 1)).toBe('occupied')
    expect(containerState(c, [], PUMPED + 4 * DAY)).toBe('expired')
    expect(isCold(c, PUMPED + 4 * DAY)).toBe(true)
  })
})

describe('U-C1 shelfState — containerState + "cooling"', () => {
  it('ocupado y tibio → cooling; frío → occupied; el resto no cambia', () => {
    expect(shelfState(box(), [], PUMPED + 10 * MIN)).toBe('cooling')
    expect(shelfState(box(), [], PUMPED + HOUR)).toBe('occupied')
    expect(shelfState(box({ released_at: iso(PUMPED) }), [], PUMPED + 10 * MIN)).toBe('free')
    expect(shelfState(box({ voided_at: iso(PUMPED) }), [], PUMPED + 10 * MIN)).toBe('voided')
    // Vencida gana sobre enfriando: un fridge_at absurdo no la resucita.
    const late = box({ fridge_at: iso(PUMPED + 4 * DAY - MIN) })
    expect(shelfState(late, [], PUMPED + 4 * DAY)).toBe('expired')
  })

  it('containerState sigue sin conocer "cooling" (el selector y Desechar lo leen)', () => {
    expect(containerState(box(), [], PUMPED + 10 * MIN)).toBe('occupied')
  })
})
