import { describe, expect, it } from 'vitest'
import { applyPendingFormula, applyPendingInventory } from '@/lib/milk'
import { milkInvariantFailures } from '@/lib/milkBottles'
import { isCold } from '@/lib/milkCooling'
import { formulaStock } from '@/lib/formulaStock'
import { startedBottle } from '@/lib/startedBottle'
import {
  addFormulaOp,
  combineMilkOp,
  discardStartedBottleOp,
  finishFormulaOp,
  logBottleFeedOp,
  logPumpingOp,
  markMilkColdOp,
  openFormulaOp,
  uncombineMilkOp,
  voidBottleFeedOp,
  voidFormulaOp,
} from '@/lib/db'
import { DEFAULT_MILK_RULES } from '@/lib/milk'
import { FORMULA_BOTTLE_ML } from '@/lib/milkParams'
import { ML_PER_FL_OZ } from '@/lib/format'
import { dependentsOf, type PendingOp, type PendingWrite } from '@/lib/queue'
import type {
  FormulaContainer,
  MilkContainer,
  MilkDiscard,
  MilkDrawdown,
  MilkTransfer,
} from '@/lib/types'

// U-Q1 (docs/plan-pruebas-v5.md §1): la vista sin conexión de v5 — combinar,
// deshacer, "ya está fría" y desechar el empezado encolados (marcan pending,
// no duplican lo que el servidor ya devolvió, `unapplied` si se espera un
// rechazo); y applyPendingFormula con compra/abrir/terminar/anular. La hora
// de cada operación es su `queuedAt`.

const OZ = ML_PER_FL_OZ
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const MON = Date.parse('2026-10-05T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const BABY = 'b1'

function box(label: string, oz: number, storedMs = MON, over: Partial<MilkContainer> = {}) {
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
  } as MilkContainer
}

let seq = 0
function queued(op: PendingOp, atMs: number): PendingWrite {
  seq += 1
  return { id: `w${seq}`, schema: 'public', label: 'x', queuedAt: iso(atMs), op }
}

function view(
  containers: MilkContainer[],
  pending: PendingWrite[],
  extra: { drawdowns?: MilkDrawdown[]; discards?: MilkDiscard[]; transfers?: MilkTransfer[] } = {},
) {
  return applyPendingInventory(
    containers,
    extra.drawdowns ?? [],
    extra.discards ?? [],
    pending,
    extra.transfers ?? [],
  )
}
function balanced(v: ReturnType<typeof view>) {
  return milkInvariantFailures({
    containers: v.containers,
    drawdowns: v.drawdowns,
    discards: v.discards,
    transfers: v.transfers,
  })
}

describe('U-Q1 "Ya está fría" en cola (milk_mark_cold)', () => {
  it('una que se enfría queda fría a la hora de la operación, marcada pending', () => {
    const warm = box('M2', 3, NOW - 20 * MIN)
    const v = view([warm], [queued(markMilkColdOp(warm, iso(NOW - 5 * MIN)), NOW - 5 * MIN)])
    const c = v.containers[0]
    expect(c.cold_at).toBe(iso(NOW - 5 * MIN))
    expect(c.pending).toBe(true)
    expect(isCold(c, NOW - 5 * MIN)).toBe(true)
    expect(isCold(warm, NOW - 5 * MIN)).toBe(false) // la entrada no se toca
  })

  it('acotada a [fridge_at, hora de la cola]; ya confirmada o libre → no cambia', () => {
    const warm = box('M2', 3, NOW - 20 * MIN)
    const early = view([warm], [queued(markMilkColdOp(warm, iso(NOW - HOUR)), NOW)])
    expect(early.containers[0].cold_at).toBe(warm.fridge_at)
    const marked = { ...warm, cold_at: iso(NOW - 10 * MIN) }
    expect(
      view([marked], [queued(markMilkColdOp(marked, iso(NOW)), NOW)]).containers[0].cold_at,
    ).toBe(iso(NOW - 10 * MIN))
    const freed = { ...warm, released_at: iso(NOW - MIN), remaining_ml: 0 }
    expect(
      view([freed], [queued(markMilkColdOp(freed, iso(NOW)), NOW)]).containers[0].cold_at,
    ).toBeNull()
  })

  it('un biberón que no está → unapplied, sin inventar nada', () => {
    const v = view([], [queued(markMilkColdOp({ id: 'nope' }, iso(NOW)), NOW)])
    expect(v.unapplied).toEqual([
      { writeId: expect.any(String), fn: 'milk_mark_cold', problem: 'milk_container_unusable' },
    ])
  })
})

describe('U-Q1 combinar y deshacer en cola', () => {
  const m5 = box('M5', 2, MON)
  const m6 = box('M6', 3, MON + DAY)

  it('M5 → M6: M5 libre, M6 con 5 oz, vence con M5; la cuenta cierra (caso límite 5)', () => {
    const op = combineMilkOp(BABY, m6, [m5], 'op1')
    const v = view([m5, m6], [queued(op, NOW)])
    const [a, b] = [
      v.containers.find((c) => c.id === m5.id)!,
      v.containers.find((c) => c.id === m6.id)!,
    ]
    expect(a.remaining_ml).toBe(0)
    expect(a.released_at).toBe(iso(NOW))
    expect(b.remaining_ml).toBeCloseTo(5 * OZ, 9)
    expect(b.expires_at).toBe(m5.expires_at)
    expect(a.pending && b.pending).toBe(true)
    expect(v.transfers).toEqual([
      expect.objectContaining({
        op_id: 'op1',
        from_container_id: m5.id,
        to_container_id: m6.id,
        amount_ml: 2 * OZ,
        target_prev_expires_at: m6.expires_at,
        pending: true,
      }),
    ])
    expect(balanced(v)).toEqual([])
    expect(v.unapplied).toEqual([])
  })

  it('el servidor ya la tiene (sus transferencias vinieron en la lectura) → no se aplica dos veces', () => {
    const op = combineMilkOp(BABY, m6, [m5], 'op1')
    const once = view([m5, m6], [queued(op, NOW)])
    const server = once.transfers.map(({ pending: _p, ...t }) => t)
    const again = view(
      once.containers.map(({ pending: _p, ...c }) => c),
      [queued(op, NOW)],
      { transfers: server },
    )
    expect(again.transfers).toHaveLength(1)
    expect(again.containers.find((c) => c.id === m6.id)!.remaining_ml).toBeCloseTo(5 * OZ, 9)
    expect(again.containers.every((c) => c.pending)).toBe(true)
    expect(balanced(again)).toEqual([])
  })

  it('con M6 enfriando → unapplied milk_not_cold:M6 y nada cambia (caso límite 6)', () => {
    const warm = box('M6', 3, NOW - 10 * MIN)
    const v = view([m5, warm], [queued(combineMilkOp(BABY, warm, [m5]), NOW)])
    expect(v.unapplied.map((u) => u.problem)).toEqual(['milk_not_cold:M6'])
    expect(v.transfers).toEqual([])
    expect(v.containers.find((c) => c.id === warm.id)!.remaining_ml).toBe(3 * OZ)
  })

  it('otro biberón servido de M5 antes (en la cola) → milk_combine_conflict', () => {
    const op = combineMilkOp(BABY, m6, [m5]) // vio M5 con 2 oz
    const bottle = logBottleFeedOp(BABY, null, {
      fed_at: iso(NOW - 2 * MIN),
      notes: null,
      formula_ml: 0,
      portions: [{ container_id: m5.id, amount_ml: OZ }],
    })
    const v = view([m5, m6], [queued(bottle, NOW - MIN), queued(op, NOW)])
    expect(v.unapplied.map((u) => u.problem)).toEqual(['milk_combine_conflict'])
    expect(v.transfers).toEqual([])
  })

  it('combinar y deshacer en cola → vuelve todo como estaba', () => {
    const c = combineMilkOp(BABY, m6, [m5], 'op1')
    const u = uncombineMilkOp('op1', m6.id)
    const v = view([m5, m6], [queued(c, NOW), queued(u, NOW + MIN)])
    const a = v.containers.find((x) => x.id === m5.id)!
    const b = v.containers.find((x) => x.id === m6.id)!
    expect(a.remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(a.released_at).toBeNull()
    expect(b.remaining_ml).toBeCloseTo(3 * OZ, 9)
    expect(b.expires_at).toBe(m6.expires_at)
    expect(v.transfers.every((t) => t.voided_at === iso(NOW + MIN))).toBe(true)
    expect(balanced(v)).toEqual([])
  })

  it('deshacer después de servir del destino por debajo de lo recibido → milk_combine_used:M6', () => {
    const c = combineMilkOp(BABY, m6, [m5], 'op1')
    const serve = logBottleFeedOp(BABY, null, {
      fed_at: iso(NOW),
      notes: null,
      formula_ml: 0,
      portions: [{ container_id: m6.id, amount_ml: 3.5 * OZ }],
    })
    const v = view(
      [m5, m6],
      [
        queued(c, NOW),
        queued(serve, NOW + MIN),
        queued(uncombineMilkOp('op1', m6.id), NOW + 2 * MIN),
      ],
    )
    expect(v.unapplied.map((x) => x.problem)).toEqual(['milk_combine_used:M6'])
    expect(v.transfers.filter((t) => !t.voided_at)).toHaveLength(1)
    expect(balanced(v)).toEqual([])
  })

  it('una toma de M5 anulada después de combinar: la leche no vuelve a M5 (D5-19)', () => {
    const served = { ...m5, remaining_ml: OZ }
    const draw: MilkDrawdown = {
      id: 'f1:c-M5',
      feeding_id: 'f1',
      container_id: m5.id,
      amount_ml: OZ,
      label: 'M5',
      voided_at: null,
    }
    const v = view(
      [served, m6],
      [
        queued(combineMilkOp(BABY, m6, [served], 'op1'), NOW),
        queued(voidBottleFeedOp('f1', iso(NOW + MIN)), NOW + MIN),
      ],
      { drawdowns: [draw] },
    )
    const a = v.containers.find((x) => x.id === m5.id)!
    expect(a.remaining_ml).toBe(0)
    expect(a.lost_ml).toBeCloseTo(OZ, 9)
    expect(v.lost).toEqual([
      expect.objectContaining({ containerId: m5.id, ml: OZ, reason: 'combined' }),
    ])
    expect(balanced(v)).toEqual([])
  })

  it('anular o vaciar una extracción combinada → unapplied milk_combined', () => {
    const c = combineMilkOp(BABY, m6, [m5], 'op1')
    const voidSession: PendingOp = {
      kind: 'rpc',
      fn: 'void_pumping_session',
      args: { p_id: 's-M5', p_voided_at: iso(NOW + MIN) },
      table: 'pumping_sessions',
      id: 's-M5',
      effect: 'delete',
      patch: { voided_at: iso(NOW + MIN) },
    }
    const zero: PendingOp = {
      kind: 'rpc',
      fn: 'update_pumping_session',
      args: { p_id: 's-M6', p_left_ml: null, p_right_ml: null, p_pumped_at: m6.stored_at },
      table: 'pumping_sessions',
      id: 's-M6',
      effect: 'update',
    }
    const v = view(
      [m5, m6],
      [queued(c, NOW), queued(voidSession, NOW + MIN), queued(zero, NOW + 2 * MIN)],
    )
    expect(v.unapplied.map((x) => x.problem)).toEqual(['milk_combined', 'milk_combined'])
    expect(v.containers.every((x) => !x.voided_at)).toBe(true)
  })

  it('el origen bajado por debajo de lo pasado → milk_served_exceeds_amount; subirlo → lost', () => {
    const c = combineMilkOp(BABY, m6, [m5], 'op1')
    const edit = (oz: number): PendingOp => ({
      kind: 'rpc',
      fn: 'update_pumping_session',
      args: { p_id: 's-M5', p_left_ml: oz * OZ, p_right_ml: null, p_pumped_at: m5.stored_at },
      table: 'pumping_sessions',
      id: 's-M5',
      effect: 'update',
    })
    const down = view([m5, m6], [queued(c, NOW), queued(edit(1), NOW + MIN)])
    expect(down.unapplied.map((x) => x.problem)).toEqual(['milk_served_exceeds_amount'])
    const up = view([m5, m6], [queued(c, NOW), queued(edit(3), NOW + MIN)])
    const a = up.containers.find((x) => x.id === m5.id)!
    expect(a.remaining_ml).toBe(0)
    expect(a.lost_ml).toBeCloseTo(OZ, 9)
    expect(balanced(up)).toEqual([])
  })

  it('descartar la extracción en cola se lleva la combinación y su deshacer (dependentsOf)', () => {
    const pump = logPumpingOp(
      BABY,
      null,
      { left_ml: 2 * OZ, right_ml: null, notes: null, pumped_at: iso(NOW - 2 * HOUR) },
      { rules: DEFAULT_MILK_RULES },
      'M7',
    )!
    const newId = pump.op.creates![0]
    const c = combineMilkOp(BABY, m6, [{ id: newId, remaining_ml: 2 * OZ }], 'op9')
    const u = uncombineMilkOp('op9', m6.id)
    const all = [queued(pump.op, NOW), queued(c, NOW + MIN), queued(u, NOW + 2 * MIN)]
    expect(dependentsOf(all[0], all).map((w) => w.id)).toEqual([all[1].id, all[2].id])
  })
})

describe('U-Q1 extracción con hora de refri (p_fridge_at)', () => {
  it('el contenedor en cola entra al refri a la hora de "Registrar" y se enfría desde ahí', () => {
    const pumped = NOW - 30 * MIN
    const built = logPumpingOp(
      BABY,
      null,
      { left_ml: 2 * OZ, right_ml: null, notes: null, pumped_at: iso(pumped) },
      { rules: DEFAULT_MILK_RULES },
      'M3',
      undefined,
      iso(NOW),
    )!
    expect(built.op.kind === 'rpc' && built.op.args.p_fridge_at).toBe(iso(NOW))
    const v = view([], [queued(built.op, NOW)])
    const c = v.containers[0]
    expect(c.fridge_at).toBe(iso(NOW))
    expect(c.cold_at).toBeNull()
    expect(c.expires_at).toBe(iso(pumped + 4 * DAY)) // la caducidad sigue desde pumped_at
    expect(isCold(c, NOW + HOUR - 1)).toBe(false)
    expect(isCold(c, NOW + HOUR)).toBe(true)
  })

  it('una op de una versión vieja (sin p_fridge_at) entra a la hora de la extracción', () => {
    const built = logPumpingOp(
      BABY,
      null,
      { left_ml: 2 * OZ, right_ml: null, notes: null, pumped_at: iso(NOW - 30 * MIN) },
      { rules: DEFAULT_MILK_RULES },
      'M3',
    )!
    if (built.op.kind !== 'rpc') throw new Error('rpc')
    delete built.op.args.p_fridge_at
    expect(view([], [queued(built.op, NOW)]).containers[0].fridge_at).toBe(iso(NOW - 30 * MIN))
  })
})

describe('U-Q1 desechar el biberón empezado en cola', () => {
  const FED = NOW - 2 * HOUR
  const started = { feedingId: 'f1', leftoverMl: OZ, fedAt: iso(FED) }

  it('pasada la hora: aparece el desecho (pending) y startedBottle deja de ofrecerlo', () => {
    const op = discardStartedBottleOp(BABY, null, started, iso(NOW), 'x1')
    const v = view([], [queued(op, NOW)])
    expect(v.discards).toEqual([
      expect.objectContaining({
        id: 'x1',
        container_id: null,
        feeding_id: 'f1',
        amount_ml: OZ,
        reason: 'started_bottle_expired',
        pending: true,
      }),
    ])
    const feeding = {
      id: 'f1',
      fed_at: iso(FED),
      feeding_type: 'bottle' as const,
      leftover_ml: OZ,
    }
    expect(startedBottle({ feedings: [feeding], discards: v.discards, nowMs: NOW })).toBeNull()
  })

  it('antes de la hora (por este teléfono) → unapplied milk_not_expired:started', () => {
    const op = discardStartedBottleOp(
      BABY,
      null,
      { ...started, fedAt: iso(NOW - 59 * MIN) },
      iso(NOW),
    )
    const v = view([], [queued(op, NOW)])
    expect(v.unapplied.map((u) => u.problem)).toEqual(['milk_not_expired:started'])
    expect(v.discards).toEqual([])
  })

  it('el servidor ya lo tiene, u otro teléfono ya lo desechó → no se duplica', () => {
    const op = discardStartedBottleOp(BABY, null, started, iso(NOW), 'x1')
    const server: MilkDiscard = {
      id: 'x1',
      container_id: null,
      feeding_id: 'f1',
      amount_ml: OZ,
      discarded_at: iso(NOW),
      reason: 'started_bottle_expired',
      voided_at: null,
    }
    const v = view([], [queued(op, NOW)], { discards: [server] })
    expect(v.discards).toHaveLength(1)
    expect(v.discards[0].pending).toBe(true)
    const other = view([], [queued(op, NOW)], { discards: [{ ...server, id: 'x-other' }] })
    expect(other.discards).toHaveLength(1)
  })

  it('anular la toma después anula el desecho (INV-10)', () => {
    const op = discardStartedBottleOp(BABY, null, started, iso(NOW), 'x1')
    const v = view([], [queued(op, NOW), queued(voidBottleFeedOp('f1', iso(NOW + MIN)), NOW + MIN)])
    expect(v.discards[0].voided_at).toBe(iso(NOW + MIN))
  })
})

describe('U-Q1 applyPendingFormula', () => {
  const closed = (id: string, addedMs = NOW - DAY): FormulaContainer => ({
    id,
    size_ml: FORMULA_BOTTLE_ML,
    added_at: iso(addedMs),
    opened_at: null,
    finished_at: null,
    finish_reason: null,
    voided_at: null,
  })

  it('compra de 6: seis cerradas pending; el reenvío con las filas del servidor no duplica', () => {
    const op = addFormulaOp(BABY, { addedAt: iso(NOW) })
    const v = applyPendingFormula([], [queued(op, NOW)])
    expect(v.containers).toHaveLength(6)
    expect(v.containers.every((c) => c.pending && !c.opened_at)).toBe(true)
    const server = v.containers.map(({ pending: _p, ...c }) => c)
    expect(applyPendingFormula(server, [queued(op, NOW)]).containers).toHaveLength(6)
  })

  it('abrir la más vieja reemplaza la abierta anterior', () => {
    const prev: FormulaContainer = { ...closed('old'), opened_at: iso(NOW - 30 * HOUR) }
    const v = applyPendingFormula(
      [prev, closed('a', NOW - 2 * DAY), closed('b')],
      [queued(openFormulaOp(BABY, { id: 'a' }, iso(NOW)), NOW)],
    )
    const by = (id: string) => v.containers.find((c) => c.id === id)!
    expect(by('a').opened_at).toBe(iso(NOW))
    expect(by('old')).toMatchObject({
      finished_at: iso(NOW),
      finish_reason: 'replaced',
      pending: true,
    })
    const s = formulaStock({ containers: v.containers, feedings: [], nowMs: NOW })
    expect(s.open?.container.id).toBe('a')
    expect(s.closed.map((c) => c.id)).toEqual(['b'])
  })

  it('sin cerradas: crea una abierta de 8 oz con el id del dispositivo (nunca bloquea)', () => {
    const op = openFormulaOp(BABY, null, iso(NOW))
    const v = applyPendingFormula([], [queued(op, NOW)])
    expect(v.containers).toEqual([
      expect.objectContaining({
        id: op.id,
        size_ml: FORMULA_BOTTLE_ML,
        opened_at: iso(NOW),
        pending: true,
      }),
    ])
  })

  it('"Desechar" antes de las 48 h → unapplied; a las 48 h exactas → terminada expired', () => {
    const open: FormulaContainer = { ...closed('o'), opened_at: iso(NOW - 48 * HOUR + 1) }
    const early = applyPendingFormula(
      [open],
      [queued(finishFormulaOp(open, 'expired', iso(NOW)), NOW)],
    )
    expect(early.unapplied.map((u) => u.problem)).toEqual(['milk_not_expired:formula'])
    expect(early.containers[0].finished_at).toBeNull()
    const at48 = applyPendingFormula(
      [open],
      [queued(finishFormulaOp(open, 'expired', iso(NOW + 1)), NOW + 1)],
    )
    expect(at48.containers[0]).toMatchObject({
      finished_at: iso(NOW + 1),
      finish_reason: 'expired',
      pending: true,
    })
  })

  it('"Se terminó" siempre; ya terminada → no-op', () => {
    const open: FormulaContainer = { ...closed('o'), opened_at: iso(NOW - HOUR) }
    const v = applyPendingFormula([open], [queued(finishFormulaOp(open, 'empty', iso(NOW)), NOW)])
    expect(v.containers[0]).toMatchObject({ finished_at: iso(NOW), finish_reason: 'empty' })
    const done = { ...open, finished_at: iso(NOW - MIN), finish_reason: 'empty' as const }
    const again = applyPendingFormula(
      [done],
      [queued(finishFormulaOp(done, 'empty', iso(NOW)), NOW)],
    )
    expect(again.containers[0].finished_at).toBe(iso(NOW - MIN))
  })

  it('anular una cerrada sí; una terminada no (milk_bad_input)', () => {
    const v = applyPendingFormula([closed('c')], [queued(voidFormulaOp({ id: 'c' }), NOW)])
    expect(v.containers[0].voided_at).toBe(iso(NOW))
    expect(formulaStock({ containers: v.containers, feedings: [], nowMs: NOW }).closed).toEqual([])
    const done: FormulaContainer = {
      ...closed('d'),
      opened_at: iso(NOW - DAY),
      finished_at: iso(NOW - HOUR),
      finish_reason: 'empty',
    }
    const no = applyPendingFormula([done], [queued(voidFormulaOp({ id: 'd' }), NOW)])
    expect(no.unapplied.map((u) => u.problem)).toEqual(['milk_bad_input'])
  })

  it('compra y apertura encoladas juntas: la abierta sale de la compra', () => {
    const add = addFormulaOp(BABY, { count: 2, addedAt: iso(NOW - MIN) })
    const firstId = (add.kind === 'rpc' && (add.args.p_ids as string[])[0]) as string
    const v = applyPendingFormula(
      [],
      [queued(add, NOW - MIN), queued(openFormulaOp(BABY, { id: firstId }, iso(NOW)), NOW)],
    )
    const s = formulaStock({ containers: v.containers, feedings: [], nowMs: NOW })
    expect(s.open?.container.id).toBe(firstId)
    expect(s.closed).toHaveLength(1)
    const all = [
      queued(add, NOW - MIN),
      queued(openFormulaOp(BABY, { id: firstId }, iso(NOW)), NOW),
    ]
    expect(dependentsOf(all[0], all)).toHaveLength(1)
  })
})
