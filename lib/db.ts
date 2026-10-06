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
import { formatMilkOz, formatVolume } from '@/lib/format'
import {
  containerExpiresAt,
  type BottleFeedArgs,
  type DiscardArgs,
  type EditBottleArgs,
  type PumpingArgs,
} from '@/lib/milk'
import { effectiveBottleCount, planBottleEdit } from '@/lib/milkBottles'
import { PAGE_SIZE, readAll } from '@/lib/readAll'
import { estimateLegacySplit, type LegacySplit } from '@/lib/milkEstimate'
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
  MilkDiscard,
  MilkDrawdown,
  MilkRules,
  MilkSettings,
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
 * `rpc` is for the milk-inventory functions of 0014 (log_bottle_feed…).
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
): Promise<{ error: string | null; data?: unknown }> {
  if (op.kind === 'rpc') {
    // The milk functions are idempotent by the id the device made (same id and
    // same payload = no-op), so the replay sends exactly what the first try
    // did: there is no ON CONFLICT to add. `data` is what the function
    // returned — the jsonb of void_bottle_feed / edit_bottle_feed (0015), the
    // milk that went back and the milk that could not (D-9).
    const call = db.rpc(op.fn, op.args)
    const { data: returned, error } = await (signal ? call.abortSignal(signal) : call)
    // Left out (undefined) when there is nothing: most functions return void.
    return {
      error: error ? error.message : null,
      data: error ? undefined : (returned ?? undefined),
    }
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
  const result = await send(label, op, opts)
  return { ...result, data: null }
}

/**
 * `write`, keeping what the server answered: the jsonb of void_bottle_feed and
 * edit_bottle_feed (0015). Null when it was queued — then the page says what
 * happens "by what this phone knows" (applyPendingInventory), §8.2.
 */
async function send(
  label: string,
  op: PendingOp,
  opts?: { queueOnly?: boolean },
): Promise<Result<unknown>> {
  // `queueOnly`: the row this update targets is itself still an insert in
  // the queue, so the server has never seen its id. A direct UPDATE would
  // match zero rows, which PostgREST reports as success — the page would
  // say "saved" over a write that did nothing. Queue it behind the insert
  // instead; the replay sends them in order.
  if (opts?.queueOnly) return enqueue(label, op)

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return enqueue(label, op)
  }

  const { error, data: returned } = await sendOpWith(data(), op, 'write')
  if (!error) return ok(returned ?? null)
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
  milk_discards: 'sync.thing.milk_discards',
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
 * signed-in parent (tests/integration/since.test.ts). NO limit also means
 * past the cloud's `max_rows` (1000 per response): every read here goes
 * through readAll (lib/readAll.ts), a page at a time; `pageSize` is for the
 * tests.
 */

/** A PostgREST `or` filter: started, ended, or still running since `sinceIso`. */
function overlapsSince(sinceIso: string): string {
  return `started_at.gte."${sinceIso}",ended_at.gte."${sinceIso}",ended_at.is.null`
}

export async function feedingsSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<Feeding[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('feedings')
        .select('id, fed_at, feeding_type, amount_ml, notes')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .gte('fed_at', sinceIso)
        .order('fed_at', { ascending: false })
        .order('id')
        .range(from, to),
    pageSize,
  )
  if (error) return fail([] as Feeding[], error)
  return ok((rows ?? []) as Feeding[])
}

export async function nursingSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<NursingSession[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('nursing_sessions')
        .select('id, side, started_at, ended_at')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .or(overlapsSince(sinceIso))
        .order('started_at', { ascending: false })
        .order('id')
        .range(from, to),
    pageSize,
  )
  if (error) return fail([] as NursingSession[], error)
  return ok((rows ?? []) as NursingSession[])
}

export async function diapersSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<DiaperChange[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('diaper_changes')
        .select('id, changed_at, diaper_type')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .gte('changed_at', sinceIso)
        .order('changed_at', { ascending: false })
        .order('id')
        .range(from, to),
    pageSize,
  )
  if (error) return fail([] as DiaperChange[], error)
  return ok((rows ?? []) as DiaperChange[])
}

export async function sleepSince(
  babyId: string,
  sinceIso: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<SleepSession[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('sleep_sessions')
        .select('id, started_at, ended_at, source')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .or(overlapsSince(sinceIso))
        .order('started_at', { ascending: false })
        .order('id')
        .range(from, to),
    pageSize,
  )
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
 * The breakdown columns (0014) and "sobró" (`leftover_ml`, 0015) are read only
 * here and in lastBottleFeeding: `feedingsSince` keeps its columns, so the
 * totals and their integration tests do not depend on 0014/0015.
 */
const FEEDING_COLUMNS =
  'id, fed_at, feeding_type, amount_ml, notes, breast_milk_ml, formula_ml, leftover_ml'

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

/**
 * Edit a past feeding — correcting the type, amount, or time after the fact.
 * Only for a feeding WITHOUT a breakdown (legacy, D-11b): that one is still a
 * plain row, "sobró" (`leftover_ml`) included. A bottle with a breakdown is
 * edited with editBottleFeed; the database refuses anything but its time and
 * note here (`milk_rpc_only`). A leftover above the total is refused by the
 * table's check (23514) — the page validates it first (validateLeftover).
 */
export function updateFeeding(
  id: string,
  patch: Partial<{
    feeding_type: FeedingType
    amount_ml: number | null
    fed_at: string
    leftover_ml: number | null
  }>,
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
 * Since 0014 every write goes through a database function that does the
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

/** A queued call to one of the milk functions. */
type RpcOp = Extract<PendingOp, { kind: 'rpc' }>

/**
 * Not a server code: the page asked to store milk without choosing the bottle
 * it went into. v4 never makes a number up (X-1, AJ-5) — the selector
 * (`bottleSlots`) is the only way to name one — so nothing is sent.
 * milkErrorText says it as `milk.bottleNeeded`.
 */
export const MILK_BOTTLE_NEEDED = 'milk_bottle_needed'

/**
 * A new container for `pumpedAt`, in the bottle the person chose, with the
 * expiry the server will also compute (it recomputes it with the family's
 * rules as they are then — this one is what the screen shows until it syncs).
 */
function newContainer(ctx: Pick<MilkContext, 'rules'>, pumpedAt: string, label: string) {
  return {
    id: newId(),
    label,
    expires_at: containerExpiresAt(pumpedAt, 'fridge', ctx.rules),
  }
}

/**
 * The queued call that logs a pumping session (log_pumping_session). Null when
 * it has an amount and no bottle was chosen. `id` is only for the tests, which
 * send the same op twice.
 */
export function logPumpingOp(
  babyId: string,
  userId: string | null,
  input: PumpingInput,
  ctx: Pick<MilkContext, 'rules'>,
  label: string | null | undefined,
  id: string = newId(),
): { op: RpcOp; label: string | null } | null {
  const total = totalOf(input)
  if (total > 0 && !label) return null
  const container = total > 0 && label ? newContainer(ctx, input.pumped_at, label) : null
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
  return {
    label: container?.label ?? null,
    op: {
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
    },
  }
}

/**
 * Log a pumping session, left and right each on its own. With an amount the
 * server fills a new container in the same transaction, in the bottle the
 * person chose from the selector (M1…MN): `label` is required then, and
 * without it nothing is sent (`MILK_BOTTLE_NEEDED`). With no amount it is a
 * session and nothing else. Returns the bottle's label for "Logged in M3."
 *
 * The server still has the last word: a bottle another live container holds
 * comes back as `milk_label_taken:M#` (online), or as that rejection in the
 * sync banner (queued) — never renumbered.
 */
export async function logPumpingSession(
  babyId: string,
  userId: string | null,
  input: PumpingInput,
  ctx: MilkContext,
  label?: string | null,
): Promise<Result<{ label: string | null }>> {
  const built = logPumpingOp(babyId, userId, input, ctx, label)
  if (!built) return { data: { label: null }, error: MILK_BOTTLE_NEEDED }
  const result = await write('Pumping', built.op)
  return { ...result, data: { label: built.label } }
}

/**
 * Correct a session. Its container follows (never below what was already
 * served — the server refuses that), and a session that had no container gets
 * one now, in the bottle chosen with the selector (`opts.label`, AJ-5:
 * required then, or nothing is sent). A session whose container was emptied
 * or discarded keeps it: it is still its container. `pending`: the session
 * itself is still a queued insert, so this has to queue behind it (see
 * `write`).
 */
export async function updatePumpingSession(
  id: string,
  input: PumpingInput,
  ctx: MilkContext,
  opts?: {
    pending?: boolean
    /**
     * The session is from before 0014: a total and no sides. With both sides
     * left empty, only its time and note change — the server keeps the total
     * (and the screen shows it kept), never erases it or splits it 50/50.
     */
    legacy?: boolean
    /** The bottle chosen for a session that gets its first container (AJ-5). */
    label?: string | null
  },
): Promise<Result<null>> {
  const total = totalOf(input)
  const keepLegacy = !!opts?.legacy && input.left_ml == null && input.right_ml == null
  const live = ctx.containers.find((c) => c.source_session_id === id && !c.voided_at)
  const needsContainer = total > 0 && !live && !keepLegacy
  if (needsContainer && !opts?.label) return { data: null, error: MILK_BOTTLE_NEEDED }
  const container =
    needsContainer && opts?.label ? newContainer(ctx, input.pumped_at, opts.label) : null
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
      patch: keepLegacy
        ? { notes: input.notes, pumped_at: input.pumped_at }
        : {
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
 * Soft-delete a session and its container (and the container's discard, if it
 * had one: the "discarded milk" total goes down). The server refuses it while
 * any of its milk is in a bottle that still stands (`milk_already_served`).
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

/**
 * Every container still on the list (not voided), oldest first: occupied,
 * expired, emptied and discarded alike — `released_at` and the discards say
 * which (lib/milkBottles.ts). No limit: the stash is a total, and the bottle
 * selector needs every occupied number however old (AJ-18). Read a page at a
 * time (lib/readAll.ts): the cloud cuts each response at 1000 rows.
 */
export async function listContainers(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<MilkContainer[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('milk_containers')
        .select(
          'id, source_session_id, label, amount_ml, remaining_ml, stored_at, location, expires_at, released_at, lost_ml',
        )
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('stored_at', { ascending: true })
        .order('id')
        .range(from, to),
    pageSize,
  )
  if (error) return fail([] as MilkContainer[], error)
  return ok(
    ((rows ?? []) as MilkContainer[]).map((c) => ({
      ...c,
      amount_ml: Number(c.amount_ml),
      remaining_ml: Number(c.remaining_ml),
      released_at: c.released_at ?? null,
      lost_ml: Number(c.lost_ml ?? 0),
    })),
  )
}

/**
 * Every portion still standing, with its container's tape. No limit, for the
 * same reason as listContainers: giving back a voided bottle's milk offline
 * needs that bottle's portions, however old. A page at a time (lib/readAll.ts).
 */
export async function listDrawdowns(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<MilkDrawdown[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('milk_drawdowns')
        .select('id, feeding_id, container_id, amount_ml, milk_containers(label)')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('id')
        .range(from, to),
    pageSize,
  )
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
 * Every live discard (0015), oldest first, with its bottle's number. No limit:
 * "Discarded milk" is a total over all of them (D-13), and History lists each.
 * A page at a time (lib/readAll.ts).
 */
export async function listDiscards(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<MilkDiscard[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('milk_discards')
        .select('id, container_id, amount_ml, discarded_at, reason, milk_containers(label)')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('discarded_at', { ascending: true })
        .order('id')
        .range(from, to),
    pageSize,
  )
  if (error) return fail([] as MilkDiscard[], error)
  type Row = MilkDiscard & { milk_containers?: { label: string } | { label: string }[] | null }
  return ok(
    ((rows ?? []) as unknown as Row[]).map(({ milk_containers: c, ...d }) => ({
      ...d,
      amount_ml: Number(d.amount_ml),
      label: (Array.isArray(c) ? c[0]?.label : c?.label) ?? null,
      voided_at: null,
    })),
  )
}

/**
 * What the estimate of an old bottle's milk and formula is made from (2B,
 * D-14, lib/milkEstimate.ts). Plain arrays, so it can go into the saved copy
 * of lib/lastSeen.ts; `estimateLegacySplits` turns it into the estimate.
 */
export type LegacySplitInputs = {
  /** Every live bottle, with and without a breakdown. */
  feedings: Pick<
    Feeding,
    'id' | 'fed_at' | 'feeding_type' | 'amount_ml' | 'breast_milk_ml' | 'formula_ml'
  >[]
  /** Every live pumping session with an amount. */
  pumping: Pick<PumpingSession, 'id' | 'pumped_at' | 'amount_ml'>[]
  /** Sessions that filled a container (occupied, emptied or discarded). */
  containerSessionIds: string[]
}

/**
 * The reads behind the estimate, with NO limit (AJ-19): which old pumping
 * fed which old bottle depends on everything before it, so a list cut at the
 * newest N rows would give another split, quietly. Each of the three is read
 * a page at a time (lib/readAll.ts): the cloud cuts every response at 1000.
 */
export async function legacySplitInputs(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<LegacySplitInputs>> {
  const empty: LegacySplitInputs = { feedings: [], pumping: [], containerSessionIds: [] }
  const [feedings, pumping, containers] = await Promise.all([
    readAll(
      (from, to) =>
        db
          .from('feedings')
          .select('id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml')
          .eq('baby_id', babyId)
          .is('voided_at', null)
          .eq('feeding_type', 'bottle')
          .order('fed_at', { ascending: true })
          .order('id')
          .range(from, to),
      pageSize,
    ),
    readAll(
      (from, to) =>
        db
          .from('pumping_sessions')
          .select('id, pumped_at, amount_ml')
          .eq('baby_id', babyId)
          .is('voided_at', null)
          .gt('amount_ml', 0)
          .order('pumped_at', { ascending: true })
          .order('id')
          .range(from, to),
      pageSize,
    ),
    readAll(
      (from, to) =>
        db
          .from('milk_containers')
          .select('id, source_session_id')
          .eq('baby_id', babyId)
          .is('voided_at', null)
          .order('id')
          .range(from, to),
      pageSize,
    ),
  ])
  const error = feedings.error ?? pumping.error ?? containers.error
  if (error) return fail(empty, error)
  const num = (x: unknown) => (x == null ? null : Number(x))
  return ok({
    feedings: ((feedings.data ?? []) as LegacySplitInputs['feedings']).map((f) => ({
      ...f,
      amount_ml: num(f.amount_ml),
      breast_milk_ml: num(f.breast_milk_ml),
      formula_ml: num(f.formula_ml),
    })),
    pumping: ((pumping.data ?? []) as LegacySplitInputs['pumping']).map((p) => ({
      ...p,
      amount_ml: num(p.amount_ml),
    })),
    containerSessionIds: ((containers.data ?? []) as { source_session_id: string | null }[])
      .map((c) => c.source_session_id)
      .filter((id): id is string => !!id),
  })
}

/** The estimate for every bottle without a breakdown ("≈ … (estimated)"). Nothing is written. */
export function estimateLegacySplits(
  inputs: LegacySplitInputs,
  fridgeDays: number,
): Map<string, LegacySplit> {
  return estimateLegacySplit({
    feedings: inputs.feedings,
    pumping: inputs.pumping,
    sessionsWithContainer: new Set(inputs.containerSessionIds),
    fridgeDays,
  })
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

// --------------------------------------------------------------- discarding (0015)

/**
 * The queued call that throws out an expired container (discard_container).
 * `id` is the discard's own id, made here: sending it twice leaves one
 * discard. It refers to the container, so discarding a rejected pumping
 * session in the sync banner takes this along (dependentsOf).
 */
export function discardContainerOp(
  babyId: string,
  userId: string | null,
  container: Pick<MilkContainer, 'id' | 'label' | 'remaining_ml'>,
  at: string = new Date().toISOString(),
  id: string = newId(),
): RpcOp {
  const args: DiscardArgs = { p_id: id, p_container_id: container.id, p_discarded_at: at }
  return {
    kind: 'rpc',
    fn: 'discard_container',
    args,
    table: 'milk_discards',
    id,
    effect: 'insert',
    row: {
      id,
      ...scope(babyId, userId),
      container_id: container.id,
      amount_ml: container.remaining_ml,
      discarded_at: at,
      reason: 'expired',
      label: container.label,
      voided_at: null,
    },
    refs: [container.id],
  }
}

/**
 * Throw out what is left in an expired container (D-6). Whether it has
 * expired is the DATABASE's call (D-15): a phone whose clock runs ahead gets
 * `milk_not_expired:M#`. Two phones discarding the same one leave one discard
 * and no rejection. `pending`: the container is still a queued insert (its
 * pumping session has not synced), so this queues behind it.
 */
export function discardContainer(
  babyId: string,
  userId: string | null,
  container: Pick<MilkContainer, 'id' | 'label' | 'remaining_ml'>,
  opts?: { pending?: boolean },
): Promise<Result<null>> {
  return write('Discard milk', discardContainerOp(babyId, userId, container), {
    queueOnly: !!opts?.pending,
  })
}

// --------------------------------------------------------------- bottles (0014, 0015)

export type BottleInput = {
  fed_at: string
  notes: string | null
  formula_ml: number
  portions: { container_id: string; amount_ml: number }[]
  /**
   * "Sobró" (0015, D-10): statistics only, never back into a container. Null
   * or left out = not known. The page checks it first (validateLeftover).
   */
  leftover_ml?: number | null
}

/** What a bottle's milk did when it went back (void, or less milk in an edit). */
export type MilkMoved = { label: string; ml: number }
/**
 * The answer of void_bottle_feed (0015): the milk that went back into its
 * containers, and the milk that could not (D-9: the number has another
 * pumping in it, or it was discarded) — the page says that one.
 */
export type MilkReturn = { returned_ml: number; lost: MilkMoved[] }
/** The answer of edit_bottle_feed: the same, plus the milk the edit took. */
export type MilkEditResult = MilkReturn & { taken: MilkMoved[] }

function movedOf(value: unknown): MilkMoved[] {
  if (!Array.isArray(value)) return []
  return value.map((m: { label?: unknown; ml?: unknown }) => ({
    label: String(m?.label ?? '?'),
    ml: Number(m?.ml ?? 0),
  }))
}

/** The jsonb of void_bottle_feed / edit_bottle_feed, typed. Null if it isn't one. */
export function milkResultOf(value: unknown): MilkEditResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  return {
    returned_ml: Number(v.returned_ml ?? 0),
    lost: movedOf(v.lost),
    taken: movedOf(v.taken),
  }
}

/** The queued call that logs a bottle (log_bottle_feed). `id` is for the tests. */
export function logBottleFeedOp(
  babyId: string,
  userId: string | null,
  input: BottleInput,
  id: string = newId(),
): RpcOp {
  const breast = input.portions.reduce((sum, p) => sum + p.amount_ml, 0)
  const leftover = input.leftover_ml ?? null
  const args: BottleFeedArgs = {
    p_id: id,
    p_baby_id: babyId,
    p_fed_at: input.fed_at,
    p_notes: input.notes,
    p_formula_ml: input.formula_ml,
    p_portions: input.portions,
    p_leftover_ml: leftover,
  }
  return {
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
      leftover_ml: leftover,
      notes: input.notes,
    },
    refs: input.portions.map((p) => p.container_id),
  }
}

/**
 * Log a bottle: breast-milk portions, each from one container, plus formula,
 * plus what was left over ("sobró", statistics only). The server takes each
 * portion from its container, refuses to take more than is left
 * (`milk_overdraw` — two phones serving from the same one, or one that was
 * just discarded), and writes the totals itself. Formula has no inventory.
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
  return write('Bottle', logBottleFeedOp(babyId, userId, input), {
    queueOnly: !!opts?.containersPending,
  })
}

/** The queued call that deletes a bottle (void_bottle_feed). */
export function voidBottleFeedOp(id: string, at: string = new Date().toISOString()): RpcOp {
  return {
    kind: 'rpc',
    fn: 'void_bottle_feed',
    args: { p_feeding_id: id, p_voided_at: at },
    table: 'feedings',
    id,
    effect: 'delete',
    patch: { voided_at: at },
  }
}

/**
 * Delete a bottle and give every portion back to its container, in one
 * operation. Formula has nothing to give back. Online, `data` says what went
 * back and what could not (D-9: "the milk did not go back to M3"); queued,
 * it is null and the page says it from applyPendingInventory's `lost`, "by
 * what this phone knows" (§8.2).
 */
export async function voidBottleFeed(
  id: string,
  opts?: { pending?: boolean },
): Promise<Result<MilkReturn | null>> {
  const result = await send('Delete feeding', voidBottleFeedOp(id), {
    queueOnly: !!opts?.pending,
  })
  const r = milkResultOf(result.data)
  return { ...result, data: r ? { returned_ml: r.returned_ml, lost: r.lost } : null }
}

/** The final state of a bottle edit (2A): absolute values, never deltas. */
export type BottleEditInput = {
  fed_at: string
  breast_ml: number
  formula_ml: number
  leftover_ml: number | null
  notes: string | null
}

/** What this phone knows of the inventory, queued writes folded in (applyPendingInventory). */
export type BottleEditContext = {
  containers: WithPending<MilkContainer>[]
  drawdowns: WithPending<MilkDrawdown>[]
  discards: WithPending<MilkDiscard>[]
}

/**
 * The queued call that edits a bottle (edit_bottle_feed). `feeding` is the row
 * as the screen showed it when the panel opened: it becomes `p_expected`, so
 * an edit made meanwhile on the other phone wins (`milk_edit_conflict`, regla
 * 21). `opId` is THIS edit's id — a new one per attempt to save, so a replay
 * of the same attempt is a no-op and a later attempt is a new edit (AJ-3).
 *
 * `refs` are the containers it touches — its current portions and the ones the
 * plan takes from (planBottleEdit, the server's rule) — so discarding a
 * rejected pumping session in the sync banner takes this edit along.
 */
export function editBottleFeedOp(
  feeding: Feeding,
  input: BottleEditInput,
  ctx: BottleEditContext,
  opId: string = newId(),
  atMs: number = Date.now(),
): RpcOp {
  const args: EditBottleArgs = {
    p_op_id: opId,
    p_feeding_id: feeding.id,
    p_fed_at: input.fed_at,
    p_breast_ml: input.breast_ml,
    p_formula_ml: input.formula_ml,
    p_leftover_ml: input.leftover_ml,
    p_notes: input.notes,
    p_expected: {
      // As read: the server compares it to the millisecond.
      fed_at: feeding.fed_at,
      breast_milk_ml: Number(feeding.breast_milk_ml ?? 0),
      formula_ml: Number(feeding.formula_ml ?? 0),
      leftover_ml: feeding.leftover_ml == null ? null : Number(feeding.leftover_ml),
    },
  }
  const plan = planBottleEdit(
    feeding,
    ctx.drawdowns,
    ctx.containers,
    ctx.discards,
    {
      fed_at: input.fed_at,
      breast_milk_ml: input.breast_ml,
      formula_ml: input.formula_ml,
      leftover_ml: input.leftover_ml,
      notes: input.notes,
    },
    atMs,
  )
  const refs = new Set(
    ctx.drawdowns
      .filter((d) => d.feeding_id === feeding.id && !d.voided_at)
      .map((d) => d.container_id),
  )
  if (plan.ok) for (const m of plan.taken) refs.add(m.containerId)
  return {
    kind: 'rpc',
    fn: 'edit_bottle_feed',
    args,
    table: 'feedings',
    id: feeding.id,
    effect: 'update',
    patch: {
      fed_at: input.fed_at,
      breast_milk_ml: input.breast_ml,
      formula_ml: input.formula_ml,
      amount_ml: input.breast_ml + input.formula_ml,
      leftover_ml: input.leftover_ml,
      notes: input.notes,
    },
    refs: [...refs],
  }
}

/**
 * Whether a bottle edit has to wait behind the queue: the bottle itself is
 * pending (a queued insert, or already a queued change), or a container the
 * edit touches is (its pumping session has not synced).
 */
export function editMustQueue(
  feeding: WithPending<Feeding>,
  op: RpcOp,
  ctx: Pick<BottleEditContext, 'containers'>,
): boolean {
  if (feeding.pending) return true
  return (op.refs ?? []).some((id) => ctx.containers.find((c) => c.id === id)?.pending)
}

/**
 * The full edit of a past bottle with a breakdown (2A): time, milk, formula,
 * "sobró" and note. Less milk goes back to the newest container first (D-17);
 * more milk comes from the oldest one usable at the bottle's time (D-18), or
 * the server answers `milk_not_enough:<ml>` and nothing changes.
 *
 * Queued behind (`queueOnly`) when the bottle is still a queued insert or
 * already has a queued change (`feeding.pending` — the row the page shows,
 * merged with the queue), or when a container it touches is still queued:
 * sent ahead, the server would not know the row (and an UPDATE on an unknown
 * id is no error), or would compare `p_expected` with a state it never had.
 *
 * Online, `data` is what moved (returned, lost, taken); queued, null.
 */
export async function editBottleFeed(
  feeding: WithPending<Feeding>,
  input: BottleEditInput,
  ctx: BottleEditContext,
  opts?: { pending?: boolean },
): Promise<Result<MilkEditResult | null>> {
  const op = editBottleFeedOp(feeding, input, ctx)
  const queueOnly = !!opts?.pending || editMustQueue(feeding, op, ctx)
  const result = await send('Edit feeding', op, { queueOnly })
  return { ...result, data: milkResultOf(result.data) }
}

// --------------------------------------------------------------- milk rules (0014, 0015)

/*
 * The pediatrician's storage rules, and how many physical bottles there are
 * (N, 0015, D-23). Like the countdown thresholds (0012) they belong to the
 * family, both parents see the same numbers, and they do NOT go through the
 * offline queue: a rule applied late could overwrite what the other parent
 * set meanwhile. Offline, Settings says so and saves nothing.
 *
 * `db` is only for the integration tests (a signed-in parent's client).
 */

export async function milkRules(
  babyId: string,
  db: Db = data(),
): Promise<Result<MilkSettings | null>> {
  const { data: row, error } = await db
    .from('babies')
    .select('milk_room_hours, milk_fridge_days, milk_freezer_months, milk_bottle_count')
    .eq('id', babyId)
    .maybeSingle()
  if (error) return fail(null, error)
  if (!row) return ok(null)
  const r = row as MilkSettings
  return ok({
    milk_room_hours: Number(r.milk_room_hours),
    milk_fridge_days: Number(r.milk_fridge_days),
    milk_freezer_months: Number(r.milk_freezer_months),
    milk_bottle_count: effectiveBottleCount(r.milk_bottle_count),
  })
}

/** One update of `babies` that has to match exactly the one row, or it is an error. */
async function saveBabyMilk(
  babyId: string,
  patch: Record<string, number>,
  db: Db,
): Promise<Result<null>> {
  // `.select` so an update that matched nothing (a baby RLS doesn't show this
  // parent) is an error, not a "Saved" that saved nothing (§5.5).
  const { data: rows, error } = await db.from('babies').update(patch).eq('id', babyId).select('id')
  if (error) return fail(null, error)
  if (!rows || rows.length !== 1) return fail(null, { message: 'milk_baby_not_found' })
  return ok(null)
}

/**
 * Save the rules — and N too when given (AJ-17: same card, same button, one
 * save). Only these columns are written, whatever else the object carries.
 */
export function saveMilkRules(
  babyId: string,
  rules: MilkRules | MilkSettings,
  db: Db = data(),
): Promise<Result<null>> {
  const patch: Record<string, number> = {
    milk_room_hours: rules.milk_room_hours,
    milk_fridge_days: rules.milk_fridge_days,
    milk_freezer_months: rules.milk_freezer_months,
  }
  if ('milk_bottle_count' in rules) patch.milk_bottle_count = rules.milk_bottle_count
  return saveBabyMilk(babyId, patch, db)
}

/**
 * Save only N, the number of bottles (1–30, checked by the page with
 * validateBottleCount and by the table's CHECK). Same rules as saveMilkRules:
 * no queue, an update that matched nothing is an error.
 */
export function saveMilkBottleCount(
  babyId: string,
  count: number,
  db: Db = data(),
): Promise<Result<null>> {
  return saveBabyMilk(babyId, { milk_bottle_count: count }, db)
}

// --------------------------------------------------------------- milk errors

const MILK_ERRORS: Record<string, MessageKey> = {
  milk_overdraw: 'milkError.overdraw',
  milk_container_unusable: 'milkError.containerUnusable',
  // The wire code stays the one of 0014 (AJ-1: a cached v3 app translates
  // it); the words are about bottles now.
  milk_label_taken: 'milkError.bottleTaken',
  milk_already_served: 'milkError.alreadyServed',
  milk_served_exceeds_amount: 'milkError.servedExceedsAmount',
  milk_idempotency_conflict: 'milkError.idempotencyConflict',
  milk_rpc_only: 'milkError.rpcOnly',
  milk_bad_input: 'milkError.badInput',
  milk_baby_not_found: 'milkError.babyNotFound',
  milk_not_signed_in: 'milkError.notSignedIn',
  milk_session_gone: 'milkError.sessionGone',
  // 0015
  milk_not_expired: 'milkError.notExpired',
  milk_not_enough: 'milkError.notEnough',
  milk_edit_conflict: 'milkError.editConflict',
  milk_future_time: 'milkError.futureTime',
  milk_feeding_gone: 'milkError.feedingGone',
  milk_not_inventory: 'milkError.notInventory',
  milk_invariant_broken: 'milkError.invariantBroken',
  // Not from the server: see MILK_BOTTLE_NEEDED.
  milk_bottle_needed: 'milk.bottleNeeded',
}

/**
 * A rejection from one of the milk functions, in words. They answer with a
 * stable code, sometimes followed by a bottle's number ("milk_overdraw:M3")
 * or, for `milk_not_enough`, the ml there were (shown in oz, AJ-12);
 * anything else is passed through as it came (and framed by the page).
 */
export function milkErrorText(
  message: string | null,
  lang: Lang = 'en',
  /**
   * 'sync': the rejection of a QUEUED entry, in the sync banner. There the
   * entry exists only on this device and "Discard" is the way out, so a
   * taken bottle says that (QA, 6 oct 2026: it said "another phone… delete
   * this session" — it may have been this phone offline, and there was
   * nothing to delete).
   */
  context?: 'sync',
): string {
  if (!message) return ''
  const match = /^(milk_[a-z_]+)(?::(.+))?$/.exec(message.trim())
  let key = match ? MILK_ERRORS[match[1]] : undefined
  if (!key) return message
  const suffix = match![2]
  if (key === 'milkError.notEnough') {
    const ml = Number(suffix)
    // Without a number the sentence would say "only NaN oz".
    if (!Number.isFinite(ml)) key = 'milkError.notEnoughUnknown'
    return translate(lang, key, { amount: Number.isFinite(ml) ? formatMilkOz(ml) : '' })
  }
  // Without a number to name, the "which one" sentence would have a hole in it.
  if (key === 'milkError.containerUnusable' && !suffix) key = 'milkError.containerUnknown'
  if (key === 'milkError.notExpired' && !suffix) key = 'milkError.notExpiredUnknown'
  if (key === 'milkError.bottleTaken' && context === 'sync') key = 'milkError.bottleTakenQueued'
  return translate(lang, key, { label: suffix ?? '' })
}

// --------------------------------------------------------------- growth

/** Every measurement, newest first. A page at a time (lib/readAll.ts): a cut
 * would drop the oldest points of the curve, quietly. */
export async function listGrowth(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<GrowthMeasurement[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('growth_measurements')
        .select('id, measured_at, weight_kg, height_cm, notes')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('measured_at', { ascending: false })
        .order('id')
        .range(from, to),
    pageSize,
  )
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

/** Every appointment, soonest first. A page at a time (lib/readAll.ts): a cut
 * would drop the NEXT ones, which are the ones that matter. */
export async function listAppointments(
  babyId: string,
  db: Db = data(),
  pageSize = PAGE_SIZE,
): Promise<Result<DoctorAppointment[]>> {
  const { data: rows, error } = await readAll(
    (from, to) =>
      db
        .from('doctor_appointments')
        .select(APPT_COLUMNS)
        .eq('baby_id', babyId)
        .order('scheduled_at', { ascending: true })
        .order('id')
        .range(from, to),
    pageSize,
  )
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

/**
 * History's rows for the milk that was thrown out (0015, V4-37): "Discarded
 * milk · M3 · 1.5 oz" at the time it was discarded. Not editable and not
 * deletable in v4 (D-11). Its own function rather than one more argument of
 * buildActivity, whose last argument has to stay `lang` (§5.7); History merges
 * these in and sorts everything by time, as it already does.
 */
export function discardActivity(
  discards: WithPending<MilkDiscard>[],
  since: number,
  lang: Lang = 'en',
): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const d of discards) {
    if (d.voided_at || new Date(d.discarded_at).getTime() < since) continue
    const vars = { label: d.label ?? '?', amount: formatMilkOz(d.amount_ml) }
    let what = translate(lang, 'milk.discardedLine', vars)
    // History already labels the kind ("Discarded milk"): the number and the
    // amount are all that is left to say, and they have no words to translate.
    let detail = `${vars.label} · ${vars.amount}`
    if (d.pending) {
      const mark = translate(lang, 'activity.notSynced')
      what = `${what} · ${mark}`
      detail = `${detail} · ${mark}`
    }
    out.push({ id: d.id, at: d.discarded_at, kind: 'discard', what, detail })
  }
  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
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
