/**
 * Qué hacer con una suscripción que el servicio de push rechaza con 403.
 *
 * PURO: sin red, sin base, sin reloj. Lo usa runNursingCheck (lib/push/server.ts)
 * y lo prueba tests/unit/push.test.ts. La columna que guarda la racha la crea
 * supabase/migrations/0010_push_forbidden_streak.sql.
 *
 * El 403 es ambiguo, y ahí está todo el problema. Significa "no te acepto esta
 * firma VAPID", y eso puede ser dos cosas MUY distintas:
 *
 *   a) Esta suscripción quedó vieja — se hizo con otro par de claves y el
 *      navegador nunca volvió a suscribirse. Está muerta: hay que borrarla, o
 *      se reintenta cada minuto para siempre.
 *
 *   b) La VAPID del SERVIDOR está mal puesta. Entonces el 403 no dice nada de
 *      la suscripción: van a fallar TODAS igual. Borrarlas sería destruir las
 *      suscripciones buenas de toda la familia por un error de configuración,
 *      y nadie las recupera sin volver a tocar "On" en cada teléfono.
 *
 * Lo que distingue (a) de (b) no es el código de estado, es el CONTRASTE
 * dentro del mismo lote: si a otro teléfono del mismo envío sí le llegó, la
 * VAPID del servidor está bien y el problema es de esta fila. Si no le llegó a
 * ninguno, no hay evidencia de que ninguna esté muerta.
 *
 * Por eso:
 *   · 403 con al menos otro envío OK en el mismo chequeo → +1 a la racha.
 *     A los 3 chequeos seguidos así, se borra.
 *   · 403 en todas las del lote → no se toca nada y se avisa por log, para
 *     que lo mire una persona.
 *   · Cualquier envío OK → la racha vuelve a 0 (son chequeos SEGUIDOS).
 *   · 403 mezclado con errores de red y sin ningún OK → ambiguo: no suma ni
 *     resetea. Un corte de red no tiene por qué gastar una vida.
 */

/** Chequeos seguidos en 403 (con otras funcionando) antes de borrar la fila. */
export const FORBIDDEN_STRIKES_BEFORE_DROP = 3

export type SendOutcome = 'ok' | 'gone' | 'forbidden' | 'failed'

/** Lo que le pasó a UNA suscripción en ESTE chequeo: un resultado por sesión. */
export type SubscriptionAttempt = {
  id: string
  /** La racha que traía de chequeos anteriores. */
  consecutive403: number
  /** Un resultado por sesión a la que se intentó avisar. Vacío = no se intentó. */
  outcomes: readonly SendOutcome[]
}

export type ForbiddenDecision = {
  /**
   * Todas las suscripciones a las que se intentó dieron 403. No se borra ni se
   * cuenta nada: es casi seguro la VAPID del servidor, no las suscripciones.
   */
  vapidSuspect: boolean
  /** Ids a borrar: llegaron a FORBIDDEN_STRIKES_BEFORE_DROP. */
  drop: string[]
  /** Ids cuya racha sube, ya con el valor nuevo a guardar. */
  strike: { id: string; consecutive403: number }[]
  /** Ids cuya racha vuelve a 0 (solo los que no estaban ya en 0). */
  reset: string[]
  /** Cuántas suscripciones dieron 403 en este chequeo. Para el reporte. */
  forbidden: number
}

/**
 * El veredicto de una suscripción en un chequeo, a partir de sus envíos.
 * Un OK manda sobre todo lo demás: si a este teléfono le llegó aunque sea un
 * aviso, la suscripción está viva.
 */
function verdict(outcomes: readonly SendOutcome[]): SendOutcome | 'none' {
  if (outcomes.length === 0) return 'none'
  if (outcomes.includes('ok')) return 'ok'
  if (outcomes.every((o) => o === 'forbidden')) return 'forbidden'
  if (outcomes.includes('gone')) return 'gone'
  return 'failed'
}

export function decideForbidden(attempts: readonly SubscriptionAttempt[]): ForbiddenDecision {
  const decision: ForbiddenDecision = {
    vapidSuspect: false,
    drop: [],
    strike: [],
    reset: [],
    forbidden: 0,
  }

  const tried = attempts
    .map((a) => ({ attempt: a, verdict: verdict(a.outcomes) }))
    .filter((x) => x.verdict !== 'none')
  if (tried.length === 0) return decision

  decision.forbidden = tried.filter((x) => x.verdict === 'forbidden').length

  // (b): ninguna recibió nada y todas dieron 403. No hay con qué distinguir una
  // suscripción muerta de una VAPID mal puesta, así que no se rompe nada.
  if (tried.every((x) => x.verdict === 'forbidden')) {
    decision.vapidSuspect = true
    return decision
  }

  // (a): hay al menos un envío OK en el lote ⇒ la VAPID del servidor sirve.
  const anyOk = tried.some((x) => x.verdict === 'ok')

  for (const { attempt, verdict: v } of tried) {
    if (v === 'ok') {
      if (attempt.consecutive403 > 0) decision.reset.push(attempt.id)
      continue
    }
    if (v !== 'forbidden' || !anyOk) continue
    const next = attempt.consecutive403 + 1
    if (next >= FORBIDDEN_STRIKES_BEFORE_DROP) decision.drop.push(attempt.id)
    else decision.strike.push({ id: attempt.id, consecutive403: next })
  }

  return decision
}
