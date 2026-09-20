import { timingSafeEqual } from 'node:crypto'

/**
 * Autenticación y validación de los dos endpoints de dispositivo
 * (`/api/ingest` y `/api/quick/nurse`).
 *
 * Lo que arregla respecto de comparar con `!==`:
 *   · comparación en tiempo constante, para no filtrar el secreto por timing
 *   · un techo de intentos por minuto, para que un secreto estático no se
 *     pueda probar a fuerza bruta
 *
 * Lo que NO arregla, y hay que saberlo: el secreto sigue siendo uno solo y
 * compartido, y el contador vive en la memoria de ESTE proceso. En un deploy
 * con varias instancias cada una cuenta por su lado, y un arranque en frío lo
 * resetea. Es una molestia para el atacante, no una barrera. El arreglo de
 * fondo (token hasheado por dispositivo + idempotencia) es cambio de schema y
 * vive en proposals/device-tokens-and-idempotency.md.
 */

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 20
const attempts = new Map<string, { count: number; resetAt: number }>()

function constantTimeEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Igual gastamos el tiempo de una comparación, para no filtrar el largo.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export type DeviceAuthResult = 'ok' | 'unauthorized' | 'rate_limited'

export function checkDeviceSecret(req: Request, expected: string | undefined): DeviceAuthResult {
  const key = req.headers.get('x-forwarded-for') ?? 'local'
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
  } else {
    entry.count += 1
    if (entry.count > MAX_ATTEMPTS) return 'rate_limited'
  }

  const given = req.headers.get('x-device-secret')
  if (!given || !expected) return 'unauthorized'
  return constantTimeEquals(given, expected) ? 'ok' : 'unauthorized'
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
