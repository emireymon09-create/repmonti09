import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import {
  authenticateDevice,
  deviceFailureResponse,
  isDeviceFailure,
  isSaneInstant,
  readJson,
  resolveBabyForDevice,
} from '@/lib/deviceAuth'

// La única puerta por la que la casa (NUC / Home Assistant) le habla a
// Supabase. Se autentica con un token de dispositivo propio (device_tokens,
// 0007), nunca con un login de usuario ni con la service_role en el dispositivo.
// Crear uno: `pnpm device-token create --family <uuid> --label ... --scope ingest`.
//
// Expected request:
//   POST /api/ingest
//   Header: Authorization: Bearer <token de dispositivo>
//   Body: { baby_id?, event_type, occurred_at?, meta? }
//     OR:  { baby_id?, kind: 'sleep_start' | 'sleep_end', occurred_at? }
//   baby_id es opcional si el token está clavado a un bebé o la familia tiene
//   uno solo. Nunca puede apuntar fuera de la familia del token (403).

// Lo único que el NUC puede empujar. Video, imagen y audio NUNCA salen de la
// casa (CLAUDE.md §1): acá solo entran eventos derivados.
const EVENT_TYPES = ['sound_alert', 'motion_start', 'motion_end'] as const
const MAX_META_BYTES = 2_048

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'ingest')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const body = await readJson<Record<string, unknown>>(req)
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 })

  const { baby_id, event_type, occurred_at, meta, kind } = body

  if (occurred_at !== undefined && !isSaneInstant(occurred_at)) {
    return NextResponse.json({ error: 'occurred_at out of range' }, { status: 400 })
  }
  if (kind !== undefined && kind !== 'sleep_start' && kind !== 'sleep_end') {
    return NextResponse.json({ error: 'unknown kind' }, { status: 400 })
  }
  // Antes, un evento sin tipo se guardaba igual como 'unknown'. Basura
  // silenciosa en la tabla que existe justamente para que no entre media.
  if (kind === undefined && !EVENT_TYPES.includes(event_type as (typeof EVENT_TYPES)[number])) {
    return NextResponse.json({ error: 'unknown event_type' }, { status: 400 })
  }
  if (meta !== undefined && meta !== null && JSON.stringify(meta).length > MAX_META_BYTES) {
    return NextResponse.json({ error: 'meta too large' }, { status: 400 })
  }

  // Validar el payload antes de tocar babies: la basura no genera queries.
  const target = await resolveBabyForDevice(supabase, identity, baby_id)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)
  const babyId = target.babyId

  // Sleep session start/end gets its own table instead of a generic event
  if (kind === 'sleep_start') {
    const { error } = await supabase.from('sleep_sessions').insert({
      baby_id: babyId,
      started_at: occurred_at ?? new Date().toISOString(),
      source: 'nuc_derived',
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (kind === 'sleep_end') {
    // closes the most recent open nuc_derived session for this baby
    const { data: openSession } = await supabase
      .from('sleep_sessions')
      .select('id')
      .eq('baby_id', babyId)
      .eq('source', 'nuc_derived')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (openSession) {
      const { error } = await supabase
        .from('sleep_sessions')
        .update({ ended_at: occurred_at ?? new Date().toISOString() })
        .eq('id', openSession.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  // Generic event (sound_alert, motion_start, motion_end)
  const { error } = await supabase.from('monitor_events').insert({
    baby_id: babyId,
    event_type,
    occurred_at: occurred_at ?? new Date().toISOString(),
    meta: meta ?? null,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
