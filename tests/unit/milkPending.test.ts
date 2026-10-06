import { describe, expect, it } from 'vitest'
import {
  amountText,
  applyPendingInventory,
  convertAmountText,
  parseAmountMl,
  readPumpingSides,
  stashMl,
  type BottleFeedArgs,
  type DiscardArgs,
  type EditBottleArgs,
  type PumpingArgs,
} from '@/lib/milk'
import { EMPTY_ML, bottleSlots, milkInvariantFailures, planBottleEdit } from '@/lib/milkBottles'
import { ML_PER_FL_OZ } from '@/lib/format'
import { dependentsOf, type PendingOp, type PendingWrite } from '@/lib/queue'
import type { MilkContainer, MilkDiscard, MilkDrawdown } from '@/lib/types'

// La vista sin conexión de v4 (docs/arquitectura-v4.md §7.3) y la entrada de
// izquierdo/derecho en oz o ml (V4-01, D-19, AJ-16). Reloj inyectado: la hora
// de cada operación es su `queuedAt`.

const OZ = ML_PER_FL_OZ
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const MON = Date.parse('2026-10-05T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

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
const portion = (feedingId: string, label: string, ml: number): MilkDrawdown => ({
  id: `${feedingId}:c-${label}`,
  feeding_id: feedingId,
  container_id: `c-${label}`,
  amount_ml: ml,
  label,
  voided_at: null,
})

let seq = 0
function queued(op: PendingOp, atMs?: number): PendingWrite {
  seq += 1
  return {
    id: `w${seq}`,
    schema: 'public',
    label: 'x',
    queuedAt: iso(atMs ?? NOW + seq * 1000),
    op,
  }
}
const rpc = (fn: string, args: object, rest: Partial<Extract<PendingOp, { kind: 'rpc' }>>) =>
  ({ kind: 'rpc', fn, args, table: 'x', id: 'x', effect: 'insert', ...rest }) as PendingOp

function pumpOp(id: string, ml: number, label: string, atMs = NOW): PendingOp {
  const args: PumpingArgs = {
    p_id: id,
    p_baby_id: 'b',
    p_side: 'both',
    p_left_ml: ml,
    p_right_ml: null,
    p_notes: null,
    p_pumped_at: iso(atMs),
    p_container_id: `c-${label}`,
    p_container_label: label,
    p_container_expires_at: iso(atMs + 4 * DAY),
  }
  return rpc('log_pumping_session', args, {
    table: 'pumping_sessions',
    id,
    creates: [`c-${label}`],
  })
}
function updatePumpOp(id: string, ml: number, label: string, atMs = MON): PendingOp {
  return rpc(
    'update_pumping_session',
    {
      p_id: id,
      p_side: 'left',
      p_left_ml: ml,
      p_right_ml: null,
      p_notes: null,
      p_pumped_at: iso(atMs),
      p_container_id: `c-${label}`,
      p_container_label: label,
      p_container_expires_at: iso(atMs + 4 * DAY),
    },
    { table: 'pumping_sessions', id, effect: 'update' },
  )
}
const voidPumpOp = (id: string) =>
  rpc('void_pumping_session', { p_id: id }, { table: 'pumping_sessions', id, effect: 'delete' })
function discardOp(id: string, label: string, atMs: number | null = NOW): PendingOp {
  const args: DiscardArgs = {
    p_id: id,
    p_container_id: `c-${label}`,
    p_discarded_at: atMs === null ? null : iso(atMs),
  }
  return rpc('discard_container', args, {
    table: 'milk_discards',
    id,
    refs: [`c-${label}`],
  })
}
function feedOp(
  id: string,
  portions: [string, number][],
  formulaMl = 0,
  leftover?: number,
): PendingOp {
  const args: BottleFeedArgs = {
    p_id: id,
    p_baby_id: 'b',
    p_fed_at: iso(NOW),
    p_notes: null,
    p_formula_ml: formulaMl,
    p_portions: portions.map(([label, amount_ml]) => ({ container_id: `c-${label}`, amount_ml })),
    p_leftover_ml: leftover ?? null,
  }
  return rpc('log_bottle_feed', args, {
    table: 'feedings',
    id,
    refs: portions.map(([l]) => `c-${l}`),
  })
}
const voidFeedOp = (id: string) =>
  rpc('void_bottle_feed', { p_feeding_id: id }, { table: 'feedings', id, effect: 'delete' })
function editOp(
  opId: string,
  feedingId: string,
  breastMl: number,
  formulaMl = 0,
  fedAt = NOW,
  refs: string[] = [],
): PendingOp {
  const args: EditBottleArgs = {
    p_op_id: opId,
    p_feeding_id: feedingId,
    p_fed_at: iso(fedAt),
    p_breast_ml: breastMl,
    p_formula_ml: formulaMl,
    p_leftover_ml: null,
    p_notes: null,
    p_expected: { fed_at: iso(fedAt), breast_milk_ml: null, formula_ml: null, leftover_ml: null },
  }
  return rpc('edit_bottle_feed', args, { table: 'feedings', id: feedingId, effect: 'update', refs })
}
const ok = (r: ReturnType<typeof applyPendingInventory>) =>
  milkInvariantFailures({ containers: r.containers, drawdowns: r.drawdowns, discards: r.discards })

// --------------------------------------------------------------- the queue

describe('applyPendingInventory v4 (U-49…U-57)', () => {
  it('U-49: a queued pumping session in M3 → a pending, occupied container holding M3', () => {
    const r = applyPendingInventory([], [], [], [queued(pumpOp('s-M3', 2 * OZ, 'M3'))])
    expect(r.containers[0]).toMatchObject({
      label: 'M3',
      pending: true,
      released_at: null,
      lost_ml: 0,
    })
    const slot = bottleSlots(6, r.containers, r.discards, NOW + DAY).slots[2]
    expect(slot).toMatchObject({ state: 'occupied', disabled: true, pending: true })
    expect(ok(r)).toEqual([])
  })

  it('U-50: a queued discard of an expired M3 → pending discard of all of it, M3 at 0 and free', () => {
    const m3 = box('M3', { expires_at: iso(NOW - HOUR), remaining_ml: 1.5 * OZ, amount_ml: 3 * OZ })
    const draws = [portion('f0', 'M3', 1.5 * OZ)]
    const w = queued(discardOp('x1', 'M3', NOW))
    const r = applyPendingInventory([m3], draws, [], [w])
    expect(r.discards).toEqual([
      {
        id: 'x1',
        container_id: 'c-M3',
        amount_ml: 1.5 * OZ,
        discarded_at: iso(NOW),
        reason: 'expired',
        label: 'M3',
        voided_at: null,
        pending: true,
      },
    ])
    expect(r.containers[0]).toMatchObject({
      remaining_ml: 0,
      released_at: w.queuedAt,
      pending: true,
    })
    expect(bottleSlots(6, r.containers, r.discards, NOW).slots[2].state).toBe('free')
    expect(stashMl(r.containers, NOW)).toBe(0)
    expect(ok(r)).toEqual([])
  })

  it('a discard queued with no time of its own uses the time it was queued', () => {
    const m3 = box('M3', { expires_at: iso(NOW - HOUR) })
    const w = queued(discardOp('x1', 'M3', null), NOW)
    expect(applyPendingInventory([m3], [], [], [w]).discards[0].discarded_at).toBe(iso(NOW))
  })

  it('U-51: a discard the server already lists is not applied twice', () => {
    const m3 = box('M3', { remaining_ml: 0, released_at: iso(NOW), expires_at: iso(NOW - HOUR) })
    const listed: MilkDiscard = {
      id: 'x1',
      container_id: 'c-M3',
      amount_ml: 3 * OZ,
      discarded_at: iso(NOW),
      reason: 'expired',
      label: 'M3',
    }
    const r = applyPendingInventory([m3], [], [listed], [queued(discardOp('x1', 'M3'))])
    expect(r.discards).toHaveLength(1)
    expect(r.discards[0].pending).toBe(true)
    expect(r.containers[0].remaining_ml).toBe(0)
  })

  it('U-51 / CL-15: discarded by the other phone with another id → no second discard', () => {
    const m3 = box('M3', { remaining_ml: 0, released_at: iso(NOW), expires_at: iso(NOW - HOUR) })
    const other: MilkDiscard = {
      id: 'other',
      container_id: 'c-M3',
      amount_ml: 3 * OZ,
      discarded_at: iso(NOW),
      reason: 'expired',
    }
    const r = applyPendingInventory([m3], [], [other], [queued(discardOp('mine', 'M3'))])
    expect(r.discards.map((d) => d.id)).toEqual(['other'])
    expect(r.unapplied).toEqual([])
  })

  it('U-52: a discard of M3 that for this phone has not expired changes nothing (D-6)', () => {
    const m3 = box('M3', { expires_at: iso(NOW + HOUR) })
    const w = queued(discardOp('x1', 'M3', NOW))
    const r = applyPendingInventory([m3], [], [], [w])
    expect(r.discards).toEqual([])
    expect(r.containers).toEqual([m3])
    expect(r.unapplied).toEqual([
      { writeId: w.id, fn: 'discard_container', problem: 'milk_not_expired' },
    ])
  })

  it('a discard of a container with only dust left frees it without a discard row', () => {
    const m3 = box('M3', { remaining_ml: 0.1, expires_at: iso(NOW - HOUR) })
    const r = applyPendingInventory([m3], [], [], [queued(discardOp('x1', 'M3'))])
    expect(r.discards).toEqual([])
    expect(r.containers[0]).toMatchObject({ remaining_ml: 0, pending: true })
    expect(r.containers[0].released_at).toBeTruthy()
  })

  it('U-53: a queued bottle that empties M3 releases it, pending', () => {
    const m3 = box('M3', { remaining_ml: 2 * OZ, amount_ml: 2 * OZ })
    const w = queued(feedOp('f1', [['M3', 2 * OZ]], 0, OZ))
    const r = applyPendingInventory([m3], [], [], [w])
    expect(r.containers[0]).toMatchObject({
      remaining_ml: 0,
      released_at: w.queuedAt,
      pending: true,
    })
    expect(bottleSlots(6, r.containers, r.discards, NOW).slots[2].state).toBe('free')
    expect(ok(r)).toEqual([])
  })

  it('U-53 / CL-8: a bottle that leaves 0.1 ml releases it too; "sobró" moves nothing', () => {
    const m3 = box('M3', { remaining_ml: 2 * OZ, amount_ml: 2 * OZ })
    const r = applyPendingInventory(
      [m3],
      [],
      [],
      [queued(feedOp('f1', [['M3', 2 * OZ - 0.1]], 0, OZ))],
    )
    expect(r.containers[0].remaining_ml).toBeCloseTo(0.1, 9)
    expect(r.containers[0].released_at).toBeTruthy()
    expect(stashMl(r.containers, NOW)).toBe(0)
  })

  it('U-54: voiding a bottle with M3 free → M3 is occupied again (CL-9)', () => {
    const m3 = box('M3', { remaining_ml: 0, amount_ml: 2 * OZ, released_at: iso(MON + HOUR) })
    const r = applyPendingInventory(
      [m3],
      [portion('f1', 'M3', 2 * OZ)],
      [],
      [queued(voidFeedOp('f1'))],
    )
    expect(r.containers[0]).toMatchObject({ released_at: null, pending: true })
    expect(r.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(r.lost).toEqual([])
    expect(ok(r)).toEqual([])
  })

  it('U-54: …and with M3 already holding another session → lost, never two M3 (CL-10)', () => {
    const m3 = box('M3', { remaining_ml: 0, amount_ml: 2 * OZ, released_at: iso(MON + HOUR) })
    const again = box('M3', { id: 'c-M3b', source_session_id: 's-M3b' })
    const w = queued(voidFeedOp('f1'))
    const r = applyPendingInventory([m3, again], [portion('f1', 'M3', 2 * OZ)], [], [w])
    expect(r.containers[0]).toMatchObject({ remaining_ml: 0, released_at: iso(MON + HOUR) })
    expect(r.containers[0].lost_ml).toBeCloseTo(2 * OZ, 9)
    expect(r.lost).toEqual([
      {
        writeId: w.id,
        containerId: 'c-M3',
        label: 'M3',
        ml: expect.closeTo(2 * OZ, 9),
        reason: 'reused',
      },
    ])
    expect(r.containers.filter((c) => c.label === 'M3' && !c.released_at)).toHaveLength(1)
    expect(ok(r)).toEqual([])
  })

  it('U-54: milk of a voided bottle from a discarded container is lost (D-9)', () => {
    const m3 = box('M3', {
      remaining_ml: 0,
      amount_ml: 3 * OZ,
      released_at: iso(NOW),
      expires_at: iso(NOW - HOUR),
    })
    const listed: MilkDiscard = {
      id: 'x',
      container_id: 'c-M3',
      amount_ml: OZ,
      discarded_at: iso(NOW),
      reason: 'expired',
    }
    const r = applyPendingInventory(
      [m3],
      [portion('f1', 'M3', 2 * OZ)],
      [listed],
      [queued(voidFeedOp('f1'))],
    )
    expect(r.lost.map((l) => l.reason)).toEqual(['discarded'])
    expect(r.discards[0].amount_ml).toBe(OZ)
    expect(ok(r)).toEqual([])
  })

  it('U-55: an edit down and an edit up give the same portions as planBottleEdit', () => {
    const m3 = box('M3', { stored_at: iso(MON), amount_ml: 4 * OZ, remaining_ml: OZ })
    const m5 = box('M5', { stored_at: iso(MON + HOUR) })
    const draws = [portion('f1', 'M3', 3 * OZ)]
    const fedAt = MON + 2 * HOUR
    for (const breast of [2 * OZ, 5 * OZ]) {
      const w = queued(editOp(`e${breast}`, 'f1', breast, 0, fedAt), NOW)
      const r = applyPendingInventory([m3, m5], draws, [], [w])
      const plan = planBottleEdit(
        {
          id: 'f1',
          fed_at: iso(fedAt),
          feeding_type: 'bottle',
          breast_milk_ml: 3 * OZ,
          formula_ml: 0,
        },
        draws,
        [m3, m5],
        [],
        { fed_at: iso(fedAt), breast_milk_ml: breast, formula_ml: 0, leftover_ml: null },
        NOW,
      )
      if (!plan.ok) throw new Error(plan.problem)
      const mine = r.drawdowns.filter((d) => d.feeding_id === 'f1' && !d.voided_at)
      expect(mine.map((d) => [d.container_id, d.amount_ml])).toEqual(
        plan.drawdowns
          .filter((d) => d.feeding_id === 'f1' && !d.voided_at)
          .map((d) => [d.container_id, d.amount_ml]),
      )
      expect(mine.every((d) => d.pending)).toBe(true)
      expect(r.containers.map((c) => c.remaining_ml)).toEqual(
        plan.containers.map((c) => c.remaining_ml),
      )
      expect(ok(r)).toEqual([])
    }
  })

  it('U-55: an edit the server already applied (portions already as asked) moves nothing: Δ = 0', () => {
    const m3 = box('M3', { amount_ml: 4 * OZ, remaining_ml: 2 * OZ })
    const draws = [portion('f1', 'M3', 2 * OZ)]
    const r = applyPendingInventory(
      [m3],
      draws,
      [],
      [queued(editOp('e1', 'f1', 2 * OZ, 0, MON + HOUR), NOW)],
    )
    expect(r.containers[0].remaining_ml).toBe(2 * OZ)
    expect(r.drawdowns[0].amount_ml).toBe(2 * OZ)
    expect(r.unapplied).toEqual([])
  })

  it('U-56: an edit that needs more milk than there is applies nothing; the bottle shows pending', () => {
    const m3 = box('M3', { amount_ml: 4 * OZ, remaining_ml: OZ })
    const draws = [portion('f1', 'M3', 3 * OZ)]
    const w = queued(editOp('e1', 'f1', 9 * OZ, 0, MON + HOUR), NOW)
    const r = applyPendingInventory([m3], draws, [], [w])
    expect(r.containers[0]).toEqual(m3)
    expect(r.drawdowns[0]).toMatchObject({ amount_ml: 3 * OZ, pending: true })
    expect(r.unapplied).toEqual([{ writeId: w.id, fn: 'edit_bottle_feed', problem: 'not_enough' }])
  })

  it('U-57: does not change its inputs', () => {
    const cs = [
      box('M3', { expires_at: iso(NOW - HOUR) }),
      box('M4', { remaining_ml: 0, released_at: iso(MON) }),
    ]
    const ds = [portion('f1', 'M4', 3 * OZ)]
    const dc: MilkDiscard[] = []
    const before = JSON.stringify([cs, ds, dc])
    applyPendingInventory(cs, ds, dc, [
      queued(discardOp('x1', 'M3')),
      queued(voidFeedOp('f1')),
      queued(editOp('e1', 'f1', OZ, 0, MON + HOUR)),
      queued(updatePumpOp('s-M4', 4 * OZ, 'M4')),
    ])
    expect(JSON.stringify([cs, ds, dc])).toBe(before)
  })

  it('the v3 three-argument form still works and returns no discards', () => {
    const r = applyPendingInventory([box('M1')], [], [queued(feedOp('f1', [['M1', OZ]]))])
    expect(r.discards).toEqual([])
    expect(r.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
  })
})

describe('applyPendingInventory — pumping edits on a discarded or freed bottle', () => {
  it('D-8: a discarded session edited up grows the discard, remaining stays 0', () => {
    const m3 = box('M3', {
      amount_ml: 3 * OZ,
      remaining_ml: 0,
      released_at: iso(NOW),
      expires_at: iso(NOW - HOUR),
    })
    const listed: MilkDiscard = {
      id: 'x',
      container_id: 'c-M3',
      amount_ml: 2 * OZ,
      discarded_at: iso(NOW),
      reason: 'expired',
    }
    const r = applyPendingInventory(
      [m3],
      [portion('f0', 'M3', OZ)],
      [listed],
      [queued(updatePumpOp('s-M3', 4 * OZ, 'M3'))],
    )
    expect(r.discards[0].amount_ml).toBeCloseTo(3 * OZ, 9)
    expect(r.discards[0].pending).toBe(true)
    expect(r.containers[0]).toMatchObject({ remaining_ml: 0, amount_ml: 4 * OZ })
    expect(ok(r)).toEqual([])
  })

  it('V4-19: below what was served is refused (not applied); the split alone moves nothing', () => {
    const m2 = box('M2', { amount_ml: 3 * OZ, remaining_ml: OZ })
    const w = queued(updatePumpOp('s-M2', 1.5 * OZ, 'M2'))
    const r = applyPendingInventory([m2], [portion('f0', 'M2', 2 * OZ)], [], [w])
    expect(r.containers[0].amount_ml).toBe(3 * OZ)
    expect(r.unapplied).toEqual([
      { writeId: w.id, fn: 'update_pumping_session', problem: 'milk_served_exceeds_amount' },
    ])
    const same = applyPendingInventory([m2], [], [], [queued(updatePumpOp('s-M2', 3 * OZ, 'M2'))])
    expect(same.containers[0].remaining_ml).toBe(OZ)
  })

  it('V4-19: up to 3.5 oz with 2 served → 1.5 oz left (papá’s example)', () => {
    const m2 = box('M2', { amount_ml: 3 * OZ, remaining_ml: OZ })
    const r = applyPendingInventory(
      [m2],
      [portion('f0', 'M2', 2 * OZ)],
      [],
      [queued(updatePumpOp('s-M2', 3.5 * OZ, 'M2'))],
    )
    expect(r.containers[0].remaining_ml).toBeCloseTo(1.5 * OZ, 9)
  })

  it('D-9: a freed session edited up while its number is reused → lost, not back on the shelf', () => {
    const m3 = box('M3', { amount_ml: 2 * OZ, remaining_ml: 0, released_at: iso(MON + HOUR) })
    const again = box('M3', { id: 'c-M3b', source_session_id: 's-M3b' })
    const r = applyPendingInventory(
      [m3, again],
      [portion('f0', 'M3', 2 * OZ)],
      [],
      [queued(updatePumpOp('s-M3', 3 * OZ, 'M3'))],
    )
    expect(r.containers[0].lost_ml).toBeCloseTo(OZ, 9)
    expect(stashMl(r.containers, NOW - DAY)).toBeCloseTo(3 * OZ, 9)
    expect(ok(r)).toEqual([])
  })

  it('CL-17: voiding a discarded, unserved session voids its discard too (the total goes down)', () => {
    const m3 = box('M3', { remaining_ml: 0, released_at: iso(NOW), expires_at: iso(NOW - HOUR) })
    const listed: MilkDiscard = {
      id: 'x',
      container_id: 'c-M3',
      amount_ml: 3 * OZ,
      discarded_at: iso(NOW),
      reason: 'expired',
    }
    const r = applyPendingInventory([m3], [], [listed], [queued(voidPumpOp('s-M3'))])
    expect(r.containers[0].voided_at).toBeTruthy()
    expect(r.discards[0]).toMatchObject({ pending: true })
    expect(r.discards[0].voided_at).toBeTruthy()
  })
})

// --------------------------------------------------------------- two ops, one bottle

describe('two queued writes on the same bottle (rules 21–22, offline)', () => {
  it('two discards of M3 with different ids → one discard', () => {
    const m3 = box('M3', { expires_at: iso(NOW - HOUR) })
    const r = applyPendingInventory(
      [m3],
      [],
      [],
      [queued(discardOp('a', 'M3')), queued(discardOp('b', 'M3'))],
    )
    expect(r.discards.map((d) => d.id)).toEqual(['a'])
    expect(ok(r)).toEqual([])
  })

  it('two bottles from M3 that together want more than it has: the second only empties it', () => {
    const m3 = box('M3', { amount_ml: 3 * OZ, remaining_ml: 3 * OZ })
    const r = applyPendingInventory(
      [m3],
      [],
      [],
      [queued(feedOp('f1', [['M3', 2 * OZ]])), queued(feedOp('f2', [['M3', 2 * OZ]]))],
    )
    expect(r.containers[0].remaining_ml).toBe(0)
    expect(r.containers[0].released_at).toBeTruthy()
    expect(r.drawdowns.map((d) => d.feeding_id)).toEqual(['f1', 'f2'])
  })

  it('D-22: discarded, then a bottle from it queued on the same phone → nothing more comes out', () => {
    const m3 = box('M3', { expires_at: iso(NOW - HOUR), remaining_ml: 2 * OZ, amount_ml: 2 * OZ })
    const r = applyPendingInventory(
      [m3],
      [],
      [],
      [queued(discardOp('a', 'M3')), queued(feedOp('f1', [['M3', OZ]]))],
    )
    expect(r.containers[0].remaining_ml).toBe(0)
    expect(r.discards[0].amount_ml).toBe(2 * OZ)
  })

  it('two edits of one bottle: the second plans on top of the first', () => {
    const m3 = box('M3', { stored_at: iso(MON), amount_ml: 4 * OZ, remaining_ml: OZ })
    const draws = [portion('f1', 'M3', 3 * OZ)]
    const r = applyPendingInventory(
      [m3],
      draws,
      [],
      [
        queued(editOp('e1', 'f1', 2 * OZ, 0, MON + HOUR), NOW),
        queued(editOp('e2', 'f1', 2.5 * OZ, 0, MON + HOUR), NOW + 1),
      ],
    )
    expect(r.drawdowns[0].amount_ml).toBeCloseTo(2.5 * OZ, 9)
    expect(r.containers[0].remaining_ml).toBeCloseTo(1.5 * OZ, 9)
    expect(ok(r)).toEqual([])
  })

  it('a bottle logged offline and then edited offline: the edit sees the queued portions', () => {
    const m3 = box('M3')
    const r = applyPendingInventory(
      [m3],
      [],
      [],
      [
        queued(feedOp('f1', [['M3', 2 * OZ]]), NOW),
        queued(editOp('e1', 'f1', OZ, 0, NOW), NOW + 1),
      ],
    )
    expect(r.drawdowns[0].amount_ml).toBeCloseTo(OZ, 9)
    expect(r.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
  })

  it('two sessions queued into M3 on two phones: the slot keeps one, the server will refuse the other', () => {
    const a = applyPendingInventory(
      [],
      [],
      [],
      [queued(pumpOp('s1', OZ, 'M3')), queued(pumpOp('s2', OZ, 'M3b'))],
    )
    // Different ids, same number: build it by hand (labels come from the op).
    const two = a.containers.map((c, i) => ({ ...c, label: 'M3', stored_at: iso(NOW + i) }))
    const slot = bottleSlots(6, two, [], NOW).slots[2]
    expect(slot.container?.id).toBe('c-M3')
  })
})

// --------------------------------------------------------------- U-58

describe('dependentsOf with the v4 calls (U-58)', () => {
  it('discarding a refused pumping session takes the discard and the edit that refer to its container', () => {
    const pump = queued(pumpOp('s-M3', 2 * OZ, 'M3'))
    const discard = queued(discardOp('x1', 'M3'))
    const edit = queued(editOp('e1', 'f9', OZ, 0, NOW, ['c-M3']))
    const unrelated = queued(discardOp('x2', 'M4'))
    expect(dependentsOf(pump, [pump, discard, edit, unrelated]).map((w) => w.id)).toEqual([
      discard.id,
      edit.id,
    ])
  })
  it('discarding a refused bottle takes its later edit and its void', () => {
    const feedW = queued(feedOp('f1', [['M3', OZ]]))
    const edit = queued(editOp('e1', 'f1', OZ))
    const voidW = queued(voidFeedOp('f1'))
    const fixed = (w: PendingWrite) =>
      ({ ...w, op: { ...w.op, table: 'feedings' } }) as PendingWrite
    expect(dependentsOf(fixed(feedW), [feedW, edit, voidW].map(fixed)).map((w) => w.id)).toEqual([
      edit.id,
      voidW.id,
    ])
  })
})

// --------------------------------------------------------------- sides & units

describe('left and right, each in oz or ml (U-45, U-46, V4-01)', () => {
  it('U-45: left 2 oz and right 60 ml → 59.147 and 60 exactly, total the sum', () => {
    const r = readPumpingSides({ text: '2', unit: 'oz' }, { text: '60', unit: 'ml' })
    if (r.problem) throw new Error(r.problem)
    expect(r.leftMl).toBe(2 * OZ)
    expect(r.rightMl).toBe(60)
    expect(r.totalMl).toBe(2 * OZ + 60)
    expect(r.needsBottle).toBe(true)
  })

  it('CL-1: one side empty is null, never 0; CL-2: both 0 or both empty → no bottle needed', () => {
    const one = readPumpingSides({ text: '1.5', unit: 'oz' }, { text: '', unit: 'ml' })
    expect(one).toMatchObject({ rightMl: null, needsBottle: true })
    expect(readPumpingSides({ text: '0', unit: 'oz' }, { text: '0', unit: 'ml' })).toMatchObject({
      leftMl: 0,
      rightMl: 0,
      totalMl: 0,
      needsBottle: false,
    })
    expect(readPumpingSides({ text: ' ', unit: 'oz' }, { text: '', unit: 'oz' })).toMatchObject({
      leftMl: null,
      rightMl: null,
      needsBottle: false,
    })
  })

  it('U-46 / CL-3: -1, 1e400, abc, Infinity are "number" problems, naming the side', () => {
    for (const bad of ['-1', '1e400', 'abc', 'Infinity', '-Infinity', 'NaN']) {
      expect(parseAmountMl(bad, 'oz')).toEqual({ problem: 'number' })
      expect(readPumpingSides({ text: bad, unit: 'oz' }, { text: '1', unit: 'oz' })).toEqual({
        problem: 'number',
        field: 'left',
      })
      expect(readPumpingSides({ text: '1', unit: 'ml' }, { text: bad, unit: 'ml' })).toEqual({
        problem: 'number',
        field: 'right',
      })
    }
  })

  it('a comma is a decimal point on either side', () => {
    const r = readPumpingSides({ text: '1,5', unit: 'oz' }, { text: '30,5', unit: 'ml' })
    expect(r).toMatchObject({ leftMl: 1.5 * OZ, rightMl: 30.5 })
  })
})

describe('convertAmountText (U-47, U-48, D-19, AJ-16)', () => {
  it('U-47: 2 oz → ml → oz comes back to 2; empty stays empty', () => {
    const ml = convertAmountText('2', 'oz', 'ml')
    expect(ml).toBe('59')
    expect(convertAmountText(ml, 'ml', 'oz')).toBe('2')
    expect(convertAmountText('', 'oz', 'ml')).toBe('')
    expect(convertAmountText('  ', 'ml', 'oz')).toBe('  ')
  })

  it('U-48: 150 ml → 5.07 oz', () => {
    expect(convertAmountText('150', 'ml', 'oz')).toBe('5.07')
  })

  it('something that is not a number is left as typed; the same unit changes nothing', () => {
    expect(convertAmountText('abc', 'oz', 'ml')).toBe('abc')
    expect(convertAmountText('2.333', 'oz', 'oz')).toBe('2.333')
    expect(convertAmountText('0', 'oz', 'ml')).toBe('')
  })

  it('every whole ml from 60 to 240 survives ml → oz → ml', () => {
    for (let ml = 60; ml <= 240; ml++) {
      const oz = convertAmountText(String(ml), 'ml', 'oz')
      expect(convertAmountText(oz, 'oz', 'ml')).toBe(String(ml))
    }
  })

  it('every 0.01 oz from 2 to 8 survives oz → ml → oz (3 oz is 88.7 ml, not 89 → 3.01)', () => {
    expect(convertAmountText('3', 'oz', 'ml')).toBe('88.7')
    expect(convertAmountText('88.7', 'ml', 'oz')).toBe('3')
    for (let cents = 200; cents <= 800; cents++) {
      const oz = String(cents / 100)
      expect(convertAmountText(convertAmountText(oz, 'oz', 'ml'), 'ml', 'oz')).toBe(oz)
    }
  })

  it('a converted ml text still parses to (almost) the same milk: within half a ml', () => {
    for (let cents = 200; cents <= 800; cents++) {
      const ml = parseAmountMl(convertAmountText(String(cents / 100), 'oz', 'ml'), 'ml').ml!
      expect(Math.abs(ml - (cents / 100) * OZ)).toBeLessThanOrEqual(0.5)
    }
  })

  it('amountText: two decimals in oz, whole ml, nothing for zero', () => {
    expect(amountText(51.7536, 'oz')).toBe('1.75')
    expect(amountText(51.7536, 'ml')).toBe('52')
    expect(amountText(0, 'oz')).toBe('')
    expect(amountText(-1, 'ml')).toBe('')
  })

  it('EMPTY_ML: 0.15 ml shows as 0.01 oz but is not milk; 0.14 ml shows as nothing', () => {
    expect(amountText(EMPTY_ML, 'oz')).toBe('0.01')
    expect(amountText(EMPTY_ML - 0.01, 'oz')).toBe('0')
  })
})
