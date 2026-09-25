import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { calendarFeedFor, tokenFromSegment } from '@/lib/calendar/server'

// El feed .ics de los turnos médicos de una familia.
//
//   GET /api/calendar/<token>.ics
//   webcal://amelia-app.vercel.app/api/calendar/<token>.ics
//
// SIN LOGIN, A PROPÓSITO — y está escrito así en CLAUDE.md §5.8 y en
// PROJECT.md, porque es una decisión de producto y no una omisión: un cliente
// de calendario suscrito a un feed no manda credenciales, ni una sesión, ni un
// header que podamos elegir. La URL es el único control de acceso.
//
// Qué expone quien tenga la URL: título, tipo, hora, doctor y notas de los
// TURNOS MÉDICOS de esa familia. Nada de tomas, pañales, sueño, peso ni los
// nombres de los padres.
//
// Y por eso el token NO es el family_id: es un token opaco y dedicado
// (`acal_…`, 0012), del que la base guarda solo el sha-256. Rotarlo desde
// Settings pisa la fila y mata el link viejo en el acto, sin tocar el
// family_id ni nada más.
//
// Corre con service_role porque no hay sesión con la que consultar. El
// aislamiento entre familias NO lo hace RLS acá: lo hace calendarFeedFor, que
// resuelve la familia DESDE el token y filtra las citas por los bebés de esa
// familia. Esta ruta no arma ninguna query (CLAUDE.md §5.3).

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = tokenFromSegment(params.token)
  // Un token mal formado y uno que no existe contestan lo mismo: distinguirlos
  // le diría a quien prueba tokens cuáles tienen la forma correcta.
  if (!token) return notFound()

  const feed = await calendarFeedFor(createAdminClient(), token)
  if (!feed) return notFound()

  return new NextResponse(feed.ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="amelia.ics"',
      // Nunca en una caché compartida: el contenido depende del token, que es
      // el secreto. `no-store` además evita que el service worker de la app lo
      // guarde (§5.5 — y de todos modos /api/ nunca entra a esa caché).
      'Cache-Control': 'private, no-store',
    },
  })
}

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

// Cada pedido se resuelve de nuevo: un turno cargado hace un minuto tiene que
// salir en la próxima lectura del calendario.
export const dynamic = 'force-dynamic'
