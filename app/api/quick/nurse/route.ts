import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import {
  authenticateDevice,
  deviceFailureResponse,
  isDeviceFailure,
  readJson,
  resolveBabyForDevice,
} from '@/lib/deviceAuth'
import { clockTime, durationBetween } from '@/lib/format'

// La puerta que usa un Shortcut de iOS para alternar la lactancia sin login:
// "L" o "R" arranca, corta o cambia de lado, igual que los botones del
// dashboard. Se autentica con un token de dispositivo con scope quick_nurse
// (device_tokens, 0007). Lo normal es clavarlo al bebé:
// `pnpm device-token create --family <uuid> --baby <uuid> --label ... --scope quick_nurse`.
//
// Expected request:
//   POST /api/quick/nurse
//   Header: Authorization: Bearer <token de dispositivo>
//   Body: { side: 'left' | 'right', baby_id? }
//
// Response body always has a `message` string meant to be read back
// via the Shortcut's "Show Notification" / "Show Result" step, e.g.
// "Nursing (left) started — 6:42 PM".

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()
  const identity = await authenticateDevice(req, supabase, 'quick_nurse')
  if (isDeviceFailure(identity)) return deviceFailureResponse(identity)

  const body = await readJson<{ side?: unknown; baby_id?: unknown }>(req)
  const side = body?.side
  if (side !== 'left' && side !== 'right') {
    return NextResponse.json({ error: "side must be 'left' or 'right'" }, { status: 400 })
  }

  const target = await resolveBabyForDevice(supabase, identity, body?.baby_id)
  if (isDeviceFailure(target)) return deviceFailureResponse(target)
  const baby = { id: target.babyId }

  const { data: active, error: activeErr } = await supabase
    .from('nursing_sessions')
    .select('id, side, started_at')
    .eq('baby_id', baby.id)
    .is('ended_at', null)
    .is('voided_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (activeErr) return NextResponse.json({ error: activeErr.message }, { status: 500 })

  const now = new Date().toISOString()

  // Nothing running — this tap starts that side.
  if (!active) {
    const { error } = await supabase.from('nursing_sessions').insert({
      baby_id: baby.id,
      side,
      started_at: now,
      ended_at: null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      ok: true,
      action: 'started',
      message: `Nursing (${side}) started — ${clockTime(now)}`,
    })
  }

  // Same side already running — this tap stops it.
  if (active.side === side) {
    const { error } = await supabase
      .from('nursing_sessions')
      .update({ ended_at: now })
      .eq('id', active.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      ok: true,
      action: 'ended',
      message: `Nursing (${side}) ended — ${durationBetween(active.started_at, now)}`,
    })
  }

  // The other side is running — treat this as a real side switch
  // rather than leaving two sessions open: close the old one, start
  // the new one at the same instant.
  const { error: closeErr } = await supabase
    .from('nursing_sessions')
    .update({ ended_at: now })
    .eq('id', active.id)
  if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 })

  const { error: startErr } = await supabase.from('nursing_sessions').insert({
    baby_id: baby.id,
    side,
    started_at: now,
    ended_at: null,
  })
  if (startErr) return NextResponse.json({ error: startErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    action: 'switched',
    message: `Switched to ${side} — ${active.side} ran ${durationBetween(active.started_at, now)}`,
  })
}
