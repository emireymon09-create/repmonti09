/**
 * Las queries de servidor del calendario. SOLO route handlers
 * (app/api/calendar/*). Nunca un archivo `'use client'`.
 *
 * POR QUÉ NO VIVE EN lib/db.ts — y por qué esto no rompe la regla §5.3
 * -------------------------------------------------------------------
 * `lib/db.ts` es `'use client'` (primera línea del archivo) y corre con el
 * cliente anon del navegador. El feed .ics lo pide un cliente de calendario:
 * **sin sesión, sin cookies, sin RLS que lo ampare**, identificado solo por un
 * token en la URL. Eso no puede pasar por ahí.
 *
 * Es exactamente el mismo caso que ya se acordó para el push el 22 sep 2026
 * (CLAUDE.md §5.3): `lib/push/server.ts` existe por la misma razón. La regla
 * de fondo se mantiene entera — **las rutas siguen sin armar una query**:
 * `app/api/calendar/[token]/route.ts` y `app/api/calendar/feed/route.ts` solo
 * llaman acá. En la fase 2 hay tres archivos que editar en vez de uno.
 *
 * DOS CLIENTES, LOS DOS DE AFUERA:
 *   · el feed público  → service_role (no hay sesión que usar), y cada query
 *     lleva la familia que salió del token, explícita.
 *   · crear / rotar    → anon + la sesión del padre (lib/supabaseRoute.ts) ⇒
 *     todo pasa por RLS. Nunca service_role para eso.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildIcs } from '@/lib/calendar/ics'
import { translate } from '@/lib/i18n'
import type { DoctorAppointment } from '@/lib/types'

if (typeof window !== 'undefined') {
  throw new Error('lib/calendar/server.ts is server-only')
}

const PREFIX = 'acal_'
/** 32 bytes en base64url son 43 caracteres. Misma forma que `amd_` (0007). */
const SHAPE = /^acal_[A-Za-z0-9_-]{43}$/

/**
 * sha-256, igual que los tokens de dispositivo. No es una contraseña elegida
 * por una persona: son 256 bits aleatorios, no hay diccionario que probar, y
 * un hash rápido permite buscar por índice único.
 */
export function hashCalendarToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** El valor en claro existe una sola vez: acá. La base guarda el hash. */
export function generateCalendarToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashCalendarToken(token) }
}

/** Filtro barato antes de ir a la base: basura con otra forma ni se busca. */
export function looksLikeCalendarToken(value: unknown): value is string {
  return typeof value === 'string' && SHAPE.test(value)
}

/**
 * El token que llega en la URL viene con `.ics` pegado
 * (`/api/calendar/<token>.ics`). Se saca acá y no en la ruta, para que la
 * forma del link esté escrita en un solo lugar.
 */
export function tokenFromSegment(segment: string): string | null {
  const bare = segment.endsWith('.ics') ? segment.slice(0, -4) : segment
  return looksLikeCalendarToken(bare) ? bare : null
}

type Failure = { status: number; error: string }

// ------------------------------------------------------- crear y rotar (RLS)

/**
 * Genera el token del feed de esta familia y devuelve el valor EN CLARO una
 * sola vez. Si ya había uno, lo pisa: `family_id` es PK, así que el link
 * anterior deja de funcionar en el acto. Eso *es* la rotación, y es lo que
 * hace falta si alguien compartió el link sin querer — un token viejo que
 * todavía sirviera no sería una rotación.
 *
 * `db` es el cliente anon con la sesión del padre ⇒ RLS (0012).
 */
export async function issueCalendarToken(
  db: SupabaseClient,
  familyId: string,
  existed: boolean,
): Promise<{ token: string } | Failure> {
  const { token, hash } = generateCalendarToken()
  const now = new Date().toISOString()
  const { error } = await db.from('calendar_feeds').upsert(
    {
      family_id: familyId,
      token_hash: hash,
      // Un reemplazo se anota como tal; el primero no tiene nada que rotar.
      ...(existed ? { rotated_at: now, last_fetched_at: null } : {}),
    },
    { onConflict: 'family_id' },
  )
  if (error) return { status: 500, error: error.message }
  return { token }
}

/**
 * De qué familia es este padre. Con más de una, falla cerrado en vez de
 * adivinar — el mismo criterio que `resolveFamily` en lib/push/server.ts.
 */
export async function resolveFamilyForUser(
  db: SupabaseClient,
  userId: string,
): Promise<{ familyId: string } | Failure> {
  const { data, error } = await db
    .from('family_members')
    .select('family_id')
    .eq('user_id', userId)
    .limit(2)
  if (error) return { status: 500, error: error.message }
  if (!data || data.length === 0) return { status: 409, error: 'you are not in a family yet' }
  if (data.length > 1) return { status: 409, error: 'you are in more than one family' }
  return { familyId: data[0].family_id as string }
}

// ------------------------------------------------------ el feed (sin sesión)

/**
 * El .ics de la familia dueña del token, o `null` si el token no existe.
 *
 * `db` es service_role: no hay sesión con la que consultar, así que el
 * aislamiento no lo hace RLS sino esta función, y por eso **la familia sale
 * del token y las citas se filtran por los bebés de ESA familia**, nunca por
 * algo que venga de la URL más allá del token.
 *
 * Un token que no existe y uno mal formado se tratan igual (`null` → 404):
 * distinguirlos le diría a quien prueba tokens cuáles tienen la forma buena.
 */
export async function calendarFeedFor(
  db: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<{ ics: string } | null> {
  const { data: feed, error } = await db
    .from('calendar_feeds')
    .select('family_id')
    .eq('token_hash', hashCalendarToken(token))
    .maybeSingle()
  if (error || !feed) return null
  const familyId = feed.family_id as string

  const babies = await db.from('babies').select('id').eq('family_id', familyId)
  if (babies.error) return null
  const babyIds = (babies.data ?? []).map((b) => b.id as string)
  if (babyIds.length === 0) {
    // Una familia sin bebés todavía es un calendario válido y vacío, no un
    // 404: un calendario suscrito que empieza a fallar se ve como una cuenta
    // rota.
    return { ics: buildIcs({ name: feedName(), appointments: [], now }) }
  }

  const rows = await db
    .from('doctor_appointments')
    .select('id, title, appointment_type, scheduled_at, doctor_name, notes, completed')
    .in('baby_id', babyIds)
    .order('scheduled_at', { ascending: true })
  if (rows.error) return null

  // "Se leyó por última vez": la única señal de que el link está vivo en algún
  // calendario. Si falla no se cancela el feed — es metadata, no el contenido.
  await db
    .from('calendar_feeds')
    .update({ last_fetched_at: now.toISOString() })
    .eq('family_id', familyId)

  return {
    ics: buildIcs({
      name: feedName(),
      appointments: (rows.data ?? []) as DoctorAppointment[],
      now,
    }),
  }
}

/** Siempre inglés: el feed no tiene sesión ni idioma que leer (CLAUDE.md §5.7). */
function feedName(): string {
  return translate('en', 'calendar.feedName')
}
