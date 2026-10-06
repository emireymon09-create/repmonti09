import { describe, expect, it } from 'vitest'
import {
  diapersSince,
  feedingsSince,
  legacySplitInputs,
  listAppointments,
  listContainers,
  listDiscards,
  listDrawdowns,
  listGrowth,
  nursingSince,
  sleepSince,
} from '@/lib/db'
import { PAGE_SIZE, readAll } from '@/lib/readAll'

// MAXROWS: Supabase en la nube corta cada respuesta de PostgREST en `max_rows`
// (1000 por defecto) SIN error y sin avisar; el stack local no tiene tope. Una
// lectura "sin limit" que suma (los totales de las secciones, "Lo que hay", la
// leche desechada, la estimación hacia atrás) daría un número corto en
// silencio en producción y bien acá. Este cliente falso hace lo que hace la
// nube: devuelve como mucho `maxRows` filas por pedido, y respeta `.range()`.

type Row = { id: string; [k: string]: unknown }

function fakeDb(tables: Record<string, Row[]>, maxRows = 1000) {
  const ranges: [string, number, number][] = []
  const builder = (table: string) => {
    const rows = tables[table] ?? []
    let range: [number, number] | null = null
    const b: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then') {
            const start = range ? range[0] : 0
            const end = range ? range[1] + 1 : rows.length
            const out = rows.slice(start, Math.min(end, start + maxRows))
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve({ data: out, error: null }).then(res, rej)
          }
          if (prop === 'range')
            return (from: number, to: number) => {
              range = [from, to]
              ranges.push([table, from, to])
              return b
            }
          return () => b
        },
      },
    )
    return b
  }
  return { db: { from: builder, rpc: () => Promise.reject(new Error('no rpc')) } as never, ranges }
}

const many = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `row-${String(i).padStart(5, '0')}`, ...extra(i) }))

const N = 2503 // dos páginas llenas y una corta

describe('MAXROWS: las lecturas que suman traen TODAS las filas aunque el servidor corte en 1000', () => {
  it('las cuatro *Since (totales de /feeding, /diapers, /sleep y /statistics)', async () => {
    const { db } = fakeDb({
      feedings: many(N, () => ({ amount_ml: 30 })),
      nursing_sessions: many(N),
      diaper_changes: many(N),
      sleep_sessions: many(N),
    })
    const since = '2026-01-01T00:00:00Z'
    for (const read of [feedingsSince, nursingSince, diapersSince, sleepSince]) {
      const r = await read('baby', since, db)
      expect(r.error).toBeNull()
      expect(r.data).toHaveLength(N)
      expect(new Set(r.data.map((x) => x.id)).size).toBe(N)
    }
  })

  it('contenedores, porciones y desechos ("Lo que hay", leche desechada)', async () => {
    const { db } = fakeDb({
      milk_containers: many(N, (i) => ({ label: `M${i + 1}`, amount_ml: 10, remaining_ml: 10 })),
      milk_drawdowns: many(N, () => ({ amount_ml: 5, milk_containers: { label: 'M1' } })),
      milk_discards: many(N, () => ({ amount_ml: 5, milk_containers: { label: 'M1' } })),
    })
    const containers = await listContainers('baby', db)
    expect(containers.data).toHaveLength(N)
    expect(containers.data.reduce((s, c) => s + c.remaining_ml, 0)).toBe(10 * N)
    expect((await listDrawdowns('baby', db)).data).toHaveLength(N)
    expect((await listDiscards('baby', db)).data.reduce((s, d) => s + d.amount_ml, 0)).toBe(5 * N)
  })

  it('las entradas de la estimación hacia atrás (AJ-19)', async () => {
    const { db } = fakeDb({
      feedings: many(N, () => ({ amount_ml: 30 })),
      pumping_sessions: many(N, () => ({ amount_ml: 40 })),
      milk_containers: many(N, (i) => ({ source_session_id: `s-${i}` })),
    })
    const r = await legacySplitInputs('baby', db)
    expect(r.error).toBeNull()
    expect(r.data.feedings).toHaveLength(N)
    expect(r.data.pumping).toHaveLength(N)
    expect(r.data.containerSessionIds).toHaveLength(N)
  })

  it('la curva de crecimiento y los turnos (un corte se come los más viejos o los próximos)', async () => {
    const { db } = fakeDb({ growth_measurements: many(N), doctor_appointments: many(N) })
    expect((await listGrowth('baby', db)).data).toHaveLength(N)
    expect((await listAppointments('baby', db)).data).toHaveLength(N)
  })
})

describe('readAll', () => {
  it('pide páginas de PAGE_SIZE (1000, el max_rows de Supabase) hasta que una venga corta', async () => {
    expect(PAGE_SIZE).toBe(1000)
    const { db, ranges } = fakeDb({ t: many(N) })
    const r = await readAll<Row>((from, to) =>
      (db as { from: (t: string) => { range: (a: number, b: number) => PromiseLike<never> } })
        .from('t')
        .range(from, to),
    )
    expect(r.error).toBeNull()
    expect(r.data).toHaveLength(N)
    expect(ranges.map(([, a, b]) => [a, b])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('un múltiplo exacto de la página pide una más, vacía, para saber que terminó', async () => {
    const pages: number[] = []
    const rows = many(14)
    const r = await readAll<Row>(async (from, to) => {
      pages.push(from)
      return { data: rows.slice(from, to + 1), error: null }
    }, 7)
    expect(r.data).toHaveLength(14)
    expect(pages).toEqual([0, 7, 14])
  })

  it('un error en el medio devuelve el error (nunca un total parcial como si fuera todo)', async () => {
    const boom = { message: 'timeout' }
    const rows = many(20)
    const r = await readAll<Row>(
      async (from, to) =>
        from === 7 ? { data: null, error: boom } : { data: rows.slice(from, to + 1), error: null },
      7,
    )
    expect(r.error).toBe(boom)
    expect(r.data).toEqual([])
  })

  it('una fila que se corre de página (alguien escribió entre dos pedidos) no se cuenta dos veces', async () => {
    const rows = many(10)
    let shifted = false
    const r = await readAll<Row>(async (from, to) => {
      // Entre la primera y la segunda página entra una fila nueva arriba de todo:
      // la última de la página 1 vuelve a aparecer como primera de la 2.
      const view = shifted ? [{ id: 'new' }, ...rows] : rows
      shifted = true
      return { data: view.slice(from, to + 1), error: null }
    }, 5)
    expect(r.data.map((x) => x.id).filter((id) => id === 'row-00004')).toHaveLength(1)
  })
})
