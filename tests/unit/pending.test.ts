import { describe, expect, it } from 'vitest'
import { describeWrite, keepLastGood, mergePending, milkErrorText } from '@/lib/db'
import type { PendingOp, PendingWrite } from '@/lib/queue'

// What a page shows offline: the last rows the server gave, with the
// queue folded on top. These are the pure pieces Dashboard, History and
// Growth use.

type Row = { id: string; changed_at: string; diaper_type: string }

const server: Row[] = [
  { id: 'a', changed_at: '2026-09-20T10:00:00.000Z', diaper_type: 'wet' },
  { id: 'b', changed_at: '2026-09-20T09:00:00.000Z', diaper_type: 'dirty' },
]

let seq = 0
function queued(op: PendingOp): PendingWrite {
  seq += 1
  return { id: `w${seq}`, schema: 'public', label: 'x', queuedAt: '2026-09-20T11:00:00Z', op }
}

describe('mergePending', () => {
  it('adds a queued insert, marked pending, and leaves other tables alone', () => {
    const merged = mergePending(server, 'diaper_changes', [
      queued({ kind: 'insert', table: 'diaper_changes', row: { id: 'c', diaper_type: 'both' } }),
      queued({ kind: 'insert', table: 'feedings', row: { id: 'f' } }),
    ])
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(merged.find((r) => r.id === 'c')?.pending).toBe(true)
    expect(merged.find((r) => r.id === 'a')?.pending).toBeUndefined()
  })

  it('does not duplicate an insert the server already returned', () => {
    const merged = mergePending(server, 'diaper_changes', [
      queued({ kind: 'insert', table: 'diaper_changes', row: { id: 'a', diaper_type: 'wet' } }),
    ])
    expect(merged.map((r) => r.id)).toEqual(['a', 'b'])
    expect(merged.find((r) => r.id === 'a')?.pending).toBe(true)
  })

  it('applies a queued edit once to an insert the server already returned', () => {
    const merged = mergePending(server, 'diaper_changes', [
      queued({ kind: 'insert', table: 'diaper_changes', row: { id: 'a', diaper_type: 'wet' } }),
      queued({ kind: 'update', table: 'diaper_changes', id: 'a', patch: { diaper_type: 'both' } }),
    ])
    const a = merged.filter((r) => r.id === 'a')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ diaper_type: 'both', pending: true })
  })

  it('applies a queued edit to the row it targets', () => {
    const merged = mergePending(server, 'diaper_changes', [
      queued({ kind: 'update', table: 'diaper_changes', id: 'b', patch: { diaper_type: 'both' } }),
    ])
    expect(merged.find((r) => r.id === 'b')).toMatchObject({ diaper_type: 'both', pending: true })
    // The input rows are not mutated: they are what the next refresh starts from.
    expect(server[1].diaper_type).toBe('dirty')
  })
})

describe('keepLastGood', () => {
  const last = { diapers: server, sleep: [{ id: 's' }] }

  it('takes every read that succeeded', () => {
    const { rows, error } = keepLastGood(last, {
      diapers: { data: [], error: null },
      sleep: { data: [{ id: 't' }], error: null },
    })
    expect(rows).toEqual({ diapers: [], sleep: [{ id: 't' }] })
    expect(error).toBeNull()
  })

  it('keeps the last good rows for a read that failed, and reports its error', () => {
    const { rows, error } = keepLastGood(last, {
      diapers: { data: [], error: 'Failed to fetch' },
      sleep: { data: [{ id: 't' }], error: null },
    })
    expect(rows.diapers).toBe(server)
    expect(rows.sleep).toEqual([{ id: 't' }])
    expect(error).toBe('Failed to fetch')
  })

  it('reports the first error when several reads fail', () => {
    const { rows, error } = keepLastGood(last, {
      diapers: { data: [], error: 'first' },
      sleep: { data: [], error: 'second' },
    })
    expect(rows).toEqual(last)
    expect(error).toBe('first')
  })

  it('works for a single value, not only lists', () => {
    const { rows } = keepLastGood(
      { appt: { id: 'x' } as { id: string } | null },
      { appt: { data: null, error: 'offline' } },
    )
    expect(rows.appt).toEqual({ id: 'x' })
  })
})

describe('describeWrite (el nombre de una entrada encolada, para el aviso de descarte)', () => {
  it('en el idioma de la interfaz, no la etiqueta en inglés guardada', () => {
    const w = queued({ kind: 'insert', table: 'diaper_changes', row: { id: 'z' } })
    expect(describeWrite(w, 'en')).toBe('Diaper (new)')
    expect(describeWrite(w, 'es')).toBe('Pañal (alta)')
    const e = queued({ kind: 'update', table: 'growth_measurements', id: 'z', patch: {} })
    expect(describeWrite(e, 'es')).toBe('Medida (edición)')
    const d = queued({
      kind: 'update',
      table: 'diaper_changes',
      id: 'z',
      patch: { voided_at: '2026-09-21T10:00:00Z' },
    })
    expect(describeWrite(d, 'en')).toBe('Diaper (deletion)')
    expect(describeWrite(d, 'es')).toBe('Pañal (borrado)')
    const o = queued({ kind: 'insert', table: 'nueva_tabla', row: { id: 'z' } })
    expect(describeWrite(o, 'es')).toBe('Registro (alta)')
  })
})

// ------------------------------------------------------------- milk (0014)

describe('mergePending con las funciones del inventario de leche', () => {
  type Feed = { id: string; fed_at: string; amount_ml: number; voided_at?: string | null }
  const feeds: Feed[] = [{ id: 'f-server', fed_at: '2026-10-04T08:00:00Z', amount_ml: 90 }]

  it('una toma registrada sin conexión aparece, marcada; su anulación la marca anulada', () => {
    const merged = mergePending(feeds, 'feedings', [
      queued({
        kind: 'rpc',
        fn: 'log_bottle_feed',
        args: {},
        table: 'feedings',
        id: 'f-new',
        effect: 'insert',
        row: { id: 'f-new', fed_at: '2026-10-04T10:00:00Z', amount_ml: 88.7 },
        refs: ['c1'],
      }),
      queued({
        kind: 'rpc',
        fn: 'void_bottle_feed',
        args: {},
        table: 'feedings',
        id: 'f-server',
        effect: 'delete',
        patch: { voided_at: '2026-10-04T10:05:00Z' },
      }),
    ])
    expect(merged.find((r) => r.id === 'f-new')).toMatchObject({ amount_ml: 88.7, pending: true })
    expect(merged.find((r) => r.id === 'f-server')).toMatchObject({
      voided_at: '2026-10-04T10:05:00Z',
      pending: true,
    })
    expect(feeds[0].voided_at).toBeUndefined()
  })

  it('una edición encolada de una extracción que también está en la cola se aplica sobre ella', () => {
    const merged = mergePending(
      [] as { id: string; amount_ml: number | null }[],
      'pumping_sessions',
      [
        queued({
          kind: 'rpc',
          fn: 'log_pumping_session',
          args: {},
          table: 'pumping_sessions',
          id: 's1',
          effect: 'insert',
          row: { id: 's1', amount_ml: null },
        }),
        queued({
          kind: 'rpc',
          fn: 'update_pumping_session',
          args: {},
          table: 'pumping_sessions',
          id: 's1',
          effect: 'update',
          patch: { amount_ml: 120 },
        }),
      ],
    )
    expect(merged).toEqual([{ id: 's1', amount_ml: 120, pending: true }])
  })

  it('no toca otras tablas', () => {
    const merged = mergePending(feeds, 'feedings', [
      queued({
        kind: 'rpc',
        fn: 'log_pumping_session',
        args: {},
        table: 'pumping_sessions',
        id: 's1',
        effect: 'insert',
        row: { id: 's1' },
      }),
    ])
    expect(merged).toEqual([{ ...feeds[0] }])
  })
})

describe('describeWrite con operaciones rpc', () => {
  it('alta, edición y borrado, en inglés y en español', () => {
    const add = queued({
      kind: 'rpc',
      fn: 'log_bottle_feed',
      args: {},
      table: 'feedings',
      id: 'f',
      effect: 'insert',
    })
    const edit = queued({
      kind: 'rpc',
      fn: 'update_pumping_session',
      args: {},
      table: 'pumping_sessions',
      id: 's',
      effect: 'update',
    })
    const del = queued({
      kind: 'rpc',
      fn: 'void_bottle_feed',
      args: {},
      table: 'feedings',
      id: 'f',
      effect: 'delete',
    })
    expect(describeWrite(add, 'en')).toBe('Feeding (new)')
    expect(describeWrite(add, 'es')).toBe('Toma (alta)')
    expect(describeWrite(edit, 'en')).toBe('Pumping (edit)')
    expect(describeWrite(edit, 'es')).toBe('Extracción (edición)')
    expect(describeWrite(del, 'en')).toBe('Feeding (deletion)')
    expect(describeWrite(del, 'es')).toBe('Toma (borrado)')
  })
})

describe('milkErrorText', () => {
  it('traduce cada código, con la cinta cuando viene', () => {
    expect(milkErrorText('milk_overdraw:M3', 'en')).toMatch(/^M3 doesn’t have that much milk left/)
    expect(milkErrorText('milk_overdraw:M3', 'es')).toMatch(/^A M3 no le queda tanta leche/)
    expect(milkErrorText('milk_already_served:M1', 'es')).toMatch(/De M1 ya se sirvió leche/)
    expect(milkErrorText('milk_container_unusable:M2', 'en')).toMatch(/^M2 can’t be used/)
    // Sin cinta no queda una frase con un hueco.
    expect(milkErrorText('milk_container_unusable', 'en')).toMatch(/^One of the containers/)
    for (const code of [
      'milk_label_taken:M4',
      'milk_served_exceeds_amount:M4',
      'milk_idempotency_conflict',
      'milk_rpc_only',
      'milk_bad_input',
      'milk_baby_not_found',
      'milk_not_signed_in',
      'milk_session_gone',
    ]) {
      for (const lang of ['en', 'es'] as const) {
        const text = milkErrorText(code, lang)
        expect(text, `${code} ${lang}`).not.toMatch(/milk_|\{label\}/)
        expect(text.length, `${code} ${lang}`).toBeGreaterThan(10)
      }
    }
  })

  it('un mensaje que no es de la leche pasa tal cual', () => {
    expect(milkErrorText('new row violates row-level security policy', 'es')).toBe(
      'new row violates row-level security policy',
    )
    expect(milkErrorText('milk_unknown_code', 'en')).toBe('milk_unknown_code')
    expect(milkErrorText(null, 'en')).toBe('')
  })
})
