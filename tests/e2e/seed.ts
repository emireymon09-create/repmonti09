import { adminClient, anonClient, type SeededFamily } from '../helpers/supabase'
import { DAY, HOUR, MIN, iso, pumpOk, rpc } from '../helpers/milkV4'
import { combineOk, formulaAddOk, formulaOpenArgs, startedFeed } from '../helpers/milkV5'

// Una familia de prueba con TODOS los estados de Inicio a la vez (el defecto
// que reportó Luis es de combinación, no de un estado suelto):
//   leche caducada · leche fría · leche enfriando · combinación viva ·
//   biberón empezado vencido · Similac abierta por caducar y stock bajo ·
//   sueño abierto · (opcional) lactancia abierta · turno en < 36 h ·
//   historial largo para que las listas lleguen hasta la barra.
// Todo por el camino real: RPC con el JWT del padre para la leche, service
// role solo para lo que la app también escribe directo (pañales, sueño…).

export type UiFamily = SeededFamily & { password: string; t0: number }

export const E2E_PASSWORD = 'test-password-1234'

export async function seedUiFamily(tag: string, o: { nursingActive: boolean }): Promise<UiFamily> {
  const admin = adminClient()
  const email = `${tag}@amelia.test`.toLowerCase()
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 })
  const stale = list?.users.find((u) => u.email === email)
  if (stale) await admin.auth.admin.deleteUser(stale.id)
  await admin.from('families').delete().eq('name', `e2e-${tag}`)

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password: E2E_PASSWORD,
    email_confirm: true,
  })
  if (userErr) throw userErr
  const userId = created.user!.id
  const { data: fam, error: famErr } = await admin
    .from('families')
    .insert({ name: `e2e-${tag}` })
    .select('id')
    .single()
  if (famErr) throw famErr
  const { error: memErr } = await admin
    .from('family_members')
    .insert({ family_id: fam.id, user_id: userId, role: 'parent' })
  if (memErr) throw memErr
  // Nombre largo a propósito: es el peor caso de la cabecera.
  const { data: baby, error: babyErr } = await admin
    .from('babies')
    .insert({ family_id: fam.id, name: 'Amelia Valentina', birth_date: '2026-08-20' })
    .select('id')
    .single()
  if (babyErr) throw babyErr
  const client = anonClient()
  const { error: signErr } = await client.auth.signInWithPassword({ email, password: E2E_PASSWORD })
  if (signErr) throw signErr
  const f: SeededFamily = { familyId: fam.id, userId, babyId: baby.id, email, client }
  const t0 = Date.now()
  const must = (r: { error: unknown }, what: string) => {
    if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  }

  // ---- leche ----
  await pumpOk(f, 120, 'M1', t0 - 4 * DAY - 2 * HOUR) // caducada
  const m2 = await pumpOk(f, 150, 'M2', t0 - 5 * HOUR) // fría
  const m3 = await pumpOk(f, 60, 'M3', t0 - 3 * HOUR) // fría, se combina en M2
  await pumpOk(f, 90, 'M4', t0 - 10 * MIN) // enfriando
  await combineOk(f, m2.containerId, [m3.containerId])
  // Biberón empezado vencido: sobró 1 oz hace 90 min (sirve 60).
  await startedFeed(f, 30, t0 - 90 * MIN, 90)
  // Similac: 2 compradas hace 49 h, una abierta hace 45 h (caduca en 3 h).
  const { ids } = await formulaAddOk(f, 2, t0 - 49 * HOUR)
  must(
    await rpc(f.client, 'formula_open', formulaOpenArgs(f, ids[0], t0 - 45 * HOUR)),
    'formula_open',
  )

  // ---- historial largo (listas que llegan a la barra) ----
  const diapers = Array.from({ length: 14 }, (_, i) => ({
    baby_id: f.babyId,
    diaper_type: (['wet', 'dirty', 'both'] as const)[i % 3],
    changed_at: iso(t0 - (i + 1) * 2 * HOUR),
    logged_by: userId,
  }))
  must(await admin.from('diaper_changes').insert(diapers), 'diapers')
  const feeds = Array.from({ length: 8 }, (_, i) => ({
    baby_id: f.babyId,
    feeding_type: 'bottle',
    amount_ml: 90 + i * 5,
    fed_at: iso(t0 - (i + 2) * 3 * HOUR),
    logged_by: userId,
  }))
  must(await admin.from('feedings').insert(feeds), 'feedings')
  const nursing = Array.from({ length: 5 }, (_, i) => ({
    baby_id: f.babyId,
    side: i % 2 ? 'left' : 'right',
    started_at: iso(t0 - (i + 1) * 5 * HOUR),
    ended_at: iso(t0 - (i + 1) * 5 * HOUR + 25 * MIN),
    logged_by: userId,
  }))
  if (o.nursingActive)
    nursing.push({
      baby_id: f.babyId,
      side: 'left',
      started_at: iso(t0 - 20 * MIN),
      ended_at: null as unknown as string,
      logged_by: userId,
    })
  must(await admin.from('nursing_sessions').insert(nursing), 'nursing')
  const sleeps = Array.from({ length: 6 }, (_, i) => ({
    baby_id: f.babyId,
    started_at: iso(t0 - (i + 1) * 6 * HOUR),
    ended_at: iso(t0 - (i + 1) * 6 * HOUR + 80 * MIN),
    logged_by: userId,
  }))
  sleeps.push({
    baby_id: f.babyId,
    started_at: iso(t0 - 40 * MIN),
    ended_at: null as unknown as string,
    logged_by: userId,
  })
  must(await admin.from('sleep_sessions').insert(sleeps), 'sleep')
  const growth = [
    { measured_at: '2026-08-20', weight_kg: 3.2, height_cm: 49 },
    { measured_at: '2026-09-10', weight_kg: 3.9, height_cm: 52 },
    { measured_at: '2026-10-01', weight_kg: 4.6, height_cm: 55.5 },
  ].map((g) => ({ ...g, baby_id: f.babyId, logged_by: userId }))
  must(await admin.from('growth_measurements').insert(growth), 'growth')
  const appts = [
    {
      title: 'Control de los dos meses con la pediatra',
      appointment_type: 'checkup',
      scheduled_at: iso(t0 + 5 * HOUR),
      doctor_name: 'Dra. Fernández',
      completed: false,
    },
    {
      title: 'Vacuna',
      appointment_type: 'vaccine',
      scheduled_at: iso(t0 + 9 * DAY),
      doctor_name: null,
      completed: false,
    },
    {
      title: 'Control',
      appointment_type: 'checkup',
      scheduled_at: iso(t0 - 12 * DAY),
      doctor_name: null,
      completed: true,
    },
  ].map((a) => ({ ...a, baby_id: f.babyId, logged_by: userId }))
  must(await admin.from('doctor_appointments').insert(appts), 'appointments')
  return { ...f, password: E2E_PASSWORD, t0 }
}

export async function cleanupUiFamily(f: UiFamily | undefined): Promise<void> {
  if (!f) return
  const admin = adminClient()
  await admin.from('families').delete().eq('id', f.familyId)
  await admin.auth.admin.deleteUser(f.userId)
}
