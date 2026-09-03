'use client'

/**
 * The app's only door to the database.
 *
 * Pages never build a query. Everything goes through the repository
 * below so that the phase-2 migration described in PROJECT.md is an
 * edit to THIS FILE and nothing else:
 *
 *   · `DATA_SCHEMA` flips from 'public' to 'baby'
 *   · `scope()` starts carrying `household_id` directly, per
 *     CONVENTIONS.md §1 ("carried directly even when it could be
 *     derived by joining a parent — that redundancy is the point")
 *   · `logged_by` becomes `created_by`
 *   · retraction moves from "not supported" to setting `voided_at`
 *
 * Everything the frontend does here runs on the anon key under RLS.
 * The service_role key is never imported into this path.
 */

import { createClient } from '@/lib/supabaseClient'
import type {
  ActivityEntry, AppointmentType, Baby, DiaperChange, DiaperType,
  DoctorAppointment, Feeding, FeedingType, GrowthMeasurement,
  NursingSession, Result, Side, SleepSession,
} from '@/lib/types'

/** Phase 2: 'baby'. Supabase must expose it under API Settings → Exposed schemas. */
export const DATA_SCHEMA = 'public'

function data() {
  return createClient().schema(DATA_SCHEMA)
}

/**
 * The columns that say who a row belongs to. One definition, so adding
 * `household_id` later is a single edit rather than a hunt through
 * every insert in the app.
 */
function scope(babyId: string, userId: string | null) {
  return { baby_id: babyId, logged_by: userId }
}

/** Never leak a Postgres message to the UI unshaped. */
function ok<T>(value: T): Result<T> { return { data: value, error: null } }
function fail<T>(empty: T, error: { message: string } | null): Result<T> {
  return { data: empty, error: error ? error.message : null }
}

// --------------------------------------------------------------- babies

export async function currentBaby(): Promise<Result<Baby | null>> {
  const { data: rows, error } = await data()
    .from('babies')
    .select('id, name, birth_date')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) return fail(null, error)
  return ok((rows && rows.length ? rows[0] : null) as Baby | null)
}

// --------------------------------------------------------------- feedings

export async function recentFeedings(babyId: string, limit = 20): Promise<Result<Feeding[]>> {
  const { data: rows, error } = await data()
    .from('feedings')
    .select('id, fed_at, feeding_type, amount_ml, notes')
    .eq('baby_id', babyId)
    .order('fed_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as Feeding[], error)
  return ok((rows ?? []) as Feeding[])
}

export async function logFeeding(
  babyId: string, userId: string | null, type: FeedingType, amountMl: number | null,
): Promise<Result<null>> {
  const { error } = await data().from('feedings')
    .insert({ ...scope(babyId, userId), feeding_type: type, amount_ml: amountMl })
  return fail(null, error)
}

// --------------------------------------------------------------- diapers

export async function recentDiapers(babyId: string, limit = 20): Promise<Result<DiaperChange[]>> {
  const { data: rows, error } = await data()
    .from('diaper_changes')
    .select('id, changed_at, diaper_type')
    .eq('baby_id', babyId)
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as DiaperChange[], error)
  return ok((rows ?? []) as DiaperChange[])
}

export async function logDiaper(
  babyId: string, userId: string | null, type: DiaperType,
): Promise<Result<null>> {
  const { error } = await data().from('diaper_changes')
    .insert({ ...scope(babyId, userId), diaper_type: type })
  return fail(null, error)
}

// --------------------------------------------------------------- nursing

export async function recentNursing(babyId: string, limit = 20): Promise<Result<NursingSession[]>> {
  const { data: rows, error } = await data()
    .from('nursing_sessions')
    .select('id, side, started_at, ended_at')
    .eq('baby_id', babyId)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as NursingSession[], error)
  return ok((rows ?? []) as NursingSession[])
}

export async function startNursing(
  babyId: string, userId: string | null, side: Side,
): Promise<Result<null>> {
  const { error } = await data().from('nursing_sessions')
    .insert({ ...scope(babyId, userId), side, started_at: new Date().toISOString() })
  return fail(null, error)
}

export async function endNursing(sessionId: string): Promise<Result<null>> {
  const { error } = await data().from('nursing_sessions')
    .update({ ended_at: new Date().toISOString() }).eq('id', sessionId)
  return fail(null, error)
}

// --------------------------------------------------------------- sleep

export async function recentSleep(babyId: string, limit = 20): Promise<Result<SleepSession[]>> {
  const { data: rows, error } = await data()
    .from('sleep_sessions')
    .select('id, started_at, ended_at, source')
    .eq('baby_id', babyId)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as SleepSession[], error)
  return ok((rows ?? []) as SleepSession[])
}

export async function startSleep(babyId: string, userId: string | null): Promise<Result<null>> {
  const { error } = await data().from('sleep_sessions')
    .insert({ ...scope(babyId, userId), started_at: new Date().toISOString(), source: 'manual' })
  return fail(null, error)
}

export async function endSleep(sessionId: string): Promise<Result<null>> {
  const { error } = await data().from('sleep_sessions')
    .update({ ended_at: new Date().toISOString() }).eq('id', sessionId)
  return fail(null, error)
}

// --------------------------------------------------------------- growth

export async function listGrowth(babyId: string): Promise<Result<GrowthMeasurement[]>> {
  const { data: rows, error } = await data()
    .from('growth_measurements')
    .select('id, measured_at, weight_kg, height_cm, notes')
    .eq('baby_id', babyId)
    .order('measured_at', { ascending: false })
  if (error) return fail([] as GrowthMeasurement[], error)
  return ok((rows ?? []) as GrowthMeasurement[])
}

export async function addGrowth(
  babyId: string, userId: string | null,
  row: { measured_at: string; weight_kg: number | null; height_cm: number | null; notes: string | null },
): Promise<Result<null>> {
  const { error } = await data().from('growth_measurements').insert({ ...scope(babyId, userId), ...row })
  return fail(null, error)
}

// --------------------------------------------------------------- appointments

const APPT_COLUMNS = 'id, title, appointment_type, scheduled_at, doctor_name, notes, completed'

export async function listAppointments(babyId: string): Promise<Result<DoctorAppointment[]>> {
  const { data: rows, error } = await data()
    .from('doctor_appointments')
    .select(APPT_COLUMNS)
    .eq('baby_id', babyId)
    .order('scheduled_at', { ascending: true })
  if (error) return fail([] as DoctorAppointment[], error)
  return ok((rows ?? []) as DoctorAppointment[])
}

export async function nextAppointment(babyId: string): Promise<Result<DoctorAppointment | null>> {
  const { data: rows, error } = await data()
    .from('doctor_appointments')
    .select(APPT_COLUMNS)
    .eq('baby_id', babyId)
    .eq('completed', false)
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
  if (error) return fail(null, error)
  return ok((rows && rows.length ? rows[0] : null) as DoctorAppointment | null)
}

export async function addAppointment(
  babyId: string, userId: string | null,
  row: {
    title: string; appointment_type: AppointmentType; scheduled_at: string
    doctor_name: string | null; notes: string | null
  },
): Promise<Result<null>> {
  const { error } = await data().from('doctor_appointments').insert({ ...scope(babyId, userId), ...row })
  return fail(null, error)
}

export async function setAppointmentCompleted(id: string, completed: boolean): Promise<Result<null>> {
  const { error } = await data().from('doctor_appointments').update({ completed }).eq('id', id)
  return fail(null, error)
}

// --------------------------------------------------------------- today feed

/**
 * The day's timeline, merged from this app's tables.
 *
 * Becomes a single read of `core.activity` once the shared backend
 * lands — see the note on ActivityEntry. Kept here rather than in the
 * page so that swap touches one file.
 */
export function buildActivity(
  feedings: Feeding[], nursing: NursingSession[], diapers: DiaperChange[],
  sleep: SleepSession[], since: number,
): ActivityEntry[] {
  const out: ActivityEntry[] = []

  for (const f of feedings) {
    out.push({
      at: f.fed_at, kind: 'feeding',
      what: f.feeding_type === 'bottle'
        ? `Bottle${f.amount_ml ? ` · ${f.amount_ml} ml` : ''}`
        : f.feeding_type === 'solid' ? 'Solids' : 'Nursing (logged as feed)',
    })
  }
  for (const n of nursing) {
    if (n.ended_at) out.push({ at: n.ended_at, kind: 'nursing', what: `Nursed · ${n.side}` })
  }
  for (const d of diapers) {
    out.push({ at: d.changed_at, kind: 'diaper', what: `Diaper · ${d.diaper_type}` })
  }
  for (const s of sleep) {
    if (s.ended_at) {
      out.push({
        at: s.ended_at, kind: 'sleep',
        what: s.source === 'nuc_derived' ? 'Woke (detected)' : 'Woke',
      })
    }
  }

  return out
    .filter((e) => new Date(e.at).getTime() >= since)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}
