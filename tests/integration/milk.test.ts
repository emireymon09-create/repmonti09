import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { listContainers, listDrawdowns, sendOpWith } from '@/lib/db'
import type { PendingOp } from '@/lib/queue'
import { adminClient, anonClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

// El inventario de leche (0013) por el camino real: PostgREST + JWT de un padre,
// RLS y GRANTs de verdad, las cinco funciones y sus guardas.
//
// NECESITA 0013 APLICADA EN LA BASE LOCAL (`pnpm db:up`). Sin ella la suite se
// SALTA sola (la sonda de abajo) y hay que reportarla como NO VERIFICADA. Corrió
// en verde contra el stack local el 4 oct 2026 (docs/progreso-feeding-v3.md).

async function hasMilkSchema(): Promise<boolean> {
  try {
    const { error } = await adminClient().from('milk_containers').select('id').limit(0)
    return !error
  } catch {
    return false
  }
}

const ready = await hasMilkSchema()

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

function pump(fam: SeededFamily, left: number | null, right: number | null, label: string | null) {
  const id = randomUUID()
  const containerId = label ? randomUUID() : null
  const op: PendingOp = {
    kind: 'rpc',
    fn: 'log_pumping_session',
    args: {
      p_id: id,
      p_baby_id: fam.babyId,
      p_side: 'both',
      p_left_ml: left,
      p_right_ml: right,
      p_notes: null,
      p_pumped_at: new Date().toISOString(),
      p_container_id: containerId,
      p_container_label: label,
      p_container_expires_at: null,
    },
    table: 'pumping_sessions',
    id,
    effect: 'insert',
  }
  return { id, containerId, op }
}

function feed(fam: SeededFamily, portions: [string, number][], formula = 0) {
  const id = randomUUID()
  const op: PendingOp = {
    kind: 'rpc',
    fn: 'log_bottle_feed',
    args: {
      p_id: id,
      p_baby_id: fam.babyId,
      p_fed_at: new Date().toISOString(),
      p_notes: null,
      p_formula_ml: formula,
      p_portions: portions.map(([container_id, amount_ml]) => ({ container_id, amount_ml })),
    },
    table: 'feedings',
    id,
    effect: 'insert',
  }
  return { id, op }
}

describe.skipIf(!ready)('inventario de leche (0013) — necesita la migración aplicada', () => {
  beforeAll(async () => {
    ;({ a, b, cleanup } = await seedTwoFamilies('milk'))
  })
  afterAll(async () => {
    await cleanup()
  })

  it('extracción con izquierda y derecha: contenedor M1 con el total; sin cantidad, sin contenedor', async () => {
    const p1 = pump(a, 60, 50, 'M1')
    expect(await sendOpWith(a.client, p1.op, 'write')).toEqual({ error: null })
    const p2 = pump(a, null, null, null)
    expect(await sendOpWith(a.client, p2.op, 'write')).toEqual({ error: null })
    const { data } = await listContainers(a.babyId, a.client)
    expect(data.map((c) => [c.label, c.amount_ml, c.remaining_ml])).toEqual([['M1', 110, 110]])
    // Reenvío: no-op.
    expect(await sendOpWith(a.client, p1.op, 'replay')).toEqual({ error: null })
    expect((await listContainers(a.babyId, a.client)).data).toHaveLength(1)
  })

  it('una cinta viva repetida se rechaza con un código legible', async () => {
    const dup = pump(a, 10, 10, 'M1')
    expect((await sendOpWith(a.client, dup.op, 'write')).error).toBe('milk_label_taken:M1')
  })

  it('toma: porciones + fórmula, totales del servidor; sobregiro rechazado; anular devuelve', async () => {
    const m1 = (await listContainers(a.babyId, a.client)).data[0]
    const f = feed(a, [[m1.id, 50]], 30)
    expect(await sendOpWith(a.client, f.op, 'write')).toEqual({ error: null })
    const { data: row } = await a.client
      .from('feedings')
      .select('amount_ml, breast_milk_ml, formula_ml')
      .eq('id', f.id)
      .single()
    expect(row).toEqual({ amount_ml: 80, breast_milk_ml: 50, formula_ml: 30 })
    expect((await listDrawdowns(a.babyId, a.client)).data.map((d) => d.label)).toEqual(['M1'])

    const over = feed(a, [[m1.id, 61]])
    expect((await sendOpWith(a.client, over.op, 'write')).error).toBe('milk_overdraw:M1')

    // Mismo id, otra carga: excepción, no un no-op silencioso.
    const conflict = { ...f.op, args: { ...(f.op as { args: object }).args, p_formula_ml: 1 } }
    expect((await sendOpWith(a.client, conflict as PendingOp, 'replay')).error).toBe(
      'milk_idempotency_conflict',
    )

    // No se anula una extracción ya servida.
    const { data: session } = await a.client
      .from('pumping_sessions')
      .select('id')
      .eq('amount_ml', 110)
      .single()
    const { error: voidErr } = await a.client.rpc('void_pumping_session', { p_id: session!.id })
    expect(voidErr?.message).toBe('milk_already_served:M1')

    // Las guardas: ni la cantidad ni el borrado de una toma con desglose por fuera.
    const { error: guardErr } = await a.client
      .from('feedings')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', f.id)
    expect(guardErr?.message).toBe('milk_rpc_only')
    // La hora sí.
    const { error: timeErr } = await a.client
      .from('feedings')
      .update({ fed_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', f.id)
    expect(timeErr).toBeNull()

    expect((await a.client.rpc('void_bottle_feed', { p_feeding_id: f.id })).error).toBeNull()
    expect((await listContainers(a.babyId, a.client)).data[0].remaining_ml).toBe(110)
    // Dos veces: no-op.
    expect((await a.client.rpc('void_bottle_feed', { p_feeding_id: f.id })).error).toBeNull()
    expect((await listContainers(a.babyId, a.client)).data[0].remaining_ml).toBe(110)
  })

  it('dos tomas a la vez sobre el mismo contenedor: una entra, la otra recibe sobregiro', async () => {
    const m1 = (await listContainers(a.babyId, a.client)).data[0]
    const results = await Promise.all([
      sendOpWith(a.client, feed(a, [[m1.id, 70]]).op, 'write'),
      sendOpWith(a.client, feed(a, [[m1.id, 70]]).op, 'write'),
    ])
    expect(results.filter((r) => r.error === null)).toHaveLength(1)
    expect(results.filter((r) => r.error === 'milk_overdraw:M1')).toHaveLength(1)
  })

  it('editar no baja de lo servido; dar cantidad a una sesión vacía crea su contenedor', async () => {
    const empty = pump(a, null, null, null)
    await sendOpWith(a.client, empty.op, 'write')
    const { error } = await a.client.rpc('update_pumping_session', {
      p_id: empty.id,
      p_side: 'left',
      p_left_ml: 40,
      p_right_ml: null,
      p_notes: null,
      p_pumped_at: new Date().toISOString(),
      p_container_id: randomUUID(),
      p_container_label: 'M2',
    })
    expect(error).toBeNull()
    expect((await listContainers(a.babyId, a.client)).data.map((c) => c.label)).toContain('M2')

    const { data: served } = await a.client
      .from('pumping_sessions')
      .select('id')
      .eq('amount_ml', 110)
      .single()
    const { error: below } = await a.client.rpc('update_pumping_session', {
      p_id: served!.id,
      p_side: 'both',
      p_left_ml: 30,
      p_right_ml: 30,
      p_notes: null,
      p_pumped_at: new Date().toISOString(),
    })
    expect(below?.message).toBe('milk_served_exceeds_amount:M1')
  })

  it('una toma vieja sin desglose se sigue editando entera', async () => {
    const { data: legacy } = await adminClient()
      .from('feedings')
      .select('id')
      .eq('baby_id', a.babyId)
      .is('breast_milk_ml', null)
      .limit(1)
      .single()
    const { error } = await a.client
      .from('feedings')
      .update({ amount_ml: 120, feeding_type: 'bottle' })
      .eq('id', legacy!.id)
    expect(error).toBeNull()
  })

  it('RLS: la otra familia no ve nada ni puede servir de un contenedor ajeno', async () => {
    expect((await listContainers(a.babyId, b.client)).data).toEqual([])
    expect((await listDrawdowns(a.babyId, b.client)).data).toEqual([])
    const m1 = (await listContainers(a.babyId, a.client)).data[0]
    const steal = feed(b, [[m1.id, 5]])
    expect((await sendOpWith(b.client, steal.op, 'write')).error).toBe('milk_container_unusable')
    const intrude = pump(a, 10, 10, 'M9')
    expect((await sendOpWith(b.client, intrude.op, 'write')).error).toBe('milk_baby_not_found')
  })

  it('anon no ejecuta las funciones ni lee las tablas', async () => {
    const anon = anonClient()
    expect(
      (await anon.rpc('void_bottle_feed', { p_feeding_id: randomUUID() })).error,
    ).not.toBeNull()
    expect((await anon.from('milk_containers').select('id')).error).not.toBeNull()
  })
})

describe('sonda del esquema', () => {
  it('dice si la base tiene 0013 (si no, la suite de arriba se salta: NO VERIFICADO)', () => {
    expect(typeof ready).toBe('boolean')
  })
})
