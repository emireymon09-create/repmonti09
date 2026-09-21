/**
 * Administración de tokens de dispositivo. Corre con service_role (la de
 * .env.local): es una herramienta de servidor, nunca de la app.
 *
 *   pnpm device-token families
 *   pnpm device-token create --family <uuid> [--baby <uuid>] --label "NUC del cuarto" --scope ingest
 *   pnpm device-token list --family <uuid>
 *   pnpm device-token revoke --id <uuid>
 *
 * El token en claro se imprime UNA vez, en `create`. Después solo existe su hash.
 */
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { DEVICE_SCOPES, generateDeviceToken, isDeviceScope } from '../lib/deviceTokens.ts'

const out = (line: string) => process.stdout.write(`${line}\n`)
function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) die('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local')
const db = createClient(url, key, { auth: { persistSession: false } })

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    family: { type: 'string' },
    baby: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', multiple: true },
    id: { type: 'string' },
  },
})

switch (positionals[0]) {
  case 'families': {
    const { data, error } = await db.from('babies').select('id, name, family_id, families(name)')
    if (error) die(error.message)
    for (const b of data ?? []) out(`familia ${b.family_id}  bebé ${b.id}  ${b.name}`)
    break
  }
  case 'create': {
    const scopes = values.scope ?? []
    if (!values.family || !values.label || scopes.length === 0) {
      die(
        `uso: create --family <uuid> [--baby <uuid>] --label <texto> --scope ${DEVICE_SCOPES.join('|')}`,
      )
    }
    const bad = scopes.filter((s) => !isDeviceScope(s))
    if (bad.length > 0) die(`scopes desconocidos: ${bad.join(', ')}`)
    const { token, hash } = generateDeviceToken()
    const { data, error } = await db
      .from('device_tokens')
      .insert({
        family_id: values.family,
        baby_id: values.baby ?? null,
        label: values.label,
        token_hash: hash,
        scopes,
      })
      .select('id')
      .single()
    if (error) die(error.message)
    out(`id:    ${data.id}`)
    out(`token: ${token}`)
    out(
      'Guardalo ahora en el dispositivo (header Authorization: Bearer <token>). No se vuelve a mostrar.',
    )
    break
  }
  case 'list': {
    if (!values.family) die('uso: list --family <uuid>')
    const { data, error } = await db
      .from('device_tokens')
      .select('id, label, baby_id, scopes, created_at, last_used_at, revoked_at')
      .eq('family_id', values.family)
      .order('created_at')
    if (error) die(error.message)
    for (const t of data ?? []) {
      const state = t.revoked_at
        ? `REVOCADO ${t.revoked_at}`
        : `último uso ${t.last_used_at ?? 'nunca'}`
      out(
        `${t.id}  ${t.label}  [${t.scopes.join(',')}]  bebé ${t.baby_id ?? 'toda la familia'}  ${state}`,
      )
    }
    break
  }
  case 'revoke': {
    if (!values.id) die('uso: revoke --id <uuid>')
    const { data, error } = await db
      .from('device_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', values.id)
      .is('revoked_at', null)
      .select('id')
    if (error) die(error.message)
    out(data && data.length > 0 ? `revocado ${values.id}` : 'no existe o ya estaba revocado')
    break
  }
  default:
    die('uso: pnpm device-token families|create|list|revoke')
}
