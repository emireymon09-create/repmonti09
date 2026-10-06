import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { listContainers, listDrawdowns, sendOpWith } from '@/lib/db'
import type { PendingOp } from '@/lib/queue'
import { stashMl, suggestContainerLabel } from '@/lib/milk'
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

// Ramas de 0014 que la auditoría del 6 oct 2026 encontró sin test. Familia
// propia, para no depender del orden de las suites de arriba. Cada rechazo se
// comprueba también contra la base (service_role): el error solo no alcanza,
// la base tiene que haber quedado igual.
describe.skipIf(!ready)('ramas de 0014 sin cubrir (auditoría 6 oct 2026) — necesita 0014', () => {
  let f: SeededFamily
  let other: SeededFamily
  let legacyOnly: SeededFamily
  let sibling: SeededFamily
  let done: () => Promise<void>
  let done2: () => Promise<void>
  beforeAll(async () => {
    ;({ a: f, b: other, cleanup: done } = await seedTwoFamilies('milk-audit'))
    ;({ a: legacyOnly, cleanup: done2 } = await seedTwoFamilies('milk-audit-legacy'))
    // Un segundo bebé en la MISMA familia: RLS lo deja ver, la función no.
    const { data: baby, error } = await adminClient()
      .from('babies')
      .insert({ family_id: f.familyId, name: 'Bebe hermano', birth_date: '2026-02-01' })
      .select('id')
      .single()
    if (error) throw error
    sibling = { ...f, babyId: baby.id }
  })
  afterAll(async () => {
    await done()
    await done2()
  })

  const admin = () => adminClient()
  /** Foto de todo lo que el inventario toca para el bebé: lo que tiene que quedar igual. */
  async function snapshot(babyId = f.babyId) {
    const [c, d, fe, p] = await Promise.all([
      admin()
        .from('milk_containers')
        .select('id, label, amount_ml, remaining_ml, expires_at, voided_at, source_session_id')
        .eq('baby_id', babyId)
        .order('id'),
      admin()
        .from('milk_drawdowns')
        .select('id, container_id, feeding_id, amount_ml, voided_at')
        .eq('baby_id', babyId)
        .order('id'),
      admin()
        .from('feedings')
        .select('id, baby_id, amount_ml, breast_milk_ml, formula_ml, voided_at, fed_at')
        .eq('baby_id', babyId)
        .order('id'),
      admin()
        .from('pumping_sessions')
        .select('id, side, amount_ml, left_ml, right_ml, pumped_at, voided_at, notes')
        .eq('baby_id', babyId)
        .order('id'),
    ])
    // A failed read would give null on both sides and make "unchanged" pass for nothing.
    for (const r of [c, d, fe, p]) expect(r.error).toBeNull()
    return { containers: c.data, drawdowns: d.data, feedings: fe.data, sessions: p.data }
  }
  async function pumpOk(
    fam: SeededFamily,
    left: number | null,
    right: number | null,
    label: string,
    pumpedAt?: string,
  ) {
    const p = pump(fam, left, right, label)
    if (pumpedAt) (p.op as { args: Record<string, unknown> }).args.p_pumped_at = pumpedAt
    expect(await sendOpWith(fam.client, p.op, 'write'), label).toEqual({ error: null })
    const { data } = await admin()
      .from('milk_containers')
      .select('id, label, remaining_ml, expires_at, voided_at')
      .eq('source_session_id', p.id)
      .single()
    return { ...p, container: data! }
  }
  const updateArgs = (id: string, left: number | null, right: number | null) => ({
    p_id: id,
    p_side: 'both',
    p_left_ml: left,
    p_right_ml: right,
    p_notes: 'editada',
    p_pumped_at: new Date().toISOString(),
  })

  // ---------------------------------------------------------------- (a)
  it('editar una extracción a total 0 con su contenedor SIN servir: anula el contenedor y actualiza la sesión', async () => {
    const p = await pumpOk(f, 30, 20, 'M1')
    for (const [left, right] of [
      [0, 0],
      [null, null],
    ] as const) {
      if (left === null) {
        // Volver a darle leche (crea M1 otra vez) y bajarla a null/null.
        const { error } = await f.client.rpc('update_pumping_session', {
          ...updateArgs(p.id, 10, 5),
          p_container_id: randomUUID(),
          p_container_label: 'M1',
        })
        expect(error).toBeNull()
      }
      const { error } = await f.client.rpc('update_pumping_session', updateArgs(p.id, left, right))
      expect(error, `${left}/${right}`).toBeNull()
      const { data: live } = await admin()
        .from('milk_containers')
        .select('id')
        .eq('source_session_id', p.id)
        .is('voided_at', null)
      expect(live, `${left}/${right}`).toEqual([])
      const { data: s } = await admin()
        .from('pumping_sessions')
        .select('amount_ml, left_ml, right_ml, notes, voided_at')
        .eq('id', p.id)
        .single()
      expect(s, `${left}/${right}`).toEqual({
        amount_ml: null,
        left_ml: left,
        right_ml: right,
        notes: 'editada',
        voided_at: null,
      })
    }
    // Dos contenedores anulados (uno por vuelta), ninguno vivo.
    const { data: all } = await admin()
      .from('milk_containers')
      .select('voided_at')
      .eq('source_session_id', p.id)
    expect(all!.map((c) => c.voided_at !== null)).toEqual([true, true])
  })

  it('editar una extracción a total 0 con leche YA servida: milk_already_served y la base no cambia', async () => {
    const p = await pumpOk(f, 40, 20, 'M2')
    const fd = feed(f, [[p.container.id, 15]])
    expect(await sendOpWith(f.client, fd.op, 'write')).toEqual({ error: null })
    const before = await snapshot()
    for (const [left, right] of [
      [0, 0],
      [null, null],
    ] as const) {
      const { error } = await f.client.rpc('update_pumping_session', updateArgs(p.id, left, right))
      expect(error?.message, `${left}/${right}`).toBe('milk_already_served:M2')
    }
    expect(await snapshot()).toEqual(before)
  })

  // ---------------------------------------------------------------- (b)
  it('INSERT y UPDATE directos sobre milk_containers y milk_drawdowns: milk_rpc_only, la base no cambia', async () => {
    const p = await pumpOk(f, 25, 25, 'M3')
    const fd = feed(f, [[p.container.id, 10]])
    expect(await sendOpWith(f.client, fd.op, 'write')).toEqual({ error: null })
    const { data: dd } = await admin()
      .from('milk_drawdowns')
      .select('id')
      .eq('feeding_id', fd.id)
      .single()
    const before = await snapshot()
    const now = new Date().toISOString()

    const insC = await f.client.from('milk_containers').insert({
      id: randomUUID(),
      family_id: f.familyId,
      baby_id: f.babyId,
      label: 'M77',
      amount_ml: 100,
      remaining_ml: 100,
      stored_at: now,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(insC.error?.message).toBe('milk_rpc_only')
    for (const patch of [
      { remaining_ml: 50 },
      { amount_ml: 500, remaining_ml: 500 },
      { voided_at: now },
      { expires_at: new Date(Date.now() + 9e9).toISOString() },
      { label: 'M78' },
    ]) {
      const { error } = await f.client
        .from('milk_containers')
        .update(patch)
        .eq('id', p.container.id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }

    const insD = await f.client.from('milk_drawdowns').insert({
      family_id: f.familyId,
      baby_id: f.babyId,
      container_id: p.container.id,
      feeding_id: fd.id,
      amount_ml: 5,
    })
    expect(insD.error?.message).toBe('milk_rpc_only')
    for (const patch of [{ amount_ml: 1 }, { voided_at: now }]) {
      const { error } = await f.client.from('milk_drawdowns').update(patch).eq('id', dd!.id)
      expect(error?.message, JSON.stringify(patch)).toBe('milk_rpc_only')
    }
    expect(await snapshot()).toEqual(before)
  })

  // ---------------------------------------------------------------- (c)
  it('feedings: una toma vieja no gana desglose, una con desglose no cambia bebé ni desglose, y no se inserta desglose directo', async () => {
    const legacyId = randomUUID()
    expect(
      (
        await f.client.from('feedings').insert({
          id: legacyId,
          baby_id: f.babyId,
          logged_by: f.userId,
          feeding_type: 'bottle',
          amount_ml: 90,
          fed_at: new Date().toISOString(),
        })
      ).error,
    ).toBeNull()
    const p = await pumpOk(f, 30, 30, 'M4')
    const fd = feed(f, [[p.container.id, 20]], 10)
    expect(await sendOpWith(f.client, fd.op, 'write')).toEqual({ error: null })
    const before = await snapshot()
    const beforeSibling = await snapshot(sibling.babyId)

    for (const patch of [
      { breast_milk_ml: 90 },
      { formula_ml: 90 },
      { breast_milk_ml: 60, formula_ml: 30 },
    ]) {
      const { error } = await f.client.from('feedings').update(patch).eq('id', legacyId)
      expect(error?.message, `legacy ${JSON.stringify(patch)}`).toBe('milk_rpc_only')
    }
    for (const patch of [
      { baby_id: sibling.babyId },
      { breast_milk_ml: 25 },
      { formula_ml: 5 },
      { breast_milk_ml: null, formula_ml: null },
    ]) {
      const { error } = await f.client.from('feedings').update(patch).eq('id', fd.id)
      expect(error?.message, `desglose ${JSON.stringify(patch)}`).toBe('milk_rpc_only')
    }
    for (const extra of [
      { breast_milk_ml: 60, formula_ml: 30 },
      { breast_milk_ml: 90 },
      { formula_ml: 90 },
      { breast_milk_ml: 0, formula_ml: 0 },
    ]) {
      const id = randomUUID()
      const { error } = await f.client.from('feedings').insert({
        id,
        baby_id: f.babyId,
        logged_by: f.userId,
        feeding_type: 'bottle',
        amount_ml: 90,
        fed_at: new Date().toISOString(),
        ...extra,
      })
      expect(error?.message, `insert ${JSON.stringify(extra)}`).toBe('milk_rpc_only')
    }
    expect(await snapshot()).toEqual(before)
    expect(await snapshot(sibling.babyId)).toEqual(beforeSibling)
  })

  // ---------------------------------------------------------------- (d)
  it('log_bottle_feed rechaza un contenedor anulado, uno vencido y uno de otro bebé de la familia; la base no cambia', async () => {
    // Anulado: extracción borrada sin servir.
    const voided = await pumpOk(f, 20, 20, 'M5')
    expect((await f.client.rpc('void_pumping_session', { p_id: voided.id })).error).toBeNull()
    // Vencido por la regla de heladera (4 días): extraída hace 5 días.
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const expired = await pumpOk(f, 20, 20, 'M6', old)
    expect(Date.parse(expired.container.expires_at)).toBeLessThanOrEqual(Date.now())
    // Fresco, pero servido con una hora posterior a su vencimiento.
    const fresh = await pumpOk(f, 20, 20, 'M7')
    const afterExpiry = new Date(Date.parse(fresh.container.expires_at) + 1000).toISOString()
    const atExpiry = fresh.container.expires_at
    // De otro bebé de la misma familia.
    const sib = await pumpOk(sibling, 20, 20, 'M1')

    const before = await snapshot()
    const beforeSibling = await snapshot(sibling.babyId)
    const cases: [string, string, string | null, string][] = [
      ['anulado', voided.container.id, null, 'milk_container_unusable:M5'],
      ['vencido por la regla', expired.container.id, null, 'milk_container_unusable:M6'],
      [
        'fed_at después del vencimiento',
        fresh.container.id,
        afterExpiry,
        'milk_container_unusable:M7',
      ],
      [
        'fed_at justo en el vencimiento',
        fresh.container.id,
        atExpiry,
        'milk_container_unusable:M7',
      ],
      ['otro bebé de la familia', sib.container.id, null, 'milk_container_unusable:M1'],
    ]
    for (const [name, containerId, fedAt, code] of cases) {
      const fd = feed(f, [[containerId, 5]], 10)
      if (fedAt) (fd.op as { args: Record<string, unknown> }).args.p_fed_at = fedAt
      expect((await sendOpWith(f.client, fd.op, 'write')).error, name).toBe(code)
      // Mezclado con una porción buena: tampoco entra nada.
      const usable = await pumpOk(f, 10, null, `M${8 + cases.findIndex((c) => c[0] === name)}`)
      const before2 = await snapshot()
      const mixed = feed(f, [
        [usable.container.id, 5],
        [containerId, 5],
      ])
      if (fedAt) (mixed.op as { args: Record<string, unknown> }).args.p_fed_at = fedAt
      const err = (await sendOpWith(f.client, mixed.op, 'write')).error
      expect(err, `${name} + porción buena`).toMatch(/^milk_container_unusable:M\d+$/)
      expect(await snapshot(), `${name} + porción buena`).toEqual(before2)
      // Limpiar el contenedor de apoyo para que el "antes" global siga valiendo.
      expect((await f.client.rpc('void_pumping_session', { p_id: usable.id })).error).toBeNull()
    }
    const after = await snapshot()
    // Lo único que cambió: los contenedores de apoyo, creados y anulados.
    const supportIds = new Set(
      after
        .containers!.filter((c) => !before.containers!.some((b) => b.id === c.id))
        .map((c) => c.id),
    )
    expect(after.containers!.filter((c) => !supportIds.has(c.id))).toEqual(before.containers)
    expect(after.containers!.filter((c) => supportIds.has(c.id)).every((c) => c.voided_at)).toBe(
      true,
    )
    expect(after.drawdowns).toEqual(before.drawdowns)
    expect(after.feedings).toEqual(before.feedings)
    expect(await snapshot(sibling.babyId)).toEqual(beforeSibling)
  })

  // ---------------------------------------------------------------- (e)
  it('log_bottle_feed reenviado con la misma carga: no-op, una toma, porciones sin duplicar, restante igual', async () => {
    const x = await pumpOk(f, 30, 30, 'M20')
    const y = await pumpOk(f, 20, 10, 'M21')
    const fd = feed(
      f,
      [
        [x.container.id, 25],
        [y.container.id, 30],
      ],
      15,
    )
    expect(await sendOpWith(f.client, fd.op, 'write')).toEqual({ error: null })
    const before = await snapshot()
    for (let i = 0; i < 3; i++) {
      expect(await sendOpWith(f.client, fd.op, 'replay'), `replay ${i + 1}`).toEqual({
        error: null,
      })
    }
    // Mismo payload por la llamada directa (no la de la cola) también es no-op.
    expect(
      (await f.client.rpc('log_bottle_feed', (fd.op as { args: object }).args)).error,
    ).toBeNull()
    expect(await snapshot()).toEqual(before)
    const { data: rows } = await admin().from('feedings').select('id, amount_ml').eq('id', fd.id)
    expect(rows).toEqual([{ id: fd.id, amount_ml: 70 }])
    const { data: dds } = await admin()
      .from('milk_drawdowns')
      .select('container_id, amount_ml')
      .eq('feeding_id', fd.id)
    expect(dds!.map((d) => Number(d.amount_ml)).sort((p, q) => p - q)).toEqual([25, 30])
    const { data: cs } = await admin()
      .from('milk_containers')
      .select('label, remaining_ml')
      .in('id', [x.container.id, y.container.id])
      .order('label')
    expect(cs!.map((c) => [c.label, Number(c.remaining_ml)])).toEqual([
      ['M20', 35],
      ['M21', 0],
    ])
  })

  // ---------------------------------------------------------------- (f)
  it('anular una extracción ya anulada es no-op; editar una anulada o inexistente da milk_session_gone', async () => {
    const p = await pumpOk(f, 15, 15, 'M30')
    const at = '2026-10-01T10:00:00.000Z'
    expect(
      (await f.client.rpc('void_pumping_session', { p_id: p.id, p_voided_at: at })).error,
    ).toBeNull()
    const before = await snapshot()
    expect((await f.client.rpc('void_pumping_session', { p_id: p.id })).error).toBeNull()
    expect(
      (
        await f.client.rpc('void_pumping_session', {
          p_id: p.id,
          p_voided_at: new Date().toISOString(),
        })
      ).error,
    ).toBeNull()
    expect(await snapshot()).toEqual(before)
    const s = before.sessions!.find((r) => r.id === p.id)!
    expect(Date.parse(s.voided_at!)).toBe(Date.parse(at))

    for (const [name, id] of [
      ['anulada', p.id],
      ['inexistente', randomUUID()],
    ]) {
      const { error } = await f.client.rpc('update_pumping_session', {
        ...updateArgs(id, 50, 50),
        p_container_id: randomUUID(),
        p_container_label: 'M31',
      })
      expect(error?.message, name).toBe('milk_session_gone')
    }
    // Y la de otra familia se ve como inexistente.
    const { error: foreign } = await other.client.rpc(
      'update_pumping_session',
      updateArgs(p.id, 1, 1),
    )
    expect(foreign?.message).toBe('milk_session_gone')
    expect(await snapshot()).toEqual(before)
  })

  // ---------------------------------------------------------------- (g)
  it('una familia con solo extracciones viejas (alta directa) tiene reserva 0', async () => {
    for (const ml of [120, 80]) {
      const { error } = await legacyOnly.client.from('pumping_sessions').insert({
        id: randomUUID(),
        baby_id: legacyOnly.babyId,
        logged_by: legacyOnly.userId,
        side: 'both',
        amount_ml: ml,
        notes: null,
        pumped_at: new Date().toISOString(),
      })
      expect(error).toBeNull()
    }
    const { data: sessions } = await admin()
      .from('pumping_sessions')
      .select('amount_ml')
      .eq('baby_id', legacyOnly.babyId)
      .is('voided_at', null)
    expect(sessions!.reduce((s, r) => s + Number(r.amount_ml), 0)).toBe(200)
    const { data: live } = await admin()
      .from('milk_containers')
      .select('remaining_ml')
      .eq('family_id', legacyOnly.familyId)
      .is('voided_at', null)
    expect(live!.reduce((s, r) => s + Number(r.remaining_ml), 0)).toBe(0)
    const { data: listed, error } = await listContainers(legacyOnly.babyId, legacyOnly.client)
    expect(error).toBeNull()
    expect(listed).toEqual([])
    expect(stashMl(listed, Date.now())).toBe(0)
  })
})

describe('sonda del esquema', () => {
  it('dice si la base tiene 0014 (si no, la suite de arriba se salta: NO VERIFICADO)', () => {
    expect(typeof ready).toBe('boolean')
  })
})
