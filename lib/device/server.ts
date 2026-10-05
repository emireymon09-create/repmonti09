import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeviceFailure } from '@/lib/deviceAuth'
import { DEFAULT_FAMILY_SETTINGS, dueFrom, lastFeedingEnd, type DueState } from '@/lib/schedule'
import type { DiaperType, Feeding, NursingSession, Side } from '@/lib/types'

/**
 * SOLO SERVIDOR: las queries de los endpoints de la pantalla del cambiador
 * (`/api/quick/diaper` y `/api/quick/status`, proposals/changer-display.md).
 *
 * Existe por lo mismo que lib/push/server.ts (CLAUDE.md §5.3): lib/db.ts es
 * 'use client' y estas queries corren con service_role en un route handler. Las
 * rutas no arman ninguna query: solo llaman a esto.
 *
 * El bebé SIEMPRE llega ya resuelto por `resolveBabyForDevice` (lib/deviceAuth.ts),
 * que nunca sale de la familia del token.
 */

export const DIAPER_TYPES: readonly DiaperType[] = ['wet', 'dirty', 'both']

export function isDiaperType(value: unknown): value is DiaperType {
  return DIAPER_TYPES.some((t) => t === value)
}

// ------------------------------------------------------------------ pañal

export type DiaperLogResult = {
  action: 'logged' | 'already_logged'
  id: string
  changed_at: string
}

/**
 * Registra un pañal AHORA (hora del servidor: la pantalla no tiene reloj
 * confiable hasta su primera lectura de estado, y un pañal del pasado se carga
 * desde la app).
 *
 * Idempotente por `id`: el insert es ON CONFLICT (id) DO NOTHING, el mismo
 * mecanismo que el replay de la cola. Si el wifi del cuarto corta la respuesta
 * y la pantalla reintenta con el mismo id, no hay un segundo pañal.
 *
 * Un id que ya existe pero es de OTRO bebé (o de otra familia) no es "ya
 * estaba": el ON CONFLICT no lo distingue solo, así que se relee la fila por
 * id + baby_id y, si no aparece, es 409 — y la fila ajena no se toca.
 */
export async function logDiaper(
  db: SupabaseClient,
  babyId: string,
  type: DiaperType,
  id: string | undefined,
  now: Date = new Date(),
): Promise<DiaperLogResult | DeviceFailure> {
  const rowId = id ?? randomUUID()
  const changedAt = now.toISOString()

  const inserted = await db
    .from('diaper_changes')
    .upsert(
      { id: rowId, baby_id: babyId, diaper_type: type, changed_at: changedAt, logged_by: null },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id, changed_at')
  if (inserted.error) return { status: 500, error: inserted.error.message }
  if (inserted.data && inserted.data.length > 0) {
    return { action: 'logged', id: rowId, changed_at: inserted.data[0].changed_at as string }
  }

  const existing = await db
    .from('diaper_changes')
    .select('id, changed_at')
    .eq('id', rowId)
    .eq('baby_id', babyId)
    .maybeSingle()
  if (existing.error) return { status: 500, error: existing.error.message }
  if (!existing.data) return { status: 409, error: 'this id belongs to another entry' }
  return { action: 'already_logged', id: rowId, changed_at: existing.data.changed_at as string }
}

// ------------------------------------------------------------------ estado

export type DeviceStatus = {
  now: string
  baby: { name: string }
  nursing: { side: Side; started_at: string } | null
  sleep: { started_at: string } | null
  /** El fin de la última comida TERMINADA, de cualquier tipo. */
  last_feeding_end: string | null
  /** `null` con una lactancia corriendo o sin ninguna comida: no se afirma lo que no se sabe. */
  feed_due: { due_at: string; overdue: boolean } | null
  last_diaper: { at: string; type: DiaperType } | null
}

/**
 * Lo que la pantalla necesita para pintar su parte de arriba, ya resuelto acá
 * para que el firmware no reimplemente reglas de la app.
 *
 * `last_feeding_end` y `feed_due` salen de `lastFeedingEnd` / `dueFrom`
 * (lib/schedule.ts) con el umbral de `family_settings`: los mismos que usan el
 * countdown de /dashboard y el aviso push. Si la pantalla y el teléfono dijeran
 * cosas distintas, sería un bug.
 *
 * Solo hace falta la ÚLTIMA fila de cada cosa, así que cada query es un
 * `order … limit 1` en vez de una ventana de tiempo.
 *
 * Qué expone: el nombre del bebé y horarios de lactancia, sueño, comida y pañal.
 * Nada de crecimiento, turnos médicos, notas ni nombres de los padres.
 */
export async function readDeviceStatus(
  db: SupabaseClient,
  familyId: string,
  babyId: string,
  now: Date = new Date(),
): Promise<DeviceStatus | DeviceFailure> {
  const [babyRes, settingsRes, feedRes, openNurseRes, lastNurseRes, sleepRes, diaperRes] =
    await Promise.all([
      db.from('babies').select('name').eq('id', babyId).maybeSingle(),
      db
        .from('family_settings')
        .select('feed_threshold_minutes')
        .eq('family_id', familyId)
        .maybeSingle(),
      db
        .from('feedings')
        .select('id, fed_at, feeding_type, amount_ml, notes')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('fed_at', { ascending: false })
        .limit(1),
      db
        .from('nursing_sessions')
        .select('id, side, started_at, ended_at')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1),
      db
        .from('nursing_sessions')
        .select('id, side, started_at, ended_at')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(1),
      db
        .from('sleep_sessions')
        .select('started_at')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1),
      db
        .from('diaper_changes')
        .select('changed_at, diaper_type')
        .eq('baby_id', babyId)
        .is('voided_at', null)
        .order('changed_at', { ascending: false })
        .limit(1),
    ])
  for (const r of [
    babyRes,
    settingsRes,
    feedRes,
    openNurseRes,
    lastNurseRes,
    sleepRes,
    diaperRes,
  ]) {
    if (r.error) return { status: 500, error: r.error.message }
  }
  if (!babyRes.data) return { status: 404, error: 'baby not found' }

  const feedThreshold =
    (settingsRes.data?.feed_threshold_minutes as number | undefined) ??
    DEFAULT_FAMILY_SETTINGS.feed_threshold_minutes

  const feedings = (feedRes.data ?? []) as Feeding[]
  const open = (openNurseRes.data ?? []) as NursingSession[]
  const ended = (lastNurseRes.data ?? []) as NursingSession[]

  // Con una sesión abierta, lastFeedingEnd dice `running` y dueFrom devuelve
  // null: es la misma regla que la tarjeta de Today.
  const withOpen = lastFeedingEnd(feedings, [...open, ...ended])
  const due: DueState | null = dueFrom(withOpen, feedThreshold, now.getTime())
  // La última comida TERMINADA, aunque ahora esté comiendo: la pantalla la
  // muestra cuando la sesión abierta se cierre sin esperar otra lectura.
  const lastEnded = lastFeedingEnd(feedings, ended)

  const nurse = open[0]
  const sleep = (sleepRes.data ?? [])[0] as { started_at: string } | undefined
  const diaper = (diaperRes.data ?? [])[0] as
    { changed_at: string; diaper_type: DiaperType } | undefined

  return {
    now: now.toISOString(),
    baby: { name: babyRes.data.name as string },
    nursing: nurse ? { side: nurse.side, started_at: nurse.started_at } : null,
    sleep: sleep ? { started_at: sleep.started_at } : null,
    last_feeding_end: lastEnded?.endedAt ?? null,
    feed_due: due ? { due_at: due.dueAt, overdue: due.overdue } : null,
    last_diaper: diaper ? { at: diaper.changed_at, type: diaper.diaper_type } : null,
  }
}
