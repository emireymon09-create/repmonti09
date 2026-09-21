import { createHash, randomBytes } from 'node:crypto'

/**
 * Tokens por dispositivo: lo que reemplaza a NUC_DEVICE_SECRET y
 * QUICK_TOGGLE_SECRET (hallazgos C1 y C2 de
 * docs/auditorias/2026-09-20-auditoria-inicial.md).
 *
 * Puro y sin imports con alias `@/`: lo usan tanto el servidor como
 * scripts/device-token.mts, que corre con Node pelado.
 *
 * Por qué sha-256 y no bcrypt: el token son 256 bits aleatorios, no una
 * contraseña elegida por una persona. No hay diccionario que probar; un hash
 * rápido alcanza y permite buscar por índice.
 */

export const DEVICE_SCOPES = ['ingest', 'quick_nurse'] as const
export type DeviceScope = (typeof DEVICE_SCOPES)[number]

const PREFIX = 'amd_'
const SHAPE = /^amd_[A-Za-z0-9_-]{43}$/

export function isDeviceScope(value: unknown): value is DeviceScope {
  return DEVICE_SCOPES.some((s) => s === value)
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** El token en claro existe una sola vez: acá, al crearlo. La base guarda el hash. */
export function generateDeviceToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashDeviceToken(token) }
}

/** Filtro barato antes de ir a la base: basura con otra forma ni se busca. */
export function looksLikeDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && SHAPE.test(value)
}

export function readBearer(req: Request): string | null {
  const match = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}
