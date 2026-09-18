'use client'

/**
 * The app's only door to the database.
 *
 * Pages never build a query, so the phase-2 migration in PROJECT.md is
 * an edit to THIS FILE and nothing else:
 *
 *   · `DATA_SCHEMA` flips from 'public' to 'baby'
 *   · `scope()` starts carrying `household_id` directly, per
 *     CONVENTIONS.md §1
 *   · `logged_by` becomes `created_by`
 *   · retraction moves from "not supported" to setting `voided_at`
 *
 * Everything here runs on the anon key under RLS. The service_role key
 * is never imported into this path.
 *
 * Writes that cannot reach the server are queued on the device rather
 * than lost — see lib/queue.ts.
 */

import { createClient } from '@/lib/supabaseClient'
import {
  browserQueueStore, flushQueue, looksOffline, newId,
  type FlushResult, type PendingOp, type PendingWrite,
} from '@/lib/queue'
import type {
  ActivityEntry, AppointmentType, Baby, DiaperChange, DiaperType,
  DoctorAppointment, Feeding, FeedingType, GrowthMeasurement,
  NursingSession, PumpingSession, PumpSide, Result, Side, SleepSession, WithPending,
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

function ok<T>(value: T): Result<T> { return { data: value, error: null } }
function fail<T>(empty: T, error: { message: string } | null): Result<T> {
  return { data: empty, error: error ? error.message : null }
}

// --------------------------------------------------------------- writing

const store = browserQueueStore()

/** Run one op against the server. Also the replay function for the queue. */
async function sendOp(op: PendingOp): Promise<{ error: string | null }> {
  const table = data().from(op.table)
  const { error } = op.kind === 'insert'
    ? await table.insert(op.row)
    : await table.update(op.patch).eq('id', op.id)
  return { error: error ? error.message : null }
}

/**
 * Try the server; keep it on the device if the request never got there.
 *
 * A rejection from the server (a policy violation, a bad value) is NOT
 * queued — replaying it would just fail again — so it comes back as a
 * plain error for the page to show.
 */
async function write(label: string, op: PendingOp): Promise<Result<null>> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return enqueue(label, op)
  }

  const { error } = await sendOp(op)
  if (!error) return ok(null)
  if (looksOffline(error)) return enqueue(label, op)
  return { data: null, error }
}

async function enqueue(label: string, op: PendingOp): Promise<Result<null>> {
  try {
    await store.add({
      id: newId(), schema: DATA_SCHEMA, label,
      queuedAt: new Date().toISOString(), op,
    })
    return { data: null, error: null, queued: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { data: null, error: `Offline, and this device wouldn't store it — ${message}` }
  }
}

export function pendingWrites(): Promise<PendingWrite[]> {
  return store.all()
}

export function flushPending(): Promise<FlushResult> {
  return flushQueue(store, DATA_SCHEMA, sendOp)
}

/**
 * Fold queued writes into rows read from the server, so a pending entry
 * is visible in the UI instead of silently missing. Inserts are marked
 * `pending`; updates are applied to whatever row they target, queued or
 * not — which is how a session started and ended offline shows up as
 * one finished session.
 */
export function mergePending<T extends { id: string }>(
  rows: T[], table: string, pending: PendingWrite[],
): WithPending<T>[] {
  const merged: WithPending<T>[] = rows.map((r) => ({ ...r }))

  for (const write of pending) {
    if (write.op.kind !== 'insert' || write.op.table !== table) continue
    merged.push({ ...(write.op.row as unknown as T), pending: true })
  }
  for (const write of pending) {
    if (write.op.kind !== 'update' || write.op.table !== table) continue
    const target = merged.find((r) => r.id === (write.op as { id: string }).id)
    if (target) Object.assign(target, write.op.patch, { pending: true })
  }
  return merged
}

// --------------------------------------------------------------- babies

export async function currentBaby(): Promise<Result<Baby | null>> {
  const { data: rows, error } = await data()
    .from('babies').select('id, name, birth_date, pumping_reset_at')
    .order('created_at', { ascending: true }).limit(1)
  if (error) return fail(null, error)
  return ok((rows && rows.length ? rows[0] : null) as Baby | null)
}

/**
 * The one-time "she's here" action. Everything else on the dashboard —
 * age, the feeding clock, growth curves — is derived from this single
 * column, so setting it is what actually starts the app tracking her
 * instead of counting down to her.
 */
export function recordBirth(babyId: string, birthDate: string): Promise<Result<null>> {
  return write('Birth date', {
    kind: 'update', table: 'babies', id: babyId,
    patch: { birth_date: birthDate },
  })
}

// --------------------------------------------------------------- feedings

export async function recentFeedings(babyId: string, limit = 20): Promise<Result<Feeding[]>> {
  const { data: rows, error } = await data()
    .from('feedings').select('id, fed_at, feeding_type, amount_ml, notes')
    .eq('baby_id', babyId).order('fed_at', { ascending: false }).limit(limit)
  if (error) return fail([] as Feeding[], error)
  return ok((rows ?? []) as Feeding[])
}

export function logFeeding(
  babyId: string, userId: string | null, type: FeedingType, amountMl: number | null,
  at?: string,
): Promise<Result<null>> {
  return write(type === 'bottle' ? 'Bottle' : 'Solid', {
    kind: 'insert', table: 'feedings',
    row: {
      id: newId(), ...scope(babyId, userId),
      feeding_type: type, amount_ml: amountMl, fed_at: at ?? new Date().toISOString(),
    },
  })
}

// --------------------------------------------------------------- diapers

export async function recentDiapers(babyId: string, limit = 20): Promise<Result<DiaperChange[]>> {
  const { data: rows, error } = await data()
    .from('diaper_changes').select('id, changed_at, diaper_type')
    .eq('baby_id', babyId).order('changed_at', { ascending: false }).limit(limit)
  if (error) return fail([] as DiaperChange[], error)
  return ok((rows ?? []) as DiaperChange[])
}

export function logDiaper(
  babyId: string, userId: string | null, type: DiaperType, at?: string,
): Promise<Result<null>> {
  return write(`Diaper (${type})`, {
    kind: 'insert', table: 'diaper_changes',
    row: {
      id: newId(), ...scope(babyId, userId),
      diaper_type: type, changed_at: at ?? new Date().toISOString(),
    },
  })
}

// --------------------------------------------------------------- nursing

export async function recentNursing(babyId: string, limit = 20): Promise<Result<NursingSession[]>> {
  const { data: rows, error } = await data()
    .from('nursing_sessions').select('id, side, started_at, ended_at')
    .eq('baby_id', babyId).order('started_at', { ascending: false }).limit(limit)
  if (error) return fail([] as NursingSession[], error)
  return ok((rows ?? []) as NursingSession[])
}

export function startNursing(
  babyId: string, userId: string | null, side: Side, at?: string,
): Promise<Result<null>> {
  return write(`Nursing (${side})`, {
    kind: 'insert', table: 'nursing_sessions',
    row: {
      id: newId(), ...scope(babyId, userId),
      side, started_at: at ?? new Date().toISOString(), ended_at: null,
    },
  })
}

export function endNursing(sessionId: string, at?: string): Promise<Result<null>> {
  return write('Nursing end', {
    kind: 'update', table: 'nursing_sessions', id: sessionId,
    patch: { ended_at: at ?? new Date().toISOString() },
  })
}

// --------------------------------------------------------------- sleep

export async function recentSleep(babyId: string, limit = 20): Promise<Result<SleepSession[]>> {
  const { data: rows, error } = await data()
    .from('sleep_sessions').select('id, started_at, ended_at, source')
    .eq('baby_id', babyId).order('started_at', { ascending: false }).limit(limit)
  if (error) return fail([] as SleepSession[], error)
  return ok((rows ?? []) as SleepSession[])
}

export function startSleep(babyId: string, userId: string | null, at?: string): Promise<Result<null>> {
  return write('Sleep start', {
    kind: 'insert', table: 'sleep_sessions',
    row: {
      id: newId(), ...scope(babyId, userId),
      started_at: at ?? new Date().toISOString(), ended_at: null, source: 'manual',
    },
  })
}

export function endSleep(sessionId: string, at?: string): Promise<Result<null>> {
  return write('Sleep end', {
    kind: 'update', table: 'sleep_sessions', id: sessionId,
    patch: { ended_at: at ?? new Date().toISOString() },
  })
}

// --------------------------------------------------------------- pumping

/**
 * Expressed milk. Deliberately independent of birth_date — the "she's
 * here" gate on the dashboard is about the baby-tracking screens, not
 * this one, since building a stash typically starts weeks before birth.
 */
export async function recentPumping(babyId: string, limit = 20): Promise<Result<PumpingSession[]>> {
  const { data: rows, error } = await data()
    .from('pumping_sessions').select('id, pumped_at, side, amount_ml, notes')
    .eq('baby_id', babyId).order('pumped_at', { ascending: false }).limit(limit)
  if (error) return fail([] as PumpingSession[], error)
  return ok((rows ?? []) as PumpingSession[])
}

export function logPumping(
  babyId: string, userId: string | null, side: PumpSide, amountMl: number | null, notes: string | null,
  at?: string,
): Promise<Result<null>> {
  return write('Pumping', {
    kind: 'insert', table: 'pumping_sessions',
    row: {
      id: newId(), ...scope(babyId, userId),
      side, amount_ml: amountMl, notes, pumped_at: at ?? new Date().toISOString(),
    },
  })
}

/** Total ml pumped across the given rows — the running "stash" figure. */
export function totalPumped(rows: PumpingSession[]): number {
  return rows.reduce((sum, r) => sum + (r.amount_ml ?? 0), 0)
}

/**
 * Zero out the running total shown on the Milk page without touching
 * any logged session — a parent who just moved the stash into the
 * freezer, or wants to start counting from today, isn't deleting
 * history.
 */
export function resetPumpingTotal(babyId: string): Promise<Result<null>> {
  return write('Reset pumping total', {
    kind: 'update', table: 'babies', id: babyId,
    patch: { pumping_reset_at: new Date().toISOString() },
  })
}

// --------------------------------------------------------------- growth

export async function listGrowth(babyId: string): Promise<Result<GrowthMeasurement[]>> {
  const { data: rows, error } = await data()
    .from('growth_measurements').select('id, measured_at, weight_kg, height_cm, notes')
    .eq('baby_id', babyId).order('measured_at', { ascending: false })
  if (error) return fail([] as GrowthMeasurement[], error)
  return ok((rows ?? []) as GrowthMeasurement[])
}

export function addGrowth(
  babyId: string, userId: string | null,
  row: { measured_at: string; weight_kg: number | null; height_cm: number | null; notes: string | null },
): Promise<Result<null>> {
  return write('Measurement', {
    kind: 'insert', table: 'growth_measurements',
    row: { id: newId(), ...scope(babyId, userId), ...row },
  })
}

// --------------------------------------------------------------- appointments

const APPT_COLUMNS = 'id, title, appointment_type, scheduled_at, doctor_name, notes, completed'

export async function listAppointments(babyId: string): Promise<Result<DoctorAppointment[]>> {
  const { data: rows, error } = await data()
    .from('doctor_appointments').select(APPT_COLUMNS)
    .eq('baby_id', babyId).order('scheduled_at', { ascending: true })
  if (error) return fail([] as DoctorAppointment[], error)
  return ok((rows ?? []) as DoctorAppointment[])
}

export async function nextAppointment(babyId: string): Promise<Result<DoctorAppointment | null>> {
  const { data: rows, error } = await data()
    .from('doctor_appointments').select(APPT_COLUMNS)
    .eq('baby_id', babyId).eq('completed', false)
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true }).limit(1)
  if (error) return fail(null, error)
  return ok((rows && rows.length ? rows[0] : null) as DoctorAppointment | null)
}

export function addAppointment(
  babyId: string, userId: string | null,
  row: {
    title: string; appointment_type: AppointmentType; scheduled_at: string
    doctor_name: string | null; notes: string | null
  },
): Promise<Result<null>> {
  return write('Appointment', {
    kind: 'insert', table: 'doctor_appointments',
    row: { id: newId(), ...scope(babyId, userId), completed: false, ...row },
  })
}

export function setAppointmentCompleted(id: string, completed: boolean): Promise<Result<null>> {
  return write('Appointment', {
    kind: 'update', table: 'doctor_appointments', id, patch: { completed },
  })
}

// --------------------------------------------------------------- today feed

/**
 * The day's timeline, merged from this app's tables. Becomes a single
 * read of `core.activity` once the shared backend lands.
 */
export function buildActivity(
  feedings: WithPending<Feeding>[], nursing: WithPending<NursingSession>[],
  diapers: WithPending<DiaperChange>[], sleep: WithPending<SleepSession>[],
  since: number,
): ActivityEntry[] {
  const out: ActivityEntry[] = []
  const mark = (row: { pending?: boolean }, text: string) =>
    row.pending ? `${text} · not synced yet` : text

  for (const f of feedings) {
    out.push({
      at: f.fed_at, kind: 'feeding',
      what: mark(f, f.feeding_type === 'bottle'
        ? `Bottle${f.amount_ml ? ` · ${f.amount_ml} ml` : ''}`
        : f.feeding_type === 'solid' ? 'Solids' : 'Nursing (logged as feed)'),
    })
  }
  for (const n of nursing) {
    if (n.ended_at) out.push({ at: n.ended_at, kind: 'nursing', what: mark(n, `Nursed · ${n.side}`) })
  }
  for (const d of diapers) {
    out.push({ at: d.changed_at, kind: 'diaper', what: mark(d, `Diaper · ${d.diaper_type}`) })
  }
  for (const s of sleep) {
    if (s.ended_at) {
      out.push({
        at: s.ended_at, kind: 'sleep',
        what: mark(s, s.source === 'nuc_derived' ? 'Woke (detected)' : 'Woke'),
      })
    }
  }

  return out
    .filter((e) => new Date(e.at).getTime() >= since)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

// --------------------------------------------------------------- predictions

export type SchedulePrediction = {
  lastAt: string | null
  avgIntervalMinutes: number | null
  dueAt: string | null
}

/**
 * Predicts when the next feeding is due from the gaps between the most
 * recent feeding events — bottles, solids, and nursing starts, combined.
 * Only the newest few gaps are averaged (not the whole history) since
 * the interval drifts as a baby grows; that also means it self-corrects
 * within a day or two of a growth spurt or schedule change.
 */
export function predictNextFeeding(
  feedings: Feeding[], nursing: NursingSession[], sampleSize = 6,
): SchedulePrediction {
  const events = [
    ...feedings.map((f) => f.fed_at),
    ...nursing.map((n) => n.started_at),
  ].sort((a, b) => new Date(b).getTime() - new Date(a).getTime())

  if (events.length === 0) return { lastAt: null, avgIntervalMinutes: null, dueAt: null }
  const lastAt = events[0]
  if (events.length < 2) return { lastAt, avgIntervalMinutes: null, dueAt: null }

  const sample = events.slice(0, sampleSize + 1)
  const gaps = sample.slice(0, -1).map((at, i) =>
    (new Date(at).getTime() - new Date(sample[i + 1]).getTime()) / 60_000,
  )
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const dueAt = new Date(new Date(lastAt).getTime() + avg * 60_000).toISOString()
  return { lastAt, avgIntervalMinutes: Math.round(avg), dueAt }
}

/**
 * Predicts the next nap from the gaps between waking up and the next
 * sleep session starting — the baby's typical awake window. Only
 * meaningful while awake; the dashboard only shows it when there's no
 * session in progress.
 */
export function predictNextNap(sleep: SleepSession[], sampleSize = 6): SchedulePrediction {
  const finished = sleep
    .filter((s): s is SleepSession & { ended_at: string } => s.ended_at != null)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())

  if (finished.length === 0) return { lastAt: null, avgIntervalMinutes: null, dueAt: null }
  const lastAt = finished[0].ended_at
  if (finished.length < 2) return { lastAt, avgIntervalMinutes: null, dueAt: null }

  const sample = finished.slice(0, sampleSize + 1)
  const gaps = sample.slice(0, -1)
    .map((s, i) => (new Date(s.started_at).getTime() - new Date(sample[i + 1].ended_at).getTime()) / 60_000)
    .filter((mins) => mins > 0)

  if (gaps.length === 0) return { lastAt, avgIntervalMinutes: null, dueAt: null }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const dueAt = new Date(new Date(lastAt).getTime() + avg * 60_000).toISOString()
  return { lastAt, avgIntervalMinutes: Math.round(avg), dueAt }
}
