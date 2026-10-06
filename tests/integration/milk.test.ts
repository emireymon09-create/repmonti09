import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { listContainers, listDrawdowns, sendOpWith } from '@/lib/db'
import type { PendingOp } from '@/lib/queue'
import { suggestContainerLabel } from '@/lib/milk'
import { adminClient, anonClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

// El inventario de leche (0014) por el camino real: PostgREST + JWT de un padre,
// RLS y GRANTs de verdad, las cinco funciones y sus guardas.
//
// NECESITA 0014 APLICADA EN LA BASE LOCAL (`pnpm db:up`). Sin ella la suite se
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

describe.skipIf(!ready)('inventario de leche (0014) — necesita la migración aplicada', () => {
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

// Pedido del dueño (5 oct 2026): la cinta se puede elegir, aunque se salte la
// secuencia. El servidor sigue siendo la autoridad: rechaza una cinta viva
// repetida y un formato inválido, y deja reusar la de un contenedor anulado.
// Familias propias, para no depender del orden de la suite de arriba.
describe.skipIf(!ready)('cinta elegida (5 oct 2026) — necesita 0014', () => {
  let f: SeededFamily
  let done: () => Promise<void>
  beforeAll(async () => {
    ;({ a: f, cleanup: done } = await seedTwoFamilies('milk-tape'))
  })
  afterAll(async () => {
    await done()
  })
  const liveLabels = async () =>
    (await listContainers(f.babyId, f.client)).data.map((c) => c.label).sort()

  it('una cinta elegida que se salta la secuencia se registra tal cual (M1 → M5)', async () => {
    expect(await sendOpWith(f.client, pump(f, 30, null, 'M1').op, 'write')).toEqual({ error: null })
    const m5 = pump(f, 20, 25, 'M5')
    expect(await sendOpWith(f.client, m5.op, 'write')).toEqual({ error: null })
    const { data } = await listContainers(f.babyId, f.client)
    expect(data.map((c) => [c.label, c.amount_ml]).sort()).toEqual([
      ['M1', 30],
      ['M5', 45],
    ])
    // La sugerencia siguiente no rellena el hueco.
    expect(suggestContainerLabel(data)).toBe('M6')
  })

  it('una cinta que tiene un contenedor vivo se rechaza con el código legible, sin renumerar', async () => {
    const dup = pump(f, 10, null, 'M5')
    expect((await sendOpWith(f.client, dup.op, 'write')).error).toBe('milk_label_taken:M5')
    const { data: session } = await f.client.from('pumping_sessions').select('id').eq('id', dup.id)
    expect(session).toEqual([])
    expect(await liveLabels()).toEqual(['M1', 'M5'])
  })

  it('un formato inválido lo rechaza también el servidor', async () => {
    for (const bad of ['M0', 'm6', 'X6', 'M 6']) {
      expect((await sendOpWith(f.client, pump(f, 10, null, bad).op, 'write')).error, bad).toBe(
        'milk_bad_input',
      )
    }
    expect(await liveLabels()).toEqual(['M1', 'M5'])
  })

  it('la cinta de una extracción anulada se puede volver a usar', async () => {
    const { data: m5 } = await f.client
      .from('milk_containers')
      .select('source_session_id')
      .eq('baby_id', f.babyId)
      .eq('label', 'M5')
      .is('voided_at', null)
      .single()
    const { error: voidErr } = await f.client.rpc('void_pumping_session', {
      p_id: m5!.source_session_id,
    })
    expect(voidErr).toBeNull()
    expect(await liveLabels()).toEqual(['M1'])
    const again = pump(f, 15, null, 'M5')
    expect(await sendOpWith(f.client, again.op, 'write')).toEqual({ error: null })
    const { data: all } = await adminClient()
      .from('milk_containers')
      .select('label, amount_ml, voided_at')
      .eq('baby_id', f.babyId)
      .eq('label', 'M5')
    expect(all!.filter((c) => c.voided_at === null).map((c) => c.amount_ml)).toEqual([15])
    expect(all!.filter((c) => c.voided_at !== null)).toHaveLength(1)
  })

  it('el servidor tolera una sesión sin cantidad con una cinta escrita: no falla y no crea contenedor', async () => {
    // Incluso con una cinta repetida o inválida: sin leche no hay contenedor.
    for (const label of ['M9', 'M1', 'basura']) {
      const empty = pump(f, null, null, label)
      expect(await sendOpWith(f.client, empty.op, 'write'), label).toEqual({ error: null })
      const { data: row } = await f.client
        .from('pumping_sessions')
        .select('amount_ml')
        .eq('id', empty.id)
        .single()
      expect(row).toEqual({ amount_ml: null })
    }
    expect(await liveLabels()).toEqual(['M1', 'M5'])
  })
})

// La ventana del deploy (6 oct 2026). Después de aplicar 0014, los teléfonos
// siguen corriendo un rato la app v0.12.1 cacheada (PWA). Esa app escribe
// pumping_sessions DIRECTO, sin las funciones: alta `{id, baby_id, logged_by,
// side, amount_ml, notes, pumped_at}` (y su replay como upsert
// ignoreDuplicates), edición con side/amount_ml/notes/pumped_at y borrado con
// voided_at. Si la guarda la rechaza, la cola vieja queda trabada hasta que la
// persona descarte la entrada — y esa leche registrada se pierde. Estas son las
// llamadas EXACTAS de v0.12.1 (lib/db.ts de 0cbe798: sendOpWith, logPumping,
// updatePumping, voidPumping, updateFeeding, voidFeeding).
describe.skipIf(!ready)('app vieja v0.12.1 durante el deploy — necesita 0014', () => {
  let f: SeededFamily
  let other: SeededFamily
  let done: () => Promise<void>
  beforeAll(async () => {
    ;({ a: f, b: other, cleanup: done } = await seedTwoFamilies('milk-v0121'))
  })
  afterAll(async () => {
    await done()
  })

  /** El alta de logPumping de v0.12.1, tal cual. */
  function oldPumpRow(amountMl: number | null, side = 'both') {
    return {
      id: randomUUID(),
      baby_id: f.babyId,
      logged_by: f.userId,
      side,
      amount_ml: amountMl,
      notes: null as string | null,
      pumped_at: new Date().toISOString(),
    }
  }
  const containersOf = async (sessionId: string) =>
    (
      await adminClient()
        .from('milk_containers')
        .select('id, voided_at')
        .eq('source_session_id', sessionId)
    ).data
  const session = async (id: string) =>
    (
      await adminClient()
        .from('pumping_sessions')
        .select('side, amount_ml, left_ml, right_ml, notes, pumped_at, voided_at, baby_id')
        .eq('id', id)
        .single()
    ).data
  const stash = async () =>
    (await listContainers(f.babyId, f.client)).data.map((c) => [c.label, c.remaining_ml])

  it('alta vieja en línea con cantidad: entra, sin contenedor y sin mover lo que hay', async () => {
    expect(await sendOpWith(f.client, pump(f, 40, 20, 'M1').op, 'write')).toEqual({ error: null })
    const before = await stash()
    const row = oldPumpRow(90, 'left')
    const { error } = await f.client.from('pumping_sessions').insert(row)
    expect(error).toBeNull()
    expect(await session(row.id)).toMatchObject({
      side: 'left',
      amount_ml: 90,
      left_ml: null,
      right_ml: null,
      voided_at: null,
    })
    expect(await containersOf(row.id)).toEqual([])
    expect(await stash()).toEqual(before)
    expect(before).toEqual([['M1', 60]])
  })

  it('alta vieja reenviada por la cola (upsert ignoreDuplicates) dos veces: una sola fila', async () => {
    const row = oldPumpRow(120)
    for (let i = 0; i < 2; i++) {
      const { error } = await f.client
        .from('pumping_sessions')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      expect(error, `replay ${i + 1}`).toBeNull()
    }
    const { data } = await adminClient().from('pumping_sessions').select('id').eq('id', row.id)
    expect(data).toHaveLength(1)
    expect(await containersOf(row.id)).toEqual([])
    expect(await stash()).toEqual([['M1', 60]])
  })

  it('alta vieja sin cantidad: entra como siempre', async () => {
    const row = oldPumpRow(null)
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    expect(await containersOf(row.id)).toEqual([])
  })

  it('edición vieja de una sesión vieja (lado, cantidad, hora, nota): entra, sin contenedor', async () => {
    const row = oldPumpRow(80, 'both')
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    const at = new Date(Date.now() - 3_600_000).toISOString()
    const { error } = await f.client
      .from('pumping_sessions')
      .update({ side: 'right', amount_ml: 95, notes: 'corrected', pumped_at: at })
      .eq('id', row.id)
    expect(error).toBeNull()
    const s = await session(row.id)
    expect(s).toMatchObject({
      side: 'right',
      amount_ml: 95,
      notes: 'corrected',
      left_ml: null,
      right_ml: null,
    })
    expect(Date.parse(s!.pumped_at)).toBe(Date.parse(at))
    expect(await containersOf(row.id)).toEqual([])
    expect(await stash()).toEqual([['M1', 60]])
  })

  it('borrado viejo de una sesión vieja (voided_at directo): entra', async () => {
    const row = oldPumpRow(70)
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    const { error } = await f.client
      .from('pumping_sessions')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', row.id)
    expect(error).toBeNull()
    expect((await session(row.id))!.voided_at).not.toBeNull()
    expect(await stash()).toEqual([['M1', 60]])
  })

  it('por fuera de las funciones, un alta con izquierda o derecha se sigue rechazando', async () => {
    const extras: Record<string, number>[] = [
      { left_ml: 30 },
      { right_ml: 30 },
      { left_ml: 0, right_ml: 0 },
    ]
    for (const extra of extras) {
      const row = { ...oldPumpRow(30), ...extra }
      const { error } = await f.client.from('pumping_sessions').insert(row)
      expect(error?.message, JSON.stringify(extra)).toBe('milk_rpc_only')
      const { data } = await adminClient().from('pumping_sessions').select('id').eq('id', row.id)
      expect(data).toEqual([])
    }
  })

  it('una sesión vieja nunca gana izquierda o derecha por fuera de las funciones', async () => {
    const row = oldPumpRow(50)
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    for (const patch of [{ left_ml: 50 }, { right_ml: 50 }, { left_ml: 25, amount_ml: 25 }]) {
      const { error } = await f.client.from('pumping_sessions').update(patch).eq('id', row.id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    expect(await session(row.id)).toMatchObject({ amount_ml: 50, left_ml: null, right_ml: null })
    expect(await containersOf(row.id)).toEqual([])
  })

  it('una sesión vieja no se muda de bebé (ni con service_role, que salta RLS)', async () => {
    const row = oldPumpRow(50)
    expect((await f.client.from('pumping_sessions').insert(row)).error).toBeNull()
    const { error } = await adminClient()
      .from('pumping_sessions')
      .update({ baby_id: other.babyId })
      .eq('id', row.id)
    expect(error?.message).toBe('milk_rpc_only')
    expect((await session(row.id))!.baby_id).toBe(f.babyId)
  })

  it('una sesión con contenedor sigue protegida: ni borrado, ni cantidad, ni lado por fuera', async () => {
    const m2 = pump(f, 30, 30, 'M2')
    expect(await sendOpWith(f.client, m2.op, 'write')).toEqual({ error: null })
    const before = await stash()
    for (const patch of [
      { voided_at: new Date().toISOString() },
      { amount_ml: 200 },
      { side: 'left', amount_ml: 60 },
      { pumped_at: new Date(Date.now() - 60_000).toISOString() },
    ]) {
      const { error } = await f.client.from('pumping_sessions').update(patch).eq('id', m2.id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    // Lo que la app vieja manda al editar solo la nota (los demás campos
    // iguales) sigue entrando, como antes.
    const s = await session(m2.id)
    const { error: noteErr } = await f.client
      .from('pumping_sessions')
      .update({ side: s!.side, amount_ml: s!.amount_ml, pumped_at: s!.pumped_at, notes: 'n' })
      .eq('id', m2.id)
    expect(noteErr).toBeNull()
    expect(await session(m2.id)).toMatchObject({ amount_ml: 60, voided_at: null, notes: 'n' })
    expect(await stash()).toEqual(before)
  })

  it('una toma con desglose sigue protegida; cambiar solo la hora (resto igual) entra', async () => {
    const m1 = (await listContainers(f.babyId, f.client)).data.find((c) => c.label === 'M1')!
    const fd = feed(f, [[m1.id, 20]], 10)
    expect(await sendOpWith(f.client, fd.op, 'write')).toEqual({ error: null })
    const before = await stash()

    const { error: voidErr } = await f.client
      .from('feedings')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', fd.id)
    expect(voidErr?.message).toBe('milk_rpc_only')
    const { error: amountErr } = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: 45, fed_at: new Date().toISOString() })
      .eq('id', fd.id)
    expect(amountErr?.message).toBe('milk_rpc_only')

    // El updateFeeding de v0.12.1 manda los tres campos: con tipo y cantidad
    // iguales es una corrección de hora, y entra.
    const at = new Date(Date.now() - 120_000).toISOString()
    const { error: timeErr } = await f.client
      .from('feedings')
      .update({ feeding_type: 'bottle', amount_ml: 30, fed_at: at })
      .eq('id', fd.id)
    expect(timeErr).toBeNull()
    const { data: row } = await adminClient()
      .from('feedings')
      .select('amount_ml, breast_milk_ml, formula_ml, voided_at, fed_at')
      .eq('id', fd.id)
      .single()
    expect(row).toMatchObject({
      amount_ml: 30,
      breast_milk_ml: 20,
      formula_ml: 10,
      voided_at: null,
    })
    expect(Date.parse(row!.fed_at)).toBe(Date.parse(at))
    expect(await stash()).toEqual(before)
  })

  it('una toma vieja de biberón sin desglose (alta, edición y borrado de v0.12.1) entra', async () => {
    const id = randomUUID()
    const base = {
      id,
      baby_id: f.babyId,
      logged_by: f.userId,
      feeding_type: 'bottle',
      amount_ml: 90,
      fed_at: new Date().toISOString(),
    }
    expect((await f.client.from('feedings').insert(base)).error).toBeNull()
    expect(
      (await f.client.from('feedings').upsert(base, { onConflict: 'id', ignoreDuplicates: true }))
        .error,
    ).toBeNull()
    expect(
      (await f.client.from('feedings').update({ amount_ml: 100 }).eq('id', id)).error,
    ).toBeNull()
    expect(
      (await f.client.from('feedings').update({ voided_at: new Date().toISOString() }).eq('id', id))
        .error,
    ).toBeNull()
    expect(await stash()).toEqual([
      ['M1', 40],
      ['M2', 60],
    ])
  })
})

describe('sonda del esquema', () => {
  it('dice si la base tiene 0014 (si no, la suite de arriba se salta: NO VERIFICADO)', () => {
    expect(typeof ready).toBe('boolean')
  })
})
