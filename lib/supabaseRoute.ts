import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { NextRequest, NextResponse } from 'next/server'

/**
 * Cliente de Supabase para un route handler que actúa COMO EL PADRE que llama:
 * anon key + la sesión de sus cookies (lo mismo que middleware.ts). Todo lo
 * que haga pasa por RLS. Nunca service_role acá.
 *
 * Si getUser() tiene que refrescar la sesión, las cookies nuevas se juntan y
 * `withCookies` las pone en la respuesta: sin eso, el navegador se queda con un
 * refresh token que el servidor ya rotó.
 */
export function routeUserClient(req: NextRequest) {
  const pending: { name: string; value: string; options: CookieOptions }[] = []
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies: { name: string; value: string; options: CookieOptions }[]) => {
          pending.push(...cookies)
        },
      },
    },
  )
  function withCookies(res: NextResponse): NextResponse {
    for (const { name, value, options } of pending) res.cookies.set(name, value, options)
    return res
  }
  return { supabase, withCookies }
}
