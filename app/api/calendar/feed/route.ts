import { NextRequest, NextResponse } from 'next/server'
import { issueCalendarToken, resolveFamilyForUser } from '@/lib/calendar/server'
import { routeUserClient } from '@/lib/supabaseRoute'

// Crear o reemplazar el token del feed .ics de la familia del padre con sesión.
//
//   POST /api/calendar/feed   { rotate?: boolean }
//   → { token, url }   ← el valor EN CLARO, una sola vez
//
// Se autentica con la sesión del padre (cookies, anon key) ⇒ todo pasa por RLS
// (0012: solo la familia de la que es miembro). Nunca service_role acá: eso
// queda para el feed público, que no tiene sesión con la que consultar.
//
// `rotate` no cambia lo que hace el servidor — un token nuevo siempre pisa al
// anterior, porque `family_id` es la PK de calendar_feeds. Lo que cambia es
// que la pantalla ya confirmó con el usuario que el link viejo va a dejar de
// funcionar, y el servidor lo anota como rotación (`rotated_at`).
//
// Esta ruta no arma ninguna query: todo está en lib/calendar/server.ts
// (CLAUDE.md §5.3, mismo caso que lib/push/server.ts).

export async function POST(req: NextRequest) {
  const { supabase, withCookies } = routeUserClient(req)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return withCookies(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const family = await resolveFamilyForUser(supabase, user.id)
  if ('error' in family) {
    return withCookies(NextResponse.json({ error: family.error }, { status: family.status }))
  }

  let rotate = false
  try {
    const body: unknown = await req.json()
    rotate =
      typeof body === 'object' && body !== null && (body as { rotate?: unknown }).rotate === true
  } catch {
    // Un body vacío o ilegible es el caso normal del primer link: no es un
    // error, es "creá el primero".
  }

  const issued = await issueCalendarToken(supabase, family.familyId, rotate)
  if ('error' in issued) {
    return withCookies(NextResponse.json({ error: issued.error }, { status: issued.status }))
  }

  // La URL se arma con el origen del pedido, no con una variable de entorno:
  // así el link que se copia es el del host por el que entraron, y no hace
  // falta una variable nueva en Vercel para que esto funcione.
  const url = new URL(`/api/calendar/${issued.token}.ics`, req.nextUrl.origin).toString()
  return withCookies(
    NextResponse.json(
      { token: issued.token, url },
      // El token en claro viaja una sola vez: que no quede en ninguna caché.
      { headers: { 'Cache-Control': 'private, no-store' } },
    ),
  )
}

export const dynamic = 'force-dynamic'
