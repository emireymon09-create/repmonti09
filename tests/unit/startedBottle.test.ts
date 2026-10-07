import { describe, expect, it } from 'vitest'
import { startedBottle } from '@/lib/startedBottle'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { Feeding, MilkDiscard } from '@/lib/types'

// U-S1 (docs/plan-pruebas-v5.md §1): el biberón empezado — el "sobró" sirve
// hasta fed_at + 60 min (a los 60 exactos ya no), sin sobró no hay empezado,
// el desechado no se ofrece, y es el de la ÚLTIMA toma con sobró. Reloj
// inyectado; corre bajo cuatro TZ.

const OZ = ML_PER_FL_OZ
const MIN = 60_000
const FED = Date.parse('2026-10-08T13:20:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function feed(
  id: string,
  at: number,
  leftoverOz: number | null,
  over: Partial<Feeding> & { voided_at?: string | null } = {},
) {
  return {
    id,
    fed_at: iso(at),
    feeding_type: 'bottle' as Feeding['feeding_type'],
    amount_ml: 3 * OZ,
    notes: null,
    breast_milk_ml: 0,
    formula_ml: 3 * OZ,
    leftover_ml: leftoverOz == null ? null : leftoverOz * OZ,
    voided_at: null as string | null,
    ...over,
  }
}
function thrown(feedingId: string, over: Partial<MilkDiscard> = {}): MilkDiscard {
  return {
    id: `x-${feedingId}`,
    container_id: null,
    feeding_id: feedingId,
    amount_ml: OZ,
    discarded_at: iso(FED + 61 * MIN),
    reason: 'started_bottle_expired',
    voided_at: null,
    ...over,
  }
}

describe('U-S1 startedBottle', () => {
  it('"Sobró 1 oz · sirve hasta 14:20": a 59:59.999 sirve, a 60:00 ya no (caso límite 1)', () => {
    const f = [feed('f1', FED, 1)]
    const at59 = startedBottle({ feedings: f, discards: [], nowMs: FED + 60 * MIN - 1 })
    expect(at59).toEqual({
      feedingId: 'f1',
      leftoverMl: OZ,
      fedAtMs: FED,
      usableUntilMs: FED + 60 * MIN,
      expired: false,
      pending: false,
    })
    expect(startedBottle({ feedings: f, discards: [], nowMs: FED + 60 * MIN })?.expired).toBe(true)
  })

  it('sin sobró (nulo o 0) no hay biberón empezado', () => {
    expect(
      startedBottle({ feedings: [feed('f1', FED, null)], discards: [], nowMs: FED }),
    ).toBeNull()
    expect(startedBottle({ feedings: [feed('f1', FED, 0)], discards: [], nowMs: FED })).toBeNull()
    expect(startedBottle({ feedings: [], discards: [], nowMs: FED })).toBeNull()
  })

  it('tomas anuladas o que no son biberón no cuentan', () => {
    const f = [
      feed('f1', FED, 1, { voided_at: iso(FED) }),
      feed('f2', FED - MIN, 1, { feeding_type: 'nursing' }),
    ]
    expect(startedBottle({ feedings: f, discards: [], nowMs: FED })).toBeNull()
  })

  it('la última toma con sobró, aunque haya otras con sobró antes', () => {
    const f = [
      feed('old', FED - 3 * 60 * MIN, 2),
      feed('new', FED, 0.5),
      feed('none', FED - MIN, null),
    ]
    const s = startedBottle({ feedings: f, discards: [], nowMs: FED })
    expect(s?.feedingId).toBe('new')
    expect(s?.leftoverMl).toBeCloseTo(0.5 * OZ, 9)
  })

  it('ya desechado (también en cola) no se ofrece — y no reaparece uno más viejo', () => {
    const f = [feed('old', FED - 3 * 60 * MIN, 2), feed('new', FED, 1)]
    expect(
      startedBottle({ feedings: f, discards: [thrown('new')], nowMs: FED + 2 * 60 * MIN }),
    ).toBeNull()
    // Un desecho anulado (se editó el sobró a 0 y volvió) no cuenta.
    const back = startedBottle({
      feedings: f,
      discards: [thrown('new', { voided_at: iso(FED + 90 * MIN) })],
      nowMs: FED + 2 * 60 * MIN,
    })
    expect(back?.feedingId).toBe('new')
    // Un desecho de leche caducada (de un biberón M#) no tiene nada que ver.
    const other = startedBottle({
      feedings: f,
      discards: [{ ...thrown('x'), reason: 'expired', container_id: 'c-M1', feeding_id: null }],
      nowMs: FED,
    })
    expect(other?.feedingId).toBe('new')
  })

  it('una toma todavía en cola lo dice (pending)', () => {
    const s = startedBottle({
      feedings: [{ ...feed('q', FED, 1), pending: true }],
      discards: [],
      nowMs: FED,
    })
    expect(s?.pending).toBe(true)
  })
})
