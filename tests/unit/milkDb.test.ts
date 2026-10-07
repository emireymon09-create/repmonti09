import { describe, expect, it } from 'vitest'
import {
  describeWrite,
  discardActivity,
  discardContainerOp,
  editBottleFeedOp,
  editMustQueue,
  estimateLegacySplits,
  logBottleFeedOp,
  logPumpingOp,
  milkErrorText,
  milkResultOf,
  voidBottleFeedOp,
  MILK_BOTTLE_NEEDED,
} from '@/lib/db'
import { applyPendingInventory, describeBottle, DEFAULT_MILK_RULES } from '@/lib/milk'
import { ML_PER_FL_OZ } from '@/lib/format'
import { dependentsOf, isDeletion, type PendingOp, type PendingWrite } from '@/lib/queue'
import type { Feeding, MilkContainer, MilkDiscard, MilkDrawdown } from '@/lib/types'

// La capa de datos de la leche v4 (H3): las ops que arma lib/db.ts para la cola,
// los textos de los rechazos nuevos de 0015 y las filas de desecho de Historial.
// Casos U-59…U-62 de docs/plan-pruebas-v4.md (U-63 es tests/unit/i18n.test.ts).
// Sin reloj real: toda hora es fija.

const OZ = ML_PER_FL_OZ
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function box(label: string, over: Partial<MilkContainer> = {}): MilkContainer {
  return {
    id: `c-${label}`,
    source_session_id: `s-${label}`,
    label,
    amount_ml: 4 * OZ,
    remaining_ml: 4 * OZ,
    stored_at: iso(NOW - 2 * DAY),
    location: 'fridge',
    expires_at: iso(NOW + 2 * DAY),
    voided_at: null,
    released_at: null,
    lost_ml: 0,
    ...over,
  }
}

function queued(op: PendingOp, atMs = NOW): PendingWrite {
  return { id: `w-${Math.random()}`, schema: 'public', label: 'x', queuedAt: iso(atMs), op }
}

const NEW_CODES = [
  'milk_not_expired:M3',
  'milk_not_expired',
  'milk_not_enough:37.5',
  'milk_not_enough',
  'milk_edit_conflict',
  'milk_future_time',
  'milk_feeding_gone',
  'milk_not_inventory',
  'milk_invariant_broken',
  'milk_label_taken:M4',
  MILK_BOTTLE_NEEDED,
]

describe('U-60 milkErrorText — los códigos de 0015, en EN y ES', () => {
  it('cada código nuevo tiene texto, sin el código crudo ni variables sin llenar', () => {
    for (const code of NEW_CODES) {
      for (const lang of ['en', 'es'] as const) {
        const text = milkErrorText(code, lang)
        expect(text, `${code} ${lang}`).not.toMatch(/milk_|\{|\}|NaN|undefined/)
        expect(text.length, `${code} ${lang}`).toBeGreaterThan(15)
      }
    }
  })

  it('milk_not_enough:37.5 pone los ml disponibles en oz (AJ-12), no como etiqueta', () => {
    expect(milkErrorText('milk_not_enough:37.5', 'en')).toMatch(/only 1\.27 oz/)
    expect(milkErrorText('milk_not_enough:37.5', 'es')).toMatch(/solo 1\.27 oz/)
    expect(milkErrorText('milk_not_enough:0', 'es')).toMatch(/solo 0 oz/)
    // Sin número no queda "solo NaN oz".
    expect(milkErrorText('milk_not_enough', 'en')).not.toMatch(/only/)
  })

  it('milk_not_expired nombra el biberón, y sin él no deja un hueco', () => {
    expect(milkErrorText('milk_not_expired:M3', 'es')).toMatch(/de M3 todavía no venció/)
    expect(milkErrorText('milk_not_expired:M3', 'en')).toMatch(/in M3 hasn’t expired/)
    expect(milkErrorText('milk_not_expired', 'es')).toMatch(/^Según el servidor, esta leche/)
  })

  it('milk_label_taken habla de biberones, no de cintas (AJ-1), en línea y en el banner', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const ctx of [undefined, 'sync'] as const) {
        const text = milkErrorText('milk_label_taken:M4', lang, ctx)
        expect(text).toMatch(/M4/)
        expect(text).not.toMatch(/tape|cinta/i)
        expect(text).toMatch(lang === 'en' ? /Bottle M4/ : /El biberón M4/)
      }
    }
    expect(milkErrorText('milk_label_taken:M4', 'en', 'sync')).toMatch(/Discard this entry/)
    expect(milkErrorText('milk_label_taken:M4', 'es', 'sync')).toMatch(/Descartar este registro/)
    expect(milkErrorText('milk_label_taken:M4', 'es')).not.toMatch(/Descartar/)
  })

  it('cada uno en su idioma', () => {
    expect(milkErrorText('milk_edit_conflict', 'es')).toMatch(/otro teléfono mientras la editabas/)
    expect(milkErrorText('milk_edit_conflict', 'en')).toMatch(/another phone while you were/)
    expect(milkErrorText('milk_future_time', 'es')).toMatch(/Revisá la hora/)
    expect(milkErrorText('milk_feeding_gone', 'es')).toMatch(/Esa toma ya no existe/)
    expect(milkErrorText('milk_not_inventory', 'es')).toMatch(/antes de que la leche se contara/)
    expect(milkErrorText(MILK_BOTTLE_NEEDED, 'es')).toBe('Elegí en qué biberón quedó.')
  })
})

describe('U-59 un desecho en la cola', () => {
  const op = discardContainerOp('baby', 'user', box('M3'), iso(NOW), 'd1')

  it('se nombra "Leche desechada (alta)" / "Discarded milk (new)" y no es un borrado', () => {
    const w = queued(op)
    expect(describeWrite(w, 'en')).toBe('Discarded milk (new)')
    expect(describeWrite(w, 'es')).toBe('Leche desechada (alta)')
    expect(isDeletion(w)).toBe(false)
  })

  it('id del dispositivo, refiere al contenedor, y su fila es lo que la pantalla ve', () => {
    expect(op).toMatchObject({
      fn: 'discard_container',
      table: 'milk_discards',
      id: 'd1',
      effect: 'insert',
      args: { p_id: 'd1', p_container_id: 'c-M3', p_discarded_at: iso(NOW) },
      refs: ['c-M3'],
      row: { id: 'd1', container_id: 'c-M3', amount_ml: 4 * OZ, reason: 'expired', label: 'M3' },
    })
  })

  it('descartar la extracción rechazada se lleva el desecho y la edición que la usan (U-58)', () => {
    const pump = logPumpingOp(
      'baby',
      'user',
      { left_ml: 2 * OZ, right_ml: null, notes: null, pumped_at: iso(NOW - DAY) },
      { rules: DEFAULT_MILK_RULES },
      'M3',
      's-new',
    )!
    const containerId = pump.op.creates![0]
    const c = box('M3', { id: containerId, source_session_id: 's-new' })
    const feeding: Feeding = {
      id: 'f1',
      fed_at: iso(NOW - HOUR),
      feeding_type: 'bottle',
      amount_ml: OZ,
      notes: null,
      breast_milk_ml: OZ,
      formula_ml: 0,
      leftover_ml: null,
    }
    const draws: MilkDrawdown[] = [
      { id: 'p1', feeding_id: 'f1', container_id: 'c-M1', amount_ml: OZ, label: 'M1' },
    ]
    const edit = editBottleFeedOp(
      feeding,
      { fed_at: feeding.fed_at, breast_ml: 2 * OZ, formula_ml: 0, leftover_ml: null, notes: null },
      // M1 is emptied by this bottle: the extra ounce has to come from M3.
      {
        containers: [box('M1', { remaining_ml: 0, released_at: iso(NOW - HOUR) }), c],
        drawdowns: draws,
        discards: [],
      },
      'e1',
      NOW,
    )
    expect(edit.refs).toEqual(expect.arrayContaining(['c-M1', containerId]))
    const all = [
      queued(pump.op),
      queued(discardContainerOp('baby', 'user', c, iso(NOW), 'd2')),
      queued(edit),
    ]
    expect(
      dependentsOf(all[0], all).map((w) => (w.op.kind === 'rpc' ? w.op.fn : w.op.kind)),
    ).toEqual(expect.arrayContaining(['discard_container', 'edit_bottle_feed']))
  })
})

describe('las ops de lib/db.ts son las que entiende applyPendingInventory', () => {
  it('extracción sin biberón elegido: no hay op (MILK_BOTTLE_NEEDED); sin cantidad, sí', () => {
    const input = { left_ml: OZ, right_ml: OZ, notes: null, pumped_at: iso(NOW) }
    const rules = { rules: DEFAULT_MILK_RULES }
    expect(logPumpingOp('b', 'u', input, rules, null)).toBeNull()
    expect(logPumpingOp('b', 'u', input, rules, '')).toBeNull()
    const none = logPumpingOp('b', 'u', { ...input, left_ml: null, right_ml: null }, rules, null)
    expect(none?.op.creates).toEqual([])
    const built = logPumpingOp('b', 'u', input, rules, 'M5', 's1')!
    expect(built.label).toBe('M5')
    expect(built.op.args).toMatchObject({ p_id: 's1', p_container_label: 'M5', p_side: 'both' })
    const view = applyPendingInventory([], [], [], [queued(built.op)])
    expect(view.containers).toHaveLength(1)
    expect(view.containers[0]).toMatchObject({ label: 'M5', released_at: null, pending: true })
  })

  it('desechar en cola: el contenedor queda en 0, liberado y la leche desechada', () => {
    const m3 = box('M3', { expires_at: iso(NOW - HOUR) })
    const view = applyPendingInventory(
      [m3],
      [],
      [],
      [queued(discardContainerOp('b', 'u', m3, iso(NOW), 'd1'))],
    )
    expect(view.containers[0]).toMatchObject({ remaining_ml: 0, pending: true })
    expect(view.containers[0].released_at).toBeTruthy()
    expect(view.discards).toHaveLength(1)
    expect(view.discards[0]).toMatchObject({ id: 'd1', amount_ml: 4 * OZ, pending: true })
  })

  it('toma con sobró: el sobró va en args y en la fila, y no toca el inventario (D-10)', () => {
    const m3 = box('M3')
    const op = logBottleFeedOp(
      'b',
      'u',
      {
        fed_at: iso(NOW),
        notes: null,
        formula_ml: 0,
        portions: [{ container_id: m3.id, amount_ml: 3 * OZ }],
        leftover_ml: OZ,
      },
      'f1',
    )
    expect(op.args).toMatchObject({ p_leftover_ml: OZ })
    expect(op.row).toMatchObject({ leftover_ml: OZ, amount_ml: 3 * OZ, breast_milk_ml: 3 * OZ })
    expect(op.refs).toEqual([m3.id])
    const view = applyPendingInventory([m3], [], [], [queued(op)])
    expect(view.containers[0].remaining_ml).toBeCloseTo(OZ, 9)
    // Sin sobró: null explícito (no se sabe), nunca 0.
    const plain = logBottleFeedOp('b', 'u', {
      fed_at: iso(NOW),
      notes: null,
      formula_ml: 60,
      portions: [],
    })
    expect(plain.args).toMatchObject({ p_leftover_ml: null })
  })

  it('edición: p_expected es lo que vio la pantalla, el patch el estado final, y la cola la aplica', () => {
    const m3 = box('M3', { remaining_ml: OZ })
    const feeding: Feeding = {
      id: 'f1',
      fed_at: '2026-10-08T10:00:00.123456+00:00',
      feeding_type: 'bottle',
      amount_ml: 3 * OZ,
      notes: 'antes',
      breast_milk_ml: 3 * OZ,
      formula_ml: 0,
      leftover_ml: null,
    }
    const draws: MilkDrawdown[] = [
      { id: 'p1', feeding_id: 'f1', container_id: m3.id, amount_ml: 3 * OZ, label: 'M3' },
    ]
    const op = editBottleFeedOp(
      feeding,
      {
        fed_at: feeding.fed_at,
        breast_ml: 2 * OZ,
        formula_ml: OZ,
        leftover_ml: 0,
        notes: 'después',
      },
      { containers: [m3], drawdowns: draws, discards: [] },
      'op-1',
      NOW,
    )
    expect(op).toMatchObject({
      fn: 'edit_bottle_feed',
      table: 'feedings',
      id: 'f1',
      effect: 'update',
    })
    expect(op.args).toMatchObject({
      p_op_id: 'op-1',
      p_feeding_id: 'f1',
      p_breast_ml: 2 * OZ,
      p_formula_ml: OZ,
      p_leftover_ml: 0,
      p_notes: 'después',
      p_expected: {
        fed_at: '2026-10-08T10:00:00.123456+00:00',
        breast_milk_ml: 3 * OZ,
        formula_ml: 0,
        leftover_ml: null,
      },
    })
    expect(op.patch).toMatchObject({ amount_ml: 3 * OZ, breast_milk_ml: 2 * OZ, leftover_ml: 0 })
    expect(op.refs).toEqual([m3.id])
    const view = applyPendingInventory([m3], draws, [], [queued(op)])
    expect(view.containers[0].remaining_ml).toBeCloseTo(2 * OZ, 9)
    expect(view.unapplied).toEqual([])
    // Cada intento de guardar es un op nuevo (AJ-3).
    const again = editBottleFeedOp(
      feeding,
      { fed_at: feeding.fed_at, breast_ml: 2 * OZ, formula_ml: OZ, leftover_ml: 0, notes: null },
      { containers: [m3], drawdowns: draws, discards: [] },
    )
    expect((again.args as { p_op_id: string }).p_op_id).not.toBe('op-1')
  })

  it('editMustQueue: toma en cola, o un contenedor que toca en cola, va detrás', () => {
    const m3 = box('M3')
    const feeding: Feeding = {
      id: 'f1',
      fed_at: iso(NOW - HOUR),
      feeding_type: 'bottle',
      amount_ml: OZ,
      notes: null,
      breast_milk_ml: OZ,
      formula_ml: 0,
    }
    const draws: MilkDrawdown[] = [
      { id: 'p1', feeding_id: 'f1', container_id: m3.id, amount_ml: OZ, label: 'M3' },
    ]
    const input = {
      fed_at: feeding.fed_at,
      breast_ml: OZ,
      formula_ml: 0,
      leftover_ml: OZ / 2,
      notes: null,
    }
    const ctx = { containers: [m3], drawdowns: draws, discards: [] }
    const op = editBottleFeedOp(feeding, input, ctx)
    expect(editMustQueue(feeding, op, ctx)).toBe(false)
    expect(editMustQueue({ ...feeding, pending: true }, op, ctx)).toBe(true)
    expect(editMustQueue(feeding, op, { containers: [{ ...m3, pending: true }] })).toBe(true)
  })

  it('anular una toma: op con borrado, y la respuesta jsonb se lee tipada', () => {
    const op = voidBottleFeedOp('f1', iso(NOW))
    expect(isDeletion(queued(op))).toBe(true)
    expect(milkResultOf({ returned_ml: '29.5', lost: [{ label: 'M3', ml: '10' }] })).toEqual({
      returned_ml: 29.5,
      lost: [{ label: 'M3', ml: 10 }],
      taken: [],
    })
    expect(milkResultOf(null)).toBeNull()
    expect(milkResultOf([1])).toBeNull()
  })
})

describe('U-61 describeBottle con sobró', () => {
  const f: Feeding = {
    id: 'f1',
    fed_at: iso(NOW),
    feeding_type: 'bottle',
    amount_ml: 3 * OZ,
    notes: null,
    breast_milk_ml: 2 * OZ,
    formula_ml: OZ,
    leftover_ml: OZ,
  }
  const draws: MilkDrawdown[] = [
    { id: 'p1', feeding_id: 'f1', container_id: 'c-M3', amount_ml: 2 * OZ, label: 'M3' },
  ]
  it('agrega "· sobró 1 oz" cuando hay dato, en los dos idiomas', () => {
    expect(describeBottle(f, draws, 'es')).toBe('M3 2 oz + fórmula 1 oz · sobró 1 oz')
    expect(describeBottle(f, draws, 'en')).toBe('M3 2 oz + formula 1 oz · 1 oz left over')
  })
  it('sin dato no dice nada', () => {
    expect(describeBottle({ ...f, leftover_ml: null }, draws, 'es')).toBe('M3 2 oz + fórmula 1 oz')
  })
})

describe('U-62 discardActivity — los desechos en Historial', () => {
  const d = (id: string, atMs: number, over: Partial<MilkDiscard> = {}): MilkDiscard => ({
    id,
    container_id: 'c-M3',
    amount_ml: 1.5 * OZ,
    discarded_at: iso(atMs),
    reason: 'expired',
    label: 'M3',
    voided_at: null,
    ...over,
  })

  it('una entrada "discard" por desecho vivo, con su hora, en EN y ES', () => {
    const es = discardActivity([d('d1', NOW - HOUR)], 0, 'es')
    expect(es).toEqual([
      {
        id: 'd1',
        at: iso(NOW - HOUR),
        kind: 'discard',
        what: 'Leche desechada · M3 · 1.5 oz',
        detail: 'M3 · 1.5 oz',
      },
    ])
    expect(discardActivity([d('d1', NOW)], 0, 'en')[0].what).toBe('Discarded milk · M3 · 1.5 oz')
  })

  it('anulados fuera, "desde" respetado, la cola marcada, lo más nuevo primero', () => {
    const rows = [
      d('old', NOW - 3 * DAY),
      d('voided', NOW - HOUR, { voided_at: iso(NOW) }),
      { ...d('queued', NOW - HOUR), pending: true },
      d('new', NOW),
    ]
    const out = discardActivity(rows, NOW - DAY, 'es')
    expect(out.map((e) => e.id)).toEqual(['new', 'queued'])
    expect(out[1].what).toBe('Leche desechada · M3 · 1.5 oz · sin sincronizar')
  })
})

describe('estimateLegacySplits — la lectura sin límite, en arrays', () => {
  it('una toma vieja sale de la extracción vieja sin contenedor; la que llenó un biberón no cuenta', () => {
    const split = estimateLegacySplits(
      {
        feedings: [
          {
            id: 'f1',
            fed_at: iso(NOW),
            feeding_type: 'bottle',
            amount_ml: 3 * OZ,
            breast_milk_ml: null,
            formula_ml: null,
          },
        ],
        pumping: [
          { id: 'legacy', pumped_at: iso(NOW - DAY), amount_ml: 2 * OZ },
          { id: 'boxed', pumped_at: iso(NOW - DAY), amount_ml: 5 * OZ },
        ],
        containerSessionIds: ['boxed'],
      },
      4,
    )
    expect(split.get('f1')?.breastMl).toBeCloseTo(2 * OZ, 9)
    expect(split.get('f1')?.formulaMl).toBeCloseTo(OZ, 9)
  })
})
