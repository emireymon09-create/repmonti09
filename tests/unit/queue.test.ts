import { describe, expect, it } from 'vitest'
import {
  flushQueue,
  looksOffline,
  newId,
  type PendingOp,
  type PendingWrite,
  type QueueStore,
} from '@/lib/queue'

function store(initial: PendingWrite[]): QueueStore & { rows: PendingWrite[] } {
  const rows = [...initial]
  return {
    rows,
    async all() {
      return [...rows]
    },
    async add(w) {
      rows.push(w)
    },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}

function write(id: string, queuedAt: string, op: PendingOp, schema = 'public'): PendingWrite {
  return { id, schema, label: id, queuedAt, op }
}

const insert: PendingOp = { kind: 'insert', table: 'feedings', row: { id: 'a' } }
const update: PendingOp = { kind: 'update', table: 'feedings', id: 'a', patch: { amount_ml: 90 } }

describe('flushQueue', () => {
  it('reenvía del más viejo al más nuevo', async () => {
    const s = store([
      write('2', '2026-01-15T10:05:00Z', update),
      write('1', '2026-01-15T10:00:00Z', insert),
    ])
    const seen: PendingOp[] = []
    const result = await flushQueue(s, 'public', async (op) => {
      seen.push(op)
      return { error: null }
    })

    expect(seen).toEqual([insert, update])
    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })

  it('se detiene en el primer fallo y deja el resto en cola', async () => {
    const s = store([
      write('1', '2026-01-15T10:00:00Z', insert),
      write('2', '2026-01-15T10:05:00Z', update),
    ])
    const result = await flushQueue(s, 'public', async (op) =>
      op.kind === 'insert' ? { error: null } : { error: 'boom' },
    )

    expect(result.sent).toBe(1)
    expect(result.error).toBe('boom')
    expect(result.remaining).toBe(1)
    expect(s.rows.map((r) => r.id)).toEqual(['2'])
  })

  it('descarta lo escrito contra un schema que este build ya no usa', async () => {
    const s = store([write('viejo', '2026-01-15T10:00:00Z', insert, 'legacy')])
    const result = await flushQueue(s, 'public', async () => {
      throw new Error('no debería enviarse')
    })

    expect(result).toEqual({ sent: 0, dropped: 1, remaining: 0, error: null })
    expect(s.rows).toHaveLength(0)
  })

  /**
   * Regresión del hallazgo A1 de docs/auditorias/2026-09-20-auditoria-inicial.md.
   *
   * `remaining` se calculaba como `pending.length - i - dropped`, y restar los
   * descartes es doble conteo: los que se descartaron ya salieron del store y
   * ya quedaron detrás del índice. Con un descarte antes de un fallo, la cola
   * reportaba 0 pendientes teniendo uno adentro — o sea, una escritura que no
   * está guardada presentándose como si no existiera (CLAUDE.md §5.5).
   */
  it('cuenta lo que queda en cola aunque antes haya habido un descarte', async () => {
    const s = store([
      write('legacy', '2026-01-15T10:00:00Z', insert, 'otro-schema'),
      write('real', '2026-01-15T10:05:00Z', insert),
    ])
    const result = await flushQueue(s, 'public', async () => ({ error: 'boom' }))

    expect(result.sent).toBe(0)
    expect(result.dropped).toBe(1)
    expect(result.error).toBe('boom')
    expect(s.rows.map((r) => r.id)).toEqual(['real'])
    expect(result.remaining).toBe(s.rows.length)
  })
})

describe('looksOffline', () => {
  it('reconoce un request que nunca llegó', () => {
    expect(looksOffline('TypeError: Failed to fetch')).toBe(true)
    expect(looksOffline('NetworkError when attempting to fetch resource')).toBe(true)
    expect(looksOffline('Load failed')).toBe(true)
  })

  it('no encola un rechazo del servidor', () => {
    expect(looksOffline('new row violates row-level security policy')).toBe(false)
    expect(looksOffline(null)).toBe(false)
  })
})

describe('newId', () => {
  it('genera uuids distintos con forma de v4', () => {
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
