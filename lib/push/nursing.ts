/**
 * El aviso de toma de pecho larga, en su parte pura: el umbral, qué sesión
 * califica, a quién se le manda y qué dice. Sin red ni base, para poder
 * probarlo bajo cuatro timezones (tests/unit/push.test.ts). Lo que
 * toca la base y el servicio de push vive en lib/push/server.ts.
 */

import { translate, type Lang } from '@/lib/i18n'
import type { Side } from '@/lib/types'

/** A partir de cuántos minutos abierta una toma de pecho se avisa. */
export const LONG_NURSING_MINUTES = 30
export const LONG_NURSING_MS = LONG_NURSING_MINUTES * 60_000

/**
 * Cuánto espera el servicio de push a un teléfono apagado o sin señal antes de
 * tirar el aviso. Una hora: pasado eso, "la toma lleva 30 min" ya no dice
 * nada útil.
 */
export const LONG_NURSING_TTL_SECONDS = 60 * 60

/**
 * El instante de corte: una sesión iniciada en él o antes califica (el umbral
 * es inclusivo, "≥ 30 min"). Es lo que usa el `update … returning` del check.
 */
export function longNursingCutoff(now: Date, thresholdMs: number = LONG_NURSING_MS): string {
  return new Date(now.getTime() - thresholdMs).toISOString()
}

export type NursingCandidate = {
  started_at: string
  ended_at: string | null
  voided_at: string | null
  long_alert_sent_at: string | null
}

/**
 * La misma regla que el `where` del check, escrita una vez en claro: abierta,
 * no borrada, sin aviso previo, y con al menos el umbral encima.
 */
export function isLongNursing(
  s: NursingCandidate,
  now: Date,
  thresholdMs: number = LONG_NURSING_MS,
): boolean {
  if (s.ended_at !== null || s.voided_at !== null || s.long_alert_sent_at !== null) return false
  return Date.parse(s.started_at) <= Date.parse(longNursingCutoff(now, thresholdMs))
}

/** Minutos enteros desde el inicio (nunca negativos: un reloj adelantado no da "-1 min"). */
export function minutesSince(startedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 60_000))
}

export type PushPayload = {
  title: string
  body: string
  /** La notificación con el mismo tag reemplaza a la anterior: un duplicado no suma otra. */
  tag: string
  url: string
}

export type LongNursingSession = {
  id: string
  side: Side
  started_at: string
  babyName: string
}

export function nursingAlertTag(sessionId: string): string {
  return `nursing-long-${sessionId}`
}

/**
 * Header `Topic` del Web Push (RFC 8030 §5.4): el servicio de push reemplaza un
 * mensaje todavía no entregado que tenga el mismo. Máximo 32 caracteres
 * base64url: el uuid sin guiones son exactamente 32 hex.
 */
export function nursingAlertTopic(sessionId: string): string {
  return sessionId.replace(/-/g, '').toLowerCase()
}

export function nursingAlertPayload(
  lang: Lang,
  session: LongNursingSession,
  now: Date,
): PushPayload {
  const minutes = minutesSince(session.started_at, now)
  return {
    title: translate(lang, 'push.nursingLong.title', { minutes }),
    body: translate(lang, 'push.nursingLong.body', {
      name: session.babyName,
      side: translate(lang, `side.${session.side}`),
      minutes,
    }),
    tag: nursingAlertTag(session.id),
    url: '/dashboard',
  }
}

export type StoredSubscription = {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  lang: string
}

/**
 * A quién se le manda: una vez por endpoint (dos filas del mismo navegador no
 * son dos avisos), solo a quien SIGUE siendo miembro de la familia (una fila de
 * alguien que salió de la familia no recibe nada), y solo a endpoints que
 * pasan `allowed` (lib/push/endpoint.ts: sin eso, una fila escrita a mano
 * convierte al servidor en un cliente HTTP de cualquier URL). Gana la fila más
 * reciente si se repite el endpoint: tiene el idioma y las claves al día.
 */
export function pickRecipients<T extends StoredSubscription & { updated_at?: string }>(
  subscriptions: readonly T[],
  memberUserIds: readonly string[],
  allowed: (endpoint: string) => boolean,
): { recipients: T[]; skipped: number } {
  const members = new Set(memberUserIds)
  const byEndpoint = new Map<string, T>()
  let skipped = 0
  for (const s of subscriptions) {
    if (!members.has(s.user_id) || !allowed(s.endpoint)) {
      skipped += 1
      continue
    }
    const seen = byEndpoint.get(s.endpoint)
    if (!seen || (s.updated_at ?? '') > (seen.updated_at ?? '')) byEndpoint.set(s.endpoint, s)
  }
  return { recipients: [...byEndpoint.values()], skipped }
}

/** El idioma guardado de una suscripción; cualquier otra cosa, inglés. */
export function subscriptionLang(value: string): Lang {
  return value === 'es' ? 'es' : 'en'
}
