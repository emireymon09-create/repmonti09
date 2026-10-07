import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIRST_SUGGESTION_ML,
  DEFAULT_MILK_RULES,
  applyPendingInventory,
  containerExpiresAt,
  describeBottle,
  isInventoryBottleFeed,
  isUsable,
  nextContainerLabel,
  normalizeTapeLabel,
  suggestContainerLabel,
  tapeInUse,
  keepMl,
  ozText,
  parseAmountMl,
  portionMl,
  stashMl,
  suggestPlan,
  suggestedTotalMl,
  usableContainers,
  validateMilkRules,
  type BottleFeedArgs,
  type PumpingArgs,
} from '@/lib/milk'
import { ML_PER_FL_OZ, formatMilkOz } from '@/lib/format'
import type { PendingOp, PendingWrite } from '@/lib/queue'
import type { Feeding, MilkContainer, MilkDrawdown } from '@/lib/types'

// Ninguna aserción depende de la TZ del sistema: la caducidad se calcula en
// UTC (pedido del dueño: "idéntico en cualquier huso"), y `pnpm test:tz` corre
// este archivo bajo cuatro TZ.

const OZ = ML_PER_FL_OZ
const NOW = Date.parse('2026-10-04T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function container(label: string, remainingOz: number, over: Partial<MilkContainer> = {}) {
  const n = Number(label.slice(1))
  return {
    id: `c-${label}`,
    source_session_id: `s-${label}`,
    label,
    amount_ml: Math.max(remainingOz, 4) * OZ,
    remaining_ml: remainingOz * OZ,
    // M1 is the oldest: one hour per label number.
    stored_at: new Date(NOW - DAY + n * HOUR).toISOString(),
    location: 'fridge',
    expires_at: new Date(NOW + 2 * DAY).toISOString(),
    voided_at: null,
    ...over,
  } satisfies MilkContainer
}

function bottle(id: string, at: string, ml: number | null, over: Partial<Feeding> = {}): Feeding {
  return { id, fed_at: at, feeding_type: 'bottle', amount_ml: ml, notes: null, ...over }
}

let seq = 0
function queued(op: PendingOp): PendingWrite {
  seq += 1
  const at = new Date(NOW + seq * 1000).toISOString()
  return { id: `w${seq}`, schema: 'public', label: 'x', queuedAt: at, op }
}

function logPumpingOp(args: PumpingArgs): PendingOp {
  return {
    kind: 'rpc',
    fn: 'log_pumping_session',
    args,
    table: 'pumping_sessions',
    id: args.p_id,
    effect: 'insert',
    creates: args.p_container_id ? [args.p_container_id] : [],
  }
}
function updatePumpingOp(args: Omit<PumpingArgs, 'p_baby_id'>): PendingOp {
  return {
    kind: 'rpc',
    fn: 'update_pumping_session',
    args,
    table: 'pumping_sessions',
    id: args.p_id,
    effect: 'update',
    creates: args.p_container_id ? [args.p_container_id] : [],
  }
}
function voidPumpingOp(id: string): PendingOp {
  return {
    kind: 'rpc',
    fn: 'void_pumping_session',
    args: { p_id: id, p_voided_at: new Date(NOW).toISOString() },
    table: 'pumping_sessions',
    id,
    effect: 'delete',
  }
}
function logFeedOp(args: BottleFeedArgs): PendingOp {
  return {
    kind: 'rpc',
    fn: 'log_bottle_feed',
    args,
    table: 'feedings',
    id: args.p_id,
    effect: 'insert',
    refs: args.p_portions.map((p) => p.container_id),
  }
}
function voidFeedOp(id: string): PendingOp {
  return {
    kind: 'rpc',
    fn: 'void_bottle_feed',
    args: { p_feeding_id: id, p_voided_at: new Date(NOW).toISOString() },
    table: 'feedings',
    id,
    effect: 'delete',
  }
}
function feedArgs(id: string, portions: [string, number][], formulaMl = 0): BottleFeedArgs {
  return {
    p_id: id,
    p_baby_id: 'baby',
    p_fed_at: new Date(NOW).toISOString(),
    p_notes: null,
    p_formula_ml: formulaMl,
    p_portions: portions.map(([container_id, amount_ml]) => ({ container_id, amount_ml })),
  }
}
function pumpingArgs(id: string, leftMl: number | null, rightMl: number | null, label: string) {
  return {
    p_id: id,
    p_baby_id: 'baby',
    p_side: 'both',
    p_left_ml: leftMl,
    p_right_ml: rightMl,
    p_notes: null,
    p_pumped_at: new Date(NOW).toISOString(),
    p_container_id: (leftMl ?? 0) + (rightMl ?? 0) > 0 ? `c-${label}` : null,
    p_container_label: (leftMl ?? 0) + (rightMl ?? 0) > 0 ? label : null,
    p_container_expires_at: new Date(NOW + 4 * DAY).toISOString(),
  } satisfies PumpingArgs
}

// --------------------------------------------------------------- caducidad

describe('containerExpiresAt', () => {
  it('fridge: exact days, 24 h each', () => {
    expect(containerExpiresAt('2026-10-04T12:30:00.000Z', 'fridge', DEFAULT_MILK_RULES)).toBe(
      '2026-10-08T12:30:00.000Z',
    )
    expect(
      containerExpiresAt('2026-10-04T12:30:00.000Z', 'fridge', {
        ...DEFAULT_MILK_RULES,
        milk_fridge_days: 1.5,
      }),
    ).toBe('2026-10-06T00:30:00.000Z')
  })

  it('freezer: calendar months, same day and time', () => {
    expect(containerExpiresAt('2026-01-15T08:00:00.000Z', 'freezer', DEFAULT_MILK_RULES)).toBe(
      '2026-07-15T08:00:00.000Z',
    )
    // Crosses the year.
    expect(containerExpiresAt('2026-10-04T08:00:00.000Z', 'freezer', DEFAULT_MILK_RULES)).toBe(
      '2027-04-04T08:00:00.000Z',
    )
  })

  it('freezer: a day the target month does not have is clipped to its last day', () => {
    // Aug 31 + 6 months → Feb has no 31st: Feb 28 (2027 is not a leap year).
    expect(containerExpiresAt('2026-08-31T22:00:00.000Z', 'freezer', DEFAULT_MILK_RULES)).toBe(
      '2027-02-28T22:00:00.000Z',
    )
    // Leap year: Feb 29.
    expect(containerExpiresAt('2027-08-31T22:00:00.000Z', 'freezer', DEFAULT_MILK_RULES)).toBe(
      '2028-02-29T22:00:00.000Z',
    )
    // Never later: Mar 31 + 1 month = Apr 30, not May 1.
    expect(
      containerExpiresAt('2026-03-31T10:00:00.000Z', 'freezer', {
        ...DEFAULT_MILK_RULES,
        milk_freezer_months: 1,
      }),
    ).toBe('2026-04-30T10:00:00.000Z')
  })
})

// --------------------------------------------------------------- utilizables

describe('usable containers', () => {
  it('a voided, an empty and an expired container are not usable', () => {
    const ok = container('M1', 2)
    const voided = container('M2', 2, { voided_at: new Date(NOW).toISOString() })
    const empty = container('M3', 0)
    const expired = container('M4', 2, { expires_at: new Date(NOW - 1).toISOString() })
    expect(isUsable(ok, NOW)).toBe(true)
    expect(isUsable(voided, NOW)).toBe(false)
    expect(isUsable(empty, NOW)).toBe(false)
    expect(isUsable(expired, NOW)).toBe(false)
    expect(usableContainers([expired, empty, ok, voided], NOW).map((c) => c.label)).toEqual(['M1'])
  })

  it('expiry is exclusive: at the exact instant it is already expired', () => {
    const c = container('M1', 1, { expires_at: new Date(NOW).toISOString() })
    expect(isUsable(c, NOW)).toBe(false)
    expect(isUsable(c, NOW - 1)).toBe(true)
  })

  it('oldest first, then by label number', () => {
    const at = new Date(NOW - DAY).toISOString()
    const list = [
      container('M10', 1, { stored_at: at }),
      container('M2', 1, { stored_at: at }),
      container('M1', 1, { stored_at: new Date(NOW - 2 * DAY).toISOString() }),
    ]
    expect(usableContainers(list, NOW).map((c) => c.label)).toEqual(['M1', 'M2', 'M10'])
  })
})

// --------------------------------------------------------------- etiquetas

describe('nextContainerLabel', () => {
  it('starts at M1', () => {
    expect(nextContainerLabel([])).toBe('M1')
  })
  it('is one more than the highest, gaps are not filled', () => {
    expect(nextContainerLabel(['M1', 'M3'])).toBe('M4')
    expect(nextContainerLabel(['M9', 'M10', 'M2'])).toBe('M11')
  })
  it('ignores nulls and anything that is not an M label', () => {
    expect(nextContainerLabel([null, undefined, 'X7', 'M', 'M0x', 'M4'])).toBe('M5')
  })
})

// ------------------------------------------------- cinta elegida (5 oct 2026)

describe('normalizeTapeLabel', () => {
  it('accepts M and digits in either case, with spaces around or after the M', () => {
    expect(normalizeTapeLabel('m5')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel('M 5')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel('m 5')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel(' M5')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel('M5 ')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel('M12')).toEqual({ ok: true, label: 'M12' })
  })
  it('drops leading zeros, so the tape matches what the server stores', () => {
    expect(normalizeTapeLabel('M05')).toEqual({ ok: true, label: 'M5' })
    expect(normalizeTapeLabel('m007')).toEqual({ ok: true, label: 'M7' })
    expect(normalizeTapeLabel('M10')).toEqual({ ok: true, label: 'M10' })
  })
  it('an empty field is its own problem, so the screen can say what is missing', () => {
    expect(normalizeTapeLabel('')).toEqual({ ok: false, problem: 'empty' })
    expect(normalizeTapeLabel('   ')).toEqual({ ok: false, problem: 'empty' })
  })
  it('refuses M0 and anything that is not M followed by digits', () => {
    for (const bad of [
      'M0',
      'M00',
      'X5',
      'M',
      'M-5',
      '5',
      'M5a',
      'MM5',
      'M 5 6',
      'M5.5',
      'M\u0665',
    ]) {
      expect(normalizeTapeLabel(bad), bad).toEqual({ ok: false, problem: 'format' })
    }
  })
  it('refuses absurdly long numbers instead of storing them', () => {
    expect(normalizeTapeLabel('M999999')).toEqual({ ok: true, label: 'M999999' })
    expect(normalizeTapeLabel('M1000000')).toEqual({ ok: false, problem: 'format' })
  })
  it('every accepted label passes the same pattern the server checks', () => {
    for (const ok of ['m5', 'M 05', ' m12 ', 'M999999']) {
      const r = normalizeTapeLabel(ok)
      expect(r.ok && /^M[1-9][0-9]*$/.test(r.label), ok).toBe(true)
    }
  })
})

describe('suggestContainerLabel', () => {
  it('with a gap (M1 and M5) suggests M6, never the hole', () => {
    expect(suggestContainerLabel([container('M1', 1), container('M5', 1)])).toBe('M6')
  })
  it('voided containers do not count', () => {
    const voided = { voided_at: new Date(NOW).toISOString() }
    expect(suggestContainerLabel([container('M1', 1), container('M5', 1, voided)])).toBe('M2')
    expect(suggestContainerLabel([container('M3', 1, voided)])).toBe('M1')
  })
  it('an empty or expired container still holds its tape', () => {
    const expired = { expires_at: new Date(NOW - DAY).toISOString() }
    expect(suggestContainerLabel([container('M2', 0), container('M4', 1, expired)])).toBe('M5')
  })
  it('a queued (offline) container counts as soon as it is in the view', () => {
    const { containers } = applyPendingInventory(
      [container('M1', 1)],
      [],
      [queued(logPumpingOp(pumpingArgs('s-M5', 30, null, 'M5')))],
    )
    expect(suggestContainerLabel(containers)).toBe('M6')
  })
})

describe('tapeInUse', () => {
  const voided = { voided_at: new Date(NOW).toISOString() }
  it('a tape on a live container is in use', () => {
    expect(tapeInUse('M5', [container('M1', 1), container('M5', 1)])).toBe(true)
  })
  it('a live container with nothing left still holds its tape', () => {
    expect(tapeInUse('M5', [container('M5', 0)])).toBe(true)
  })
  it('the tape of a voided container can be used again (S-20)', () => {
    expect(tapeInUse('M5', [container('M1', 1), container('M5', 1, voided)])).toBe(false)
  })
  it('a free number above or in a gap is not in use', () => {
    expect(tapeInUse('M3', [container('M1', 1), container('M5', 1)])).toBe(false)
  })
  it('a queued container with a chosen tape is in use right away', () => {
    const { containers } = applyPendingInventory(
      [container('M1', 1)],
      [],
      [queued(logPumpingOp(pumpingArgs('s-M5', 30, 20, 'M5')))],
    )
    expect(tapeInUse('M5', containers)).toBe(true)
    expect(containers.find((c) => c.label === 'M5')).toMatchObject({ amount_ml: 50, pending: true })
  })
})

// --------------------------------------------------------------- sugerencia

describe('suggestedTotalMl', () => {
  it('with no bottle ever: the 3 oz starting value', () => {
    expect(DEFAULT_FIRST_SUGGESTION_ML).toBeCloseTo(3 * OZ, 6)
    expect(suggestedTotalMl([])).toBe(DEFAULT_FIRST_SUGGESTION_ML)
  })

  it('is the total of the LAST bottle feed, whatever its amount', () => {
    const feeds = [
      bottle('a', '2026-10-04T08:00:00Z', 4 * OZ),
      bottle('b', '2026-10-04T10:00:00Z', 2 * OZ),
      bottle('c', '2026-10-04T06:00:00Z', 5 * OZ),
    ]
    expect(suggestedTotalMl(feeds)).toBe(2 * OZ)
  })

  it('skips solids, nursing rows, voided rows and bottles without an amount', () => {
    const feeds: Feeding[] = [
      bottle('a', '2026-10-04T06:00:00Z', 3.5 * OZ),
      bottle('b', '2026-10-04T07:00:00Z', null),
      bottle('c', '2026-10-04T08:00:00Z', 6 * OZ, { feeding_type: 'solid' }),
      {
        ...bottle('d', '2026-10-04T09:00:00Z', 9 * OZ),
        voided_at: '2026-10-04T09:05:00Z',
      } as Feeding,
    ]
    expect(suggestedTotalMl(feeds)).toBe(3.5 * OZ)
  })

  it('a legacy bottle (no breakdown) counts the same as a new one', () => {
    expect(suggestedTotalMl([bottle('a', '2026-10-04T06:00:00Z', 2.5 * OZ)])).toBe(2.5 * OZ)
  })
})

describe('suggestPlan', () => {
  it('one container that covers it: all milk, no formula', () => {
    const plan = suggestPlan(3 * OZ, [container('M1', 4)], NOW)
    expect(plan.portions).toEqual([{ containerId: 'c-M1', label: 'M1', ml: 3 * OZ }])
    expect(plan.formulaMl).toBe(0)
    expect(plan.totalMl).toBeCloseTo(3 * OZ, 9)
  })

  it('the shortfall goes to formula — the owner’s example, M3 1.75 + 1.25', () => {
    const plan = suggestPlan(3 * OZ, [container('M3', 1.75)], NOW)
    expect(plan.portions.map((p) => [p.label, formatMilkOz(p.ml)])).toEqual([['M3', '1.75 oz']])
    expect(formatMilkOz(plan.formulaMl)).toBe('1.25 oz')
    expect(plan.portions[0].ml + plan.formulaMl).toBeCloseTo(3 * OZ, 9)
  })

  it('two containers: oldest first, combined', () => {
    const plan = suggestPlan(3 * OZ, [container('M2', 2), container('M1', 0.5)], NOW)
    expect(plan.portions.map((p) => p.label)).toEqual(['M1', 'M2'])
    expect(plan.portions[0].ml).toBeCloseTo(0.5 * OZ, 9)
    expect(plan.portions[1].ml).toBeCloseTo(2 * OZ, 9)
    expect(plan.formulaMl).toBeCloseTo(0.5 * OZ, 9)
  })

  it('four containers: takes what it needs, leaves the newest alone', () => {
    const plan = suggestPlan(
      4 * OZ,
      [container('M4', 3), container('M1', 1), container('M3', 1), container('M2', 1)],
      NOW,
    )
    expect(plan.portions.map((p) => [p.label, Number((p.ml / OZ).toFixed(6))])).toEqual([
      ['M1', 1],
      ['M2', 1],
      ['M3', 1],
      ['M4', 1],
    ])
    expect(plan.formulaMl).toBe(0)
    const tight = suggestPlan(
      2.5 * OZ,
      [container('M4', 3), container('M1', 1), container('M2', 1)],
      NOW,
    )
    expect(tight.portions.map((p) => p.label)).toEqual(['M1', 'M2', 'M4'])
    expect(tight.portions[2].ml).toBeCloseTo(0.5 * OZ, 9)
  })

  it('no usable milk: all formula, and an expired or voided container is not used', () => {
    const plan = suggestPlan(
      3 * OZ,
      [
        container('M1', 2, { expires_at: new Date(NOW - 1).toISOString() }),
        container('M2', 2, { voided_at: new Date(NOW).toISOString() }),
        container('M3', 0),
      ],
      NOW,
    )
    expect(plan.portions).toEqual([])
    expect(plan.formulaMl).toBeCloseTo(3 * OZ, 9)
  })

  it('a non-positive total suggests nothing at all', () => {
    expect(suggestPlan(0, [container('M1', 2)], NOW)).toEqual({
      portions: [],
      formulaMl: 0,
      totalMl: 0,
    })
  })
})

// --------------------------------------------------------------- stash

describe('stashMl', () => {
  it('sums what is left in usable containers only, in ml (shown as total oz)', () => {
    const list = [
      container('M1', 1.5),
      container('M2', 2.25),
      container('M3', 4, { expires_at: new Date(NOW - 1).toISOString() }),
      container('M4', 4, { voided_at: new Date(NOW).toISOString() }),
    ]
    expect(stashMl(list, NOW)).toBeCloseTo(3.75 * OZ, 9)
    expect(formatMilkOz(stashMl(list, NOW))).toBe('3.75 oz')
  })

  it('has no formula in it: a formula-only feed does not move it', () => {
    const list = [container('M1', 2)]
    const { containers } = applyPendingInventory(
      list,
      [],
      [queued(logFeedOp(feedArgs('f1', [], 3 * OZ)))],
    )
    expect(stashMl(containers, NOW)).toBeCloseTo(2 * OZ, 9)
  })

  it('nothing at all is 0', () => {
    expect(stashMl([], NOW)).toBe(0)
  })
})

// --------------------------------------------------------------- porciones

describe('portionMl', () => {
  it('typing exactly what the container shows takes all of it, in exact ml', () => {
    const c = container('M3', 0) // remaining set below
    const remaining = 51.7536
    expect(portionMl(1.75, 'oz', { ...c, remaining_ml: remaining })).toBe(remaining)
    expect(portionMl(52, 'ml', { ...c, remaining_ml: remaining })).toBe(remaining)
  })
  it('anything else is converted as typed', () => {
    const c = { ...container('M3', 2) }
    expect(portionMl(1, 'oz', c)).toBeCloseTo(OZ, 9)
    expect(portionMl(30, 'ml', c)).toBe(30)
    expect(portionMl(1, 'oz', null)).toBeCloseTo(OZ, 9)
  })
})

// --------------------------------------------------------------- pendientes

describe('applyPendingInventory', () => {
  const base = [container('M1', 2), container('M2', 3)]

  it('a queued pumping session with an amount adds its container, marked pending', () => {
    const { containers } = applyPendingInventory(
      base,
      [],
      [queued(logPumpingOp(pumpingArgs('s-M3', 40, 50, 'M3')))],
    )
    const m3 = containers.find((c) => c.label === 'M3')
    expect(m3).toMatchObject({ id: 'c-M3', amount_ml: 90, remaining_ml: 90, pending: true })
    expect(stashMl(containers, NOW)).toBeCloseTo(5 * OZ + 90, 9)
  })

  it('a queued pumping session without an amount adds nothing', () => {
    const { containers } = applyPendingInventory(
      base,
      [],
      [queued(logPumpingOp(pumpingArgs('s-x', null, null, 'M3')))],
    )
    expect(containers).toHaveLength(2)
  })

  it('a session without an amount that is later given one gets its container then', () => {
    const { containers } = applyPendingInventory(
      base,
      [],
      [
        queued(logPumpingOp(pumpingArgs('s-x', null, null, 'M3'))),
        queued(updatePumpingOp({ ...pumpingArgs('s-x', 30, null, 'M3') })),
      ],
    )
    expect(containers.find((c) => c.source_session_id === 's-x')).toMatchObject({
      label: 'M3',
      amount_ml: 30,
      remaining_ml: 30,
      pending: true,
    })
  })

  it('editing a session moves its container, keeping what was already served', () => {
    // M2 started at 3 oz and 1 oz was served: 2 oz left.
    const served = container('M2', 2, { amount_ml: 3 * OZ })
    const { containers } = applyPendingInventory(
      [served],
      [],
      [queued(updatePumpingOp({ ...pumpingArgs('s-M2', 2 * OZ, 2 * OZ, 'M2') }))],
    )
    expect(containers[0].amount_ml).toBeCloseTo(4 * OZ, 9)
    expect(containers[0].remaining_ml).toBeCloseTo(3 * OZ, 9)
    expect(containers[0].pending).toBe(true)
  })

  it('voiding a session voids its container', () => {
    const { containers } = applyPendingInventory(base, [], [queued(voidPumpingOp('s-M1'))])
    expect(containers.find((c) => c.label === 'M1')).toMatchObject({ pending: true })
    expect(containers.find((c) => c.label === 'M1')?.voided_at).toBeTruthy()
    expect(stashMl(containers, NOW)).toBeCloseTo(3 * OZ, 9)
  })

  it('a queued bottle takes each portion from its container and records it', () => {
    const { containers, drawdowns } = applyPendingInventory(
      base,
      [],
      [
        queued(
          logFeedOp(
            feedArgs(
              'f1',
              [
                ['c-M1', 2 * OZ],
                ['c-M2', 0.5 * OZ],
              ],
              0.5 * OZ,
            ),
          ),
        ),
      ],
    )
    expect(containers.find((c) => c.label === 'M1')?.remaining_ml).toBeCloseTo(0, 9)
    expect(containers.find((c) => c.label === 'M2')?.remaining_ml).toBeCloseTo(2.5 * OZ, 9)
    expect(drawdowns.map((d) => [d.feeding_id, d.label, d.pending])).toEqual([
      ['f1', 'M1', true],
      ['f1', 'M2', true],
    ])
    expect(stashMl(containers, NOW)).toBeCloseTo(2.5 * OZ, 9)
  })

  it('a bottle the server already applied is not taken twice', () => {
    const after = [container('M1', 0, { amount_ml: 2 * OZ }), container('M2', 3)]
    const server: MilkDrawdown[] = [
      { id: 'd1', feeding_id: 'f1', container_id: 'c-M1', amount_ml: 2 * OZ, label: 'M1' },
    ]
    const { containers, drawdowns } = applyPendingInventory(after, server, [
      queued(logFeedOp(feedArgs('f1', [['c-M1', 2 * OZ]]))),
    ])
    expect(containers.find((c) => c.label === 'M1')?.remaining_ml).toBe(0)
    expect(drawdowns).toHaveLength(1)
  })

  it('voiding a bottle gives every portion back to its container (restitution)', () => {
    const after = [
      container('M1', 0, { amount_ml: 2 * OZ }),
      container('M2', 2.5, { amount_ml: 3 * OZ }),
    ]
    const server: MilkDrawdown[] = [
      { id: 'd1', feeding_id: 'f1', container_id: 'c-M1', amount_ml: 2 * OZ, label: 'M1' },
      { id: 'd2', feeding_id: 'f1', container_id: 'c-M2', amount_ml: 0.5 * OZ, label: 'M2' },
    ]
    const { containers, drawdowns } = applyPendingInventory(after, server, [
      queued(voidFeedOp('f1')),
    ])
    expect(containers.find((c) => c.label === 'M1')?.remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(containers.find((c) => c.label === 'M2')?.remaining_ml).toBeCloseTo(3 * OZ, 9)
    expect(drawdowns.every((d) => d.voided_at)).toBe(true)
    expect(stashMl(containers, NOW)).toBeCloseTo(5 * OZ, 9)
  })

  it('a bottle logged and voided while offline leaves the stash where it was', () => {
    const { containers } = applyPendingInventory(
      base,
      [],
      [queued(logFeedOp(feedArgs('f1', [['c-M1', 1 * OZ]], 2 * OZ))), queued(voidFeedOp('f1'))],
    )
    expect(stashMl(containers, NOW)).toBeCloseTo(5 * OZ, 9)
  })

  it('giving back never goes over what the container started with', () => {
    const c = [container('M1', 2, { amount_ml: 2 * OZ })]
    const server: MilkDrawdown[] = [
      { id: 'd1', feeding_id: 'f1', container_id: 'c-M1', amount_ml: 1 * OZ, label: 'M1' },
    ]
    const { containers } = applyPendingInventory(c, server, [queued(voidFeedOp('f1'))])
    expect(containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
  })

  it('a bottle served from a container pumped offline uses that container', () => {
    const { containers } = applyPendingInventory(
      [],
      [],
      [
        queued(logPumpingOp(pumpingArgs('s-M1', 60, 60, 'M1'))),
        queued(logFeedOp(feedArgs('f1', [['c-M1', 100]], 0))),
      ],
    )
    expect(containers[0].remaining_ml).toBe(20)
  })

  it('does not change its inputs', () => {
    const list = [container('M1', 2)]
    applyPendingInventory(list, [], [queued(logFeedOp(feedArgs('f1', [['c-M1', 1 * OZ]])))])
    expect(list[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
  })

  it('ignores ops it has nothing to do with', () => {
    const { containers } = applyPendingInventory(
      base,
      [],
      [
        queued({ kind: 'insert', table: 'diaper_changes', row: { id: 'x' } }),
        queued({ kind: 'update', table: 'feedings', id: 'f9', patch: { fed_at: 'x' } }),
      ],
    )
    expect(containers.map((c) => c.pending)).toEqual([undefined, undefined])
  })
})

// --------------------------------------------------------------- tomas viejas

describe('isInventoryBottleFeed — legacy feeds stay editable', () => {
  it('a bottle with a breakdown is locked (time only)', () => {
    expect(
      isInventoryBottleFeed(bottle('a', 'x', 90, { breast_milk_ml: 60, formula_ml: 30 })),
    ).toBe(true)
    expect(isInventoryBottleFeed(bottle('a', 'x', 90, { breast_milk_ml: 0, formula_ml: 90 }))).toBe(
      true,
    )
  })
  it('a legacy bottle (no breakdown), a solid and a nursing row are not', () => {
    expect(isInventoryBottleFeed(bottle('a', 'x', 90))).toBe(false)
    expect(
      isInventoryBottleFeed(bottle('a', 'x', 90, { breast_milk_ml: null, formula_ml: null })),
    ).toBe(false)
    expect(isInventoryBottleFeed(bottle('a', 'x', null, { feeding_type: 'solid' }))).toBe(false)
  })
})

// --------------------------------------------------------------- texto

describe('describeBottle', () => {
  const feed = bottle('f1', 'x', 3 * OZ, { breast_milk_ml: 2.25 * OZ, formula_ml: 0.75 * OZ })
  const portions: MilkDrawdown[] = [
    { id: 'd2', feeding_id: 'f1', container_id: 'c-M4', amount_ml: 0.5 * OZ, label: 'M4' },
    { id: 'd1', feeding_id: 'f1', container_id: 'c-M3', amount_ml: 1.75 * OZ, label: 'M3' },
    { id: 'dx', feeding_id: 'other', container_id: 'c-M1', amount_ml: 1, label: 'M1' },
  ]
  it('several containers and formula, in English and Spanish', () => {
    expect(describeBottle(feed, portions, 'en')).toBe('M3 1.75 oz + M4 0.5 oz + formula 0.75 oz')
    expect(describeBottle(feed, portions, 'es')).toBe('M3 1.75 oz + M4 0.5 oz + fórmula 0.75 oz')
  })
  it('formula only, and milk only', () => {
    expect(
      describeBottle(bottle('f2', 'x', 90, { breast_milk_ml: 0, formula_ml: 3 * OZ }), [], 'en'),
    ).toBe('formula 3 oz')
    expect(
      describeBottle(
        bottle('f1', 'x', 90, { breast_milk_ml: 2.25 * OZ, formula_ml: 0 }),
        portions,
        'en',
      ),
    ).toBe('M3 1.75 oz + M4 0.5 oz')
  })
  it('a legacy bottle has no breakdown to describe', () => {
    expect(describeBottle(bottle('f9', 'x', 90), [], 'en')).toBeNull()
  })
})

// --------------------------------------------------------------- reglas

describe('validateMilkRules', () => {
  it('accepts the defaults and decimals for hours and days', () => {
    expect(validateMilkRules({ room: '4', fridge: '4', freezer: '6' })).toEqual({
      rules: { milk_room_hours: 4, milk_fridge_days: 4, milk_freezer_months: 6 },
    })
    expect(validateMilkRules({ room: '3.5', fridge: '2.5', freezer: '3' }).rules).toBeTruthy()
  })
  it('an empty field is never saved as 0', () => {
    expect(validateMilkRules({ room: '', fridge: '4', freezer: '6' })).toEqual({
      problem: 'empty',
      field: 'room',
    })
    expect(validateMilkRules({ room: '4', fridge: '  ', freezer: '6' }).field).toBe('fridge')
  })
  it('rejects zero, negatives, letters and out-of-range values', () => {
    expect(validateMilkRules({ room: '0', fridge: '4', freezer: '6' }).problem).toBe('range')
    expect(validateMilkRules({ room: '4', fridge: '-1', freezer: '6' }).problem).toBe('range')
    expect(validateMilkRules({ room: '4', fridge: 'abc', freezer: '6' }).problem).toBe('number')
    expect(validateMilkRules({ room: '25', fridge: '4', freezer: '6' }).problem).toBe('range')
    expect(validateMilkRules({ room: '4', fridge: '4', freezer: '1.5' })).toEqual({
      problem: 'whole',
      field: 'freezer',
    })
  })
})

describe('parseAmountMl / ozText / keepMl', () => {
  it('empty is nothing, never 0; a comma works as a decimal point', () => {
    expect(parseAmountMl('', 'oz')).toEqual({ ml: null })
    expect(parseAmountMl('  ', 'ml')).toEqual({ ml: null })
    expect(parseAmountMl('2', 'oz').ml).toBeCloseTo(2 * OZ, 9)
    expect(parseAmountMl('1,5', 'oz').ml).toBeCloseTo(1.5 * OZ, 9)
    expect(parseAmountMl('120', 'ml')).toEqual({ ml: 120 })
    expect(parseAmountMl('0', 'oz')).toEqual({ ml: 0 })
  })
  it('letters and negatives are a problem', () => {
    expect(parseAmountMl('abc', 'oz')).toEqual({ problem: 'number' })
    expect(parseAmountMl('-1', 'oz')).toEqual({ problem: 'number' })
    expect(parseAmountMl('Infinity', 'oz')).toEqual({ problem: 'number' })
  })
  it('an edit field left as prefilled keeps the exact stored ml', () => {
    expect(ozText(150)).toBe('5.07')
    expect(ozText(null)).toBe('')
    expect(keepMl('5.07', '5.07', 150)).toEqual({ ml: 150 })
    expect(keepMl('5', '5.07', 150).ml).toBeCloseTo(5 * OZ, 9)
    expect(keepMl('', '', null)).toEqual({ ml: null })
  })
})

describe('what float arithmetic leaves behind is not milk', () => {
  it('a container the screen would show as 0 oz is empty: not usable, not counted, not suggested', () => {
    const crumbs = container('M1', 0, { remaining_ml: 1e-10 })
    expect(isUsable(crumbs, NOW)).toBe(false)
    expect(stashMl([crumbs], NOW)).toBe(0)
    expect(suggestPlan(3 * OZ, [crumbs], NOW).portions).toEqual([])
    const shownAsZero = container('M2', 0, { remaining_ml: 0.14 })
    expect(isUsable(shownAsZero, NOW)).toBe(false)
    expect(formatMilkOz(0.14)).toBe('0 oz')
    expect(isUsable(container('M3', 0, { remaining_ml: 0.3 }), NOW)).toBe(true)
  })
})
