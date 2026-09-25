import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { authenticateDevice, deviceFailureResponse, isDeviceFailure } from '@/lib/deviceAuth'
import { runNursingCheck, runScheduleChecks, vapidFromEnv } from '@/lib/push/server'

// Revisa si hay una toma de pecho abierta hace 30 min o más y, si nadie avisó
// todavía, manda UN push a cada dispositivo suscripto de la familia.
//
// Se autentica con un token de dispositivo de scope `push_check` (device_tokens,
// 0007/0009), el mismo camino que /api/ingest. El token decide la familia (y el
// bebé, si está clavado a uno): nunca cruza a otra.
//
//   pnpm device-token create --family <uuid> --label "check de avisos" --scope push_check
//
//   curl -fsS -X POST https://<host>/api/push/nursing-check \
//     -H "Authorization: Bearer amd_…"
//
// Responde { subscriptions, marked, sent, failed, removed, skipped, released }.
// `failed` incluye los envíos a suscripciones que el servicio dio por muertas
// (404/410), que además se borran (`removed`). `released` son las sesiones que
// este check marcó y a las que no les llegó a NADIE: se les saca la marca para
// que el próximo lo vuelva a intentar (por eso `marked` puede incluirlas).
//
// GET hace lo mismo, para un scheduler que solo sabe mandar GET con
// `Authorization: Bearer` (Vercel Cron: su CRON_SECRET tendría que ser el token).
//
// QUIÉN LO LLAMA CADA MINUTO: DECIDIDO el 22 sep 2026 (CLAUDE.md §7.6) —
// pg_cron + pg_net DENTRO del proyecto Supabase de la nube, migración
// supabase/migrations/0011_push_cron.sql. Se descartaron el VPS (no es
// producción) y Vercel Cron (Hobby corre una vez por día). Hasta que esa
// migración se aplique en la nube y se carguen los dos secretos en Vault, el
// aviso NO llega solo: docs/aplicar-en-la-nube.md.
//
// EL NOMBRE `nursing-check` QUEDÓ CHICO (24 sep 2026)
// ---------------------------------------------------
// Desde hoy este endpoint corre CUATRO checks, no uno:
//
//   1. toma de pecho larga        (runNursingCheck, 0009)
//   2. comida vencida             (runScheduleChecks, 0012)
//   3. siesta vencida             (runScheduleChecks, 0012)
//   4. cita médica en 24 h        (runScheduleChecks, 0012)
//
// Se dejó el nombre a propósito. `0011` ya está escrita y en camino a
// aplicarse en la nube con el jobname `nursing-check`, la URL en Vault y el
// token de scope `push_check`; renombrar o agregar un endpoint sería un
// secreto más en Vault, un job más de pg_cron y otra corrida manual en
// producción. Y el techo de intentos de lib/deviceAuth.ts es POR IP (20 por
// minuto, compartido con /api/ingest y /api/quick/nurse — CLAUDE.md §7
// pregunta 4): cuatro endpoints por minuto gastarían 4 de esas 20 en vez de 1.
//
// Los dos checks corren aunque el otro falle: un error leyendo las citas no
// puede tragarse el aviso de una toma de 40 minutos.

async function check(req: NextRequest) {
  // Un solo `now` para los cuatro checks: dos relojes distintos en la misma
  // corrida harían que un umbral se evalúe contra un instante y la marca se
  // escriba con otro.
  const now = new Date()
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'push_check')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  // Sin claves no se marca nada: una sesión marcada sin aviso es un aviso perdido.
  const vapid = vapidFromEnv()
  if (!vapid) return NextResponse.json({ error: 'push is not configured' }, { status: 503 })

  const [nursing, schedule] = await Promise.all([
    runNursingCheck(supabase, identity, vapid, now),
    runScheduleChecks(supabase, identity, vapid, now),
  ])

  // Si los DOS fallaron no hay nada que reportar como hecho: sale el error.
  // Si falló uno solo, el otro ya mandó lo suyo y tragarlo sería peor: la
  // respuesta lleva el resultado bueno y el error del otro, y el 200 dice la
  // verdad sobre lo que salió.
  if ('error' in nursing && 'error' in schedule) {
    return NextResponse.json({ error: nursing.error }, { status: nursing.status })
  }

  return NextResponse.json({
    ...('error' in nursing ? { nursingError: nursing.error } : nursing),
    schedule: 'error' in schedule ? { error: schedule.error } : schedule,
  })
}

export async function POST(req: NextRequest) {
  return check(req)
}

export async function GET(req: NextRequest) {
  return check(req)
}

// Nunca cacheado ni pre-renderizado: cada llamada es un check nuevo.
export const dynamic = 'force-dynamic'
