/**
 * The totals on /feeding, /diapers and /sleep — pure functions, no clock and
 * no database: the page hands in the rows (queue already merged in, see
 * mergePending in lib/db.ts), the window and "now".
 *
 * The two windows:
 *
 *   · last24h — the LAST 24 HOURS, rolling: from exactly 24 h ago until now.
 *              Not a calendar day (23 sep 2026). At 00:10 a feeding from
 *              23:50 still counts, which is the whole point at 3 AM: what
 *              matters is how much she ate since about this time yesterday,
 *              not since a midnight that just went by. The label says
 *              "Last 24 hours", never "Today" — see lib/i18n ('kpi.last24h').
 *   · week   — the last 7 days: from the household midnight 6 days ago
 *              until now, today included. CALENDAR days, deliberately left
 *              alone in that pass: nobody asked for it to roll, and the
 *              household timezone (lib/format.ts) is what makes it survive
 *              the two DST changes.
 *
 * Point events (a bottle, a diaper) count when they happened inside the
 * window. Sessions (nursing, sleep) count twice over: as a feeding or a nap
 * when they STARTED inside it, and as time for the part of
 * [started_at, ended_at ?? now] that overlaps it — a sleep that began before
 * the window gives it only the hours inside.
 *
 * A row still in the offline queue counts (it is what the parent logged) and
 * raises `pending`, so the page can say the total includes it. A row whose
 * deletion is queued (`voided_at` set by the merged patch) no longer counts,
 * and raises `pending` too: the total already reflects a change the server
 * has not seen.
 */

import { startOfHouseholdDay } from '@/lib/format'
import type { DiaperChange, Feeding, NursingSession, SleepSession, WithPending } from '@/lib/types'

export type KpiWindow = { start: number; end: number }

/** Rows as a page holds them: queue merged in, maybe a queued deletion. */
type Row<T> = WithPending<T> & { voided_at?: string | null }

/** The rolling window's length. Plain clock hours: a DST change moves what
 * wall-clock time "24 hours ago" lands on, and that is the honest answer. */
export const DAY_MS = 24 * 60 * 60 * 1000

export function kpiWindows(now: Date = new Date()): { last24h: KpiWindow; week: KpiWindow } {
  const end = now.getTime()
  return {
    last24h: { start: end - DAY_MS, end },
    week: { start: startOfHouseholdDay(now, 6), end },
  }
}

function inWindow(iso: string, w: KpiWindow): boolean {
  const t = new Date(iso).getTime()
  return t >= w.start && t <= w.end
}

/** Milliseconds of [start, end ?? now] that fall inside the window. */
export function overlapMs(
  startIso: string,
  endIso: string | null,
  w: KpiWindow,
  now: number = w.end,
): number {
  const start = new Date(startIso).getTime()
  const end = endIso ? new Date(endIso).getTime() : now
  return Math.max(0, Math.min(end, w.end) - Math.max(start, w.start))
}

/**
 * Walks the rows, skipping retracted ones: `contributes` says whether a row
 * contributes, and a contributing row that is pending — or a queued deletion
 * that would have contributed — marks the result as including unsynced rows.
 */
function each<T>(
  rows: Row<T>[],
  contributes: (row: Row<T>) => boolean,
  visit: (row: Row<T>) => void,
) {
  let pending = false
  for (const row of rows) {
    if (!contributes(row)) continue
    if (row.pending) pending = true
    if (row.voided_at) continue
    visit(row)
  }
  return pending
}

// --------------------------------------------------------------- feeding

export type FeedingKpis = {
  /** bottle + solid + breast */
  total: number
  bottle: number
  solid: number
  /** Nursing sessions started in the window, plus any feeding logged as "nursing". */
  breast: number
  bottleMl: number
  breastMs: number
  pending: boolean
}

export function feedingKpis(
  feedings: Row<Feeding>[],
  nursing: Row<NursingSession>[],
  w: KpiWindow,
  now: number = w.end,
): FeedingKpis {
  const out: FeedingKpis = {
    total: 0,
    bottle: 0,
    solid: 0,
    breast: 0,
    bottleMl: 0,
    breastMs: 0,
    pending: false,
  }

  const p1 = each(
    feedings,
    (f) => inWindow(f.fed_at, w),
    (f) => {
      if (f.feeding_type === 'bottle') {
        out.bottle += 1
        out.bottleMl += f.amount_ml ?? 0
      } else if (f.feeding_type === 'solid') out.solid += 1
      else out.breast += 1
    },
  )
  const p2 = each(
    nursing,
    (n) => inWindow(n.started_at, w) || overlapMs(n.started_at, n.ended_at, w, now) > 0,
    (n) => {
      if (inWindow(n.started_at, w)) out.breast += 1
      out.breastMs += overlapMs(n.started_at, n.ended_at, w, now)
    },
  )

  out.total = out.bottle + out.solid + out.breast
  out.pending = p1 || p2
  return out
}

// --------------------------------------------------------------- diapers

export type DiaperKpis = {
  total: number
  wet: number
  dirty: number
  /** Its own kind: a "both" is not also counted as wet and as dirty. */
  both: number
  pending: boolean
}

export function diaperKpis(diapers: Row<DiaperChange>[], w: KpiWindow): DiaperKpis {
  const out: DiaperKpis = { total: 0, wet: 0, dirty: 0, both: 0, pending: false }
  out.pending = each(
    diapers,
    (d) => inWindow(d.changed_at, w),
    (d) => {
      out.total += 1
      if (d.diaper_type === 'wet') out.wet += 1
      else if (d.diaper_type === 'dirty') out.dirty += 1
      else if (d.diaper_type === 'both') out.both += 1
    },
  )
  return out
}

// --------------------------------------------------------------- sleep

export type SleepKpis = {
  sleptMs: number
  /** Sessions that started in the window. */
  naps: number
  pending: boolean
}

export function sleepKpis(
  sleep: Row<SleepSession>[],
  w: KpiWindow,
  now: number = w.end,
): SleepKpis {
  const out: SleepKpis = { sleptMs: 0, naps: 0, pending: false }
  out.pending = each(
    sleep,
    (s) => inWindow(s.started_at, w) || overlapMs(s.started_at, s.ended_at, w, now) > 0,
    (s) => {
      if (inWindow(s.started_at, w)) out.naps += 1
      out.sleptMs += overlapMs(s.started_at, s.ended_at, w, now)
    },
  )
  return out
}

// --------------------------------------------------------------- dashboard

export type LastFeeding =
  | { kind: 'feeding'; at: string; row: WithPending<Feeding> }
  | { kind: 'nursing'; at: string; row: WithPending<NursingSession> & { ended_at: string } }

/**
 * The feeding the dashboard's Feeding card names: the most recent of the
 * logged feedings and the FINISHED nursing sessions (a running one has its
 * own stopwatch). A session is placed at its start — when the feeding
 * began, which is also what the next-feeding prediction measures from.
 */
export function lastFeedingEvent(
  feedings: WithPending<Feeding>[],
  nursing: WithPending<NursingSession>[],
): LastFeeding | null {
  let best: LastFeeding | null = null
  const later = (at: string) => !best || new Date(at).getTime() > new Date(best.at).getTime()
  for (const f of feedings) {
    if (later(f.fed_at)) best = { kind: 'feeding', at: f.fed_at, row: f }
  }
  for (const n of nursing) {
    if (!n.ended_at) continue
    if (later(n.started_at)) {
      best = {
        kind: 'nursing',
        at: n.started_at,
        row: n as WithPending<NursingSession> & { ended_at: string },
      }
    }
  }
  return best
}

// --------------------------------------------------------------- past entries

export type PastRangeProblem = 'needTime' | 'endBeforeStart' | 'inFuture'

/**
 * Whether a time (or a start–end pair) typed into "Log a past one" or an
 * edit can be saved: both there, not in the future, and the end after the
 * start. `null` when it can.
 */
export function checkPastRange(
  startIso: string | null,
  endIso: string | null | undefined,
  now: number,
): PastRangeProblem | null {
  if (!startIso || endIso === null) return 'needTime'
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return 'needTime'
  if (start > now) return 'inFuture'
  if (endIso === undefined) return null
  const end = new Date(endIso).getTime()
  if (Number.isNaN(end)) return 'needTime'
  if (end > now) return 'inFuture'
  if (end <= start) return 'endBeforeStart'
  return null
}

// --------------------------------------------------------- running sessions

export type ShiftProblem = 'notNumber' | 'notPositive' | 'tooLong' | 'tooFarBack'

/** The most one correction may move a start back, in minutes. Four hours is
 * already longer than any nursing session or nap this app has seen; past
 * that it is a typo, not a correction. */
export const MAX_SHIFT_MINUTES = 240

/** And however many corrections are applied, the start may not end up more
 * than this before now: a session running for half a day is a session that
 * was never stopped, and backdating it would quietly rewrite the totals. */
export const MAX_SHIFT_BACK_MS = 12 * 60 * 60 * 1000

/**
 * "She started nursing five minutes before I hit the button": the new
 * `started_at` for a session already running, moved `minutes` earlier.
 *
 * Pure on purpose — the page hands in the row's current start and its own
 * clock, so it can be tested without React, a database or a timer. It is
 * CUMULATIVE by construction: it shifts the start it is given, so applying
 * it twice moves the session twice.
 *
 * Returns the problem instead of a value when the number can't be used; the
 * card shows it in a Banner and writes nothing (design.md §5.5).
 */
export function shiftStart(
  startIso: string,
  minutes: number,
  now: number,
): { at: string | null; problem: ShiftProblem | null } {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes))
    return { at: null, problem: 'notNumber' }
  if (minutes <= 0) return { at: null, problem: 'notPositive' }
  if (minutes > MAX_SHIFT_MINUTES) return { at: null, problem: 'tooLong' }

  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return { at: null, problem: 'notNumber' }

  const shifted = start - minutes * 60_000
  if (shifted < now - MAX_SHIFT_BACK_MS) return { at: null, problem: 'tooFarBack' }
  return { at: new Date(shifted).toISOString(), problem: null }
}
