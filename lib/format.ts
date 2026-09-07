/**
 * Time and unit formatting.
 *
 * CONVENTIONS.md §3: "Times render in `America/Los_Angeles`. Relative
 * for recent ('22m ago'), absolute past a day." The timezone is the
 * household's, not the viewer's — the wall screen and a phone in
 * another timezone must agree about when a feed happened, and the
 * database stores UTC (CONVENTIONS.md §1).
 *
 * Dependency-free on purpose; this is a handful of functions, not a
 * reason to ship a date library to the browser.
 */

export const HOUSEHOLD_TZ = 'America/Los_Angeles'

// --------------------------------------------------------------- timezone

/** How far the household timezone sits from UTC at a given instant. */
function tzOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOUSEHOLD_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  )
  return asIfUtc - at.getTime()
}

function fmt(iso: string | number | Date, opts: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString([], { timeZone: HOUSEHOLD_TZ, ...opts })
}

// --------------------------------------------------------------- display

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return fmt(iso, { hour: 'numeric', minute: '2-digit' })
}

export function longDate(iso: string | number | Date): string {
  return fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function apptWhen(iso: string): string {
  return fmt(iso, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export function measuredOn(dateOnly: string): string {
  // A date column has no time; render the calendar date as written
  // rather than shifting it across midnight into another day.
  const [y, m, d] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  })
}

/**
 * Relative inside a day, absolute past it.
 * "just now" · "42m ago" · "3h 10m ago" · "Mon 2:14 PM" · "Aug 28, 2:14 PM"
 */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const diff = now - then

  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`

  // Past a day: absolute. Within the week the weekday is more legible
  // than a date; beyond it, name the date.
  const days = Math.floor(hrs / 24)
  return days < 7
    ? fmt(then, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : fmt(then, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Live stopwatch for a session in progress: "7:42" / "1:07:42". */
export function elapsed(startIso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Length of a finished session: "24 min" / "2h 15m". */
export function durationBetween(startIso: string, endIso: string): string {
  const mins = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * A predicted clock time, read against now: "due in 45m" · "10m
 * overdue" · "due now". Signed on purpose — a predicted feeding or nap
 * that's already passed is exactly the thing worth surfacing.
 */
export function dueRelative(targetIso: string | null, now: number = Date.now()): string | null {
  if (!targetIso) return null
  const diffMin = Math.round((new Date(targetIso).getTime() - now) / 60_000)
  if (Math.abs(diffMin) < 1) return 'due now'
  const mins = Math.abs(diffMin)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const span = h > 0 ? `${h}h ${m}m` : `${m}m`
  return diffMin > 0 ? `due in ${span}` : `${span} overdue`
}

// --------------------------------------------------------------- units

export const LB_PER_KG = 2.20462

/** The DB stores metric; the pediatrician's office talks in lb/oz. */
export function kgToLbOz(kg: number): string {
  const total = kg * LB_PER_KG
  let lb = Math.floor(total)
  let oz = Math.round((total - lb) * 16)
  if (oz === 16) { lb += 1; oz = 0 }
  return `${lb} lb ${oz} oz`
}

export function lbOzToKg(lb: number, oz: number): number {
  return (lb + oz / 16) / LB_PER_KG
}

export function cmToIn(cm: number): string {
  return `${(cm / 2.54).toFixed(1)} in`
}

/** "6 days old" / "5 weeks old" / "3 months old" — null before birth. */
export function ageFrom(birthDate: string | null | undefined, now: Date = new Date()): string | null {
  if (!birthDate) return null
  const [y, m, d] = birthDate.split('-').map(Number)
  const bornUtc = Date.UTC(y, m - 1, d)
  const nowLocalDay = new Date(now.getTime() + tzOffsetMs(now))
  const todayUtc = Date.UTC(
    nowLocalDay.getUTCFullYear(), nowLocalDay.getUTCMonth(), nowLocalDay.getUTCDate(),
  )
  const days = Math.floor((todayUtc - bornUtc) / 86_400_000)
  if (days < 0) return null
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`
  if (days < 60) return `${Math.floor(days / 7)} weeks old`
  return `${Math.floor(days / 30.44)} months old`
}

// --------------------------------------------------------------- form values

/** Today's date in the household timezone, as a `date` input value. */
export function householdToday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + tzOffsetMs(now))
  return shifted.toISOString().slice(0, 10)
}

/** A `datetime-local` value showing household wall-clock time. */
export function toHouseholdInputValue(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + tzOffsetMs(at))
  return shifted.toISOString().slice(0, 16)
}

/**
 * Read a `datetime-local` value back as household wall-clock time and
 * return the UTC instant to store. Resolved twice so a time that falls
 * near a DST change lands on the right side of it.
 */
export function fromHouseholdInputValue(value: string): string {
  const naive = Date.parse(`${value}:00Z`)
  if (Number.isNaN(naive)) return new Date().toISOString()
  let instant = new Date(naive - tzOffsetMs(new Date(naive)))
  instant = new Date(naive - tzOffsetMs(instant))
  return instant.toISOString()
}

/** Midnight tonight-past, household time — the window for "today". */
export function startOfHouseholdDay(now: Date = new Date()): number {
  return Date.parse(fromHouseholdInputValue(`${householdToday(now)}T00:00`))
}
