import { describe, expect, it } from 'vitest'
import { estimateLegacySplit } from '@/lib/milkEstimate'
import { ML_PER_FL_OZ } from '@/lib/format'
import type { Feeding, PumpingSession } from '@/lib/types'

// 2B, D-14: "leche 0 salvo evidencia". Sin reloj: todas las horas salen de
// los datos. Corre bajo cuatro TZ (`pnpm test:tz`) — U-38 depende de eso.

const OZ = ML_PER_FL_OZ
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-09-20T15:00:00.000Z')
const at = (ms: number) => new Date(ms).toISOString()

type F = Parameters<typeof estimateLegacySplit>[0]['feedings'][number]
type P = Parameters<typeof estimateLegacySplit>[0]['pumping'][number]

const legacyBottle = (id: string, ms: number, ml: number): F => ({
  id,
  fed_at: at(ms),
  feeding_type: 'bottle',
  amount_ml: ml,
  breast_milk_ml: null,
  formula_ml: null,
})
const pumped = (id: string, ms: number, ml: number | null): P => ({
  id,
  pumped_at: at(ms),
  amount_ml: ml,
})
const run = (feedings: F[], pumping: P[], withContainer: string[] = [], fridgeDays = 4) =>
  estimateLegacySplit({
    feedings,
    pumping,
    sessionsWithContainer: new Set(withContainer),
    fridgeDays,
  })

describe('estimateLegacySplit', () => {
  it('U-34: no legacy pumping at all → 3 oz is all formula (CL-31)', () => {
    const out = run([legacyBottle('f1', T0, 3 * OZ)], [])
    expect(out.get('f1')).toEqual({ breastMl: 0, formulaMl: 3 * OZ, estimated: true })
  })

  it('U-35: 2 oz pumped the day before, a 3 oz bottle → 2 + 1 (CL-32)', () => {
    const out = run([legacyBottle('f1', T0, 3 * OZ)], [pumped('p1', T0 - DAY, 2 * OZ)])
    const s = out.get('f1')!
    expect(s.breastMl).toBeCloseTo(2 * OZ, 9)
    expect(s.formulaMl).toBeCloseTo(1 * OZ, 9)
    expect(s.estimated).toBe(true)
  })

  it('a pool larger than the bottle: all milk, never more than its total', () => {
    const out = run([legacyBottle('f1', T0, 3 * OZ)], [pumped('p1', T0 - HOUR, 5 * OZ)])
    expect(out.get('f1')).toEqual({ breastMl: 3 * OZ, formulaMl: 0, estimated: true })
  })

  it('U-36: pumped 5 days before (rule: 4 days) → 0 + 3 (CL-32)', () => {
    const out = run([legacyBottle('f1', T0, 3 * OZ)], [pumped('p1', T0 - 5 * DAY, 2 * OZ)])
    expect(out.get('f1')).toEqual({ breastMl: 0, formulaMl: 3 * OZ, estimated: true })
  })

  it('expiry is exclusive and follows the fridge rule given', () => {
    const exactly = [pumped('p1', T0 - 4 * DAY, 2 * OZ)]
    expect(run([legacyBottle('f1', T0, OZ)], exactly).get('f1')?.breastMl).toBe(0)
    expect(run([legacyBottle('f1', T0 - 1, OZ)], exactly).get('f1')?.breastMl).toBe(OZ)
    // With a 5-day rule the same session still counts.
    expect(run([legacyBottle('f1', T0, OZ)], exactly, [], 5).get('f1')?.breastMl).toBe(OZ)
  })

  it('milk pumped AFTER the bottle never goes into it', () => {
    const out = run([legacyBottle('f1', T0, 3 * OZ)], [pumped('p1', T0 + 1, 5 * OZ)])
    expect(out.get('f1')?.breastMl).toBe(0)
  })

  it('U-37: two bottles share a pool, oldest session first; container sessions and breakdown bottles stay out', () => {
    const feedings: F[] = [
      legacyBottle('f1', T0, 2 * OZ),
      legacyBottle('f2', T0 + 2 * HOUR, 3 * OZ),
      // A bottle with a breakdown (0014+): already served from containers.
      {
        id: 'f3',
        fed_at: at(T0 + HOUR),
        feeding_type: 'bottle',
        amount_ml: 4 * OZ,
        breast_milk_ml: 4 * OZ,
        formula_ml: 0,
      },
    ]
    const pumping = [
      pumped('old', T0 - 2 * DAY, 1.5 * OZ),
      pumped('new', T0 - DAY, 2 * OZ),
      pumped('box', T0 - DAY, 10 * OZ), // filled a container: not in the pool
    ]
    const out = run(feedings, pumping, ['box'])
    expect(out.has('f3')).toBe(false)
    // f1 takes 1.5 of "old" and 0.5 of "new"; f2 the 1.5 that is left.
    expect(out.get('f1')?.breastMl).toBeCloseTo(2 * OZ, 9)
    expect(out.get('f1')?.formulaMl).toBeCloseTo(0, 9)
    expect(out.get('f2')?.breastMl).toBeCloseTo(1.5 * OZ, 9)
    expect(out.get('f2')?.formulaMl).toBeCloseTo(1.5 * OZ, 9)
  })

  it('the oldest session is used first even when a newer one would last longer', () => {
    const out = run(
      [legacyBottle('f1', T0, OZ), legacyBottle('f2', T0 + 3 * DAY + 12 * HOUR, OZ)],
      [pumped('old', T0 - DAY, OZ), pumped('new', T0 - HOUR, OZ)],
    )
    // f1 drains "old"; by f2 "new" still has 1 oz and is not expired.
    expect(out.get('f2')?.breastMl).toBeCloseTo(OZ, 9)
  })

  it('U-38: same answer whatever order the rows come in (ties broken by id)', () => {
    const feedings = [
      legacyBottle('fb', T0, 2 * OZ),
      legacyBottle('fa', T0, 2 * OZ),
      legacyBottle('fc', T0 + HOUR, OZ),
    ]
    const pumping = [pumped('p2', T0 - HOUR, 1.5 * OZ), pumped('p1', T0 - HOUR, 1.5 * OZ)]
    const a = run(feedings, pumping)
    const b = run(feedings.slice().reverse(), pumping.slice().reverse())
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
    // "fa" sorts before "fb" at the same instant: it gets the milk first.
    expect(a.get('fa')?.breastMl).toBeCloseTo(2 * OZ, 9)
    expect(a.get('fb')?.breastMl).toBeCloseTo(1 * OZ, 9)
    expect(a.get('fc')?.breastMl).toBe(0)
  })

  it('U-38: the result does not depend on the process timezone (fixed instants)', () => {
    const out = run(
      [legacyBottle('f1', Date.parse('2026-03-08T09:30:00.000Z'), 3 * OZ)],
      // Pumped 4 days minus 1 ms before, across the March clock change: 96 h, not 4 calendar days.
      [pumped('p1', Date.parse('2026-03-04T09:30:00.001Z'), OZ)],
    )
    expect(out.get('f1')?.breastMl).toBe(OZ)
  })

  it('U-39: a session and a bottle at the exact same instant: the session goes in first', () => {
    const out = run([legacyBottle('f1', T0, OZ)], [pumped('p1', T0, 2 * OZ)])
    expect(out.get('f1')?.breastMl).toBe(OZ)
  })

  it('nursing, solids, empty and zero bottles, and sessions with no amount are ignored', () => {
    const feedings: F[] = [
      { ...legacyBottle('n', T0, 0), feeding_type: 'nursing', amount_ml: null },
      { ...legacyBottle('s', T0, OZ), feeding_type: 'solid' },
      legacyBottle('z', T0, 0),
      { ...legacyBottle('null', T0, 0), amount_ml: null },
    ]
    const out = run(feedings, [pumped('p0', T0 - HOUR, null), pumped('p1', T0 - HOUR, 0)])
    expect(out.size).toBe(0)
  })

  it('writes nothing: its inputs come back unchanged', () => {
    const feedings = [legacyBottle('f1', T0, 3 * OZ)]
    const pumping = [pumped('p1', T0 - DAY, 2 * OZ)]
    const before = JSON.stringify([feedings, pumping])
    run(feedings, pumping)
    expect(JSON.stringify([feedings, pumping])).toBe(before)
  })
})

// The type the history page will pass: real Feeding/PumpingSession rows fit.
const _typecheck: [Feeding, PumpingSession] | null = null
void _typecheck
