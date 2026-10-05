import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import {
  authenticateDevice,
  deviceFailureResponse,
  isDeviceFailure,
  isUuid,
  readJson,
  resolveBabyForDevice,
} from '@/lib/deviceAuth'
import { isDiaperType, logDiaper } from '@/lib/device/server'
import { clockTime } from '@/lib/format'

// Registrar un pañal desde un dispositivo, sin login: la pantalla del
// cambiador (proposals/changer-display.md §4) o un Shortcut. Token de
// dispositivo con scope quick_diaper (0013), normalmente clavado al bebé.
//
// Expected request:
//   POST /api/quick/diaper
//   Header: Authorization: Bearer <token de dispositivo>
//   Body: { type: 'wet' | 'dirty' | 'both', id?: <uuid>, baby_id?: <uuid> }
//
// `id` lo genera el dispositivo, una vez por toque: un reintento con el mismo
// id no registra un segundo pañal (action: 'already_logged'). Sin id el
// servidor genera uno y no hay garantía contra el doble registro.
//
// 200 { ok, action: 'logged' | 'already_logged', id, changed_at, message }
// 400 tipo inválido / id que no es uuid · 409 id de otra fila
// 401 / 403 / 404 / 429 como los otros endpoints de dispositivo

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'quick_diaper')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const body = await readJson<{ type?: unknown; id?: unknown; baby_id?: unknown }>(req)
  const type = body?.type
  if (!isDiaperType(type)) {
    return NextResponse.json({ error: "type must be 'wet', 'dirty' or 'both'" }, { status: 400 })
  }
  const id = body?.id
  if (id !== undefined && !isUuid(id)) {
    return NextResponse.json({ error: 'id must be a uuid' }, { status: 400 })
  }

  const target = await resolveBabyForDevice(supabase, identity, body?.baby_id)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)

  const result = await logDiaper(supabase, target.babyId, type, id?.toLowerCase())
  if (isDeviceFailure(result)) return deviceFailureResponse(result)

  return NextResponse.json({
    ok: true,
    action: result.action,
    id: result.id,
    changed_at: result.changed_at,
    message: `Diaper (${type}) — ${clockTime(result.changed_at)}`,
  })
}
