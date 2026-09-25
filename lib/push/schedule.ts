/**
 * Los tres avisos nuevos, en su parte PURA: cuándo corresponde mandarlos y qué
 * dicen. Sin red ni base, igual que lib/push/nursing.ts — lo que toca la base
 * y el servicio de push vive en lib/push/server.ts.
 *
 *   · comida vencida  — pasó el umbral de la familia sin un evento nuevo
 *   · siesta vencida  — lo mismo, con el umbral de siesta
 *   · cita en 24 h    — recordatorio, una sola vez por cita
 *
 * POR QUÉ LOS DOS PRIMEROS SE REPITEN Y EL TERCERO NO
 * ---------------------------------------------------
 * "La cita es mañana a las 10" se dice una vez: repetirlo cada media hora
 * durante 24 horas es spam, y la cita no se mueve. "Hace tres horas y media
 * que no come" sí cambia con el tiempo, y si nadie lo atendió a los 30 minutos
 * el aviso sigue siendo verdad. Por eso el primero se marca por fila
 * (`doctor_appointments.reminder_sent_at`, 0012, mismo patrón que
 * `nursing_sessions.long_alert_sent_at` de 0009) y los otros dos llevan una
 * marca por familia que se pisa (`family_settings.feed_alert_sent_at` /
 * `nap_alert_sent_at`).
 */

import { translate, type Lang } from '@/lib/i18n'
import type { PushPayload } from '@/lib/push/nursing'

/** Cada cuánto se repite un aviso que sigue sin resolverse. */
export const REPEAT_MINUTES = 30
export const REPEAT_MS = REPEAT_MINUTES * 60_000

/**
 * Cuánto espera el servicio de push antes de tirarlo. Media hora: pasado eso
 * ya salió (o va a salir) el siguiente, y un aviso viejo de "hace 3 h que no
 * come" contradice al nuevo.
 */
export const SCHEDULE_TTL_SECONDS = REPEAT_MINUTES * 60

/** Y el de la cita aguanta hasta la cita misma. */
export const APPOINTMENT_TTL_SECONDS = 12 * 60 * 60

export type AlertDecision = {
  send: boolean
  /** Por qué no, cuando no. Solo para los tests y el log; no va a la pantalla. */
  reason?: 'notOverdue' | 'tooSoon'
}

/**
 * La regla de repetición, escrita una sola vez.
 *
 * Se avisa si está vencido **y** alguna de estas:
 *   · nunca se avisó;
 *   · el último aviso es de hace ≥ 30 min;
 *   · **hubo un evento nuevo después del último aviso** — eso reinicia el
 *     ciclo. Sin esta tercera condición, una toma a las 14:00 seguida de un
 *     vencimiento a las 17:00 podría quedarse callada porque a las 16:50 se
 *     había avisado por el ciclo ANTERIOR. Es el caso que se paga caro: el
 *     aviso que no llega.
 */
export function shouldAlert(params: {
  overdue: boolean
  /** `family_settings.feed_alert_sent_at` / `nap_alert_sent_at`. */
  lastAlertAt: string | null
  /** El fin del último evento: si es posterior al aviso, empezó un ciclo nuevo. */
  lastEventAt: string | null
  now: number
}): AlertDecision {
  const { overdue, lastAlertAt, lastEventAt, now } = params
  if (!overdue) return { send: false, reason: 'notOverdue' }
  if (!lastAlertAt) return { send: true }

  const alerted = Date.parse(lastAlertAt)
  if (Number.isNaN(alerted)) return { send: true }
  if (now - alerted >= REPEAT_MS) return { send: true }

  const event = lastEventAt ? Date.parse(lastEventAt) : NaN
  if (!Number.isNaN(event) && event > alerted) return { send: true }

  return { send: false, reason: 'tooSoon' }
}

// ---------------------------------------------------------------- payloads

/** Un aviso de comida por familia a la vez: el tag hace que el nuevo reemplace al viejo. */
export function overdueFeedingTag(familyId: string): string {
  return `feeding-overdue-${familyId}`
}

export function overdueNapTag(familyId: string): string {
  return `nap-overdue-${familyId}`
}

export function appointmentTag(appointmentId: string): string {
  return `appointment-${appointmentId}`
}

/** El uuid sin guiones son 32 hex: el máximo que admite el header `Topic` (RFC 8030 §5.4). */
export function scheduleTopic(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

export function overdueFeedingPayload(
  lang: Lang,
  params: { familyId: string; babyName: string; minutesOverdue: number },
): PushPayload {
  return {
    title: translate(lang, 'push.feedingOverdue.title'),
    body: translate(lang, 'push.feedingOverdue.body', {
      name: params.babyName,
      minutes: params.minutesOverdue,
    }),
    tag: overdueFeedingTag(params.familyId),
    url: '/dashboard',
  }
}

export function overdueNapPayload(
  lang: Lang,
  params: { familyId: string; babyName: string; minutesOverdue: number },
): PushPayload {
  return {
    title: translate(lang, 'push.napOverdue.title'),
    body: translate(lang, 'push.napOverdue.body', {
      name: params.babyName,
      minutes: params.minutesOverdue,
    }),
    tag: overdueNapTag(params.familyId),
    url: '/dashboard',
  }
}

export function appointmentPayload(
  lang: Lang,
  params: { id: string; title: string; hours: number },
): PushPayload {
  return {
    title: translate(lang, 'push.appointment.title'),
    body: translate(lang, 'push.appointment.body', {
      title: params.title,
      hours: params.hours,
    }),
    tag: appointmentTag(params.id),
    url: '/appointments',
  }
}
