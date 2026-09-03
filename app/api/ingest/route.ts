import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'

// This is the ONLY door the NUC uses to talk to Supabase.
// It authenticates with a shared secret (NUC_DEVICE_SECRET), not a
// user login — the NUC is a device, not a person, so it should never
// hold a Supabase Auth session or the service_role key directly.
//
// Set NUC_DEVICE_SECRET in Vercel env vars, and configure the same
// value in your HA automation's HTTP request header.
//
// Expected request:
//   POST /api/ingest
//   Header: x-device-secret: <NUC_DEVICE_SECRET>
//   Body: { baby_id, event_type, occurred_at?, meta? }
//     OR:  { baby_id, kind: 'sleep_start' | 'sleep_end', occurred_at? }

export async function POST(req: NextRequest) {
  const deviceSecret = req.headers.get('x-device-secret')
  if (!deviceSecret || deviceSecret !== process.env.NUC_DEVICE_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { baby_id, event_type, occurred_at, meta, kind } = body

  if (!baby_id) {
    return NextResponse.json({ error: 'baby_id required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Sleep session start/end gets its own table instead of a generic event
  if (kind === 'sleep_start') {
    const { error } = await supabase.from('sleep_sessions').insert({
      baby_id,
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
      .eq('baby_id', baby_id)
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

  // Generic event (sound_alert, motion_start, etc.)
  const { error } = await supabase.from('monitor_events').insert({
    baby_id,
    event_type: event_type ?? 'unknown',
    occurred_at: occurred_at ?? new Date().toISOString(),
    meta: meta ?? null,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
