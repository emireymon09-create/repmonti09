import { describe, expect, it } from 'vitest'
import { describeWrite, keepLastGood, mergePending } from '@/lib/db'
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
