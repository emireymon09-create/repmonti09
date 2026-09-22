import { NextRequest, NextResponse } from 'next/server'
import { readJson } from '@/lib/deviceAuth'
import { parseEndpointBody, parseSubscriptionBody } from '@/lib/push/endpoint'
import { deleteSubscription, pushExtraOrigins, saveSubscription } from '@/lib/push/server'
import { routeUserClient } from '@/lib/supabaseRoute'

// La suscripción push de ESTE dispositivo para el padre con sesión.
//
//   POST   /api/push/subscription   { endpoint, keys: { p256dh, auth }, lang, baby_id? }
//   DELETE /api/push/subscription   { endpoint }
//
// Se autentica con la sesión del padre (cookies, anon key) ⇒ todo pasa por RLS
// (0009: cada uno solo sus filas, solo de su familia). Nunca service_role acá.
// Lo llama lib/push/client.ts desde el menú del engranaje y al cerrar sesión.

export async function POST(req: NextRequest) {
  const { supabase, withCookies } = routeUserClient(req)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return withCookies(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const parsed = parseSubscriptionBody(await readJson(req), pushExtraOrigins())
  if ('error' in parsed) {
    return withCookies(NextResponse.json({ error: parsed.error }, { status: 400 }))
  }

  const saved = await saveSubscription(supabase, user.id, parsed.ok)
  if ('error' in saved) {
    return withCookies(NextResponse.json({ error: saved.error }, { status: saved.status }))
  }
  return withCookies(NextResponse.json({ ok: true }))
}

export async function DELETE(req: NextRequest) {
  const { supabase, withCookies } = routeUserClient(req)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return withCookies(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const parsed = parseEndpointBody(await readJson(req), pushExtraOrigins())
  if ('error' in parsed) {
    return withCookies(NextResponse.json({ error: parsed.error }, { status: 400 }))
  }

  const done = await deleteSubscription(supabase, user.id, parsed.ok)
  if ('error' in done) {
    return withCookies(NextResponse.json({ error: done.error }, { status: done.status }))
  }
  return withCookies(NextResponse.json({ ok: true, deleted: done.deleted }))
}
