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
import { decideForbidden, type SendOutcome, type SubscriptionAttempt } from '@/lib/push/retry'
import type { Feeding, NursingSession, Side, SleepSession } from '@/lib/types'
import {
  APPOINTMENT_REMINDER_MS,
  DEFAULT_FAMILY_SETTINGS,
  dueFrom,
  lastFeedingEnd,
  lastNapEnd,
} from '@/lib/schedule'
import {
  APPOINTMENT_TTL_SECONDS,
  SCHEDULE_TTL_SECONDS,
  appointmentPayload,
  overdueFeedingPayload,
  overdueNapPayload,
  scheduleTopic,
  shouldAlert,
} from '@/lib/push/schedule'

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

async function sendOne(
  sub: StoredSubscription,
  payload: PushPayload,
  topic: string,
  vapid: Vapid,
  ttl: number = LONG_NURSING_TTL_SECONDS,
): Promise<SendOutcome> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: vapid,
        TTL: ttl,
        urgency: 'high',
        topic,
        timeout: SEND_TIMEOUT_MS,
        ...(transport.agent ? { agent: transport.agent } : {}),
      },
    )
    return 'ok'
  } catch (e) {
    // 404/410: el servicio dice que esa suscripción ya no existe (la app se
    // desinstaló, se revocó el permiso). Se borra en el acto.
    // 403: "no acepto esta firma VAPID" — ambiguo, y NO se borra acá. Puede ser
    // esta fila (vieja, de otro par de claves) o la VAPID del servidor mal
    // puesta, en cuyo caso van a fallar todas. Lo decide lib/push/retry.ts con
    // el contraste del lote; acá solo se reporta el 403 como tal.
    // Cualquier otra cosa es 'failed'; si a la sesión no le llegó a nadie,
    // runNursingCheck le saca la marca y el próximo check reintenta.
    if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) return 'gone'
    if (e instanceof WebPushError && e.statusCode === 403) return 'forbidden'
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
      // Suscribirse de nuevo son claves nuevas: la racha de 403 que traía esta
      // fila (0010) no dice nada de ellas y empieza de cero.
      consecutive_403: 0,
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
  /**
   * Suscripciones borradas: las que el servicio dio por muertas (404/410) y las
   * que agotaron su racha de 403 con otras del lote recibiendo bien (0010).
   */
  removed: number
  /** Suscripciones que dieron 403 en este chequeo. */
  forbidden: number
  /**
   * TODAS las suscripciones a las que se intentó dieron 403. No se borró
   * ninguna: casi seguro es la VAPID del servidor, no las suscripciones.
   * Queda en el log y en la respuesta para que lo mire una persona.
   */
  vapidSuspect: boolean
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
    forbidden: 0,
    vapidSuspect: false,
    skipped: 0,
    released: 0,
  }

  const [subsRes, membersRes] = await Promise.all([
    db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth, lang, updated_at, consecutive_403')
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

  // Qué hacer con los 403. `perSession` es sesiones × destinatarios; acá se da
  // vuelta a destinatarios × sesiones, que es la unidad que importa: la racha
  // se cuenta POR SUSCRIPCIÓN, no por envío. La regla y el porqué, en
  // lib/push/retry.ts.
  const attempts: SubscriptionAttempt[] = recipients.map((sub, j) => ({
    id: sub.id,
    consecutive403: Number((sub as { consecutive_403?: number }).consecutive_403 ?? 0),
    outcomes: perSession.map((row) => row[j]),
  }))
  const forbidden = decideForbidden(attempts)
  result.forbidden = forbidden.forbidden
  result.vapidSuspect = forbidden.vapidSuspect
  if (forbidden.vapidSuspect) {
    // No es un error de esta corrida: es una configuración que hay que mirar a
    // mano. Se avisa fuerte y NO se borra nada.
    console.warn(
      `[push] every subscription of family ${identity.familyId} was rejected with 403 ` +
        `(${result.forbidden} of ${recipients.length}). Nothing deleted — this looks like a ` +
        `server-side VAPID misconfiguration, not dead subscriptions. Check VAPID_PRIVATE_KEY / ` +
        `NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_SUBJECT.`,
    )
  }

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

  // Un solo borrado para los dos motivos: el servicio las dio por muertas
  // (404/410) o agotaron su racha de 403 mientras otras del lote sí recibían.
  const doomed = new Set([...gone, ...forbidden.drop])
  if (doomed.size > 0) {
    const del = await db
      .from('push_subscriptions')
      .delete()
      .in('id', [...doomed])
      .eq('family_id', identity.familyId)
      .select('id')
    // Si el borrado falla, la próxima vez vuelve a dar 410/403 y se reintenta.
    result.removed = del.error ? 0 : (del.data?.length ?? 0)
  }

  // Las rachas que siguen vivas. Una fila borrada arriba ya no está, así que
  // estos updates no la tocan. Si alguno falla, la racha queda como estaba: se
  // pierde un paso de la cuenta, nunca se borra de más.
  for (const s of forbidden.strike) {
    await db
      .from('push_subscriptions')
      .update({ consecutive_403: s.consecutive403 })
      .eq('id', s.id)
      .eq('family_id', identity.familyId)
  }
  if (forbidden.reset.length > 0) {
    await db
      .from('push_subscriptions')
      .update({ consecutive_403: 0 })
      .in('id', forbidden.reset)
      .eq('family_id', identity.familyId)
  }
  return result
}

// ==================================================== los tres checks nuevos
//
// POR QUÉ VIVEN EN EL MISMO ENDPOINT QUE EL DE TOMA LARGA
// -------------------------------------------------------
// Decisión del 24 sep 2026, con el mismo criterio con que §7.6 eligió
// pg_cron+pg_net sobre Vercel Cron y la caja de la casa:
//
//   · El techo de intentos de lib/deviceAuth.ts es por IP, no por endpoint
//     (20 por minuto, CLAUDE.md §7 pregunta 4). Cuatro endpoints llamados una
//     vez por minuto desde la misma IP gastan 4 de esas 20 en vez de 1, y ese
//     techo ya lo comparten /api/ingest y /api/quick/nurse.
//   · `0011` ya está escrita y en camino a aplicarse en la nube, con el
//     jobname `nursing-check`, la URL en Vault y el token de scope
//     `push_check`. Un endpoint nuevo sería un secreto más en Vault, un job
//     más de pg_cron y otra corrida manual de Luis en producción. Nada de eso
//     hace falta.
//   · `0011` es historia y no se edita (CLAUDE.md §5.2). No hace falta
//     tocarla.
//
// Lo que se paga: el nombre `nursing-check` ya no describe todo lo que hace.
// Queda documentado acá, en el encabezado del handler y en CLAUDE.md §6. Es
// preferible un nombre viejo y anotado a una pieza de infraestructura nueva
// que alguien tiene que aplicar a mano en producción.

export type ScheduleCheckResult = {
  /** Avisos que salieron, por tipo. */
  feeding: number
  nap: number
  appointments: number
  sent: number
  failed: number
  /** Suscripciones que el servicio dio por muertas (404/410) y se borraron. */
  removed: number
  /** No se pudo decidir nada: falta la configuración o no hay a quién avisar. */
  skipped: boolean
}

type Recipient = StoredSubscription

/** Un envío a cada destinatario, en el idioma de cada uno. */
async function deliver(
  recipients: readonly Recipient[],
  build: (lang: ReturnType<typeof subscriptionLang>) => PushPayload,
  topic: string,
  ttl: number,
  vapid: Vapid,
): Promise<{ sent: number; failed: number; gone: string[] }> {
  const gone: string[] = []
  const outcomes = await Promise.all(
    recipients.map(async (sub) => {
      const outcome = await sendOne(sub, build(subscriptionLang(sub.lang)), topic, vapid, ttl)
      if (outcome === 'gone') gone.push(sub.id)
      return outcome
    }),
  )
  return {
    sent: outcomes.filter((o) => o === 'ok').length,
    failed: outcomes.filter((o) => o !== 'ok').length,
    gone,
  }
}

/**
 * Comida vencida, siesta vencida y cita en 24 h, para la familia del token.
 *
 * `db` es service_role, así que —igual que runNursingCheck— cada query lleva
 * la familia o los bebés de ESA familia explícitos: el aislamiento no lo hace
 * RLS acá, lo hace este código.
 *
 * Las decisiones son todas de funciones puras: `dueFrom` y `nextAppointment`
 * (lib/schedule.ts) y `shouldAlert` (lib/push/schedule.ts). Acá solo hay base
 * y red.
 */
export async function runScheduleChecks(
  db: SupabaseClient,
  identity: Pick<DeviceIdentity, 'familyId' | 'babyId'>,
  vapid: Vapid,
  now: Date = new Date(),
): Promise<ScheduleCheckResult | Failure> {
  const result: ScheduleCheckResult = {
    feeding: 0,
    nap: 0,
    appointments: 0,
    sent: 0,
    failed: 0,
    removed: 0,
    skipped: false,
  }
  const at = now.getTime()

  const [subsRes, membersRes] = await Promise.all([
    db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth, lang, updated_at')
      .eq('family_id', identity.familyId),
    db.from('family_members').select('user_id').eq('family_id', identity.familyId),
  ])
  if (subsRes.error) return { status: 500, error: subsRes.error.message }
  if (membersRes.error) return { status: 500, error: membersRes.error.message }

  const { recipients } = pickRecipients(
    subsRes.data ?? [],
    (membersRes.data ?? []).map((m) => m.user_id as string),
    pushEndpointAllowed,
  )
  // Sin nadie a quien avisar no se marca nada: si alguien prende los avisos
  // dentro de un rato, el vencimiento que sigue abierto le llega igual.
  if (recipients.length === 0) {
    result.skipped = true
    return result
  }

  let babiesQuery = db.from('babies').select('id, name').eq('family_id', identity.familyId)
  if (identity.babyId) babiesQuery = babiesQuery.eq('id', identity.babyId)
  const babiesRes = await babiesQuery
  if (babiesRes.error) return { status: 500, error: babiesRes.error.message }
  const babies = (babiesRes.data ?? []) as { id: string; name: string }[]
  if (babies.length === 0) {
    result.skipped = true
    return result
  }
  // M-2 (auditoría del 24 sep 2026): con más de un bebé en la familia y un
  // token que no está clavado a ninguno, estos checks mezclaban los eventos de
  // todos y le ponían al aviso el nombre de babies[0]. Falla CERRADO, que es
  // lo que ya hace resolveBabyForDevice en lib/deviceAuth.ts para el mismo
  // caso: no alcanza la información para decidir de quién hablar, así que no
  // se habla. (El check de toma larga sí puede con varios bebés: cada aviso
  // sale de UNA sesión, que trae su propio baby_id.)
  if (babies.length > 1) {
    result.skipped = true
    return result
  }
  const babyIds = babies.map((b) => b.id)
  const babyName = babies[0].name

  // Los umbrales de la familia. Sin fila todavía, valen los defaults —los
  // mismos números que el DEFAULT de la columna (0012)—, así que el aviso
  // funciona antes de que nadie entre a Settings.
  const settingsRes = await db
    .from('family_settings')
    .select('nap_threshold_minutes, feed_threshold_minutes, feed_alert_sent_at, nap_alert_sent_at')
    .eq('family_id', identity.familyId)
    .maybeSingle()
  if (settingsRes.error) return { status: 500, error: settingsRes.error.message }
  const settings = {
    ...DEFAULT_FAMILY_SETTINGS,
    feed_alert_sent_at: null as string | null,
    nap_alert_sent_at: null as string | null,
    ...(settingsRes.data ?? {}),
  }

  // Solo hace falta mirar hacia atrás lo que el umbral más largo abarca, más
  // un margen: una fila de la semana pasada no cambia "cuándo fue la última".
  const lookbackMs =
    Math.max(settings.feed_threshold_minutes, settings.nap_threshold_minutes) * 60_000 * 2 +
    DAY_LOOKBACK_MS
  const sinceIso = new Date(at - lookbackMs).toISOString()

  const [feedingsRes, nursingRes, sleepRes] = await Promise.all([
    db
      .from('feedings')
      .select('id, fed_at, feeding_type, amount_ml, notes')
      .in('baby_id', babyIds)
      .is('voided_at', null)
      .gte('fed_at', sinceIso),
    db
      .from('nursing_sessions')
      .select('id, side, started_at, ended_at')
      .in('baby_id', babyIds)
      .is('voided_at', null)
      .or(`started_at.gte."${sinceIso}",ended_at.gte."${sinceIso}",ended_at.is.null`),
    db
      .from('sleep_sessions')
      .select('id, started_at, ended_at, source')
      .in('baby_id', babyIds)
      .is('voided_at', null)
      .or(`started_at.gte."${sinceIso}",ended_at.gte."${sinceIso}",ended_at.is.null`),
  ])
  if (feedingsRes.error) return { status: 500, error: feedingsRes.error.message }
  if (nursingRes.error) return { status: 500, error: nursingRes.error.message }
  if (sleepRes.error) return { status: 500, error: sleepRes.error.message }

  const gone = new Set<string>()

  // ---------------------------------------------------------- comida vencida
  const lastFeed = lastFeedingEnd(
    (feedingsRes.data ?? []) as Feeding[],
    (nursingRes.data ?? []) as NursingSession[],
  )
  const feedDue = dueFrom(lastFeed, settings.feed_threshold_minutes, at)
  if (
    feedDue &&
    shouldAlert({
      overdue: feedDue.overdue,
      lastAlertAt: settings.feed_alert_sent_at,
      lastEventAt: lastFeed?.endedAt ?? null,
      now: at,
    }).send
  ) {
    // M-1 / A-3: la marca se PONE ANTES de mandar y de forma atómica, igual
    // que la de la toma larga (0009). Dos checks a la vez: el UPDATE del
    // segundo re-evalúa su WHERE tras el lock de fila y no matchea, así que
    // manda uno solo. Y si el claim falla —o lo ganó el otro— no se manda
    // nada: antes el upsert se hacía DESPUÉS y sin mirar su error, así que un
    // fallo ahí repetía el push cada minuto.
    const previousFeedMark = settings.feed_alert_sent_at
    const claimed = await claimAlert(
      db,
      identity.familyId,
      'feed_alert_sent_at',
      now,
      previousFeedMark,
    )
    if (claimed) {
      const out = await deliver(
        recipients,
        (lang) =>
          overdueFeedingPayload(lang, {
            familyId: identity.familyId,
            babyName,
            // A-1 (auditoría del 24 sep 2026): el texto dice "hace {minutes} que
            // no come", así que tiene que ser el tiempo DESDE LA ÚLTIMA COMIDA,
            // no los minutos de atraso. Con umbral 180 y 5 de atraso, mandar el
            // atraso hacía decir "hace 5 min que no come" cuando hacía 185.
            minutesOverdue: minutesSinceEvent(lastFeed, at),
          }),
        scheduleTopic(identity.familyId),
        SCHEDULE_TTL_SECONDS,
        vapid,
      )
      result.sent += out.sent
      result.failed += out.failed
      out.gone.forEach((id) => gone.add(id))
      // La marca se pone SOLO si le llegó a alguien: si no salió, el próximo
      // check reintenta en vez de quedarse callado media hora (§5.5 aplicado al
      // aviso — no se da por mandado lo que no se mandó).
      if (out.sent > 0) result.feeding = 1
      else await releaseAlert(db, identity.familyId, 'feed_alert_sent_at', now, previousFeedMark)
    }
  }

  // ---------------------------------------------------------- siesta vencida
  const lastNap = lastNapEnd((sleepRes.data ?? []) as SleepSession[])
  const napDue = dueFrom(lastNap, settings.nap_threshold_minutes, at)
  if (
    napDue &&
    shouldAlert({
      overdue: napDue.overdue,
      lastAlertAt: settings.nap_alert_sent_at,
      lastEventAt: lastNap?.endedAt ?? null,
      now: at,
    }).send
  ) {
    const previousNapMark = settings.nap_alert_sent_at
    const claimedNap = await claimAlert(
      db,
      identity.familyId,
      'nap_alert_sent_at',
      now,
      previousNapMark,
    )
    if (claimedNap) {
      const out = await deliver(
        recipients,
        (lang) =>
          overdueNapPayload(lang, {
            familyId: identity.familyId,
            babyName,
            // A-1, mismo caso: el texto dice "lleva {minutes} despierta".
            minutesOverdue: minutesSinceEvent(lastNap, at),
          }),
        scheduleTopic(identity.familyId),
        SCHEDULE_TTL_SECONDS,
        vapid,
      )
      result.sent += out.sent
      result.failed += out.failed
      out.gone.forEach((id) => gone.add(id))
      if (out.sent > 0) result.nap = 1
      else await releaseAlert(db, identity.familyId, 'nap_alert_sent_at', now, previousNapMark)
    }
  }

  // ------------------------------------------------------ recordatorio de cita
  // LA marca, con el mismo patrón que la toma larga (0009): un solo UPDATE con
  // `reminder_sent_at is null` en el WHERE, así dos checks a la vez no mandan
  // dos veces. Y el recordatorio NO se repite: "la cita es mañana a las 10" no
  // cambia con el tiempo, repetirlo cada media hora sería spam.
  const dueWindow = new Date(at + APPOINTMENT_REMINDER_MS).toISOString()
  const claimed = await db
    .from('doctor_appointments')
    .update({ reminder_sent_at: now.toISOString() })
    .in('baby_id', babyIds)
    .eq('completed', false)
    .is('reminder_sent_at', null)
    .gt('scheduled_at', now.toISOString())
    .lte('scheduled_at', dueWindow)
    .select('id, title, scheduled_at')
  if (claimed.error) return { status: 500, error: claimed.error.message }

  for (const appt of claimed.data ?? []) {
    const hours = Math.max(
      1,
      Math.round((Date.parse(appt.scheduled_at as string) - at) / 3_600_000),
    )
    const out = await deliver(
      recipients,
      (lang) =>
        appointmentPayload(lang, { id: appt.id as string, title: appt.title as string, hours }),
      scheduleTopic(appt.id as string),
      APPOINTMENT_TTL_SECONDS,
      vapid,
    )
    result.sent += out.sent
    result.failed += out.failed
    out.gone.forEach((id) => gone.add(id))
    if (out.sent > 0) result.appointments += 1
    else {
      // No le llegó a nadie: se le saca la marca para que el próximo check lo
      // reintente. Igual que `released` en runNursingCheck, y solo si la marca
      // sigue siendo la que puso ESTE check.
      await db
        .from('doctor_appointments')
        .update({ reminder_sent_at: null })
        .eq('id', appt.id as string)
        .in('baby_id', babyIds)
        .eq('reminder_sent_at', now.toISOString())
    }
  }

  // Las que el servicio dio por muertas. Los 403 los sigue decidiendo
  // runNursingCheck con el contraste del lote (lib/push/retry.ts): acá no se
  // toca ninguna racha, para no contar dos veces el mismo minuto.
  if (gone.size > 0) {
    const del = await db
      .from('push_subscriptions')
      .delete()
      .in('id', [...gone])
      .eq('family_id', identity.familyId)
      .select('id')
    result.removed = del.error ? 0 : (del.data?.length ?? 0)
  }

  return result
}

/** Un día de margen sobre el umbral más largo, para la ventana de lectura. */
const DAY_LOOKBACK_MS = 24 * 60 * 60 * 1000

/** Minutos enteros desde el fin del último evento. Es lo que dice el texto. */
function minutesSinceEvent(last: { endedAt: string } | null, now: number): number {
  if (!last) return 0
  return Math.max(0, Math.round((now - Date.parse(last.endedAt)) / 60_000))
}

/**
 * Toma la marca de "ya avisé" ANTES de mandar, y de forma exclusiva.
 *
 * El UPDATE lleva en el WHERE el valor que la marca tenía cuando se leyó
 * (compare-and-set): si otro check la movió mientras tanto, no matchea ninguna
 * fila y este check no manda. Es el mismo mecanismo que usa la toma larga en
 * 0009 con `long_alert_sent_at is null`, adaptado a una marca que se PISA en
 * vez de ponerse una sola vez.
 *
 * Devuelve `false` también si el UPDATE falla: sin marca confirmada no se
 * manda nada, porque un aviso que sale sin quedar marcado se repite cada
 * minuto mientras siga vencido (hallazgo A-3 de la auditoría del 24 sep 2026:
 * antes la marca se escribía DESPUÉS de mandar y con el error ignorado).
 */
async function claimAlert(
  db: SupabaseClient,
  familyId: string,
  column: 'feed_alert_sent_at' | 'nap_alert_sent_at',
  now: Date,
  previous: string | null,
): Promise<boolean> {
  // La familia puede no tener fila de ajustes todavía: los umbrales valen por
  // default hasta que alguien entra a Settings, y el aviso no puede depender
  // de eso. Se crea vacía y recién después se compite por la marca.
  const seeded = await db
    .from('family_settings')
    .upsert({ family_id: familyId }, { onConflict: 'family_id', ignoreDuplicates: true })
  if (seeded.error) return false

  let q = db
    .from('family_settings')
    .update({ [column]: now.toISOString(), updated_at: now.toISOString() })
    .eq('family_id', familyId)
  q = previous === null ? q.is(column, null) : q.eq(column, previous)
  const { data, error } = await q.select('family_id')
  if (error) return false
  return (data?.length ?? 0) > 0
}

/**
 * Devuelve la marca a donde estaba: este check la tomó pero el aviso no le
 * llegó a nadie, así que el próximo tiene que reintentar. Solo se revierte la
 * marca que puso ESTE check (mismo valor), igual que `released` en
 * runNursingCheck.
 */
async function releaseAlert(
  db: SupabaseClient,
  familyId: string,
  column: 'feed_alert_sent_at' | 'nap_alert_sent_at',
  now: Date,
  previous: string | null,
): Promise<void> {
  await db
    .from('family_settings')
    .update({ [column]: previous })
    .eq('family_id', familyId)
    .eq(column, now.toISOString())
}
