import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { generateDeviceToken, type DeviceScope } from '@/lib/deviceTokens'

/** Carga .env.test si las variables no vienen ya del entorno. */
function loadEnv(): void {
  if (process.env.SUPABASE_URL) return
  let raw: string
  try {
    raw = readFileSync(new URL('../../.env.test', import.meta.url), 'utf8')
  } catch {
    throw new Error('Falta .env.test. Levantá el stack con `pnpm db:up` y corré `pnpm db:env`.')
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/)
    if (m) process.env[m[1]] ??= m[2]
  }
}

export function adminClient(): SupabaseClient {
  loadEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function anonClient(): SupabaseClient {
  loadEnv()
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Los route handlers construyen su cliente con createAdminClient(), que lee
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. La segunda ya se
 * llama igual en .env.test; la primera hay que puentearla.
 */
export function exposeEnvToRouteHandlers(): void {
  loadEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL
}

export type SeededFamily = {
  familyId: string
  userId: string
  babyId: string
  email: string
  /** Cliente anon con sesión de este padre: el camino real de la app. */
  client: SupabaseClient
}

/**
 * Dos familias completas, cada una con su padre, su bebé y datos propios.
 *
 * La familia A se siembra primero: era la que el bug viejo de /api/quick/nurse
 * se quedaba (C1). Se mantiene el orden para que el test que lo prueba cerrado
 * siga significando algo.
 */
export async function seedTwoFamilies(tag: string): Promise<{
  a: SeededFamily
  b: SeededFamily
  cleanup: () => Promise<void>
}> {
  const admin = adminClient()

  async function seedOne(name: string): Promise<SeededFamily> {
    const email = `${tag}-${name}@amelia.test`.toLowerCase()
    const password = 'test-password-1234'

    // Un test anterior pudo haber dejado el usuario colgado.
    await deleteUserByEmail(admin, email)

    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (userErr) throw userErr
    const userId = created.user!.id

    const { data: fam, error: famErr } = await admin
      .from('families')
      .insert({ name: `${tag}-${name}` })
      .select('id')
      .single()
    if (famErr) throw famErr

    const { error: memErr } = await admin
      .from('family_members')
      .insert({ family_id: fam.id, user_id: userId, role: 'parent' })
    if (memErr) throw memErr

    const { data: baby, error: babyErr } = await admin
      .from('babies')
      .insert({ family_id: fam.id, name: `Bebe ${name}`, birth_date: '2026-01-15' })
      .select('id')
      .single()
    if (babyErr) throw babyErr

    const client = anonClient()
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
    if (signInErr) throw signInErr

    return { familyId: fam.id, userId, babyId: baby.id, email, client }
  }

  const a = await seedOne('a')
  const b = await seedOne('b')

  // Un dato propio por familia, para que "no ver lo del otro" signifique algo.
  for (const f of [a, b]) {
    const { error } = await admin.from('feedings').insert({
      baby_id: f.babyId,
      feeding_type: 'bottle',
      amount_ml: 90,
      fed_at: '2026-01-15T16:00:00Z',
      logged_by: f.userId,
    })
    if (error) throw error
  }

  async function cleanup() {
    // families borra en cascada babies -> feedings/nursing/etc.
    await admin.from('families').delete().in('id', [a.familyId, b.familyId])
    await admin.auth.admin.deleteUser(a.userId)
    await admin.auth.admin.deleteUser(b.userId)
  }

  return { a, b, cleanup }
}

/**
 * Un token de dispositivo sembrado directo con service_role, como lo haría
 * `pnpm device-token create`. Devuelve el token en claro: la base solo tiene el
 * hash. Se borra en cascada con la familia en cleanup().
 */
export async function seedDeviceToken(opts: {
  familyId: string
  babyId?: string | null
  scopes: DeviceScope[]
  revoked?: boolean
}): Promise<{ id: string; token: string }> {
  const { token, hash } = generateDeviceToken()
  const { data, error } = await adminClient()
    .from('device_tokens')
    .insert({
      family_id: opts.familyId,
      baby_id: opts.babyId ?? null,
      label: 'dispositivo de prueba',
      token_hash: hash,
      scopes: opts.scopes,
      revoked_at: opts.revoked ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (error) throw error
  return { id: data.id, token }
}

async function deleteUserByEmail(admin: SupabaseClient, email: string): Promise<void> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const found = data?.users.find((u) => u.email === email)
  if (found) await admin.auth.admin.deleteUser(found.id)
}
