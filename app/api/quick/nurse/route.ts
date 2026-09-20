import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
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

export async function POST(req: NextRequest) {
  const deviceSecret = req.headers.get('x-device-secret')
  if (!deviceSecret || deviceSecret !== process.env.QUICK_TOGGLE_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const side = body?.side
  if (side !== 'left' && side !== 'right') {
    return NextResponse.json({ error: "side must be 'left' or 'right'" }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Single-baby household — same "oldest family" lookup currentBaby()
  // uses client-side, so the Shortcut never has to know a baby_id.
  const { data: babies, error: babyErr } = await supabase
    .from('babies').select('id')
    .order('created_at', { ascending: true }).limit(1)
  if (babyErr) return NextResponse.json({ error: babyErr.message }, { status: 500 })
  const baby = babies?.[0]
  if (!baby) return NextResponse.json({ error: 'no baby set up yet' }, { status: 404 })

  const { data: active, error: activeErr } = await supabase
    .from('nursing_sessions').select('id, side, started_at')
    .eq('baby_id', baby.id).is('ended_at', null).is('voided_at', null)
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (activeErr) return NextResponse.json({ error: activeErr.message }, { status: 500 })

  const now = new Date().toISOString()

  // Nothing running — this tap starts that side.
  if (!active) {
    const { error } = await supabase.from('nursing_sessions').insert({
      baby_id: baby.id, side, started_at: now, ended_at: null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      ok: true, action: 'started',
      message: `Nursing (${side}) started — ${clockTime(now)}`,
    })
  }

  // Same side already running — this tap stops it.
  if (active.side === side) {
    const { error } = await supabase.from('nursing_sessions')
      .update({ ended_at: now }).eq('id', active.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      ok: true, action: 'ended',
      message: `Nursing (${side}) ended — ${durationBetween(active.started_at, now)}`,
    })
  }

  // The other side is running — treat this as a real side switch
  // rather than leaving two sessions open: close the old one, start
  // the new one at the same instant.
  const { error: closeErr } = await supabase.from('nursing_sessions')
    .update({ ended_at: now }).eq('id', active.id)
  if (closeErr) return NextResponse.json({ error: closeErr.message }, { status: 500 })

  const { error: startErr } = await supabase.from('nursing_sessions').insert({
    baby_id: baby.id, side, started_at: now, ended_at: null,
  })
  if (startErr) return NextResponse.json({ error: startErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true, action: 'switched',
    message: `Switched to ${side} — ${active.side} ran ${durationBetween(active.started_at, now)}`,
  })
}
