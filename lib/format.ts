// Small formatting helpers shared across the app.
// Deliberately dependency-free — no date library for six functions.

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "just now" / "42m ago" / "3h 10m ago" / "yesterday" */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const diff = now - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

/** Live stopwatch for an in-progress session: "7:42" or "1:07:42" */
export function elapsed(startIso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Length of a finished session: "24 min" / "2h 15m" */
export function durationBetween(startIso: string, endIso: string): string {
  const mins = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** The DB stores metric; the pediatrician's office talks in lb/oz. */
export function kgToLbOz(kg: number): string {
  const total = kg * 2.20462
  let lb = Math.floor(total)
  let oz = Math.round((total - lb) * 16)
  if (oz === 16) { lb += 1; oz = 0 }
  return `${lb} lb ${oz} oz`
}

export function cmToIn(cm: number): string {
  return `${(cm / 2.54).toFixed(1)} in`
}

/** "6 days old" / "5 weeks old" / "3 months old" — null before birth. */
export function ageFrom(birthDate: string | null | undefined, now: Date = new Date()): string | null {
  if (!birthDate) return null
  const born = new Date(`${birthDate}T00:00:00`)
  const days = Math.floor((now.getTime() - born.getTime()) / 86_400_000)
  if (days < 0) return null
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`
  if (days < 60) return `${Math.floor(days / 7)} weeks old`
  return `${Math.floor(days / 30.44)} months old`
}

/** Value for a datetime-local input, in the browser's local timezone. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
