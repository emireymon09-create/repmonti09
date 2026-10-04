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
import { formatVolume } from '@/lib/format'
import {
  containerExpiresAt,
  nextContainerLabel,
  type BottleFeedArgs,
  type PumpingArgs,
} from '@/lib/milk'
import type { FamilySettings } from '@/lib/schedule'
import { documentLang, translate, type Lang, type MessageKey } from '@/lib/i18n'
import {
  browserQueueStore,
  flushQueue,
  looksOffline,
  newId,
  discardPlan,
  discardWrites,
  flushSettled,
  isDeletion,
  nudgeSync,
  withFlushLock,
  type FlushResult,
  type PendingOp,
  type PendingWrite,
} from '@/lib/queue'
import type {
  ActivityEntry,
  AppointmentType,
  Baby,
  DiaperChange,
  DiaperType,
  DoctorAppointment,
  Feeding,
  FeedingType,
  GrowthMeasurement,
  MilkContainer,
  MilkDrawdown,
  MilkRules,
  NursingSession,
  PumpingSession,
  PumpSide,
  Result,
  RunningSession,
  Side,
  SleepSession,
  VolumeUnit,
  WithPending,
} from '@/lib/types'

/** Phase 2: 'baby'. Supabase must expose it under API Settings → Exposed schemas. */
export const DATA_SCHEMA = 'public'

function data() {
  return createClient().schema(DATA_SCHEMA)
}

/**
 * Something to run a query on: the app's client, or a signed-in test client.
 * `rpc` is for the milk-inventory functions of 0013 (log_bottle_feed…).
 */
type Db = Pick<ReturnType<typeof data>, 'from' | 'rpc'>

/**
 * The columns that say who a row belongs to. One definition, so adding
 * `household_id` later is a single edit rather than a hunt through
 * every insert in the app.
 */
function scope(babyId: string, userId: string | null) {
  return { baby_id: babyId, logged_by: userId }
}

function ok<T>(value: T): Result<T> {
  return { data: value, error: null }
}
function fail<T>(empty: T, error: { message: string } | null): Result<T> {
  return { data: empty, error: error ? error.message : null }
}

// --------------------------------------------------------------- writing

const store = browserQueueStore()

/**
 * Send one op through `db`. Exported so the integration tests run the
 * exact call the app makes, with a signed-in test client.
 *
 * `replay` (the queue flush) sends an insert as INSERT … ON CONFLICT (id)
 * DO NOTHING: the same entry sent twice — two tabs replaying the queue,
 * or a replay of an insert whose response was lost — leaves one row and
 * no error, instead of a primary-key violation that would stop the queue
 * for good. It needs nothing beyond the INSERT grant and policy an insert
 * already needs.
 *
 * A write made online (`write`) stays a plain insert: an id that clashes
 * there is a real error and is shown as one, never reported as saved.
 *
 * What DO NOTHING could swallow on replay is an insert whose id is
 * already taken by some other row — another family's included, silently.
 * Ids are v4 uuids made on the device (newId); with crypto.randomUUID
 * that collision doesn't happen in practice. newId's Math.random fallback
 * for old WebViews is weaker, but a clash there would already have
 * failed as an error on the first, online attempt — unless that first
 * attempt never got an answer.
 */
export async function sendOpWith(
  db: Db,
  op: PendingOp,
  mode: 'write' | 'replay',
  signal?: AbortSignal,
): Promise<{ error: string | null }> {
  if (op.kind === 'rpc') {
    // The milk functions are idempotent by the id the device made (same id and
    // same payload = no-op), so the replay sends exactly what the first try
    // did: there is no ON CONFLICT to add.
    const call = db.rpc(op.fn, op.args)
    const { error } = await (signal ? call.abortSignal(signal) : call)
    return { error: error ? error.message : null }
  }
  const table = db.from(op.table)
  const query =
    op.kind === 'update'
      ? table.update(op.patch).eq('id', op.id)
      : mode === 'replay'
        ? table.upsert(op.row, { onConflict: 'id', ignoreDuplicates: true })
        : table.insert(op.row)
  // The replay's deadline (flushQueue): an aborted request comes back as
  // an error here, and flushQueue reports it as TIMED_OUT — offline.
  const { error } = await (signal ? query.abortSignal(signal) : query)
  return { error: error ? error.message : null }
}

/**
 * Try the server; keep it on the device if the request never got there.
 *
 * A rejection from the server (a policy violation, a bad value) is NOT
 * queued — replaying it would just fail again — so it comes back as a
 * plain error for the page to show.
 */
async function write(
  label: string,
  op: PendingOp,
  opts?: { queueOnly?: boolean },
): Promise<Result<null>> {
  // `queueOnly`: the row this update targets is itself still an insert in
  // the queue, so the server has never seen its id. A direct UPDATE would
  // match zero rows, which PostgREST reports as success — the page would
  // say "saved" over a write that did nothing. Queue it behind the insert
  // instead; the replay sends them in order.
  if (opts?.queueOnly) return enqueue(label, op)

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return enqueue(label, op)
  }

  const { error } = await sendOpWith(data(), op, 'write')
  if (!error) return ok(null)
  if (looksOffline(error)) return enqueue(label, op)
  return { data: null, error }
}

async function enqueue(label: string, op: PendingOp): Promise<Result<null>> {
  try {
    await store.add({
      id: newId(),
      schema: DATA_SCHEMA,
      label,
      queuedAt: new Date().toISOString(),
      op,
    })
    // With the browser calling itself online (bad wifi) no 'online' event
    // will come to start the replay: useSync schedules the retries.
    nudgeSync('queued')
    return { data: null, error: null, queued: true }
  } catch (e) {
    // The underlying reason stays as the browser/queue wrote it; the frame
    // around it follows the interface language.
    const message = e instanceof Error ? e.message : String(e)
    return {
      data: null,
      error: `${translate(documentLang(), 'common.offlineNotStored')} — ${message}`,
    }
  }
}

export function pendingWrites(): Promise<PendingWrite[]> {
  return store.all()
}

/**
 * One replay at a time across tabs; see withFlushLock in lib/queue.ts. If
 * another flush holds the queue, nothing is sent and `busy` says so.
 */
export async function flushPending(): Promise<FlushResult> {
  const result = await withFlushLock(() =>
    flushQueue(store, DATA_SCHEMA, (op, signal) => sendOpWith(data(), op, 'replay', signal)),
  )
  if (result) return result
  const remaining = (await store.all()).length
  return { sent: 0, dropped: 0, remaining, error: null, busy: true }
}

/**
 * Drop queued entries the server rejected — the user chose to, after a
 * confirm naming them (components/SyncStatus.tsx): exactly the ids that
 * confirm counted. See discardWrites in lib/queue.ts.
 */
export function discardPending(ids: string[]): Promise<PendingWrite[]> {
  return discardWrites(store, ids)
}

/** What discarding `id` would take, read from the queue right now. */
export function discardPendingPlan(id: string): Promise<PendingWrite[]> {
  return discardPlan(store, id)
}

const THING: Record<string, MessageKey> = {
  feedings: 'sync.thing.feedings',
  diaper_changes: 'sync.thing.diaper_changes',
  nursing_sessions: 'sync.thing.nursing_sessions',
  sleep_sessions: 'sync.thing.sleep_sessions',
  pumping_sessions: 'sync.thing.pumping_sessions',
  growth_measurements: 'sync.thing.growth_measurements',
  doctor_appointments: 'sync.thing.doctor_appointments',
  babies: 'sync.thing.babies',
}

/**
 * A queued entry named for the user, in the interface language — "Diaper
 * (new)", "Pañal (edición)". Not the `label` stored with it: that is
 * written once, in English, when it is queued.
 */
export function describeWrite(write: PendingWrite, lang: Lang = 'en'): string {
  const thing = translate(lang, THING[write.op.table] ?? 'sync.thing.other')
  const created =
    write.op.kind === 'insert' || (write.op.kind === 'rpc' && write.op.effect === 'insert')
  const what = created
    ? 'sync.what.insert'
    : isDeletion(write)
      ? 'sync.what.delete'
      : 'sync.what.update'
  return translate(lang, what, { thing })
}

/** Resolves once no flush (in any tab) is running. */
export function pendingFlushSettled(): Promise<void> {
  return flushSettled()
}

/**
 * Fold queued writes into rows read from the server, so a pending entry
 * is visible in the UI instead of silently missing. Inserts are marked
 * `pending`; updates are applied to whatever row they target, queued or
 * not — which is how a session started and ended offline shows up as
 * one finished session.
 *
 * An insert whose row the server already returned is not added a second
 * time: reads and queue are fetched together, and the flush can finish
 * after the queue was read but before the server read. It stays marked
 * `pending` until the queue no longer holds it.
 */
export function mergePending<T extends { id: string }>(
  rows: T[],
  table: string,
  pending: PendingWrite[],
): WithPending<T>[] {
  const merged: WithPending<T>[] = rows.map((r) => ({ ...r }))

  for (const write of pending) {
    const row = insertedRow(write.op, table)
    if (!row) continue
    const already = merged.find((r) => r.id === row.id)
    if (already) already.pending = true
    else merged.push({ ...(row as unknown as T), pending: true })
  }
  for (const write of pending) {
    const change = changeOf(write.op, table)
    if (!change) continue
    const target = merged.find((r) => r.id === change.id)
    if (target) Object.assign(target, change.patch, { pending: true })
  }
  return merged
}

/** The row a queued entry adds to `table`: a plain insert, or a milk function's. */
function insertedRow(op: PendingOp, table: string): Record<string, unknown> | null {
  if (op.table !== table) return null
  if (op.kind === 'insert') return op.row
  if (op.kind === 'rpc' && op.effect === 'insert' && op.row) return op.row
  return null
}

/**
 * The change a queued entry makes to a row of `table`: a plain update, or a
 * milk function that edits or voids one (its `patch` carries `voided_at`, so
 * a void shows the same way a plain soft delete does).
 */
function changeOf(
  op: PendingOp,
  table: string,
): { id: string; patch: Record<string, unknown> } | null {
  if (op.table !== table) return null
  if (op.kind === 'update') return { id: op.id, patch: op.patch }
  if (op.kind === 'rpc' && op.effect !== 'insert' && op.patch) return { id: op.id, patch: op.patch }
  return null
}

/**
 * Last rows each read returned without an error. Offline, a read fails
 * (after a few seconds of retries) and hands back an empty list; showing
 * that would wipe the page. Instead, each failed read keeps what the
 * previous good one returned, and the queue is merged on top of that.
 * `error` is the first read error, for the caller to show when online.
 */
export function keepLastGood<T extends Record<string, unknown>>(
  last: T,
  reads: { [K in keyof T]: Result<T[K]> },
): { rows: T; error: string | null } {
  const rows = { ...last }
  let error: string | null = null
  for (const key of Object.keys(reads) as (keyof T)[]) {
    const read = reads[key]
    if (read.error) error ??= read.error
    else rows[key] = read.data
  }
  return { rows, error }
}

// --------------------------------------------------------------- windows

/*
 * Reads for the totals on /feeding, /diapers and /sleep (lib/kpis.ts): every
 * row from `sinceIso` on, with NO limit — a total cut at the newest N rows
 * would be quietly wrong. A session counts for the part of it inside the
 * window, so one that started before `sinceIso` and ended after it (or is
 * still running) is read too.
 *
 * `db` is only for the integration tests, which run the same query as a
 * signed-in parent (tests/integration/since.test.ts).
 */

/** A PostgREST `or` filter: started, ended, or still running since `sinceIso`. */
function overlapsSince(sinceIso: string): string {
  return `started_at.gte."${sinceIso}",ended_at.gte."${sinceIso}",ended_at.is.null`
}

export async function feedingsSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
): Promise<Result<Feeding[]>> {
  const { data: rows, error } = await db
    .from('feedings')
    .select('id, fed_at, feeding_type, amount_ml, notes')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .gte('fed_at', sinceIso)
    .order('fed_at', { ascending: false })
  if (error) return fail([] as Feeding[], error)
  return ok((rows ?? []) as Feeding[])
}

export async function nursingSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
): Promise<Result<NursingSession[]>> {
  const { data: rows, error } = await db
    .from('nursing_sessions')
    .select('id, side, started_at, ended_at')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .or(overlapsSince(sinceIso))
    .order('started_at', { ascending: false })
  if (error) return fail([] as NursingSession[], error)
  return ok((rows ?? []) as NursingSession[])
}

export async function diapersSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
): Promise<Result<DiaperChange[]>> {
  const { data: rows, error } = await db
    .from('diaper_changes')
    .select('id, changed_at, diaper_type')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .gte('changed_at', sinceIso)
    .order('changed_at', { ascending: false })
  if (error) return fail([] as DiaperChange[], error)
  return ok((rows ?? []) as DiaperChange[])
}

export async function sleepSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
): Promise<Result<SleepSession[]>> {
  const { data: rows, error } = await db
    .from('sleep_sessions')
    .select('id, started_at, ended_at, source')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .or(overlapsSince(sinceIso))
    .order('started_at', { ascending: false })
  if (error) return fail([] as SleepSession[], error)
  return ok((rows ?? []) as SleepSession[])
}

// --------------------------------------------------------------- babies

export async function currentBaby(): Promise<Result<Baby | null>> {
  const { data: rows, error } = await data()
    .from('babies')
    .select('id, name, birth_date, pumping_reset_at, family_id')
    .order('created_at', { ascending: true })
    .limit(1)
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
    kind: 'update',
    table: 'babies',
    id: babyId,
    patch: { birth_date: birthDate },
  })
}

// --------------------------------------------------------------- feedings

/**
 * The breakdown columns (0013) are read only here and in lastBottleFeeding:
 * `feedingsSince` keeps its columns, so the totals and their integration
 * tests do not depend on 0013.
 */
const FEEDING_COLUMNS = 'id, fed_at, feeding_type, amount_ml, notes, breast_milk_ml, formula_ml'

export async function recentFeedings(babyId: string, limit = 20): Promise<Result<Feeding[]>> {
  const { data: rows, error } = await data()
    .from('feedings')
    .select(FEEDING_COLUMNS)
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('fed_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as Feeding[], error)
  return ok((rows ?? []) as Feeding[])
}

// No `logFeeding` any more (4 oct 2026): a bottle is logged with
// logBottleFeed, which writes its breakdown and takes the milk from its
// containers. Solids stopped being created on 23 sep 2026.

/** Edit a past feeding — correcting the type, amount, or time after the fact. */
export function updateFeeding(
  id: string,
  patch: Partial<{ feeding_type: FeedingType; amount_ml: number | null; fed_at: string }>,
  opts?: { queueOnly?: boolean },
): Promise<Result<null>> {
  return write('Edit feeding', { kind: 'update', table: 'feedings', id, patch }, opts)
}

/** Soft-delete: marks the row retracted rather than removing history. */
export function voidFeeding(id: string): Promise<Result<null>> {
  return write('Delete feeding', {
    kind: 'update',
    table: 'feedings',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
}

// --------------------------------------------------------------- diapers

export async function recentDiapers(babyId: string, limit = 20): Promise<Result<DiaperChange[]>> {
  const { data: rows, error } = await data()
    .from('diaper_changes')
    .select('id, changed_at, diaper_type')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as DiaperChange[], error)
  return ok((rows ?? []) as DiaperChange[])
}

export function logDiaper(
  babyId: string,
  userId: string | null,
  type: DiaperType,
  at?: string,
): Promise<Result<null>> {
  return write(`Diaper (${type})`, {
    kind: 'insert',
    table: 'diaper_changes',
    row: {
      id: newId(),
      ...scope(babyId, userId),
      diaper_type: type,
      changed_at: at ?? new Date().toISOString(),
    },
  })
}

/** Edit a past diaper change — correcting the type or time after the fact. */
export function updateDiaper(
  id: string,
  patch: Partial<{ diaper_type: DiaperType; changed_at: string }>,
): Promise<Result<null>> {
  return write('Edit diaper', { kind: 'update', table: 'diaper_changes', id, patch })
}

/** Soft-delete: marks the row retracted rather than removing history. */
export function voidDiaper(id: string): Promise<Result<null>> {
  return write('Delete diaper', {
    kind: 'update',
    table: 'diaper_changes',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
}

// --------------------------------------------------------------- nursing

export async function recentNursing(babyId: string, limit = 20): Promise<Result<NursingSession[]>> {
  const { data: rows, error } = await data()
    .from('nursing_sessions')
    .select('id, side, started_at, ended_at')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as NursingSession[], error)
  return ok((rows ?? []) as NursingSession[])
}

/**
 * `endedAt` logs a session that is already over ("Log a past one" on
 * /feeding) as one insert, so it can never be left half-written as a
 * session still running.
 */
export function startNursing(
  babyId: string,
  userId: string | null,
  side: Side,
  at?: string,
  endedAt?: string,
): Promise<Result<null>> {
  return write(`Nursing (${side})`, {
    kind: 'insert',
    table: 'nursing_sessions',
    row: {
      id: newId(),
      ...scope(babyId, userId),
      side,
      started_at: at ?? new Date().toISOString(),
      ended_at: endedAt ?? null,
    },
  })
}

export function endNursing(sessionId: string, at?: string): Promise<Result<null>> {
  return write('Nursing end', {
    kind: 'update',
    table: 'nursing_sessions',
    id: sessionId,
    patch: { ended_at: at ?? new Date().toISOString() },
  })
}

/** Edit a past nursing session — correcting the side or start/end time. */
export function updateNursing(
  id: string,
  patch: Partial<{ side: Side; started_at: string; ended_at: string | null }>,
  opts?: { queueOnly?: boolean },
): Promise<Result<null>> {
  return write('Edit nursing', { kind: 'update', table: 'nursing_sessions', id, patch }, opts)
}

/** Soft-delete: marks the row retracted rather than removing history. */
export function voidNursing(id: string): Promise<Result<null>> {
  return write('Delete nursing', {
    kind: 'update',
    table: 'nursing_sessions',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
}

// --------------------------------------------------------------- sleep

export async function recentSleep(babyId: string, limit = 20): Promise<Result<SleepSession[]>> {
  const { data: rows, error } = await data()
    .from('sleep_sessions')
    .select('id, started_at, ended_at, source')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as SleepSession[], error)
  return ok((rows ?? []) as SleepSession[])
}

/** `endedAt`: a finished sleep, logged afterwards in one insert (see startNursing). */
export function startSleep(
  babyId: string,
  userId: string | null,
  at?: string,
  endedAt?: string,
): Promise<Result<null>> {
  return write('Sleep start', {
    kind: 'insert',
    table: 'sleep_sessions',
    row: {
      id: newId(),
      ...scope(babyId, userId),
      started_at: at ?? new Date().toISOString(),
      ended_at: endedAt ?? null,
      source: 'manual',
    },
  })
}

export function endSleep(sessionId: string, at?: string): Promise<Result<null>> {
  return write('Sleep end', {
    kind: 'update',
    table: 'sleep_sessions',
    id: sessionId,
    patch: { ended_at: at ?? new Date().toISOString() },
  })
}

/** Edit a past sleep session — correcting the start or end time. */
export function updateSleep(
  id: string,
  patch: Partial<{ started_at: string; ended_at: string | null }>,
  opts?: { queueOnly?: boolean },
): Promise<Result<null>> {
  return write('Edit sleep', { kind: 'update', table: 'sleep_sessions', id, patch }, opts)
}

/** Soft-delete: marks the row retracted rather than removing history. */
export function voidSleep(id: string): Promise<Result<null>> {
  return write('Delete sleep', {
    kind: 'update',
    table: 'sleep_sessions',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
}

// ------------------------------------------------ running session, re-read

/**
 * One session row, read fresh by id, for a screen that is about to write
 * over it.
 *
 * No page in this app re-reads on its own (CLAUDE.md §6), so the wall
 * screen can sit for hours on a session the other parent already stopped
 * from their phone. Moving `started_at` back on a row that already has an
 * `ended_at` does not correct anything — it stretches a finished session
 * (measured: a 10-minute feed became 70) and the screen still says the
 * start moved. The dashboard reads the row first and refuses.
 *
 * `data` is `null` when the row is gone: retracted, or never on the server.
 * `db` is only for the integration tests, which run the same query as a
 * signed-in parent (tests/integration/since.test.ts).
 */
export async function sessionById(
  table: 'nursing_sessions' | 'sleep_sessions',
  id: string,
  db: Db = data(),
): Promise<Result<RunningSession | null>> {
  const { data: rows, error } = await db
    .from(table)
    .select('id, started_at, ended_at')
    .eq('id', id)
    .is('voided_at', null)
    .limit(1)
  if (error) return fail<RunningSession | null>(null, error)
  return ok(((rows ?? [])[0] as RunningSession | undefined) ?? null)
}

// --------------------------------------------------------------- pumping

/**
 * Expressed milk. Deliberately independent of birth_date — the "she's
 * here" gate on the dashboard is about the baby-tracking screens, not
 * this one, since building a stash typically starts weeks before birth.
 *
 * Since 0013 every write goes through a database function that does the
 * session and its container in one transaction (docs/spec-feeding-v3.md).
 */
export async function recentPumping(babyId: string, limit = 20): Promise<Result<PumpingSession[]>> {
  const { data: rows, error } = await data()
    .from('pumping_sessions')
    .select('id, pumped_at, side, amount_ml, notes, left_ml, right_ml')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('pumped_at', { ascending: false })
    .limit(limit)
  if (error) return fail([] as PumpingSession[], error)
  return ok((rows ?? []) as PumpingSession[])
}

export type PumpingInput = {
  left_ml: number | null
  right_ml: number | null
  notes: string | null
  pumped_at: string
}

/** What the device needs to name and date a new container while offline. */
export type MilkContext = {
  /** Every live container this page knows of, queued ones included. */
  containers: MilkContainer[]
  rules: MilkRules
}

/** Which side to store: the breasts that gave something, or "both". */
function sideOf(input: PumpingInput): PumpSide {
  const left = (input.left_ml ?? 0) > 0
  const right = (input.right_ml ?? 0) > 0
  if (left && !right) return 'left'
  if (right && !left) return 'right'
  return 'both'
}

function totalOf(input: PumpingInput): number {
  return (input.left_ml ?? 0) + (input.right_ml ?? 0)
}

/**
 * A new container for `pumpedAt`: the next M label and the expiry the
 * server will also compute (it recomputes it with the family's rules as
 * they are then — this one is what the screen shows until it syncs).
 */
function newContainer(ctx: MilkContext, pumpedAt: string) {
  return {
    id: newId(),
    label: nextContainerLabel(ctx.containers.filter((c) => !c.voided_at).map((c) => c.label)),
    expires_at: containerExpiresAt(pumpedAt, 'fridge', ctx.rules),
  }
}

/**
 * Log a pumping session, left and right each on its own. With an amount the
 * server fills a new container (M1, M2…) in the same transaction; with none,
 * it is a session and nothing else. Returns the container's label, so the
 * page can say which number to write on the tape.
 */
export async function logPumpingSession(
  babyId: string,
  userId: string | null,
  input: PumpingInput,
  ctx: MilkContext,
): Promise<Result<{ label: string | null }>> {
  const id = newId()
  const total = totalOf(input)
  const container = total > 0 ? newContainer(ctx, input.pumped_at) : null
  const args: PumpingArgs = {
    p_id: id,
    p_baby_id: babyId,
    p_side: sideOf(input),
    p_left_ml: input.left_ml,
    p_right_ml: input.right_ml,
    p_notes: input.notes,
    p_pumped_at: input.pumped_at,
    p_container_id: container?.id ?? null,
    p_container_label: container?.label ?? null,
    p_container_expires_at: container?.expires_at ?? null,
  }
  const result = await write('Pumping', {
    kind: 'rpc',
    fn: 'log_pumping_session',
    args,
    table: 'pumping_sessions',
    id,
    effect: 'insert',
    row: {
      id,
      ...scope(babyId, userId),
      pumped_at: input.pumped_at,
      side: args.p_side,
      amount_ml: total > 0 ? total : null,
      left_ml: input.left_ml,
      right_ml: input.right_ml,
      notes: input.notes,
    },
    creates: container ? [container.id] : [],
  })
  return { ...result, data: { label: container?.label ?? null } }
}

/**
 * Correct a session. Its container follows (never below what was already
 * served — the server refuses that), and a session that had no amount gets
 * its container now. `pending`: the session itself is still a queued insert,
 * so this has to queue behind it (see `write`).
 */
export function updatePumpingSession(
  id: string,
  input: PumpingInput,
  ctx: MilkContext,
  opts?: { pending?: boolean },
): Promise<Result<null>> {
  const total = totalOf(input)
  const live = ctx.containers.find((c) => c.source_session_id === id && !c.voided_at)
  const container = total > 0 && !live ? newContainer(ctx, input.pumped_at) : null
  const side = sideOf(input)
  return write(
    'Edit pumping',
    {
      kind: 'rpc',
      fn: 'update_pumping_session',
      args: {
        p_id: id,
        p_side: side,
        p_left_ml: input.left_ml,
        p_right_ml: input.right_ml,
        p_notes: input.notes,
        p_pumped_at: input.pumped_at,
        p_container_id: container?.id ?? null,
        p_container_label: container?.label ?? null,
        p_container_expires_at:
          container?.expires_at ?? containerExpiresAt(input.pumped_at, 'fridge', ctx.rules),
      },
      table: 'pumping_sessions',
      id,
      effect: 'update',
      patch: {
        side,
        left_ml: input.left_ml,
        right_ml: input.right_ml,
        amount_ml: total > 0 ? total : null,
        notes: input.notes,
        pumped_at: input.pumped_at,
      },
      creates: container ? [container.id] : [],
    },
    { queueOnly: !!opts?.pending },
  )
}

/**
 * Soft-delete a session and its container. The server refuses it while any
 * of its milk is in a bottle that still stands (`milk_already_served`).
 */
export function voidPumpingSession(
  id: string,
  opts?: { pending?: boolean },
): Promise<Result<null>> {
  const at = new Date().toISOString()
  return write(
    'Delete pumping',
    {
      kind: 'rpc',
      fn: 'void_pumping_session',
      args: { p_id: id, p_voided_at: at },
      table: 'pumping_sessions',
      id,
      effect: 'delete',
      patch: { voided_at: at },
    },
    { queueOnly: !!opts?.pending },
  )
}

/** Every container still on the list (not voided), oldest first. No limit: the stash is a total. */
export async function listContainers(
  babyId: string,
  db: Db = data(),
): Promise<Result<MilkContainer[]>> {
  const { data: rows, error } = await db
    .from('milk_containers')
    .select(
      'id, source_session_id, label, amount_ml, remaining_ml, stored_at, location, expires_at',
    )
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('stored_at', { ascending: true })
  if (error) return fail([] as MilkContainer[], error)
  return ok(
    ((rows ?? []) as MilkContainer[]).map((c) => ({
      ...c,
      amount_ml: Number(c.amount_ml),
      remaining_ml: Number(c.remaining_ml),
    })),
  )
}

/**
 * Every portion still standing, with its container's tape. No limit, for the
 * same reason as listContainers: giving back a voided bottle's milk offline
 * needs that bottle's portions, however old.
 */
export async function listDrawdowns(
  babyId: string,
  db: Db = data(),
): Promise<Result<MilkDrawdown[]>> {
  const { data: rows, error } = await db
    .from('milk_drawdowns')
    .select('id, feeding_id, container_id, amount_ml, milk_containers(label)')
    .eq('baby_id', babyId)
    .is('voided_at', null)
  if (error) return fail([] as MilkDrawdown[], error)
  type Row = MilkDrawdown & { milk_containers?: { label: string } | { label: string }[] | null }
  return ok(
    ((rows ?? []) as unknown as Row[]).map(({ milk_containers: c, ...d }) => ({
      ...d,
      amount_ml: Number(d.amount_ml),
      label: (Array.isArray(c) ? c[0]?.label : c?.label) ?? null,
    })),
  )
}

/**
 * The last bottle with an amount — what the next bottle suggestion starts
 * from. Its own read, because the screens read only the newest few feedings
 * and those can all be something else.
 */
export async function lastBottleFeeding(babyId: string): Promise<Result<Feeding | null>> {
  const { data: rows, error } = await data()
    .from('feedings')
    .select(FEEDING_COLUMNS)
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .eq('feeding_type', 'bottle')
    .gt('amount_ml', 0)
    .order('fed_at', { ascending: false })
    .limit(1)
  if (error) return fail(null, error)
  return ok(((rows ?? [])[0] as Feeding | undefined) ?? null)
}

// --------------------------------------------------------------- bottles (0013)

export type BottleInput = {
  fed_at: string
  notes: string | null
  formula_ml: number
  portions: { container_id: string; amount_ml: number }[]
}

/**
 * Log a bottle: breast-milk portions, each from one container, plus formula.
 * The server takes each portion from its container, refuses to take more
 * than is left (`milk_overdraw` — two phones serving from the same one), and
 * writes the totals itself. Formula has no inventory: it is just a number.
 *
 * `containersPending`: a portion comes from a container whose pumping
 * session is still in the queue. The server doesn't know it yet, so the
 * bottle queues behind it instead of being rejected as unknown.
 */
export function logBottleFeed(
  babyId: string,
  userId: string | null,
  input: BottleInput,
  opts?: { containersPending?: boolean },
): Promise<Result<null>> {
  const id = newId()
  const breast = input.portions.reduce((sum, p) => sum + p.amount_ml, 0)
  const args: BottleFeedArgs = {
    p_id: id,
    p_baby_id: babyId,
    p_fed_at: input.fed_at,
    p_notes: input.notes,
    p_formula_ml: input.formula_ml,
    p_portions: input.portions,
  }
  return write(
    'Bottle',
    {
      kind: 'rpc',
      fn: 'log_bottle_feed',
      args,
      table: 'feedings',
      id,
      effect: 'insert',
      row: {
        id,
        ...scope(babyId, userId),
        fed_at: input.fed_at,
        feeding_type: 'bottle',
        amount_ml: breast + input.formula_ml,
        breast_milk_ml: breast,
        formula_ml: input.formula_ml,
        notes: input.notes,
      },
      refs: input.portions.map((p) => p.container_id),
    },
    { queueOnly: !!opts?.containersPending },
  )
}

/**
 * Delete a bottle and give every portion back to its container, in one
 * operation. Formula has nothing to give back.
 */
export function voidBottleFeed(id: string, opts?: { pending?: boolean }): Promise<Result<null>> {
  const at = new Date().toISOString()
  return write(
    'Delete feeding',
    {
      kind: 'rpc',
      fn: 'void_bottle_feed',
      args: { p_feeding_id: id, p_voided_at: at },
      table: 'feedings',
      id,
      effect: 'delete',
      patch: { voided_at: at },
    },
    { queueOnly: !!opts?.pending },
  )
}

// --------------------------------------------------------------- milk rules (0013)

/*
 * The pediatrician's storage rules. Like the countdown thresholds (0012) they
 * belong to the family, both parents see the same numbers, and they do NOT go
 * through the offline queue: a rule applied late could overwrite what the
 * other parent set meanwhile. Offline, Settings says so and saves nothing.
 */

export async function milkRules(babyId: string): Promise<Result<MilkRules | null>> {
  const { data: row, error } = await data()
    .from('babies')
    .select('milk_room_hours, milk_fridge_days, milk_freezer_months')
    .eq('id', babyId)
    .maybeSingle()
  if (error) return fail(null, error)
  if (!row) return ok(null)
  const r = row as MilkRules
  return ok({
    milk_room_hours: Number(r.milk_room_hours),
    milk_fridge_days: Number(r.milk_fridge_days),
    milk_freezer_months: Number(r.milk_freezer_months),
  })
}

export async function saveMilkRules(babyId: string, rules: MilkRules): Promise<Result<null>> {
  const { error } = await data().from('babies').update(rules).eq('id', babyId)
  if (error) return fail(null, error)
  return ok(null)
}

// --------------------------------------------------------------- milk errors

const MILK_ERRORS: Record<string, MessageKey> = {
  milk_overdraw: 'milkError.overdraw',
  milk_container_unusable: 'milkError.containerUnusable',
  milk_label_taken: 'milkError.labelTaken',
  milk_already_served: 'milkError.alreadyServed',
  milk_served_exceeds_amount: 'milkError.servedExceedsAmount',
  milk_idempotency_conflict: 'milkError.idempotencyConflict',
  milk_rpc_only: 'milkError.rpcOnly',
  milk_bad_input: 'milkError.badInput',
  milk_baby_not_found: 'milkError.babyNotFound',
  milk_not_signed_in: 'milkError.notSignedIn',
  milk_session_gone: 'milkError.sessionGone',
}

/**
 * A rejection from one of the milk functions, in words. They answer with a
 * stable code, sometimes followed by a container's tape ("milk_overdraw:M3");
 * anything else is passed through as it came (and framed by the page).
 */
export function milkErrorText(message: string | null, lang: Lang = 'en'): string {
  if (!message) return ''
  const match = /^(milk_[a-z_]+)(?::(.+))?$/.exec(message.trim())
  let key = match ? MILK_ERRORS[match[1]] : undefined
  if (!key) return message
  const label = match![2]
  // Without a tape to name, the "which one" sentence would have a hole in it.
  if (key === 'milkError.containerUnusable' && !label) key = 'milkError.containerUnknown'
  return translate(lang, key, { label: label ?? '' })
}

// --------------------------------------------------------------- growth

export async function listGrowth(babyId: string): Promise<Result<GrowthMeasurement[]>> {
  const { data: rows, error } = await data()
    .from('growth_measurements')
    .select('id, measured_at, weight_kg, height_cm, notes')
    .eq('baby_id', babyId)
    .is('voided_at', null)
    .order('measured_at', { ascending: false })
  if (error) return fail([] as GrowthMeasurement[], error)
  return ok((rows ?? []) as GrowthMeasurement[])
}

export function addGrowth(
  babyId: string,
  userId: string | null,
  row: {
    measured_at: string
    weight_kg: number | null
    height_cm: number | null
    notes: string | null
  },
): Promise<Result<null>> {
  return write('Measurement', {
    kind: 'insert',
    table: 'growth_measurements',
    row: { id: newId(), ...scope(babyId, userId), ...row },
  })
}

/** Correct a measurement typed wrong — the pediatrician's number, not ours. */
export function updateGrowth(
  id: string,
  patch: Partial<{
    measured_at: string
    weight_kg: number | null
    height_cm: number | null
    notes: string | null
  }>,
): Promise<Result<null>> {
  return write('Edit measurement', { kind: 'update', table: 'growth_measurements', id, patch })
}

/** Soft-delete: the entry leaves the growth curve, the row stays. */
export function voidGrowth(id: string): Promise<Result<null>> {
  return write('Delete measurement', {
    kind: 'update',
    table: 'growth_measurements',
    id,
    patch: { voided_at: new Date().toISOString() },
  })
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

export function addAppointment(
  babyId: string,
  userId: string | null,
  row: {
    title: string
    appointment_type: AppointmentType
    scheduled_at: string
    doctor_name: string | null
    notes: string | null
  },
): Promise<Result<null>> {
  return write('Appointment', {
    kind: 'insert',
    table: 'doctor_appointments',
    row: { id: newId(), ...scope(babyId, userId), completed: false, ...row },
  })
}

export function setAppointmentCompleted(id: string, completed: boolean): Promise<Result<null>> {
  return write('Appointment', {
    kind: 'update',
    table: 'doctor_appointments',
    id,
    patch: { completed },
  })
}

// --------------------------------------------------------------- today feed

/**
 * The day's timeline, merged from this app's tables. Becomes a single
 * read of `core.activity` once the shared backend lands.
 */
export function buildActivity(
  feedings: WithPending<Feeding>[],
  nursing: WithPending<NursingSession>[],
  diapers: WithPending<DiaperChange>[],
  sleep: WithPending<SleepSession>[],
  pumping: WithPending<PumpingSession>[],
  since: number,
  unit: VolumeUnit = 'oz',
  lang: Lang = 'en',
): ActivityEntry[] {
  const out: ActivityEntry[] = []
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate(lang, key, vars)
  const mark = (row: { pending?: boolean }, text: string) =>
    row.pending ? `${text} · ${t('activity.notSynced')}` : text
  // `what` names the kind itself (the Today feed shows it alone); `detail`
  // leaves the kind out, for views that already label it ("Diaper · Wet").
  const entry = (
    row: { id: string; pending?: boolean },
    at: string,
    kind: ActivityEntry['kind'],
    what: string,
    detail: string,
  ) => out.push({ id: row.id, at, kind, what: mark(row, what), detail: mark(row, detail) })
  // A session still running is listed where it started, marked as such —
  // the same thing the card above shows with its stopwatch.
  const running = (
    row: { id: string; pending?: boolean },
    at: string,
    kind: ActivityEntry['kind'],
    what: string,
    detail: string,
  ) => {
    const now = t('activity.inProgress')
    out.push({
      id: row.id,
      at,
      kind,
      what: mark(row, `${what} · ${now}`),
      detail: mark(row, `${detail} · ${now}`),
      ongoing: true,
    })
  }

  for (const f of feedings) {
    const text =
      f.feeding_type === 'bottle'
        ? `${t('activity.bottle')}${f.amount_ml ? ` · ${formatVolume(f.amount_ml, unit)}` : ''}`
        : f.feeding_type === 'solid'
          ? t('activity.solids')
          : f.feeding_type === 'nursing'
            ? t('activity.nursingFeed')
            : t(`feedingType.${f.feeding_type}`)
    entry(f, f.fed_at, 'feeding', text, text)
  }
  for (const n of nursing) {
    if (n.ended_at) {
      entry(
        n,
        n.ended_at,
        'nursing',
        t('activity.nursed', { side: t(`side.${n.side}`) }),
        t(`activity.sideDetail.${n.side}`),
      )
    } else {
      running(
        n,
        n.started_at,
        'nursing',
        t('activity.nursingNow', { side: t(`side.${n.side}`) }),
        t(`activity.sideDetail.${n.side}`),
      )
    }
  }
  for (const d of diapers) {
    entry(
      d,
      d.changed_at,
      'diaper',
      t('activity.diaper', { type: t(`diaper.${d.diaper_type}`) }),
      t(`activity.diaperDetail.${d.diaper_type}`),
    )
  }
  for (const s of sleep) {
    if (s.ended_at) {
      const text = s.source === 'nuc_derived' ? t('activity.wokeDetected') : t('activity.woke')
      entry(s, s.ended_at, 'sleep', text, text)
    } else {
      const text = s.source === 'nuc_derived' ? t('activity.asleepDetected') : t('activity.asleep')
      running(s, s.started_at, 'sleep', text, text)
    }
  }
  // A pumping session is a single moment, never "in progress". The amount is
  // optional on the form, so it is only appended when there is one — the
  // same rule as a bottle above.
  for (const p of pumping) {
    const amount = p.amount_ml ? ` · ${formatVolume(p.amount_ml, unit)}` : ''
    entry(
      p,
      p.pumped_at,
      'pumping',
      `${t('activity.pumped', { side: t(`side.${p.side}`) })}${amount}`,
      `${t(`activity.pumpSide.${p.side}`)}${amount}`,
    )
  }

  // A session still running stays in Today even if it began before
  // midnight, and goes first: it is what is happening now. History wants
  // plain time order and sorts again (app/history/page.tsx).
  return out
    .filter((e) => e.ongoing || new Date(e.at).getTime() >= since)
    .sort(
      (a, b) =>
        Number(!!b.ongoing) - Number(!!a.ongoing) ||
        new Date(b.at).getTime() - new Date(a.at).getTime(),
    )
}

// --------------------------------------------------- family settings (0012)

/*
 * Los umbrales del countdown de /dashboard. NO son localStorage como el tema o
 * el idioma: los dos padres tienen que ver el mismo número, y el check de push
 * (lib/push/server.ts) los lee del lado del servidor, donde no hay
 * localStorage. Scope por `family_id` directo — la forma de la fase 2.
 *
 * Y NO PASAN POR LA COLA OFFLINE, a propósito: son un dato compartido con el
 * otro padre, y una cola que los aplica tarde podría pisar un valor que el
 * otro cambió mientras tanto. Sin conexión, la pantalla lo dice y no guarda
 * nada (§5.5: nada se presenta como guardado si no lo está).
 */

export async function familySettings(familyId: string): Promise<Result<FamilySettings | null>> {
  const { data: rows, error } = await data()
    .from('family_settings')
    .select('nap_threshold_minutes, feed_threshold_minutes')
    .eq('family_id', familyId)
    .maybeSingle()
  if (error) return fail(null, error)
  return ok((rows ?? null) as FamilySettings | null)
}

export async function saveFamilySettings(
  familyId: string,
  patch: FamilySettings,
): Promise<Result<null>> {
  const { error } = await data()
    .from('family_settings')
    .upsert(
      { family_id: familyId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'family_id' },
    )
  if (error) return fail(null, error)
  return ok(null)
}

// -------------------------------------------------- calendar feed (0012)

export type CalendarFeedInfo = {
  created_at: string
  rotated_at: string | null
  last_fetched_at: string | null
}

/**
 * Lo que la pantalla puede saber del feed sin poder reconstruir el link: la
 * base guarda solo el hash, así que esta lectura NO trae nada con lo que
 * armar una URL. El valor en claro existe una sola vez, en la respuesta de
 * /api/calendar/feed, y no se vuelve a mostrar.
 */
export async function calendarFeed(familyId: string): Promise<Result<CalendarFeedInfo | null>> {
  const { data: rows, error } = await data()
    .from('calendar_feeds')
    .select('created_at, rotated_at, last_fetched_at')
    .eq('family_id', familyId)
    .maybeSingle()
  if (error) return fail(null, error)
  return ok((rows ?? null) as CalendarFeedInfo | null)
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
  feedings: Feeding[],
  nursing: NursingSession[],
  sampleSize = 6,
): SchedulePrediction {
  const events = [...feedings.map((f) => f.fed_at), ...nursing.map((n) => n.started_at)].sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  )

  if (events.length === 0) return { lastAt: null, avgIntervalMinutes: null, dueAt: null }
  const lastAt = events[0]
  if (events.length < 2) return { lastAt, avgIntervalMinutes: null, dueAt: null }

  const sample = events.slice(0, sampleSize + 1)
  const gaps = sample
    .slice(0, -1)
    .map((at, i) => (new Date(at).getTime() - new Date(sample[i + 1]).getTime()) / 60_000)
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
  const gaps = sample
    .slice(0, -1)
    .map(
      (s, i) =>
        (new Date(s.started_at).getTime() - new Date(sample[i + 1].ended_at).getTime()) / 60_000,
    )
    .filter((mins) => mins > 0)

  if (gaps.length === 0) return { lastAt, avgIntervalMinutes: null, dueAt: null }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const dueAt = new Date(new Date(lastAt).getTime() + avg * 60_000).toISOString()
  return { lastAt, avgIntervalMinutes: Math.round(avg), dueAt }
}
