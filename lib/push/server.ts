import type { Agent } from 'node:https'
import webpush, { WebPushError } from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeviceIdentity } from '@/lib/deviceAuth'
import { isAllowedPushEndpoint, type SubscriptionInput } from '@/lib/push/endpoint'
import {
  LONG_NURSING_TTL_SECONDS,
  longNursingCutoff,
  nursingAlertPayload,
  nursingAlertTopic,
  pickRecipients,
  subscriptionLang,
  type PushPayload,
  type StoredSubscription,
} from '@/lib/push/nursing'
import type { Side } from '@/lib/types'

/**
 * Push, del lado del SERVIDOR. Solo lo importan route handlers
 * (app/api/push/*). Nunca un 'use client': lee VAPID_PRIVATE_KEY.
 *
 * Por qué no vive en lib/db.ts: lib/db.ts es 'use client' (corre en el
 * navegador, con la cola offline). Esto corre en el servidor, con dos
 * clientes distintos según la ruta, y los dos se le pasan de afuera:
 *   · /api/push/subscription → cliente anon + sesión del padre (cookies) ⇒ RLS.
 *   · /api/push/nursing-check → cliente service_role, ya autenticado el
 *     dispositivo por lib/deviceAuth.ts, y siempre filtrado por SU familia.
 * La regla de CLAUDE.md §5.3 se mantiene en espíritu: ninguna ruta arma una
 * query; todas están acá.
 */

if (typeof window !== 'undefined') {
  throw new Error('lib/push/server.ts is server-only')
}

// ---------------------------------------------------------------- transporte

type Transport = {
  /** Orígenes https aceptados además de los servicios de push reales. */
  extraOrigins: readonly string[]
  /** Agente TLS (para confiar en el certificado del servicio falso). */
  agent?: Agent
}

const REAL: Transport = { extraOrigins: [] }
let transport: Transport = REAL

/**
 * SOLO TESTS. Deja apuntar a un servicio de push falso en 127.0.0.1 con su
 * certificado propio (tests/integration/push.test.ts). Tira fuera de
 * NODE_ENV === 'test': en desarrollo y en producción no hay forma de agregar
 * un host.
 */
export function setPushTransportForTests(next: Transport | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setPushTransportForTests is test-only')
  transport = next ?? REAL
}

export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  return isAllowedPushEndpoint(endpoint, transport.extraOrigins)
}

export function pushExtraOrigins(): readonly string[] {
  return transport.extraOrigins
}

type Vapid = { subject: string; publicKey: string; privateKey: string }

/** null si falta alguna: el check no marca nada sin poder mandar. */
export function vapidFromEnv(): Vapid | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) return null
  return { subject, publicKey, privateKey }
}

const SEND_TIMEOUT_MS = 10_000

type SendOutcome = 'ok' | 'gone' | 'failed'

async function sendOne(
  sub: StoredSubscription,
  payload: PushPayload,
  topic: string,
  vapid: Vapid,
): Promise<SendOutcome> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: vapid,
        TTL: LONG_NURSING_TTL_SECONDS,
        urgency: 'high',
        topic,
        timeout: SEND_TIMEOUT_MS,
        ...(transport.agent ? { agent: transport.agent } : {}),
      },
    )
    return 'ok'
  } catch (e) {
    // 404/410: el servicio dice que esa suscripción ya no existe (la app se
    // desinstaló, se revocó el permiso). Cualquier otra cosa es 'failed'; si a
    // la sesión no le llegó a nadie, runNursingCheck le saca la marca y el
    // próximo check reintenta.
    if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) return 'gone'
    return 'failed'
  }
}

// ---------------------------------------------------------------- suscripción

type Failure = { status: number; error: string }

/**
 * Guarda (o actualiza) la suscripción de este dispositivo para este padre.
 * `db` es el cliente anon con la sesión del padre: todo pasa por RLS
 * (0009 — solo sus filas, solo de su familia).
 */
export async function saveSubscription(
  db: SupabaseClient,
  userId: string,
  input: SubscriptionInput,
): Promise<{ familyId: string } | Failure> {
  const family = await resolveFamily(db, userId, input.babyId)
  if ('error' in family) return family
  const { error } = await db.from('push_subscriptions').upsert(
    {
      family_id: family.familyId,
      user_id: userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      lang: input.lang,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,endpoint' },
  )
  if (error) return { status: 500, error: error.message }
  return { familyId: family.familyId }
}

/** Borra la suscripción de ese endpoint, si es de este padre. Idempotente. */
export async function deleteSubscription(
  db: SupabaseClient,
  userId: string,
  endpoint: string,
): Promise<{ deleted: number } | Failure> {
  const { data, error } = await db
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .select('id')
  if (error) return { status: 500, error: error.message }
  return { deleted: data?.length ?? 0 }
}

/**
 * De qué familia es la suscripción. Con `babyId`: la de ese bebé (RLS solo lo
 * deja ver si el padre es de esa familia). Sin él: la única familia del padre;
 * con más de una, falla cerrado en vez de adivinar.
 */
async function resolveFamily(
  db: SupabaseClient,
  userId: string,
  babyId: string | null,
): Promise<{ familyId: string } | Failure> {
  if (babyId) {
    const { data, error } = await db
      .from('babies')
      .select('family_id')
      .eq('id', babyId)
      .maybeSingle()
    if (error) return { status: 500, error: error.message }
    if (!data) return { status: 403, error: 'baby_id is not in your family' }
    return { familyId: data.family_id }
  }
  const { data, error } = await db
    .from('family_members')
    .select('family_id')
    .eq('user_id', userId)
    .limit(2)
  if (error) return { status: 500, error: error.message }
  if (!data || data.length === 0) return { status: 409, error: 'you are not in a family yet' }
  if (data.length > 1)
    return { status: 409, error: 'you are in more than one family — send baby_id' }
  return { familyId: data[0].family_id }
}

// ---------------------------------------------------------------- el check

export type NursingCheckResult = {
  /** Suscripciones a las que se les puede mandar (dedupe por endpoint, solo miembros). */
  subscriptions: number
  /**
   * Sesiones que este check marcó como avisadas. La marca es exclusiva: dos
   * checks a la vez, una sola la toma. No es para siempre — si el aviso no le
   * llegó a nadie se le saca (`released`) y el próximo check la vuelve a
   * marcar; lo que nunca pasa es que se avise dos veces por un aviso entregado.
   */
  marked: number
  sent: number
  failed: number
  /** Suscripciones borradas porque el servicio de push las dio por muertas (404/410). */
  removed: number
  /** Filas que no se usaron: de alguien que ya no es de la familia, o con un endpoint no permitido. */
  skipped: number
  /**
   * Sesiones marcadas por este check a las que no les llegó a NADIE: se les
   * sacó la marca para que el próximo check lo vuelva a intentar.
   */
  released: number
}

/**
 * Para la familia del token (y solo su bebé, si el token está clavado a uno):
 * marca de una vez las tomas de pecho largas y avisa a cada dispositivo
 * suscripto. `db` es service_role — por eso cada query lleva la familia o los
 * bebés de ESA familia explícitos.
 */
export async function runNursingCheck(
  db: SupabaseClient,
  identity: Pick<DeviceIdentity, 'familyId' | 'babyId'>,
  vapid: Vapid,
  now: Date = new Date(),
): Promise<NursingCheckResult | Failure> {
  const result: NursingCheckResult = {
    subscriptions: 0,
    marked: 0,
    sent: 0,
    failed: 0,
    removed: 0,
    skipped: 0,
    released: 0,
  }

  const [subsRes, membersRes] = await Promise.all([
    db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth, lang, updated_at')
      .eq('family_id', identity.familyId),
    db.from('family_members').select('user_id').eq('family_id', identity.familyId),
  ])
  if (subsRes.error) return { status: 500, error: subsRes.error.message }
  if (membersRes.error) return { status: 500, error: membersRes.error.message }

  const { recipients, skipped } = pickRecipients(
    subsRes.data ?? [],
    (membersRes.data ?? []).map((m) => m.user_id as string),
    pushEndpointAllowed,
  )
  result.subscriptions = recipients.length
  result.skipped = skipped
  // Sin nadie a quien avisar no se marca nada: si alguien activa los avisos
  // dentro de un rato, esa toma todavía le llega.
  if (recipients.length === 0) return result

  let babiesQuery = db.from('babies').select('id, name').eq('family_id', identity.familyId)
  if (identity.babyId) babiesQuery = babiesQuery.eq('id', identity.babyId)
  const babiesRes = await babiesQuery
  if (babiesRes.error) return { status: 500, error: babiesRes.error.message }
  const names = new Map((babiesRes.data ?? []).map((b) => [b.id as string, b.name as string]))
  if (names.size === 0) return result

  // LA marca. Un solo UPDATE con `long_alert_sent_at is null` en el WHERE: si
  // dos checks corren a la vez, Postgres re-evalúa el WHERE del segundo tras el
  // lock de fila y ya no la toma. Un aviso entregado no se manda dos veces;
  // uno que no llegó a nadie devuelve la marca más abajo (`released`).
  const marked = await db
    .from('nursing_sessions')
    .update({ long_alert_sent_at: now.toISOString() })
    .in('baby_id', [...names.keys()])
    .is('ended_at', null)
    .is('voided_at', null)
    .is('long_alert_sent_at', null)
    .lte('started_at', longNursingCutoff(now))
    .select('id, baby_id, side, started_at')
  if (marked.error) return { status: 500, error: marked.error.message }
  const sessions = marked.data ?? []
  result.marked = sessions.length

  const gone = new Set<string>()
  const perSession = await Promise.all(
    sessions.map((s) =>
      Promise.all(
        recipients.map(async (sub) => {
          const payload = nursingAlertPayload(
            subscriptionLang(sub.lang),
            {
              id: s.id as string,
              side: s.side as Side,
              started_at: s.started_at as string,
              babyName: names.get(s.baby_id as string) ?? '',
            },
            now,
          )
          const outcome = await sendOne(sub, payload, nursingAlertTopic(s.id as string), vapid)
          if (outcome === 'gone') gone.add(sub.id)
          return outcome
        }),
      ),
    ),
  )
  const outcomes = perSession.flat()
  result.sent = outcomes.filter((o) => o === 'ok').length
  result.failed = outcomes.filter((o) => o !== 'ok').length

  // La marca se puso ANTES de mandar (es lo que evita el doble aviso). Si a
  // una sesión no le llegó a nadie, se la saca: con un 5xx, un timeout o sin
  // red, el próximo check reintenta; y si todas dieron 404/410, esas
  // suscripciones se borran abajo y no hubo a quién avisar — igual que con 0
  // suscripciones, la sesión queda sin marcar por si alguien activa los
  // avisos. Solo se saca la marca que puso ESTE check (mismo valor): si otro
  // la cambió mientras tanto, no se toca.
  const unsent = sessions.filter((_, i) => !perSession[i].includes('ok'))
  if (unsent.length > 0) {
    const released = await db
      .from('nursing_sessions')
      .update({ long_alert_sent_at: null })
      .in(
        'id',
        unsent.map((s) => s.id as string),
      )
      .in('baby_id', [...names.keys()])
      .eq('long_alert_sent_at', now.toISOString())
      .select('id')
    // Si falla, la sesión queda marcada: se pierde ese aviso, no se duplica.
    result.released = released.error ? 0 : (released.data?.length ?? 0)
  }

  if (gone.size > 0) {
    const del = await db
      .from('push_subscriptions')
      .delete()
      .in('id', [...gone])
      .eq('family_id', identity.familyId)
      .select('id')
    // Si el borrado falla, la próxima vez vuelve a dar 410 y se reintenta.
    result.removed = del.error ? 0 : (del.data?.length ?? 0)
  }
  return result
}
