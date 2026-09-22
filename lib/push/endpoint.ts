/**
 * Qué suscripción push se acepta. Puro (sin red, sin base): lo usan la ruta
 * que guarda la suscripción, el check que manda los avisos, y los tests.
 *
 * Por qué una lista de hosts y no "cualquier https": el servidor hace un POST
 * a `endpoint`. Un endpoint elegido por quien sea (la fila se puede escribir
 * directo por PostgREST con la sesión de un padre, sin pasar por la ruta) es
 * un SSRF: el servidor golpeando una URL interna. Por eso se valida al guardar
 * Y al mandar. Los hosts son los de los servicios de push de los navegadores
 * que existen hoy; un navegador con otro servicio no puede activar avisos
 * hasta que se lo agregue acá.
 */

export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Samsung Internet, Brave, Opera
  'android.googleapis.com', // GCM viejo, todavía en suscripciones antiguas de Chrome
  // Chromium sin claves de API de Google (y algunos derivados): FCM, pero con
  // este host. Visto el 22 sep 2026 en el Chromium de Playwright
  // (https://jmt17.google.com/fcm/send/…). Exacto: no todo google.com.
  'jmt17.google.com',
  'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
  'push.apple.com', // Safari en macOS e iOS instalado (web.push.apple.com)
  'notify.windows.com', // Edge en Windows (*.notify.windows.com)
] as const

export const PUSH_LANGS = ['en', 'es'] as const
export type PushLang = (typeof PUSH_LANGS)[number]

const MAX_ENDPOINT = 2048

/**
 * `extraOrigins`: orígenes exactos que se aceptan además de la lista, SOLO
 * para el servicio de push falso de los tests (lib/push/server.ts, que lo
 * permite únicamente con NODE_ENV === 'test'). Igual tienen que ser https.
 */
export function isAllowedPushEndpoint(
  value: unknown,
  extraOrigins: readonly string[] = [],
): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  if (extraOrigins.includes(url.origin)) return true
  if (url.port !== '') return false
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

const B64URL = /^[A-Za-z0-9_-]+$/

/** base64url (con o sin '=') que decodifica a exactamente `bytes` bytes. */
function b64urlBytes(value: unknown, bytes: number): Uint8Array | null {
  if (typeof value !== 'string') return null
  const bare = value.replace(/=+$/, '')
  if (!B64URL.test(bare) || bare.length !== Math.ceil((bytes * 4) / 3)) return null
  const decoded = Buffer.from(bare, 'base64url')
  return decoded.length === bytes ? decoded : null
}

export type SubscriptionInput = {
  endpoint: string
  p256dh: string
  auth: string
  lang: PushLang
  babyId: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * El body de POST /api/push/subscription: lo que da `PushSubscription.toJSON()`
 * más `lang` y, opcional, `baby_id` (para saber de qué familia es cuando el
 * padre está en más de una).
 */
export function parseSubscriptionBody(
  body: unknown,
  extraOrigins: readonly string[] = [],
): { ok: SubscriptionInput } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid json' }
  const b = body as Record<string, unknown>
  if (!isAllowedPushEndpoint(b.endpoint, extraOrigins)) {
    return { error: 'endpoint must be an https URL of a known push service' }
  }
  const keys = (b.keys ?? {}) as Record<string, unknown>
  // p256dh: punto P-256 sin comprimir (0x04 || X || Y). auth: 16 bytes.
  const p256dh = b64urlBytes(keys.p256dh, 65)
  if (!p256dh || p256dh[0] !== 0x04) return { error: 'keys.p256dh must be a P-256 public key' }
  if (!b64urlBytes(keys.auth, 16)) return { error: 'keys.auth must be 16 bytes' }
  const lang = b.lang ?? 'en'
  if (!PUSH_LANGS.includes(lang as PushLang)) return { error: 'lang must be en or es' }
  if (
    b.baby_id !== undefined &&
    b.baby_id !== null &&
    !(typeof b.baby_id === 'string' && UUID.test(b.baby_id))
  ) {
    return { error: 'baby_id must be a uuid' }
  }
  return {
    ok: {
      endpoint: b.endpoint,
      p256dh: (keys.p256dh as string).replace(/=+$/, ''),
      auth: (keys.auth as string).replace(/=+$/, ''),
      lang: lang as PushLang,
      babyId: typeof b.baby_id === 'string' ? b.baby_id.toLowerCase() : null,
    },
  }
}

/** El body de DELETE: solo el endpoint, que es lo que identifica al dispositivo. */
export function parseEndpointBody(
  body: unknown,
  extraOrigins: readonly string[] = [],
): { ok: string } | { error: string } {
  const endpoint =
    body && typeof body === 'object' ? (body as { endpoint?: unknown }).endpoint : undefined
  return isAllowedPushEndpoint(endpoint, extraOrigins)
    ? { ok: endpoint }
    : { error: 'endpoint must be an https URL of a known push service' }
}
