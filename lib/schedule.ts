/**
 * El countdown de /dashboard: cuándo le toca la próxima comida y la próxima
 * siesta, y si hay una cita cerca. Funciones PURAS — sin reloj propio, sin
 * base, sin React: la página entrega las filas y su `now`, igual que
 * lib/kpis.ts. Así se prueba bajo cuatro timezones.
 *
 * QUÉ REEMPLAZA, Y POR QUÉ NO ERA "UN CÁLCULO HARDCODEADO"
 * -------------------------------------------------------
 * Hasta el 24 sep 2026 la línea "Next feeding" salía de `predictNextFeeding`
 * (lib/db.ts), que PROMEDIABA los últimos 6 intervalos entre comidas, y "Next
 * nap" de `predictNextNap`, que promediaba las últimas 6 ventanas de vigilia.
 * No había ninguna constante de 2 h ni de 3 h en el repo.
 *
 * El cambio es real, no un reemplazo de un placeholder:
 *
 *   · El promedio se autocorregía solo en uno o dos días tras un estirón.
 *     Esto no: el número lo pone el padre.
 *   · A cambio, un umbral SÍ puede disparar un aviso. "Llegó al promedio" no
 *     es una condición de alerta, es una estadística — no se puede notificar
 *     sobre eso sin mentir.
 *   · Y el umbral es un dato de FAMILIA (0012, family_settings), así que los
 *     dos padres ven el mismo número y el servidor lo puede leer.
 *
 * DESDE DÓNDE SE MIDE: desde el FIN del último evento, no desde su inicio.
 * `predictNextFeeding` medía desde el inicio (lib/kpis.ts:206-208 lo dice
 * explícito). Una toma de 40 minutos no vence tres horas después de EMPEZAR.
 */

import type { DoctorAppointment, Feeding, NursingSession, SleepSession } from '@/lib/types'

/** Defaults del pedido, espejo de los de `family_settings` (0012). */
export const DEFAULT_FEED_THRESHOLD_MINUTES = 180
export const DEFAULT_NAP_THRESHOLD_MINUTES = 120

/** Lo que el CHECK de la columna acepta. Fuera de esto no se guarda. */
export const MIN_THRESHOLD_MINUTES = 15
export const MAX_THRESHOLD_MINUTES = 1440

export type FamilySettings = {
  nap_threshold_minutes: number
  feed_threshold_minutes: number
}

export const DEFAULT_FAMILY_SETTINGS: FamilySettings = {
  nap_threshold_minutes: DEFAULT_NAP_THRESHOLD_MINUTES,
  feed_threshold_minutes: DEFAULT_FEED_THRESHOLD_MINUTES,
}

export type ThresholdProblem = 'notNumber' | 'outOfRange'

/**
 * Un umbral tipeado en Settings. Entero, y dentro del rango que el CHECK de
 * 0012 acepta — validar acá y no solo en la base es lo que hace que el error
 * se lea como una frase y no como un mensaje de Postgres (§5.5).
 */
export function checkThreshold(minutes: number): ThresholdProblem | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'notNumber'
  if (!Number.isInteger(minutes)) return 'notNumber'
  if (minutes < MIN_THRESHOLD_MINUTES || minutes > MAX_THRESHOLD_MINUTES) return 'outOfRange'
  return null
}

// ------------------------------------------------------------- último evento

/** Una fila retractada no cuenta para nada de acá. */
function live<T extends { voided_at?: string | null }>(row: T): boolean {
  return !row.voided_at
}

export type LastEvent = {
  /** El instante desde el que se cuenta el umbral: el FIN del evento. */
  endedAt: string
  /** Hay una sesión abierta ahora mismo: no hay nada que vencer. */
  running: boolean
}

/**
 * El fin del último evento de comida, **de cualquier tipo**.
 *
 * La pregunta que contesta la tarjeta es "¿cuándo le toca comer?", y un
 * biberón de 120 ml la contesta igual que una toma de pecho. `lastFeedingEvent`
 * (lib/kpis.ts) ya trata las dos tablas como una sola fuente para la línea de
 * la tarjeta; la única diferencia acá es el instante:
 *
 *   · `feedings` (bottle / solid / nursing-typed) → `fed_at`. Es un evento
 *     puntual: no tiene fin separado, la columna es una sola.
 *   · `nursing_sessions` terminada → `ended_at`.
 *   · `nursing_sessions` EN CURSO → `running: true`. Está comiendo ahora; no
 *     hay una próxima comida que contar todavía. Es también lo que preserva el
 *     ocultamiento de la línea durante una lactancia, que ya existía.
 */
export function lastFeedingEnd(
  feedings: readonly (Feeding & { voided_at?: string | null })[],
  nursing: readonly (NursingSession & { voided_at?: string | null })[],
): LastEvent | null {
  let best: LastEvent | null = null
  const later = (at: string) => !best || Date.parse(at) > Date.parse(best.endedAt)

  for (const f of feedings) {
    if (!live(f)) continue
    if (later(f.fed_at)) best = { endedAt: f.fed_at, running: false }
  }
  for (const n of nursing) {
    if (!live(n)) continue
    if (n.ended_at === null) return { endedAt: n.started_at, running: true }
    if (later(n.ended_at)) best = { endedAt: n.ended_at, running: false }
  }
  return best
}

/**
 * El fin de la última siesta. `predictNextNap` ya medía desde `ended_at`, así
 * que acá el instante no cambia — lo que cambia es que el intervalo deja de
 * ser un promedio y pasa a ser el umbral configurado.
 */
export function lastNapEnd(
  sleep: readonly (SleepSession & { voided_at?: string | null })[],
): LastEvent | null {
  let best: LastEvent | null = null
  for (const s of sleep) {
    if (!live(s)) continue
    if (s.ended_at === null) return { endedAt: s.started_at, running: true }
    if (!best || Date.parse(s.ended_at) > Date.parse(best.endedAt)) {
      best = { endedAt: s.ended_at, running: false }
    }
  }
  return best
}

// -------------------------------------------------------------- el countdown

export type DueState = {
  /** Cuándo vence, ISO. */
  dueAt: string
  /** Minutos que faltan; NEGATIVO si ya se pasó. */
  minutesLeft: number
  /** Ya se pasó del umbral. */
  overdue: boolean
}

/**
 * `endedAt + threshold`, leído contra `now`. El signo se conserva a propósito:
 * "vence en 45 min" y "45 min tarde" son la misma cuenta y las dos hacen falta.
 */
export function nextDue(endedAt: string, thresholdMinutes: number, now: number): DueState | null {
  const end = Date.parse(endedAt)
  if (Number.isNaN(end)) return null
  const due = end + thresholdMinutes * 60_000
  const minutesLeft = Math.round((due - now) / 60_000)
  return { dueAt: new Date(due).toISOString(), minutesLeft, overdue: due <= now }
}

/**
 * El countdown tal como lo muestra la tarjeta: `null` cuando no hay nada
 * honesto que decir — sin ningún evento todavía, o con una sesión corriendo
 * ahora mismo (§5.4: no se afirma un hecho que no se sabe).
 */
export function dueFrom(
  last: LastEvent | null,
  thresholdMinutes: number,
  now: number,
): DueState | null {
  if (!last || last.running) return null
  return nextDue(last.endedAt, thresholdMinutes, now)
}

// ---------------------------------------------------------------- citas

/** Cuánto antes de una cita aparece su tarjeta en Today. */
export const APPOINTMENT_CARD_HOURS = 36
export const APPOINTMENT_CARD_MS = APPOINTMENT_CARD_HOURS * 60 * 60 * 1000

/** Cuánto antes sale el recordatorio push. */
export const APPOINTMENT_REMINDER_HOURS = 24
export const APPOINTMENT_REMINDER_MS = APPOINTMENT_REMINDER_HOURS * 60 * 60 * 1000

/**
 * La cita que la tarjeta de Today muestra: la más próxima que todavía no pasó,
 * que no está marcada como hecha, y que cae dentro de las próximas 36 horas.
 * Fuera de esa ventana la tarjeta no existe — una cita del mes que viene no es
 * información de hoy, y Doctor ya la lista.
 */
export function nextAppointment(
  appointments: readonly DoctorAppointment[],
  now: number,
  windowMs: number = APPOINTMENT_CARD_MS,
): DoctorAppointment | null {
  let best: DoctorAppointment | null = null
  for (const a of appointments) {
    if (a.completed) continue
    const at = Date.parse(a.scheduled_at)
    if (Number.isNaN(at)) continue
    if (at < now || at > now + windowMs) continue
    if (!best || at < Date.parse(best.scheduled_at)) best = a
  }
  return best
}

/** Minutos hasta la cita, nunca negativos (`nextAppointment` ya descartó el pasado). */
export function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
}
