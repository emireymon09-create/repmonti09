import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import {
  authenticateDevice,
  deviceFailureResponse,
  isDeviceFailure,
  resolveBabyForDevice,
} from '@/lib/deviceAuth'
import { readDeviceStatus } from '@/lib/device/server'

// Solo lectura: lo que la pantalla del cambiador pinta arriba
// (proposals/changer-display.md §5). Token de dispositivo con scope
// read_status (0013). La pantalla lo pide cada 30 s y después de cada toque.
//
// Expected request:
//   GET /api/quick/status[?baby_id=<uuid>]
//   Header: Authorization: Bearer <token de dispositivo>
//
// 200 { ok, now, baby: { name }, nursing, sleep, last_feeding_end, feed_due, last_diaper }
// Todas las horas en ISO UTC. `now` va en la respuesta para que la pantalla
// cuente "hace 12 min" desde la última lectura sin depender de su reloj.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'read_status')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const requested = req.nextUrl.searchParams.get('baby_id') ?? undefined
  const target = await resolveBabyForDevice(supabase, identity, requested)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)

  const status = await readDeviceStatus(supabase, identity.familyId, target.babyId)
  if (isDeviceFailure(status)) return deviceFailureResponse(status)

  return NextResponse.json({ ok: true, ...status }, { headers: { 'cache-control': 'no-store' } })
}
