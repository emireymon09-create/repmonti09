import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sendOpWith } from '@/lib/db'
import { looksOffline } from '@/lib/queue'
import { adminClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

// El replay de la cola offline manda cada alta con INSERT … ON CONFLICT (id)
// DO NOTHING (sendOpWith en lib/db.ts, modo 'replay'); una escritura online
// (modo 'write') es un insert común. Acá se prueban esas mismas llamadas, como
// padre autenticado por PostgREST + JWT, contra RLS y los GRANTs reales: que
// reenviar la misma alta no dé error ni deje dos filas, que online un id
// repetido sí sea error, y que nada de eso abra camino hacia la otra familia.

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

beforeAll(async () => {
  ;({ a, b, cleanup } = await seedTwoFamilies('replay'))
})
afterAll(async () => {
  await cleanup()
})

function diaper(fam: SeededFamily, id: string, type = 'wet') {
  return {
    kind: 'insert' as const,
    table: 'diaper_changes',
    row: {
      id,
      baby_id: fam.babyId,
      logged_by: fam.userId,
      diaper_type: type,
      changed_at: '2026-01-16T03:00:00Z',
    },
  }
}

async function countById(id: string): Promise<number> {
  const { count, error } = await adminClient()
    .from('diaper_changes')
    .select('id', { count: 'exact', head: true })
    .eq('id', id)
  if (error) throw error
  return count ?? 0
}

describe('replay de una alta que ya llegó al server', () => {
  it('la misma alta dos veces: sin error y una sola fila', async () => {
    const id = randomUUID()
    const first = await sendOpWith(a.client.schema('public'), diaper(a, id), 'replay')
    const again = await sendOpWith(a.client.schema('public'), diaper(a, id), 'replay')

    expect(first.error).toBeNull()
    expect(again.error).toBeNull()
    expect(await countById(id)).toBe(1)
  })

  it('dos "pestañas" a la vez con la misma alta: sin error y una sola fila', async () => {
    const id = randomUUID()
    const results = await Promise.all([
      sendOpWith(a.client.schema('public'), diaper(a, id), 'replay'),
      sendOpWith(a.client.schema('public'), diaper(a, id), 'replay'),
    ])
    expect(results.map((r) => r.error)).toEqual([null, null])
    expect(await countById(id)).toBe(1)
  })

  it('el reenvío no pisa una edición que ya se aplicó', async () => {
    const id = randomUUID()
    await sendOpWith(a.client.schema('public'), diaper(a, id, 'wet'), 'replay')
    const edit = await sendOpWith(
      a.client.schema('public'),
      {
        kind: 'update',
        table: 'diaper_changes',
        id,
        patch: { diaper_type: 'both' },
      },
      'replay',
    )
    expect(edit.error).toBeNull()

    const replay = await sendOpWith(a.client.schema('public'), diaper(a, id, 'wet'), 'replay')
    expect(replay.error).toBeNull()

    const { data } = await adminClient()
      .from('diaper_changes')
      .select('diaper_type')
      .eq('id', id)
      .single()
    expect(data!.diaper_type).toBe('both')
  })
})

describe('escritura online (modo write): insert común', () => {
  it('un id repetido es un error visible, no un "Guardado"', async () => {
    const id = randomUUID()
    const first = await sendOpWith(a.client.schema('public'), diaper(a, id), 'write')
    const again = await sendOpWith(a.client.schema('public'), diaper(a, id), 'write')
    expect(first.error).toBeNull()
    expect(again.error).toContain('duplicate key')
    expect(await countById(id)).toBe(1)
  })

  it('respuesta perdida: el insert online llegó, quedó en cola y el replay no falla', async () => {
    // write() encola si no ve la respuesta; el insert ya estaba en la base.
    const id = randomUUID()
    expect((await sendOpWith(a.client.schema('public'), diaper(a, id), 'write')).error).toBeNull()
    const replay = await sendOpWith(a.client.schema('public'), diaper(a, id), 'replay')
    expect(replay.error).toBeNull()
    expect(await countById(id)).toBe(1)
  })
})

describe('replay cortado por tiempo', () => {
  it('con la señal abortada, supabase-js devuelve un error que cuenta como offline y no escribe', async () => {
    const id = randomUUID()
    const controller = new AbortController()
    controller.abort()
    const { error } = await sendOpWith(
      a.client.schema('public'),
      diaper(a, id),
      'replay',
      controller.signal,
    )
    expect(error).not.toBeNull()
    expect(looksOffline(error)).toBe(true)
    expect(await countById(id)).toBe(0)
  })
})

describe('ON CONFLICT DO NOTHING no cruza de familia', () => {
  it('una alta contra el bebé de otra familia sigue rechazada por RLS', async () => {
    const { error } = await sendOpWith(
      a.client.schema('public'),
      {
        ...diaper(a, randomUUID()),
        row: { ...diaper(a, randomUUID()).row, baby_id: b.babyId },
      },
      'replay',
    )
    expect(error).not.toBeNull()
    expect(error!.toLowerCase()).toContain('row-level security')
  })

  it('reusar el id de una fila ajena no la toca (se descarta en silencio)', async () => {
    // El caso que DO NOTHING podría "tragarse". Con ids v4 aleatorios no pasa
    // en la práctica; acá se fuerza para dejar escrito qué pasaría: nada.
    const ajeno = randomUUID()
    const { error: seedErr } = await adminClient()
      .from('diaper_changes')
      .insert(diaper(b, ajeno, 'dirty').row)
    expect(seedErr).toBeNull()

    const { error } = await sendOpWith(a.client.schema('public'), diaper(a, ajeno, 'wet'), 'replay')
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('diaper_changes')
      .select('baby_id, diaper_type')
      .eq('id', ajeno)
      .single()
    expect(data).toEqual({ baby_id: b.babyId, diaper_type: 'dirty' })
  })
})
