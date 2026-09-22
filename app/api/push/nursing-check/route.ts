import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { authenticateDevice, deviceFailureResponse, isDeviceFailure } from '@/lib/deviceAuth'
import { runNursingCheck, vapidFromEnv } from '@/lib/push/server'

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
// QUIÉN LO LLAMA CADA MINUTO: PREGUNTA ABIERTA (CLAUDE.md §7). Opciones: la
// caja de la casa (NUC o HA Green) con un curl por minuto; Vercel Cron (Hobby
// corre una vez por día: no sirve; Pro, por minuto); pg_cron + pg_net en el
// Supabase del Hub. Hasta que se decida, el aviso NO llega solo.

async function check(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'push_check')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  // Sin claves no se marca nada: una sesión marcada sin aviso es un aviso perdido.
  const vapid = vapidFromEnv()
  if (!vapid) return NextResponse.json({ error: 'push is not configured' }, { status: 503 })

  const result = await runNursingCheck(supabase, identity, vapid)
  if ('error' in result)
    return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  return check(req)
}

export async function GET(req: NextRequest) {
  return check(req)
}

// Nunca cacheado ni pre-renderizado: cada llamada es un check nuevo.
export const dynamic = 'force-dynamic'
