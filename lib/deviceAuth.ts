import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hashDeviceToken,
  looksLikeDeviceToken,
  readBearer,
  type DeviceScope,
} from '@/lib/deviceTokens'

/**
 * Autenticación y autorización de los dos endpoints de dispositivo
 * (`/api/ingest` y `/api/quick/nurse`). SOLO SERVIDOR: recibe el cliente
 * service_role del route handler.
 *
 * Quién entra: un token de `device_tokens` (0007), buscado por su hash, no
 * revocado, con el scope del endpoint. A qué bebé escribe: el que resuelva
 * resolveBabyForDevice(), que nunca sale de la familia del token. Eso es lo que
 * cierra C1 y C2 (docs/auditorias/2026-09-20-auditoria-inicial.md).
 *
 * Por qué ya no hay comparación en tiempo constante: no se compara un secreto,
 * se busca un hash por índice. Lo que un atacante podría medir es el tiempo de
 * buscar el sha-256 de SU intento, que no le dice nada del token real.
 *
 * Lo que sigue sin resolver: el techo de intentos vive en la memoria de este
 * proceso (varias instancias = varios contadores), y no hay idempotencia.
 * Ver proposals/device-tokens-and-idempotency.md.
 */

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 20
const attempts = new Map<string, { count: number; resetAt: number }>()

export type DeviceIdentity = {
  tokenId: string
  familyId: string
  babyId: string | null
  scopes: DeviceScope[]
}

export type DeviceFailure = {
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500
  error: string
}

export function isDeviceFailure(value: object): value is DeviceFailure {
  return 'error' in value
}

export function deviceFailureResponse(f: DeviceFailure): NextResponse {
  return NextResponse.json({ error: f.error }, { status: f.status })
}

function allowAttempt(req: Request): boolean {
  const key = req.headers.get('x-forwarded-for') ?? 'local'
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= MAX_ATTEMPTS
}

export async function authenticateDevice(
  req: Request,
  supabase: SupabaseClient,
  scope: DeviceScope,
): Promise<DeviceIdentity | DeviceFailure> {
  // El techo va ANTES de la base: la fuerza bruta no llega ni a la query.
  if (!allowAttempt(req)) return { status: 429, error: 'too many requests' }

  const token = readBearer(req)
  if (!looksLikeDeviceToken(token)) return { status: 401, error: 'unauthorized' }

  const { data, error } = await supabase
    .from('device_tokens')
    .select('id, family_id, baby_id, scopes')
    .eq('token_hash', hashDeviceToken(token))
    .is('revoked_at', null)
    .maybeSingle()
  if (error) return { status: 500, error: error.message }
  if (!data) return { status: 401, error: 'unauthorized' }
  if (!data.scopes.includes(scope)) {
    return { status: 403, error: `this token does not have the ${scope} scope` }
  }

  // Best effort: que un fallo al anotar el uso no tumbe el evento.
  await supabase
    .from('device_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)

  return { tokenId: data.id, familyId: data.family_id, babyId: data.baby_id, scopes: data.scopes }
}

/**
 * El bebé sobre el que un dispositivo puede escribir. Nunca sale de la familia
 * del token; con un token clavado, nunca sale de ese bebé. Cuando no alcanza
 * la información para decidir, falla cerrado en vez de adivinar.
 */
export async function resolveBabyForDevice(
  supabase: SupabaseClient,
  identity: DeviceIdentity,
  requested: unknown,
): Promise<{ babyId: string } | DeviceFailure> {
  if (requested !== undefined) {
    if (!isUuid(requested)) return { status: 400, error: 'baby_id must be a uuid' }
    if (identity.babyId !== null) {
      return requested === identity.babyId
        ? { babyId: requested }
        : { status: 403, error: 'this token is pinned to another baby' }
    }
    const { data, error } = await supabase
      .from('babies')
      .select('id')
      .eq('id', requested)
      .eq('family_id', identity.familyId)
      .maybeSingle()
    if (error) return { status: 500, error: error.message }
    return data
      ? { babyId: requested }
      : { status: 403, error: "baby_id is not in this token's family" }
  }

  if (identity.babyId !== null) return { babyId: identity.babyId }

  // limit(2): alcanza para saber si hay ambigüedad.
  const { data, error } = await supabase
    .from('babies')
    .select('id')
    .eq('family_id', identity.familyId)
    .order('created_at', { ascending: true })
    .limit(2)
  if (error) return { status: 500, error: error.message }
  if (!data || data.length === 0) return { status: 404, error: 'no baby set up in this family yet' }
  if (data.length > 1) {
    return {
      status: 409,
      error: 'this family has more than one baby — send baby_id, or pin the token to one baby',
    }
  }
  return { babyId: data[0].id }
}

/** Solo para los tests: el contador es global al proceso y se arrastra. */
export function resetDeviceRateLimit(): void {
  attempts.clear()
}

/** Un body que no es JSON es un 400 del cliente, no un 500 nuestro. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Un instante ISO dentro de una ventana sensata: ni el año 1900 ni el 3000. */
export function isSaneInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const t = Date.parse(value)
  if (Number.isNaN(t)) return false
  const now = Date.now()
  return t > now - 365 * 86_400_000 && t < now + 86_400_000
}
