import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, anonClient, seedTwoFamilies, type SeededFamily } from '../helpers/supabase'

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>

beforeAll(async () => {
  ;({ a, b, cleanup } = await seedTwoFamilies('rls'))
})
afterAll(async () => {
  await cleanup()
})

describe('la base responde por el camino real de la app', () => {
  it('un padre autenticado ve su propio bebé (regresión del GRANT de 0005)', async () => {
    const { data, error } = await a.client.from('babies').select('id, name')
    expect(error).toBeNull()
    expect(data?.map((r) => r.id)).toEqual([a.babyId])
  })
})

describe('una familia no ve a la otra', () => {
  it('el select de feedings solo trae lo propio', async () => {
    const { data, error } = await a.client.from('feedings').select('id, baby_id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].baby_id).toBe(a.babyId)
  })

  it('pedir explícitamente el bebé ajeno devuelve vacío, no error', async () => {
    const { data, error } = await a.client.from('feedings').select('id').eq('baby_id', b.babyId)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('no se puede insertar contra el bebé de otra familia', async () => {
    const { error } = await a.client.from('feedings').insert({
      baby_id: b.babyId,
      feeding_type: 'bottle',
      amount_ml: 60,
      fed_at: '2026-01-15T18:00:00Z',
    })
    expect(error).not.toBeNull()
    expect(error!.message.toLowerCase()).toContain('row-level security')
  })

  it('un update contra una fila ajena no afecta ninguna fila', async () => {
    const admin = adminClient()
    const { data: ajena } = await admin
      .from('feedings')
      .select('id')
      .eq('baby_id', b.babyId)
      .single()

    const { data, error } = await a.client
      .from('feedings')
      .update({ amount_ml: 999 })
      .eq('id', ajena!.id)
      .select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])

    // Y la fila de B sigue intacta.
    const { data: despues } = await admin
      .from('feedings')
      .select('amount_ml')
      .eq('id', ajena!.id)
      .single()
    expect(Number(despues!.amount_ml)).toBe(90)
  })

  it('el borrado lógico ajeno tampoco pasa', async () => {
    const admin = adminClient()
    const { data: ajena } = await admin
      .from('feedings')
      .select('id')
      .eq('baby_id', b.babyId)
      .single()

    const { data } = await a.client
      .from('feedings')
      .update({ voided_at: new Date().toISOString() })
      .eq('id', ajena!.id)
      .select('id')
    expect(data).toEqual([])
  })

  it('families y family_members solo muestran la propia', async () => {
    const { data: fams } = await a.client.from('families').select('id')
    expect(fams?.map((f) => f.id)).toEqual([a.familyId])

    const { data: miembros } = await a.client.from('family_members').select('user_id')
    expect(miembros?.map((m) => m.user_id)).toEqual([a.userId])
  })

  it('un cliente sin sesión no ve nada', async () => {
    const anon = anonClient()
    const { data, error } = await anon.from('babies').select('id')
    expect(error === null ? data : []).toEqual([])
  })

  it('monitor_events no acepta escritura de un usuario (solo el servidor)', async () => {
    const { error } = await a.client.from('monitor_events').insert({
      baby_id: a.babyId,
      event_type: 'sound_alert',
      occurred_at: '2026-01-15T16:00:00Z',
    })
    expect(error).not.toBeNull()
  })
})

/**
 * Los huecos que la auditoría (T7) reporta, escritos como test para que no se
 * discutan de memoria. Si alguno cambia de resultado, la propuesta de schema
 * correspondiente ya se aplicó y hay que actualizar esto.
 */
describe('huecos conocidos de las policies, documentados', () => {
  it('growth_measurements no tiene policy de UPDATE: una medición mal cargada es permanente', async () => {
    const admin = adminClient()
    const { data: medicion, error: insErr } = await admin
      .from('growth_measurements')
      .insert({ baby_id: a.babyId, measured_at: '2026-01-15', weight_kg: 3.5 })
      .select('id')
      .single()
    expect(insErr).toBeNull()

    // El dueño de la fila tampoco la puede corregir: no hay policy de update.
    const { data, error } = await a.client
      .from('growth_measurements')
      .update({ weight_kg: 3.6 })
      .eq('id', medicion!.id)
      .select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])

    const { data: sigue } = await admin
      .from('growth_measurements')
      .select('weight_kg')
      .eq('id', medicion!.id)
      .single()
    expect(Number(sigue!.weight_kg)).toBe(3.5)
  })

  it('families no tiene policy de INSERT: un usuario no puede crear su propia familia', async () => {
    const { error } = await a.client.from('families').insert({ name: 'familia nueva' })
    expect(error).not.toBeNull()
    expect(error!.message.toLowerCase()).toContain('row-level security')
  })
})
