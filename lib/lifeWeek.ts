/**
 * La semana de vida de la bebé: semana 1, 2, 3… desde su fecha de nacimiento.
 * Funciones PURAS, sin reloj propio ni base.
 *
 * NO ES la ventana `week` de lib/kpis.ts
 * --------------------------------------
 * `kpiWindows().week` es "hoy + los 6 días de calendario anteriores": una
 * ventana rodante de la que hoy es siempre el último día. Esta es otra cosa:
 * un tramo FIJO del calendario, el mismo para siempre, que no se mueve al
 * pasar el tiempo. La semana 3 de Amelia es la semana 3 hoy y dentro de un
 * año. Por eso se puede elegir una y comparar con la anterior; con la ventana
 * rodante no hay nada que elegir.
 *
 * Las dos conviven a propósito: `week` sigue siendo una función pura de
 * lib/kpis.ts, aunque desde el 24 sep 2026 las tres páginas de sección ya no
 * la usen (el selector de semana de vida ocupó ese lugar).
 *
 * DÍA DE CALENDARIO DEL HOGAR, NO 7×24 h
 * --------------------------------------
 * Una semana arranca a medianoche de `America/Los_Angeles`, igual que
 * `startOfHouseholdDay` (lib/format.ts). Con los dos cambios de horario del
 * año, una semana dura 167 o 169 horas y eso es lo correcto: nadie piensa la
 * semana 12 como "168 horas después de la 11", la piensa como siete días.
 */

import { fromHouseholdInputValue, householdToday } from '@/lib/format'

export const DAYS_PER_WEEK = 7

export type LifeWeekRange = {
  /** 1-based: no existe la semana 0. */
  week: number
  /** Instante (ms) de la medianoche del hogar en que arranca. */
  start: number
  /** Instante (ms) de la medianoche en que arranca la semana siguiente. */
  end: number
  /** Los siete días de calendario del hogar, `YYYY-MM-DD`, en orden. */
  days: string[]
}

/** Suma días a una fecha `YYYY-MM-DD` de calendario, sin tocar husos. */
export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Días enteros de calendario entre dos fechas `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

function isDateOnly(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * En qué semana de vida cae un día de calendario del hogar. El día del
 * nacimiento es la semana 1. Devuelve `null` para un día anterior al
 * nacimiento y para una fecha de nacimiento que no está cargada — sin ella no
 * hay semana de vida y no se inventa una (§5.4: no afirmar lo que no se sabe).
 */
export function lifeWeekOfDay(
  birthDate: string | null | undefined,
  dateOnly: string,
): number | null {
  if (!isDateOnly(birthDate) || !isDateOnly(dateOnly)) return null
  const days = daysBetween(birthDate, dateOnly)
  if (days < 0) return null
  return Math.floor(days / DAYS_PER_WEEK) + 1
}

/** Lo mismo, para un instante: se resuelve primero a qué día del hogar cae. */
export function lifeWeekOf(birthDate: string | null | undefined, at: Date): number | null {
  return lifeWeekOfDay(birthDate, householdToday(at))
}

/** La semana de vida que corre ahora: la más alta que se puede elegir. */
export function currentLifeWeek(birthDate: string | null | undefined, now: Date): number | null {
  return lifeWeekOf(birthDate, now)
}

/**
 * El tramo de una semana de vida. `end` es la medianoche en que arranca la
 * siguiente — medio abierto `[start, end)`, que es lo que hace que un evento
 * no pueda caer en dos semanas.
 */
export function lifeWeekRange(
  birthDate: string | null | undefined,
  week: number,
): LifeWeekRange | null {
  if (!isDateOnly(birthDate)) return null
  if (!Number.isInteger(week) || week < 1) return null
  const first = addDays(birthDate, (week - 1) * DAYS_PER_WEEK)
  const days = Array.from({ length: DAYS_PER_WEEK }, (_, i) => addDays(first, i))
  return {
    week,
    start: Date.parse(fromHouseholdInputValue(`${first}T00:00`)),
    end: Date.parse(fromHouseholdInputValue(`${addDays(first, DAYS_PER_WEEK)}T00:00`)),
    days,
  }
}

/**
 * Las semanas elegibles, de la actual hacia atrás. La lista arranca en la
 * semana 1 y termina en la que corre: una semana futura no tiene datos y
 * ofrecerla sería ofrecer una pantalla vacía garantizada.
 */
export function lifeWeeksUpTo(birthDate: string | null | undefined, now: Date): number[] {
  const current = currentLifeWeek(birthDate, now)
  if (current === null) return []
  return Array.from({ length: current }, (_, i) => current - i)
}

/**
 * La ventana de lectura de una semana, como la piden las lecturas `*Since` de
 * lib/db.ts: un ISO desde el que leer. Se lee desde el arranque de la semana,
 * y las filas posteriores a `end` se descartan al contar — la lectura no sabe
 * de topes, pero `kpiWindows` sí.
 */
export function lifeWeekSinceIso(range: LifeWeekRange): string {
  return new Date(range.start).toISOString()
}
