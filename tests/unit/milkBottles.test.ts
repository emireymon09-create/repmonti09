import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOTTLE_COUNT,
  EMPTY_ML,
  FUTURE_TOLERANCE_MS,
  MAX_BOTTLE_COUNT,
  MILK_INVARIANT_IDS,
  MIN_BOTTLE_COUNT,
  bottleSlots,
  canDiscard,
  containerBalance,
  containerState,
  discardedTotalMl,
  effectiveBottleCount,
  isOccupied,
  milkInvariantFailures,
  planBottleEdit,
  rebalance,
  validateBottleCount,
  validateLeftover,
  type BottleEditPlan,
} from '@/lib/milkBottles'
import {
  EMPTY_ML as EMPTY_ML_FROM_MILK,
  activeContainers,
  containerExpiresAt,
  isUsable,
  portionMl,
  stashMl,
  suggestPlan,
  usableContainers,
} from '@/lib/milk'
import { ML_PER_FL_OZ, fromHouseholdInputValue } from '@/lib/format'
import type { Feeding, MilkContainer, MilkDiscard, MilkDrawdown, MilkTransfer } from '@/lib/types'

// Lógica pura de v4 (docs/arquitectura-v4.md §1, §2, §3.8, §7.1). Reloj
// inyectado en todos los casos; corre bajo cuatro TZ (`pnpm test:tz`). Los
// U-xx son los de docs/plan-pruebas-v4.md.

const OZ = ML_PER_FL_OZ
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** "Ahora" de los casos: jueves 8 oct 2026, 12:00 UTC (05:00 en la casa). */
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
/** Lunes, martes, miércoles de esa semana, 09:00 UTC. */
const MON = Date.parse('2026-10-05T09:00:00.000Z')
const TUE = MON + DAY
const WED = TUE + DAY

function box(label: string, over: Partial<MilkContainer> = {}): MilkContainer {
  return {
    id: `c-${label}`,
    source_session_id: `s-${label}`,
    label,
    amount_ml: 3 * OZ,
    remaining_ml: 3 * OZ,
    stored_at: iso(MON),
    location: 'fridge',
    expires_at: iso(MON + 4 * DAY),
    voided_at: null,
    released_at: null,
    lost_ml: 0,
    ...over,
  }
}
function discard(label: string, ml: number, over: Partial<MilkDiscard> = {}): MilkDiscard {
  return {
    id: `x-${label}`,
    container_id: `c-${label}`,
    amount_ml: ml,
    discarded_at: iso(NOW),
    reason: 'expired',
    label,
    voided_at: null,
    ...over,
  }
}
function portion(feedingId: string, label: string, ml: number): MilkDrawdown {
  return {
    id: `${feedingId}:c-${label}`,
    feeding_id: feedingId,
    container_id: `c-${label}`,
    amount_ml: ml,
    label,
    voided_at: null,
  }
}
function feed(id: string, at: number, breastMl: number, formulaMl: number): Feeding {
  return {
    id,
    fed_at: iso(at),
    feeding_type: 'bottle',
    amount_ml: breastMl + formulaMl,
    notes: null,
    breast_milk_ml: breastMl,
    formula_ml: formulaMl,
    leftover_ml: null,
  }
}
/** The invariant of §2.1–2.2 on a plan's result (and the edited bottle). */
function balanced(plan: BottleEditPlan, f: Feeding) {
  const breast = plan.portions.reduce((s, p) => s + p.ml, 0)
  const edited = { ...f, breast_milk_ml: breast, amount_ml: breast + Number(f.formula_ml) }
  return milkInvariantFailures({
    containers: plan.containers,
    drawdowns: plan.drawdowns,
    discards: plan.discards,
    feedings: [edited],
  })
}

// --------------------------------------------------------------- constants

describe('constants', () => {
  it('EMPTY_ML moved here and lib/milk.ts re-exports the same value', () => {
    expect(EMPTY_ML).toBe(0.15)
    expect(EMPTY_ML_FROM_MILK).toBe(EMPTY_ML)
  })
  it('the future tolerance is 10 minutes', () => {
    expect(FUTURE_TOLERANCE_MS).toBe(10 * 60 * 1000)
  })
  it('N: 6 by default, 1 to 30 (D-23)', () => {
    expect([DEFAULT_BOTTLE_COUNT, MIN_BOTTLE_COUNT, MAX_BOTTLE_COUNT]).toEqual([6, 1, 30])
  })
})

// U-40 / U-41: the same numbers in 0015. Skipped (and said so) until the
// migration exists in this worktree — the database engineer writes it.
const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations')
const m0015 = readdirSync(migrationsDir).find((f) => f.startsWith('0015'))
describe.runIf(m0015)('U-40 / U-41 — constants match 0015', () => {
  const sql = m0015 ? readFileSync(join(migrationsDir, m0015), 'utf8') : ''
  it('U-40: every "interval N minutes" in 0015 is FUTURE_TOLERANCE_MS', () => {
    const intervals = [...sql.matchAll(/interval\s+'(\d+)\s+minutes?'/gi)].map((m) => Number(m[1]))
    expect(intervals.length).toBeGreaterThan(0)
    for (const minutes of intervals) expect(minutes * 60_000).toBe(FUTURE_TOLERANCE_MS)
  })
  it('U-41: the released/empty threshold in 0015 is EMPTY_ML', () => {
    const literals = [...sql.matchAll(/remaining_ml\s*(?:<|>=)\s*([0-9.]+)/g)].map((m) =>
      Number(m[1]),
    )
    expect(literals.length).toBeGreaterThan(0)
    for (const x of literals) if (x !== 0) expect(x).toBe(EMPTY_ML)
  })
})

// --------------------------------------------------------------- states

describe('containerState (U-01…U-03)', () => {
  it('U-01: voided → discarded → free → expired → occupied, in that precedence', () => {
    const expired = { expires_at: iso(NOW - 1) }
    // Voided wins over everything, even a live discard and a release.
    const v = box('M1', { voided_at: iso(NOW), released_at: iso(NOW), ...expired })
    expect(containerState(v, [discard('M1', 10)], NOW)).toBe('voided')
    // A live discard wins over released and expired.
    const d = box('M2', { released_at: iso(NOW), remaining_ml: 0, ...expired })
    expect(containerState(d, [discard('M2', 10)], NOW)).toBe('discarded')
    // A voided discard does not count: released → free.
    expect(containerState(d, [discard('M2', 10, { voided_at: iso(NOW) })], NOW)).toBe('free')
    // Released wins over expired.
    expect(containerState(box('M3', { released_at: iso(NOW), ...expired }), [], NOW)).toBe('free')
    expect(containerState(box('M4', expired), [], NOW)).toBe('expired')
    expect(containerState(box('M5'), [], NOW)).toBe('occupied')
    // Another container's discard is not this one's.
    expect(containerState(box('M5'), [discard('M2', 10)], NOW)).toBe('occupied')
  })

  it('U-02 / U-03: expiry is exclusive — expired AT the instant, occupied 1 ms before', () => {
    const c = box('M3', { expires_at: iso(NOW) })
    expect(containerState(c, [], NOW)).toBe('expired')
    expect(containerState(c, [], NOW - 1)).toBe('occupied')
    expect(containerState(c, [], NOW + 1)).toBe('expired')
  })

  it('4 days exactly: stored at T, occupied at T + 96 h − 1 ms, expired at T + 96 h', () => {
    const stored = iso(MON)
    const c = box('M3', {
      stored_at: stored,
      expires_at: containerExpiresAt(stored, 'fridge', {
        milk_room_hours: 4,
        milk_fridge_days: 4,
        milk_freezer_months: 6,
      }),
    })
    expect(containerState(c, [], MON + 4 * DAY - 1)).toBe('occupied')
    expect(containerState(c, [], MON + 4 * DAY)).toBe('expired')
    expect(containerState(c, [], MON + 4 * DAY + 1)).toBe('expired')
  })

  it('expiring at the household midnight: the same instant in every process timezone', () => {
    const midnight = fromHouseholdInputValue('2026-10-09T00:00')
    expect(midnight).toBe('2026-10-09T07:00:00.000Z') // PDT
    const c = box('M3', { expires_at: midnight })
    expect(containerState(c, [], Date.parse(midnight) - 1)).toBe('occupied')
    expect(containerState(c, [], Date.parse(midnight))).toBe('expired')
  })

  it('isOccupied: not voided and not released', () => {
    expect(isOccupied(box('M1'))).toBe(true)
    expect(isOccupied(box('M1', { released_at: iso(NOW) }))).toBe(false)
    expect(isOccupied(box('M1', { voided_at: iso(NOW) }))).toBe(false)
    // An expired one still holds its number.
    expect(isOccupied(box('M1', { expires_at: iso(NOW - DAY) }))).toBe(true)
  })
})

describe('containerExpiresAt across the clock change (U-04, U-05)', () => {
  const rules = { milk_room_hours: 4, milk_fridge_days: 4, milk_freezer_months: 6 }
  const laHour = (ms: number) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(ms),
    )

  it('U-04: stored the Saturday before the March change: +96 h exact, the wall clock moves an hour', () => {
    const stored = '2026-03-07T18:00:00.000Z' // Sat 10:00 PST; DST starts Sun Mar 8
    const exp = containerExpiresAt(stored, 'fridge', rules)
    expect(exp).toBe('2026-03-11T18:00:00.000Z')
    expect(Date.parse(exp) - Date.parse(stored)).toBe(96 * HOUR)
    expect([laHour(Date.parse(stored)), laHour(Date.parse(exp))]).toEqual([10, 11])
  })

  it('U-04: and the November change, the other way', () => {
    const stored = '2026-10-31T17:00:00.000Z' // Sat 10:00 PDT; DST ends Sun Nov 1
    const exp = containerExpiresAt(stored, 'fridge', rules)
    expect(exp).toBe('2026-11-04T17:00:00.000Z')
    expect([laHour(Date.parse(stored)), laHour(Date.parse(exp))]).toEqual([10, 9])
  })

  it('U-05: stored at 23:59:59.999 household time, the same ISO under any TZ', () => {
    const stored = '2026-10-05T06:59:59.999Z' // Oct 4, 23:59:59.999 PDT
    expect(containerExpiresAt(stored, 'fridge', rules)).toBe('2026-10-09T06:59:59.999Z')
  })
})

// --------------------------------------------------------------- selector

describe('bottleSlots (U-06…U-10)', () => {
  it('U-06: M1…M6 in numeric order; M3 occupied with its container, M5 expired, the rest free', () => {
    const m3 = box('M3', {
      remaining_ml: 2.5 * OZ,
      stored_at: iso(WED),
      expires_at: iso(WED + 4 * DAY),
    })
    const m5 = box('M5', { stored_at: iso(MON - 5 * DAY), expires_at: iso(MON - DAY) })
    const m2 = box('M2', { remaining_ml: 0, released_at: iso(TUE) })
    const { slots, outOfRange, known } = bottleSlots(6, [m5, m3, m2], [], NOW)
    expect(known).toBe(true)
    expect(outOfRange).toEqual([])
    expect(slots.map((s) => [s.label, s.state, s.disabled])).toEqual([
      ['M1', 'free', false],
      ['M2', 'free', false],
      ['M3', 'occupied', true],
      ['M4', 'free', false],
      ['M5', 'expired', true],
      ['M6', 'free', false],
    ])
    expect(slots[2]).toMatchObject({ container: m3, remainingMl: 2.5 * OZ, storedAt: iso(WED) })
  })

  it('U-07: an occupied M9 with N = 6 is out of range, never a slot (D-1)', () => {
    const { slots, outOfRange } = bottleSlots(6, [box('M9'), box('M12')], [], NOW)
    expect(slots.map((s) => s.label)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])
    expect(slots.every((s) => s.state === 'free')).toBe(true)
    expect(outOfRange.map((s) => [s.label, s.state])).toEqual([
      ['M9', 'occupied'],
      ['M12', 'occupied'],
    ])
  })

  it('U-07: once emptied, a number above N is gone from the selector altogether', () => {
    const { slots, outOfRange } = bottleSlots(6, [box('M9', { released_at: iso(NOW) })], [], NOW)
    expect(slots).toHaveLength(6)
    expect(outOfRange).toEqual([])
  })

  it('U-08: N lowered from 6 to 4 with M5 occupied: M1–M4, M5 out of range (D-2)', () => {
    const { slots, outOfRange } = bottleSlots(4, [box('M5'), box('M2')], [], NOW)
    expect(slots.map((s) => [s.label, s.state])).toEqual([
      ['M1', 'free'],
      ['M2', 'occupied'],
      ['M3', 'free'],
      ['M4', 'free'],
    ])
    expect(outOfRange.map((s) => s.label)).toEqual(['M5'])
  })

  it('U-09: a container still in the queue holds its bottle, marked pending', () => {
    const queued = { ...box('M2'), pending: true }
    const slot = bottleSlots(6, [queued], [], NOW).slots[1]
    expect(slot).toMatchObject({ label: 'M2', state: 'occupied', disabled: true, pending: true })
  })

  it('U-09b (E-16, V4-39): a bottle freed by a discard still in the queue is free and marked pending; a synced free one is not', () => {
    // applyPendingInventory leaves a queued discard as: at 0, released, pending.
    const queuedDiscard = {
      ...box('M3', { remaining_ml: 0, released_at: iso(NOW) }),
      pending: true,
    }
    const synced = box('M5', { remaining_ml: 0, released_at: iso(TUE) })
    const { slots } = bottleSlots(
      6,
      [queuedDiscard, synced],
      [discard('M3', 2 * OZ), discard('M5', OZ)],
      NOW,
    )
    expect(slots[2]).toMatchObject({ label: 'M3', state: 'free', disabled: false, pending: true })
    expect(slots[4].pending).toBeFalsy()
    // Freed by the queue but already holding a newer, synced bottle: the slot
    // is that bottle's, not pending.
    const holder = box('M3', { id: 'holder', stored_at: iso(WED) })
    const again = bottleSlots(6, [queuedDiscard, holder], [discard('M3', 2 * OZ)], NOW).slots[2]
    expect(again).toMatchObject({ state: 'occupied', pending: false })
  })

  it('U-10: an emptied M3 and a newer occupied M3 → the slot is the occupied one', () => {
    const old = box('M3', { id: 'old', remaining_ml: 0.1, released_at: iso(TUE) })
    const now = box('M3', { id: 'new', stored_at: iso(WED), expires_at: iso(WED + 4 * DAY) })
    const slot = bottleSlots(6, [old, now], [], NOW).slots[2]
    expect(slot.container?.id).toBe('new')
  })

  it('a discarded container frees its number; a voided one too', () => {
    const d = box('M1', { remaining_ml: 0, released_at: iso(NOW) })
    const v = box('M2', { voided_at: iso(NOW) })
    const { slots } = bottleSlots(6, [d, v], [discard('M1', 3 * OZ)], NOW)
    expect(slots.slice(0, 2).map((s) => s.state)).toEqual(['free', 'free'])
  })

  it('two live containers on one number (two phones offline): the server’s wins the slot', () => {
    const server = box('M4', { id: 'srv', stored_at: iso(WED) })
    const queued = { ...box('M4', { id: 'q', stored_at: iso(MON) }), pending: true }
    expect(bottleSlots(6, [queued, server], [], NOW).slots[3].container?.id).toBe('srv')
    // Neither confirmed: the oldest.
    const q2 = { ...server, pending: true }
    expect(bottleSlots(6, [q2, queued], [], NOW).slots[3].container?.id).toBe('q')
  })

  it('an unknown list (offline, nothing read, nothing saved) offers every number (V4-11 CA3)', () => {
    const r = bottleSlots(6, null, [], NOW)
    expect(r.known).toBe(false)
    expect(r.slots.every((s) => s.state === 'free' && !s.disabled)).toBe(true)
  })

  it('an out-of-range N falls back to the default instead of offering nothing or 1000', () => {
    expect(bottleSlots(0, [], [], NOW).slots).toHaveLength(6)
    expect(bottleSlots(1000, [], [], NOW).slots).toHaveLength(6)
    expect(bottleSlots(30, [], [], NOW).slots).toHaveLength(30)
    expect(bottleSlots(1, [], [], NOW).slots.map((s) => s.label)).toEqual(['M1'])
  })
})

describe('validateBottleCount (U-43) and effectiveBottleCount', () => {
  it.each([
    ['', { problem: 'empty' }],
    ['   ', { problem: 'empty' }],
    ['0', { problem: 'range' }],
    ['31', { problem: 'range' }],
    ['-3', { problem: 'range' }],
    ['2.5', { problem: 'whole' }],
    ['abc', { problem: 'number' }],
    ['Infinity', { problem: 'number' }],
    ['1', { n: 1 }],
    ['30', { n: 30 }],
    [' 6 ', { n: 6 }],
  ])('%j → %j', (text, expected) => {
    expect(validateBottleCount(text)).toEqual(expected)
  })

  it('a missing or impossible stored N reads as the default', () => {
    expect(effectiveBottleCount(undefined)).toBe(6)
    expect(effectiveBottleCount(null)).toBe(6)
    expect(effectiveBottleCount(2.5)).toBe(6)
    expect(effectiveBottleCount(31)).toBe(6)
    expect(effectiveBottleCount(8)).toBe(8)
    expect(effectiveBottleCount('8')).toBe(8)
  })
})

// --------------------------------------------------------------- usable / stash

describe('usable and the stash in v4 (U-11…U-13, U-65)', () => {
  const released = box('M1', { remaining_ml: 0.1, released_at: iso(TUE) })
  const discarded = box('M2', { remaining_ml: 0, released_at: iso(TUE) })
  const expired = box('M3', { expires_at: iso(NOW - 1) })
  const good = box('M4', { remaining_ml: 2 * OZ })

  it('U-11: only the occupied, unexpired container counts', () => {
    const all = [released, discarded, expired, good]
    expect(all.map((c) => isUsable(c, NOW))).toEqual([false, false, false, true])
    expect(stashMl(all, NOW)).toBeCloseTo(2 * OZ, 9)
  })

  it('a released container never counts, whatever is left in it (V4-36)', () => {
    expect(isUsable(box('M1', { released_at: iso(TUE) }), NOW)).toBe(false)
  })

  it('U-12: M6 pumped Monday and M1 Tuesday → the suggestion serves M6 first (R-3)', () => {
    const m6 = box('M6', { stored_at: iso(MON), remaining_ml: 2 * OZ })
    const m1 = box('M1', { stored_at: iso(TUE), remaining_ml: 2 * OZ })
    const plan = suggestPlan(3 * OZ, [m1, m6], NOW)
    expect(plan.portions.map((p) => [p.label, p.ml / OZ])).toEqual([
      ['M6', 2],
      ['M1', expect.closeTo(1, 9)],
    ])
  })

  it('U-13: a released container with 0.1 ml is not in the plan', () => {
    const plan = suggestPlan(3 * OZ, [released, good], NOW)
    expect(plan.portions.map((p) => p.label)).toEqual(['M4'])
    expect(usableContainers([released, good], NOW).map((c) => c.label)).toEqual(['M4'])
  })

  it('activeContainers lists only containers holding a bottle', () => {
    expect(activeContainers([released, discarded, expired, good]).map((c) => c.label)).toEqual([
      'M3',
      'M4',
    ])
  })

  it('U-65: the stash at the household midnight is the same total in every TZ', () => {
    const midnight = Date.parse(fromHouseholdInputValue('2026-10-09T00:00'))
    const a = box('M1', { expires_at: iso(midnight) })
    const b = box('M2', { expires_at: iso(midnight + 1) })
    expect(stashMl([a, b], midnight - 1)).toBeCloseTo(6 * OZ, 9)
    expect(stashMl([a, b], midnight)).toBeCloseTo(3 * OZ, 9)
  })

  it('U-64: typing exactly the 1.75 oz shown on 51.7536 ml takes the exact ml', () => {
    expect(portionMl(1.75, 'oz', { remaining_ml: 51.7536 })).toBe(51.7536)
    expect(portionMl(52, 'ml', { remaining_ml: 51.7536 })).toBe(51.7536)
    expect(portionMl(1.7, 'oz', { remaining_ml: 51.7536 })).toBeCloseTo(1.7 * OZ, 9)
  })
})

// --------------------------------------------------------------- discards

describe('canDiscard, discardedTotalMl, containerBalance (U-14…U-16)', () => {
  it('U-14: expired occupied / current / discarded / free → true / false / false / false', () => {
    const exp = box('M1', { expires_at: iso(NOW - 1) })
    const cur = box('M2')
    const dis = box('M3', { remaining_ml: 0, released_at: iso(NOW), expires_at: iso(NOW - 1) })
    const free = box('M4', { remaining_ml: 0, released_at: iso(NOW), expires_at: iso(NOW - 1) })
    const discards = [discard('M3', 3 * OZ)]
    expect([exp, cur, dis, free].map((c) => canDiscard(c, discards, NOW))).toEqual([
      true,
      false,
      false,
      false,
    ])
    // Exactly at expiry it can be discarded (exclusive expiry), 1 ms before not.
    const edge = box('M5', { expires_at: iso(NOW) })
    expect(canDiscard(edge, [], NOW)).toBe(true)
    expect(canDiscard(edge, [], NOW - 1)).toBe(false)
  })

  it('U-15: the total is the live discards only', () => {
    expect(
      discardedTotalMl([
        discard('M1', 40),
        discard('M2', 50.5),
        discard('M3', 1000, { voided_at: iso(NOW) }),
      ]),
    ).toBeCloseTo(90.5, 9)
    expect(discardedTotalMl([])).toBe(0)
  })

  it('U-16: served + discarded + lost + remaining = amount', () => {
    const c = box('M3', { amount_ml: 120, remaining_ml: 0, lost_ml: 10, released_at: iso(NOW) })
    const draws = [portion('f1', 'M3', 50), { ...portion('f2', 'M3', 7), voided_at: iso(NOW) }]
    const b = containerBalance(c, draws, [discard('M3', 60)])
    // 0016: in and out (transfers) are 0 without any.
    expect(b).toEqual({ served: 50, discarded: 60, lost: 10, remaining: 0, in: 0, out: 0 })
    expect(b.served + b.discarded + b.lost + b.remaining).toBe(c.amount_ml)
    // Without the portions, served is what the other three leave.
    expect(containerBalance(c, null, [discard('M3', 60)]).served).toBe(50)
  })
})

// --------------------------------------------------------------- rebalance

describe('rebalance — the mirror of milk_rebalance (U-17…U-23)', () => {
  const at = iso(NOW)

  it('U-17: serving that leaves 0.1 ml releases it; the 0.1 ml stays as dust', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 90 })
    const r = rebalance(c, 'serve', 0.1, [c], [], at)
    expect(r.container.remaining_ml).toBeCloseTo(0.1, 9)
    expect(r.container.released_at).toBe(at)
    expect(isUsable(r.container, NOW)).toBe(false)
  })

  it('serving down to exactly EMPTY_ML keeps it occupied (the threshold is "< 0.15")', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 90 })
    expect(rebalance(c, 'serve', EMPTY_ML, [c], [], at).container.released_at).toBeNull()
    expect(rebalance(c, 'serve', EMPTY_ML - 1e-6, [c], [], at).container.released_at).toBe(at)
  })

  it('U-18: milk coming back to a released container whose number is still free re-occupies it', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 0.1, released_at: iso(TUE) })
    const r = rebalance(c, 'return', 30.1, [c], [], at)
    expect(r.container).toMatchObject({ released_at: null, lost_ml: 0 })
    expect(r.container.remaining_ml).toBeCloseTo(30.1, 9)
    expect([r.returnedMl, r.lostMl]).toEqual([expect.closeTo(30, 9), 0])
  })

  it('U-19: …and if another container holds the number now, it is lost, still free (D-9)', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 0, released_at: iso(TUE) })
    const other = box('M3', { id: 'other', stored_at: iso(WED) })
    const r = rebalance(c, 'return', 30, [c, other], [], at)
    expect(r.container).toMatchObject({ remaining_ml: 0, released_at: iso(TUE), lost_ml: 30 })
    expect([r.returnedMl, r.lostMl, r.lostReason]).toEqual([0, 30, 'reused'])
  })

  it('a released container whose number another RELEASED one has is free: it takes the milk', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 0, released_at: iso(TUE) })
    const other = box('M3', { id: 'other', released_at: iso(WED), remaining_ml: 0 })
    expect(rebalance(c, 'return', 30, [c, other], [], at).returnedMl).toBe(30)
  })

  it('U-20: milk coming back to a discarded container is lost (D-9)', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 0, released_at: iso(TUE) })
    const ds = [discard('M3', 60)]
    const r = rebalance(c, 'return', 90, [c], ds, at)
    expect(r.container.lost_ml).toBe(30)
    expect(r.discards[0].amount_ml).toBe(60)
    expect(r.lostReason).toBe('discarded')
  })

  it('U-21: an expired, still occupied container takes the milk back (stays expired)', () => {
    const c = box('M3', { amount_ml: 90, remaining_ml: 30, expires_at: iso(NOW - DAY) })
    const r = rebalance(c, 'return', 60, [c], [], at)
    expect(r.container.remaining_ml).toBe(60)
    expect(containerState(r.container, [], NOW)).toBe('expired')
  })

  it('a voided container never takes milk back, and is not touched (as on the server)', () => {
    const c = box('M3', { voided_at: iso(TUE), remaining_ml: 0 })
    const r = rebalance(c, 'return', 30, [c], [], at)
    expect([r.lostMl, r.lostReason]).toEqual([30, 'voided'])
    // As milk_rebalance: a voided container is not written at all.
    expect(r.container).toBe(c)
  })

  it('U-22: a discarded session edited up 1 oz: the discard grows 1 oz (D-8)', () => {
    const c = box('M3', { amount_ml: 4 * OZ, remaining_ml: 0, released_at: iso(TUE) })
    const r = rebalance(c, 'amount', 3 * OZ, [c], [discard('M3', 2 * OZ)], at)
    expect(r.discards[0].amount_ml).toBeCloseTo(3 * OZ, 9)
    expect(r.container).toMatchObject({ remaining_ml: 0, lost_ml: 0, released_at: iso(TUE) })
  })

  it('U-23: going down takes from remaining, then lost, then the discard — and voids a discard at 0', () => {
    // Not a reachable state for a discarded one (remaining is 0 there); the
    // order is what is tested.
    const c = box('M3', { amount_ml: 100, remaining_ml: 10, lost_ml: 5, released_at: null })
    const ds = [discard('M3', 20)]
    let r = rebalance(c, 'amount', 30, [c], ds, at) // parts 35 → 30
    expect([r.container.remaining_ml, r.container.lost_ml, r.discards[0].amount_ml]).toEqual([
      5, 5, 20,
    ])
    r = rebalance(c, 'amount', 18, [c], ds, at) // −17: 10 + 5 + 2
    expect([r.container.remaining_ml, r.container.lost_ml, r.discards[0].amount_ml]).toEqual([
      0, 0, 18,
    ])
    expect(r.container.released_at).toBe(at)
    r = rebalance(c, 'amount', 0, [c], ds, at)
    expect(r.discards[0]).toMatchObject({ amount_ml: 20, voided_at: at })
  })

  it('a change smaller than float dust moves nothing', () => {
    const c = box('M3')
    const r = rebalance(c, 'return', c.remaining_ml + 1e-12, [c], [], at)
    expect(r.container).toEqual({ ...c, lost_ml: 0 })
  })

  it('does not change its inputs', () => {
    const c = box('M3', { remaining_ml: 0, released_at: iso(TUE) })
    const ds = [discard('M3', 60)]
    const before = JSON.stringify([c, ds])
    rebalance(c, 'amount', 120, [c], ds, at)
    expect(JSON.stringify([c, ds])).toBe(before)
  })
})

// --------------------------------------------------------------- edit 2A

describe('planBottleEdit — the mirror of edit_bottle_feed (U-24…U-33)', () => {
  const ask = (f: Feeding, over: Partial<Parameters<typeof planBottleEdit>[4]> = {}) => ({
    fed_at: f.fed_at,
    breast_milk_ml: Number(f.breast_milk_ml),
    formula_ml: Number(f.formula_ml),
    leftover_ml: f.leftover_ml ?? null,
    ...over,
  })

  it('U-24: milk 3 → 2 oz, all from M3: 1 oz back to M3', () => {
    const f = feed('f1', WED, 3 * OZ, 0)
    const m3 = box('M3', { amount_ml: 4 * OZ, remaining_ml: 1 * OZ })
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', 3 * OZ)],
      [m3],
      [],
      ask(f, { breast_milk_ml: 2 * OZ }),
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.returned).toEqual([{ containerId: 'c-M3', label: 'M3', ml: expect.closeTo(OZ, 9) }])
    expect(p.portions.map((x) => [x.label, x.ml / OZ])).toEqual([['M3', expect.closeTo(2, 9)]])
    expect(p.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(balanced(p, f)).toEqual([])
  })

  it('U-25: 3 → 2 oz from M3 1.75 (older) + M4 1.25 (newer): M4 down to 0.25, M3 untouched (D-17)', () => {
    const f = feed('f1', WED, 3 * OZ, 0)
    const m3 = box('M3', {
      stored_at: iso(MON),
      amount_ml: 1.75 * OZ,
      remaining_ml: 0,
      released_at: iso(WED),
    })
    const m4 = box('M4', { stored_at: iso(TUE), amount_ml: 3 * OZ, remaining_ml: 1.75 * OZ })
    const draws = [portion('f1', 'M3', 1.75 * OZ), portion('f1', 'M4', 1.25 * OZ)]
    const p = planBottleEdit(f, draws, [m3, m4], [], ask(f, { breast_milk_ml: 2 * OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    expect(p.returned.map((x) => [x.label, x.ml / OZ])).toEqual([['M4', expect.closeTo(1, 9)]])
    expect(p.portions.map((x) => [x.label, x.ml / OZ])).toEqual([
      ['M3', 1.75],
      ['M4', expect.closeTo(0.25, 9)],
    ])
    expect(p.containers.find((c) => c.label === 'M3')).toEqual(m3)
    expect(balanced(p, f)).toEqual([])
  })

  it('U-26: lowering more than the newest portion voids it and goes on (spec: M3 1.75 + M4 0.5, −1 oz)', () => {
    const f = feed('f1', WED, 2.25 * OZ, 0)
    const m3 = box('M3', { stored_at: iso(MON), amount_ml: 2 * OZ, remaining_ml: 0.25 * OZ })
    const m4 = box('M4', { stored_at: iso(TUE), amount_ml: 3 * OZ, remaining_ml: 2.5 * OZ })
    const draws = [portion('f1', 'M3', 1.75 * OZ), portion('f1', 'M4', 0.5 * OZ)]
    const p = planBottleEdit(f, draws, [m3, m4], [], ask(f, { breast_milk_ml: 1.25 * OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    expect(p.returned.map((x) => [x.label, x.ml / OZ])).toEqual([
      ['M4', expect.closeTo(0.5, 9)],
      ['M3', expect.closeTo(0.5, 9)],
    ])
    expect(p.drawdowns.find((d) => d.container_id === 'c-M4')?.voided_at).toBe(iso(NOW))
    expect(p.portions.map((x) => [x.label, x.ml / OZ])).toEqual([['M3', expect.closeTo(1.25, 9)]])
    expect(balanced(p, f)).toEqual([])
  })

  it('a portion from an EXPIRED container still gets its milk back (it shows as expired)', () => {
    const f = feed('f1', MON + HOUR, 2 * OZ, 0)
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: OZ, expires_at: iso(NOW - HOUR) })
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', 2 * OZ)],
      [m3],
      [],
      ask(f, { breast_milk_ml: OZ }),
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(containerState(p.containers[0], [], NOW)).toBe('expired')
  })

  it('CL-30 / D-9: lowered, but M3 was discarded → the milk is lost, the bottle still goes down', () => {
    const f = feed('f1', MON + HOUR, 2 * OZ, 0)
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: 0, released_at: iso(NOW) })
    const ds = [discard('M3', OZ)]
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', 2 * OZ)],
      [m3],
      ds,
      ask(f, { breast_milk_ml: OZ }),
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.returned).toEqual([])
    expect(p.lost).toEqual([
      { containerId: 'c-M3', label: 'M3', ml: expect.closeTo(OZ, 9), reason: 'discarded' },
    ])
    expect(p.portions[0].ml).toBeCloseTo(OZ, 9)
    expect(balanced(p, f)).toEqual([])
  })

  it('CL-10 / D-9: lowered, M3 emptied and its number reused → lost; free → re-occupied', () => {
    const f = feed('f1', MON + HOUR, 3 * OZ, 0)
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: 0, released_at: iso(TUE) })
    const reuse = box('M3', { id: 'c-M3b', source_session_id: 's-M3b', stored_at: iso(WED) })
    const draws = [portion('f1', 'M3', 3 * OZ)]
    const lost = planBottleEdit(f, draws, [m3, reuse], [], ask(f, { breast_milk_ml: 2 * OZ }), NOW)
    if (!lost.ok) throw new Error(lost.problem)
    expect(lost.lost.map((l) => [l.label, l.reason])).toEqual([['M3', 'reused']])
    expect(balanced(lost, f)).toEqual([])
    const back = planBottleEdit(f, draws, [m3], [], ask(f, { breast_milk_ml: 2 * OZ }), NOW)
    if (!back.ok) throw new Error(back.problem)
    expect(back.containers[0]).toMatchObject({ released_at: null })
    expect(back.containers[0].remaining_ml).toBeCloseTo(OZ, 9)
  })

  it('U-27: 2 → 3 oz, usable at that time M5 (Monday) and M6 (Tuesday) → 1 oz from M5 (D-18)', () => {
    const f = feed('f1', WED, 2 * OZ, 0)
    const m4 = box('M4', {
      stored_at: iso(MON - DAY),
      amount_ml: 2 * OZ,
      remaining_ml: 0,
      released_at: iso(WED),
    })
    const m5 = box('M5', { stored_at: iso(MON) })
    const m6 = box('M6', { stored_at: iso(TUE) })
    const p = planBottleEdit(
      f,
      [portion('f1', 'M4', 2 * OZ)],
      [m6, m4, m5],
      [],
      ask(f, { breast_milk_ml: 3 * OZ }),
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.taken.map((x) => [x.label, x.ml / OZ])).toEqual([['M5', expect.closeTo(1, 9)]])
    expect(p.containers.find((c) => c.label === 'M6')).toEqual(m6)
    expect(balanced(p, f)).toEqual([])
  })

  it('U-27: FIFO across containers when the oldest is not enough', () => {
    const f = feed('f1', WED, 0, 2 * OZ)
    const m5 = box('M5', { stored_at: iso(MON), amount_ml: OZ, remaining_ml: OZ })
    const m6 = box('M6', { stored_at: iso(TUE) })
    const p = planBottleEdit(f, [], [m6, m5], [], ask(f, { breast_milk_ml: 2 * OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    expect(p.taken.map((x) => [x.label, x.ml / OZ])).toEqual([
      ['M5', 1],
      ['M6', expect.closeTo(1, 9)],
    ])
    expect(p.containers.find((c) => c.label === 'M5')?.released_at).toBe(iso(NOW))
  })

  it('U-28: going up with a container the bottle already uses grows its portion, no new row', () => {
    const f = feed('f1', WED, OZ, 0)
    const m5 = box('M5', { stored_at: iso(MON), amount_ml: 3 * OZ, remaining_ml: 2 * OZ })
    const draws = [portion('f1', 'M5', OZ)]
    const p = planBottleEdit(f, draws, [m5], [], ask(f, { breast_milk_ml: 2 * OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    expect(p.drawdowns.filter((d) => d.feeding_id === 'f1')).toHaveLength(1)
    expect(p.portions[0].ml).toBeCloseTo(2 * OZ, 9)
    expect(balanced(p, f)).toEqual([])
  })

  it('a portion voided by an earlier edit is revived, not duplicated', () => {
    const f = feed('f1', WED, 0, OZ)
    const m5 = box('M5', { stored_at: iso(MON) })
    const draws = [{ ...portion('f1', 'M5', 0.5 * OZ), voided_at: iso(TUE) }]
    const p = planBottleEdit(f, draws, [m5], [], ask(f, { breast_milk_ml: OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    const mine = p.drawdowns.filter((d) => d.feeding_id === 'f1')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ voided_at: null })
    expect(mine[0].amount_ml).toBeCloseTo(OZ, 9)
  })

  it('U-29: going up with not enough milk → not_enough with the exact ml there was; nothing changes', () => {
    const f = feed('f1', WED, 2 * OZ, 0)
    const m5 = box('M5', { stored_at: iso(MON), remaining_ml: 37.5 })
    const p = planBottleEdit(f, [], [m5], [], ask(f, { breast_milk_ml: 5 * OZ }), NOW)
    expect(p).toEqual({
      ok: false,
      problem: 'not_enough',
      availableMl: 37.5,
      neededMl: expect.closeTo(3 * OZ, 9),
    })
  })

  it('U-30: formula only 1 → 3 oz with no milk at all → fine, no portion touched (R-14)', () => {
    const f = feed('f1', WED, 0, OZ)
    const p = planBottleEdit(f, [], [], [], ask(f, { formula_ml: 3 * OZ }), NOW)
    if (!p.ok) throw new Error(p.problem)
    expect([p.returned, p.taken, p.lost, p.portions]).toEqual([[], [], [], []])
    expect(p.noop).toBe(false)
  })

  it('U-31: the new time is after M3 expired → unusable M3 (D-7)', () => {
    const f = feed('f1', TUE, 2 * OZ, 0)
    const m3 = box('M3', {
      stored_at: iso(MON),
      expires_at: iso(WED),
      amount_ml: 3 * OZ,
      remaining_ml: OZ,
    })
    const draws = [portion('f1', 'M3', 2 * OZ)]
    expect(planBottleEdit(f, draws, [m3], [], ask(f, { fed_at: iso(WED) }), NOW)).toEqual({
      ok: false,
      problem: 'unusable',
      label: 'M3',
    })
    // 1 ms before expiry is fine.
    expect(planBottleEdit(f, draws, [m3], [], ask(f, { fed_at: iso(WED - 1) }), NOW).ok).toBe(true)
  })

  it('U-31: and a new time more than 10 min before the milk was pumped → unusable', () => {
    const f = feed('f1', TUE, 2 * OZ, 0)
    const m3 = box('M3', { stored_at: iso(TUE), amount_ml: 3 * OZ, remaining_ml: OZ })
    const draws = [portion('f1', 'M3', 2 * OZ)]
    const at = (ms: number) => planBottleEdit(f, draws, [m3], [], ask(f, { fed_at: iso(ms) }), NOW)
    expect(at(TUE - FUTURE_TOLERANCE_MS).ok).toBe(true)
    expect(at(TUE - FUTURE_TOLERANCE_MS - 1)).toMatchObject({ problem: 'unusable', label: 'M3' })
  })

  it('U-32: a new time more than 10 min ahead of the clock → future; exactly 10 min is fine', () => {
    const f = feed('f1', WED, 0, OZ)
    const plan = (ms: number) => planBottleEdit(f, [], [], [], ask(f, { fed_at: iso(ms) }), NOW)
    expect(plan(NOW + FUTURE_TOLERANCE_MS).ok).toBe(true)
    expect(plan(NOW + FUTURE_TOLERANCE_MS + 1)).toEqual({ ok: false, problem: 'future' })
  })

  it('U-33: released, voided, discarded, stored after, expired at the time — none is used', () => {
    const f = feed('f1', WED, 0, OZ)
    const cands = [
      box('M1', { released_at: iso(TUE), remaining_ml: 0.1 }),
      box('M2', { voided_at: iso(TUE) }),
      box('M3', { released_at: iso(TUE), remaining_ml: 0 }),
      box('M4', { stored_at: iso(WED + 1) }),
      box('M5', { expires_at: iso(WED) }),
      box('M6', { remaining_ml: 0.1 }),
    ]
    const p = planBottleEdit(
      f,
      [],
      cands,
      [discard('M3', 3 * OZ)],
      ask(f, { breast_milk_ml: OZ }),
      NOW,
    )
    expect(p).toMatchObject({ ok: false, problem: 'not_enough', availableMl: 0 })
  })

  it('the time used to pick the milk is the FINAL time (D-18)', () => {
    const f = feed('f1', WED, 0, OZ)
    const m5 = box('M5', { stored_at: iso(TUE) })
    // Moved to Monday: M5 did not exist yet.
    expect(
      planBottleEdit(f, [], [m5], [], ask(f, { fed_at: iso(MON), breast_milk_ml: OZ }), NOW),
    ).toMatchObject({
      problem: 'not_enough',
    })
  })

  it('already as asked → a no-op that moves nothing', () => {
    const f = feed('f1', WED, 2 * OZ, OZ)
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: OZ })
    const p = planBottleEdit(f, [portion('f1', 'M3', 2 * OZ)], [m3], [], ask(f), NOW)
    expect(p).toMatchObject({ ok: true, noop: true, returned: [], taken: [], lost: [] })
  })

  it('leftover and notes alone change nothing in the inventory', () => {
    const f = feed('f1', WED, 2 * OZ, OZ)
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: OZ })
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', 2 * OZ)],
      [m3],
      [],
      { ...ask(f, { leftover_ml: OZ }), notes: 'x' },
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.noop).toBe(false)
    expect(p.containers).toEqual([m3])
  })

  it('bad input and a bottle with no breakdown are refused before anything else', () => {
    const f = feed('f1', WED, 2 * OZ, 0)
    const bad = (over: Parameters<typeof ask>[1]) =>
      planBottleEdit(f, [], [], [], ask(f, over), NOW)
    expect(bad({ breast_milk_ml: -1 })).toEqual({ ok: false, problem: 'bad_input' })
    expect(bad({ formula_ml: Number.NaN })).toEqual({ ok: false, problem: 'bad_input' })
    expect(bad({ breast_milk_ml: 0, formula_ml: 0 })).toEqual({ ok: false, problem: 'bad_input' })
    expect(bad({ leftover_ml: 3 * OZ })).toEqual({ ok: false, problem: 'bad_input' })
    expect(bad({ fed_at: 'not a date' })).toEqual({ ok: false, problem: 'bad_input' })
    const legacy = { ...f, breast_milk_ml: null, formula_ml: null }
    expect(planBottleEdit(legacy, [], [], [], ask(f), NOW)).toEqual({
      ok: false,
      problem: 'not_inventory',
    })
  })

  it('order of the server: future before not_enough, not_enough before unusable', () => {
    const f = feed('f1', TUE, 2 * OZ, 0)
    const m3 = box('M3', {
      stored_at: iso(MON),
      expires_at: iso(WED),
      amount_ml: 3 * OZ,
      remaining_ml: OZ,
    })
    const draws = [portion('f1', 'M3', 2 * OZ)]
    const far = iso(NOW + DAY)
    expect(
      planBottleEdit(f, draws, [m3], [], ask(f, { fed_at: far, breast_milk_ml: 9 * OZ }), NOW),
    ).toMatchObject({ problem: 'future' })
    expect(
      planBottleEdit(f, draws, [m3], [], ask(f, { fed_at: iso(WED), breast_milk_ml: 9 * OZ }), NOW),
    ).toMatchObject({ problem: 'not_enough' })
  })

  it('does not change its inputs', () => {
    const f = feed('f1', WED, 3 * OZ, 0)
    const cs = [
      box('M3', { amount_ml: 4 * OZ, remaining_ml: OZ }),
      box('M5', { stored_at: iso(MON) }),
    ]
    const ds = [portion('f1', 'M3', 3 * OZ)]
    const before = JSON.stringify([f, cs, ds])
    planBottleEdit(f, ds, cs, [], ask(f, { breast_milk_ml: 5 * OZ }), NOW)
    planBottleEdit(f, ds, cs, [], ask(f, { breast_milk_ml: OZ }), NOW)
    expect(JSON.stringify([f, cs, ds])).toBe(before)
  })

  // Espejo de I-79b (m-1): log_bottle_feed acepta una toma anterior a la
  // extracción (S-17); edit_bottle_feed re-valida las porciones solo si la
  // edición mueve la hora o la leche.
  it('U-66: a bottle from BEFORE its milk was pumped (S-17): note, leftover or formula alone go through; moving the time or the milk re-checks (m-1)', () => {
    const f = feed('f1', TUE - 3 * HOUR, OZ, 0)
    const m3 = box('M3', { stored_at: iso(TUE), amount_ml: 2 * OZ, remaining_ml: OZ })
    const draws = [portion('f1', 'M3', OZ)]
    const plan = (over: Parameters<typeof ask>[1] & { notes?: string | null }) =>
      planBottleEdit(f, draws, [m3], [], { ...ask(f), ...over }, NOW)
    for (const over of [{ notes: 'solo la nota' }, { leftover_ml: 5 }, { formula_ml: 10 }]) {
      expect(plan(over), JSON.stringify(over)).toMatchObject({ ok: true, noop: false, lost: [] })
    }
    expect(plan({ fed_at: iso(TUE - 3 * HOUR + 60_000) })).toEqual({
      ok: false,
      problem: 'unusable',
      label: 'M3',
    })
    expect(plan({ breast_milk_ml: OZ / 2 })).toEqual({
      ok: false,
      problem: 'unusable',
      label: 'M3',
    })
  })

  it('U-67: the same time read with microseconds and sent to the millisecond is NOT a time change (O-4)', () => {
    const f = { ...feed('f1', TUE - 3 * HOUR, OZ, 0), fed_at: '2026-10-06T06:00:00.123456+00:00' }
    const m3 = box('M3', { stored_at: iso(TUE), amount_ml: 2 * OZ, remaining_ml: OZ })
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', OZ)],
      [m3],
      [],
      { ...ask(f), fed_at: '2026-10-06T06:00:00.123Z', notes: 'solo la nota' },
      NOW,
    )
    expect(p).toMatchObject({ ok: true, noop: false })
  })

  it('U-69: milk going back to a container that is not in the list → lost, reason unknown', () => {
    const f = feed('f1', WED, 2 * OZ, 0)
    const p = planBottleEdit(
      f,
      [portion('f1', 'M3', 2 * OZ)],
      [],
      [],
      ask(f, { breast_milk_ml: OZ }),
      NOW,
    )
    if (!p.ok) throw new Error(p.problem)
    expect(p.returned).toEqual([])
    expect(p.lost).toEqual([
      { containerId: 'c-M3', label: 'M3', ml: expect.closeTo(OZ, 9), reason: 'unknown' },
    ])
    expect(p.portions).toEqual([{ containerId: 'c-M3', label: 'M3', ml: expect.closeTo(OZ, 9) }])
  })
})

// --------------------------------------------------------------- leftover

describe('validateLeftover (U-44)', () => {
  it('more than served / equal / 0 / negative / nothing', () => {
    const total = 3 * OZ
    expect(validateLeftover(4 * OZ, total)).toBe('too_much')
    expect(validateLeftover(total, total)).toBeNull()
    expect(validateLeftover(0, total)).toBeNull()
    expect(validateLeftover(-1, total)).toBe('number')
    expect(validateLeftover(null, total)).toBeNull()
    expect(validateLeftover(Number.NaN, total)).toBe('number')
    expect(validateLeftover(Infinity, total)).toBe('number')
  })
  it('the same amount typed in ml is not "more" because of the oz rounding', () => {
    expect(validateLeftover(3 * OZ, 3 * OZ + 1e-12)).toBeNull()
    expect(validateLeftover(89, 3 * OZ)).toBe('too_much') // 88.72 ml served
  })
})

// --------------------------------------------------------------- invariant

describe('milkInvariantFailures (U-42 and the checks themselves)', () => {
  it('U-42: the same checks as the SQL of docs/arquitectura-v4.md §2.4 (INV-7 is a constraint there)', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'arquitectura-v4.md'), 'utf8')
    const section = doc.slice(doc.indexOf('### 2.4'), doc.indexOf('## 3.'))
    const sqlIds = new Set([...section.matchAll(/'(INV-\d)/g)].map((m) => m[1]))
    // v4's nine (0015); 0016 adds INV-10…INV-12, checked against 0016 below.
    const v4Ids = MILK_INVARIANT_IDS.filter((x) => x !== 'INV-7' && Number(x.slice(4)) < 10)
    expect([...sqlIds].sort()).toEqual(v4Ids)
    // And the block that 0015 runs at the end of the migration: the same ids,
    // in the same order as the document (re-auditoría H6).
    const mig = readFileSync(
      join(__dirname, '..', '..', 'supabase', 'migrations', '0015_milk_phase1_2.sql'),
      'utf8',
    )
    const invBlock = mig.slice(mig.indexOf('=== INVARIANTE'), mig.indexOf('notify pgrst'))
    const migIds = [...invBlock.matchAll(/'(INV-\d)/g)].map((m) => m[1])
    expect(migIds).toEqual([...section.matchAll(/'(INV-\d)/g)].map((m) => m[1]))
    expect(migIds).toEqual(v4Ids)
    // And 0016's closing block: every id, the new ones too, once each in order.
    const m16 = readFileSync(
      join(__dirname, '..', '..', 'supabase', 'migrations', '0016_milk_phase3_4.sql'),
      'utf8',
    )
    const block16 = m16.slice(m16.indexOf('=== INVARIANTE'), m16.indexOf('notify pgrst'))
    const ids16 = [...new Set([...block16.matchAll(/'(INV-\d+)/g)].map((m) => m[1]))]
    expect(ids16).toEqual(MILK_INVARIANT_IDS.filter((x) => x !== 'INV-7'))
    // And the integration helper, once it exists, names the same ones.
    const helper = join(__dirname, '..', 'helpers', 'milkInvariant.ts')
    if (existsSync(helper)) {
      const text = readFileSync(helper, 'utf8')
      const uses = text.includes('milkInvariantFailures')
      const ids = new Set([...text.matchAll(/INV-\d/g)].map((m) => m[0]))
      expect(uses || [...sqlIds].every((id) => ids.has(id))).toBe(true)
    }
  })

  it('a consistent inventory has no failures', () => {
    const c = box('M3', { amount_ml: 100, remaining_ml: 30, lost_ml: 10 })
    const f = feed('f1', WED, 60, 10)
    expect(
      milkInvariantFailures({
        containers: [c],
        drawdowns: [portion('f1', 'M3', 60)],
        discards: [],
        feedings: [f],
        sessions: [{ id: 's-M3', amount_ml: 100 }],
      }),
    ).toEqual([])
  })

  it('names each broken rule', () => {
    const fails = milkInvariantFailures({
      containers: [
        box('M1', { amount_ml: 100, remaining_ml: 30 }), // INV-1 (70 missing)
        box('M2'),
        box('M2', { id: 'c-M2b' }), // INV-2
        box('M3', { remaining_ml: 0, released_at: null, amount_ml: 0 }), // INV-5 empty and held
        box('M4', { voided_at: iso(NOW) }), // INV-4 with a live portion
        box('M5', { amount_ml: 50, remaining_ml: 0, released_at: null }), // INV-3 + INV-5
      ],
      drawdowns: [portion('f9', 'M4', 10), portion('fv', 'M2', 0)],
      discards: [discard('M5', 50)],
      feedings: [
        { ...feed('f9', WED, 20, 5), leftover_ml: 40 }, // INV-6 (portions 10) + INV-7
        { ...feed('fv', WED, 0, 5), voided_at: iso(NOW) }, // INV-9 (live portion)
      ],
      sessions: [{ id: 's-M2', amount_ml: 1 }], // INV-8
    })
    // 0016's three, on rows of their own.
    const more = milkInvariantFailures({
      containers: [
        box('M6', { remaining_ml: 2 * OZ, amount_ml: 3 * OZ }), // a source NOT released
        box('M7', { remaining_ml: 4 * OZ }),
      ],
      drawdowns: [],
      discards: [
        {
          id: 'x-started',
          container_id: null,
          feeding_id: 'fs',
          amount_ml: 30,
          discarded_at: iso(NOW),
          reason: 'started_bottle_expired',
        }, // INV-10: the feeding says 20 left over
      ],
      feedings: [{ ...feed('fs', WED, 0, 60), leftover_ml: 20 }],
      transfers: [
        {
          id: 't1',
          op_id: 'op1',
          from_container_id: 'c-M6',
          to_container_id: 'c-M7',
          amount_ml: 1 * OZ,
          target_prev_expires_at: iso(MON + 4 * DAY),
          created_at: iso(NOW),
        }, // INV-11 (and INV-1 on both)
      ],
      formula: [
        { id: 'o1', opened_at: iso(MON), finished_at: null },
        { id: 'o2', opened_at: iso(TUE), finished_at: null }, // INV-12: two open
      ],
    })
    expect([...new Set([...fails, ...more].map((f) => f.check))].sort()).toEqual(
      [...MILK_INVARIANT_IDS].sort(),
    )
  })
})

// --------------------------------------------------------------- transfers (0016, U-I1)

describe('U-I1 rebalance y la invariante con transferencias (0016)', () => {
  const t1 = (ml: number, over: Partial<MilkTransfer> = {}): MilkTransfer => ({
    id: 't1',
    op_id: 'op1',
    from_container_id: 'c-M5',
    to_container_id: 'c-M6',
    amount_ml: ml,
    target_prev_expires_at: iso(MON + 5 * DAY),
    created_at: iso(NOW),
    voided_at: null,
    ...over,
  })
  // M5 (2 oz) volcado entero en M6 (3 oz): M5 libre y vacío, M6 con 5 oz.
  const src = box('M5', { amount_ml: 2 * OZ, remaining_ml: 0, released_at: iso(NOW) })
  const dst = box('M6', { amount_ml: 3 * OZ, remaining_ml: 5 * OZ })

  it('containerBalance: amount + in = served + discarded + lost + remaining + out', () => {
    expect(containerBalance(src, [], [], [t1(2 * OZ)])).toMatchObject({
      in: 0,
      out: 2 * OZ,
      served: 0,
    })
    expect(containerBalance(dst, [], [], [t1(2 * OZ)])).toMatchObject({
      in: 2 * OZ,
      out: 0,
      served: 0,
    })
    // Sin las porciones, lo servido sale de la cuenta con transferencias.
    const servedDst = { ...dst, remaining_ml: 4 * OZ }
    expect(containerBalance(servedDst, null, [], [t1(2 * OZ)]).served).toBeCloseTo(OZ, 9)
    // Una transferencia anulada (deshecha) no cuenta.
    expect(containerBalance(dst, null, [], [t1(2 * OZ, { voided_at: iso(NOW) })]).in).toBe(0)
  })

  it('milkInvariantFailures: la combinación cierra (INV-1 con entra/sale, INV-11)', () => {
    expect(
      milkInvariantFailures({
        containers: [src, dst],
        drawdowns: [],
        discards: [],
        transfers: [t1(2 * OZ)],
      }),
    ).toEqual([])
    // Sin la transferencia, las dos cuentas fallan.
    expect(
      milkInvariantFailures({ containers: [src, dst], drawdowns: [], discards: [] }).map(
        (f) => f.check,
      ),
    ).toEqual(['INV-1', 'INV-1'])
    // Un anulado con transferencias vivas: INV-4.
    expect(
      milkInvariantFailures({
        containers: [{ ...src, voided_at: iso(NOW) }, dst],
        drawdowns: [],
        discards: [],
        transfers: [t1(2 * OZ)],
      }).map((f) => f.check),
    ).toContain('INV-4')
  })

  it("leche que vuelve por 'return' o 'amount' a un origen volcado → lost 'combined' (D5-19)", () => {
    for (const cause of ['return', 'amount'] as const) {
      const r = rebalance(src, cause, OZ, [src, dst], [], iso(NOW), [t1(2 * OZ)])
      expect(r.lostMl).toBeCloseTo(OZ, 9)
      expect(r.lostReason).toBe('combined')
      expect(r.container.remaining_ml).toBe(0)
      expect(r.container.released_at).toBe(iso(NOW))
    }
  })

  it("por 'transfer' (deshacer) el origen vuelve a ocupar su número", () => {
    const r = rebalance(src, 'transfer', 2 * OZ, [src, dst], [], iso(NOW), [])
    expect(r.returnedMl).toBeCloseTo(2 * OZ, 9)
    expect(r.container.released_at).toBeNull()
    // Con el número ocupado por otra extracción, no (el servidor lo rechaza antes).
    const other = box('M5', { id: 'c-M5b' })
    const taken = rebalance(src, 'transfer', 2 * OZ, [src, dst, other], [], iso(NOW), [])
    expect(taken.lostReason).toBe('reused')
  })

  it('sin transferencias, rebalance hace exactamente lo de 0015', () => {
    const freed = box('M5', { remaining_ml: 0, released_at: iso(NOW) })
    const r = rebalance(freed, 'return', OZ, [freed], [], iso(NOW))
    expect(r.returnedMl).toBeCloseTo(OZ, 9)
    expect(r.container.released_at).toBeNull()
  })

  it('discardedTotalMl deja afuera el biberón empezado (D5-11)', () => {
    const started: MilkDiscard = {
      id: 'x-s',
      container_id: null,
      feeding_id: 'f1',
      amount_ml: 50,
      discarded_at: iso(NOW),
      reason: 'started_bottle_expired',
      voided_at: null,
    }
    expect(discardedTotalMl([discard('M3', 30), started])).toBe(30)
  })

  it('planBottleEdit: menos leche de una toma de un origen volcado → lost combined', () => {
    const served = box('M5', { amount_ml: 3 * OZ, remaining_ml: 0, released_at: iso(NOW) })
    const f = feed('f1', WED, OZ, 0)
    const plan = planBottleEdit(
      f,
      [portion('f1', 'M5', OZ)],
      [served, dst],
      [],
      { fed_at: f.fed_at, breast_milk_ml: 0, formula_ml: OZ, leftover_ml: null },
      NOW,
      [t1(2 * OZ)],
    )
    expect(plan.ok && plan.lost).toEqual([
      { containerId: 'c-M5', label: 'M5', ml: OZ, reason: 'combined' },
    ])
  })
})
