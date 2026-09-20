import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { checkDeviceSecret, isSaneInstant, isUuid, readJson } from '@/lib/deviceAuth'

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
//
// ⚠️ HALLAZGO C2 (docs/auditorias/2026-09-20-auditoria-inicial.md): el secreto
// es uno solo para toda la instalación y este handler corre con service_role,
// que salta RLS. Quien tenga el secreto escribe sobre CUALQUIER baby_id de la
// base, no solo el suyo. Demostrado en tests/integration/ingest.test.ts.
// Arreglo propuesto: proposals/device-tokens-and-idempotency.md §1-§2.

// Lo único que el NUC puede empujar. Video, imagen y audio NUNCA salen de la
// casa (CLAUDE.md §1): acá solo entran eventos derivados.
const EVENT_TYPES = ['sound_alert', 'motion_start', 'motion_end'] as const
const MAX_META_BYTES = 2_048

export async function POST(req: NextRequest) {
  const auth = checkDeviceSecret(req, process.env.NUC_DEVICE_SECRET)
  if (auth === 'rate_limited') {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }
  if (auth !== 'ok') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await readJson<Record<string, unknown>>(req)
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 })

  const { baby_id, event_type, occurred_at, meta, kind } = body

  if (!isUuid(baby_id)) {
    return NextResponse.json({ error: 'baby_id required' }, { status: 400 })
  }
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

  // Generic event (sound_alert, motion_start, motion_end)
  const { error } = await supabase.from('monitor_events').insert({
    baby_id,
    event_type,
    occurred_at: occurred_at ?? new Date().toISOString(),
    meta: meta ?? null,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
