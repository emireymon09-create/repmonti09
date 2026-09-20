import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Guard de auth del lado del servidor.
 *
 * Lo que protege los DATOS sigue siendo RLS — esto no la reemplaza. Lo que
 * arregla es el parpadeo: hasta acá, una ruta privada se renderizaba entera y
 * recién después useBaby() rebotaba al login, así que una pantalla de pared
 * compartida le mostraba el esqueleto de la app a cualquiera que pasara. Y
 * toda ruta nueva que se olvidara del hook nacía desprotegida.
 */
const PROTECTED = ['/dashboard', '/pumping', '/growth', '/appointments', '/history']

export async function middleware(req: NextRequest) {
  const needsAuth = PROTECTED.some((p) => req.nextUrl.pathname.startsWith(p))
  const res = NextResponse.next({ request: { headers: req.headers } })
  if (!needsAuth) return res

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies: { name: string; value: string; options: CookieOptions }[]) => {
          for (const { name, value, options } of cookies) res.cookies.set(name, value, options)
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const login = req.nextUrl.clone()
    login.pathname = '/login'
    return NextResponse.redirect(login)
  }
  return res
}

export const config = {
  // Ni assets, ni el service worker, ni el manifest: el kiosco tiene que poder
  // levantar la shell sin conexión aunque la sesión haya caducado. /api queda
  // afuera porque los dos endpoints de dispositivo se autentican con secreto,
  // no con sesión (lib/deviceAuth.ts).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|sw.js|manifest.webmanifest|api).*)'],
}
