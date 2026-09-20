import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { checkDeviceSecret, isUuid, readJson } from '@/lib/deviceAuth'
import { clockTime, durationBetween } from '@/lib/format'

// The door an iOS Shortcut uses to toggle nursing with no login — tap
// "L" or "R" and it starts, stops, or switches sides, mirroring the
// Left/Right buttons on the dashboard. Authenticates with a shared
// secret (QUICK_TOGGLE_SECRET), not a user session — same reasoning
// as /api/ingest: a phone Shortcut is a device, not a person, so it
// never holds a Supabase Auth session or the service_role key itself.
//
// Set QUICK_TOGGLE_SECRET in Vercel env vars, and the same value in
// the Shortcut's "Get Contents of URL" request header.
//
// Expected request:
//   POST /api/quick/nurse
//   Header: x-device-secret: <QUICK_TOGGLE_SECRET>
//   Body: { side: 'left' | 'right' }
//
// Response body always has a `message` string meant to be read back
// via the Shortcut's "Show Notification" / "Show Result" step, e.g.
// "Nursing (left) started — 6:42 PM".

/**
 * Qué bebé recibe la sesión.
 *
 * ⚠️ HALLAZGO C1 (docs/auditorias/2026-09-20-auditoria-inicial.md): este
 * handler corre con service_role, o sea que salta RLS por completo, y el
 * secreto es uno solo para toda la instalación. Antes tomaba el `babies` más
 * ANTIGUO de toda la base sin filtrar por familia: con dos familias, el
 * secreto de cualquiera escribía sobre el bebé de la más vieja. Demostrado en
 * tests/integration/quick-nurse.test.ts.
 *
 * Parche mientras llega el arreglo de fondo (token por dispositivo,
 * proposals/device-tokens-and-idempotency.md §3):
 *
 *   · Si QUICK_TOGGLE_BABY_ID está seteada, se usa esa y punto. Es lo que
 *     corresponde en cuanto haya más de un hogar en la base.
 *   · Si no está y hay exactamente un bebé, se usa ese — el caso de hoy, un
 *     solo hogar, sigue funcionando sin configurar nada.
 *   · Si no está y hay más de uno, FALLA CERRADO (409). Adivinar es
 *     justamente lo que hacía el bug.
 */
async function resolveBabyId(
  supabase: SupabaseClient,
): Promise<{ babyId: string } | { error: string; status: number }> {
  const configured = process.env.QUICK_TOGGLE_BABY_ID
  if (configured) {
    if (!isUuid(configured)) {
      return { error: 'QUICK_TOGGLE_BABY_ID is not a uuid', status: 500 }
    }
    return { babyId: configured }
  }

  // limit(2): alcanza para saber si hay ambigüedad, sin traer la base entera.
  const { data: babies, error } = await supabase
    .from('babies')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(2)
  if (error) return { error: error.message, status: 500 }
  if (!babies || babies.length === 0) return { error: 'no baby set up yet', status: 404 }
  if (babies.length > 1) {
    return {
      error:
        'more than one baby in this database — set QUICK_TOGGLE_BABY_ID so this ' +
        'endpoint does not have to guess',
      status: 409,
    }
  }
  return { babyId: babies[0].id as string }
}

export async function POST(req: NextRequest) {
  const auth = checkDeviceSecret(req, process.env.QUICK_TOGGLE_SECRET)
  if (auth === 'rate_limited') {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }
  if (auth !== 'ok') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await readJson<{ side?: unknown }>(req)
  const side = body?.side
  if (side !== 'left' && side !== 'right') {
    return NextResponse.json({ error: "side must be 'left' or 'right'" }, { status: 400 })
  }

  const supabase = createAdminClient()

  const resolved = await resolveBabyId(supabase)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const baby = { id: resolved.babyId }

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
