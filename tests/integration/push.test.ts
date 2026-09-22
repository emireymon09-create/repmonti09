import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  exposeEnvToRouteHandlers,
  seedDeviceToken,
  seedTwoFamilies,
  type SeededFamily,
} from '../helpers/supabase'
import {
  freshVapid,
  startFakePushService,
  verifyVapid,
  type Browser,
  type FakePushService,
} from '../helpers/fakePush'
import { resetDeviceRateLimit } from '@/lib/deviceAuth'
import { setPushTransportForTests } from '@/lib/push/server'

/**
 * Aviso push de toma de pecho larga, por el camino real:
 *   · push_subscriptions con RLS (PostgREST + JWT de cada padre, y anon).
 *   · POST/DELETE /api/push/subscription con la cookie de sesión de verdad.
 *   · /api/push/nursing-check con tokens de dispositivo, contra un servicio de
 *     push falso en 127.0.0.1 que descifra lo que recibe (tests/helpers/fakePush.ts).
 */

const PASSWORD = 'test-password-1234'
const admin = adminClient()
const vapid = freshVapid()

let a: SeededFamily
let b: SeededFamily
let cleanup: () => Promise<void>
let partner: { userId: string; email: string; client: SupabaseClient }
let push: FakePushService

let checkA: string // push_check, toda la familia A
let checkPinnedA: string // push_check, clavado al bebé de A
let checkB: string // push_check, familia B
let ingestA: string // scope equivocado
let revokedA: string

beforeAll(async () => {
  exposeEnvToRouteHandlers()
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= process.env.SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = vapid.publicKey
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey
  process.env.VAPID_SUBJECT = vapid.subject
  ;({ a, b, cleanup } = await seedTwoFamilies('push'))

  // El otro padre de la familia A: misma familia, otra cuenta.
  const email = 'push-partner@amelia.test'
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const stale = list?.users.find((u) => u.email === email)
  if (stale) await admin.auth.admin.deleteUser(stale.id)
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error) throw error
  await admin.from('family_members').insert({ family_id: a.familyId, user_id: created.user!.id })
  const client = anonClient()
  await client.auth.signInWithPassword({ email, password: PASSWORD })
  partner = { userId: created.user!.id, email, client }

  push = await startFakePushService()
  setPushTransportForTests({ extraOrigins: [push.origin], agent: push.agent })

  checkA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['push_check'] })).token
  checkPinnedA = (
    await seedDeviceToken({ familyId: a.familyId, babyId: a.babyId, scopes: ['push_check'] })
  ).token
  checkB = (await seedDeviceToken({ familyId: b.familyId, scopes: ['push_check'] })).token
  ingestA = (await seedDeviceToken({ familyId: a.familyId, scopes: ['ingest'] })).token
  revokedA = (
    await seedDeviceToken({ familyId: a.familyId, scopes: ['push_check'], revoked: true })
  ).token
})

afterAll(async () => {
  setPushTransportForTests(null)
  await push?.close()
  if (partner) await admin.auth.admin.deleteUser(partner.userId)
  await cleanup()
})

beforeEach(() => {
  resetDeviceRateLimit()
})

// ---------------------------------------------------------------- helpers

function row(family: string, user: string, browser: Browser, lang = 'en') {
  return {
    family_id: family,
    user_id: user,
    endpoint: browser.subscription.endpoint,
    p256dh: browser.subscription.keys.p256dh,
    auth: browser.subscription.keys.auth,
    lang,
  }
}

/** La cookie de sesión que el navegador le mandaría a la ruta. */
async function sessionCookie(email: string): Promise<string> {
  const jar = new Map<string, string>()
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies: { name: string; value: string }[]) => {
          for (const c of cookies) {
            if (c.value) jar.set(c.name, c.value)
            else jar.delete(c.name)
          }
        },
      },
    },
  )
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw error
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ')
}

async function subscriptionRoute(method: 'POST' | 'DELETE', body: unknown, cookie: string | null) {
  const route = await import('@/app/api/push/subscription/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const req = new NextRequest(
    new Request('http://localhost/api/push/subscription', {
      method,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return method === 'POST' ? route.POST(req) : route.DELETE(req)
}

async function check(token: string | null, method: 'POST' | 'GET' = 'POST') {
  const route = await import('@/app/api/push/nursing-check/route')
  const { NextRequest } = await import('next/server')
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  const req = new NextRequest(
    new Request('http://localhost/api/push/nursing-check', { method, headers }),
  )
  return method === 'POST' ? route.POST(req) : route.GET(req)
}

async function openNursing(
  babyId: string,
  minutesAgo: number,
  extra: Record<string, unknown> = {},
) {
  const { data, error } = await admin
    .from('nursing_sessions')
    .insert({
      baby_id: babyId,
      side: 'left',
      started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ...extra,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function alertSentAt(id: string): Promise<string | null> {
  const { data } = await admin
    .from('nursing_sessions')
    .select('long_alert_sent_at')
    .eq('id', id)
    .single()
  return data!.long_alert_sent_at
}

async function stopAllOpen(babyId: string) {
  await admin
    .from('nursing_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('baby_id', babyId)
    .is('ended_at', null)
}

const requestsTo = (path: string) => push.received.filter((r) => r.path === path)

// ---------------------------------------------------------------- RLS

describe('push_subscriptions — RLS por el camino real', () => {
  const tag = 'rls'
  let mine: Browser
  let theirs: Browser

  beforeAll(async () => {
    mine = push.browser(`/${tag}/a`)
    theirs = push.browser(`/${tag}/b`)
    // Filas de A y de B, escritas por cada uno con SU sesión.
    const ra = await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, mine))
    expect(ra.error).toBeNull()
    const rb = await b.client.from('push_subscriptions').insert(row(b.familyId, b.userId, theirs))
    expect(rb.error).toBeNull()
  })

  afterAll(async () => {
    await admin.from('push_subscriptions').delete().like('endpoint', `${push.origin}/${tag}/%`)
  })

  it('cada padre ve solo su fila', async () => {
    const { data } = await a.client.from('push_subscriptions').select('endpoint')
    expect(data!.map((r) => r.endpoint)).toEqual([mine.subscription.endpoint])
  })

  it('el otro padre de la MISMA familia tampoco ve la fila de A', async () => {
    const { data } = await partner.client.from('push_subscriptions').select('id')
    expect(data).toEqual([])
  })

  it('B no edita ni borra la de A', async () => {
    const up = await b.client
      .from('push_subscriptions')
      .update({ lang: 'es' })
      .eq('endpoint', mine.subscription.endpoint)
      .select('id')
    expect(up.data ?? []).toEqual([])
    const del = await b.client
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', mine.subscription.endpoint)
      .select('id')
    expect(del.data ?? []).toEqual([])
    const { data } = await admin
      .from('push_subscriptions')
      .select('lang')
      .eq('endpoint', mine.subscription.endpoint)
      .single()
    expect(data!.lang).toBe('en')
  })

  it('nadie inserta con la familia de otro', async () => {
    const x = push.browser(`/${tag}/x`)
    const { error } = await a.client.from('push_subscriptions').insert(row(b.familyId, a.userId, x))
    expect(error).not.toBeNull()
  })

  it('nadie inserta a nombre de otro usuario', async () => {
    const x = push.browser(`/${tag}/y`)
    const { error } = await a.client
      .from('push_subscriptions')
      .insert(row(a.familyId, partner.userId, x))
    expect(error).not.toBeNull()
  })

  it('A no muda su fila a la familia de B', async () => {
    const { data } = await a.client
      .from('push_subscriptions')
      .update({ family_id: b.familyId })
      .eq('endpoint', mine.subscription.endpoint)
      .select('id')
    expect(data ?? []).toEqual([])
  })

  it('anon no lee nada (sin grant: error, no filas)', async () => {
    const { data, error } = await anonClient().from('push_subscriptions').select('id')
    expect(data ?? []).toEqual([])
    expect(error?.code).toBe('42501')
  })

  it('una URL que no es https no entra ni con sesión (CHECK)', async () => {
    const x = push.browser(`/${tag}/z`)
    const { error } = await a.client
      .from('push_subscriptions')
      .insert({ ...row(a.familyId, a.userId, x), endpoint: 'http://127.0.0.1/nope' })
    expect(error).not.toBeNull()
  })
})

// ---------------------------------------------------------------- la ruta

describe('/api/push/subscription — con la sesión del padre', () => {
  const tag = 'route'
  let cookieA: string
  let device: Browser

  beforeAll(async () => {
    cookieA = await sessionCookie(a.email)
    device = push.browser(`/${tag}/1`)
  })
  afterAll(async () => {
    await admin.from('push_subscriptions').delete().like('endpoint', `${push.origin}/${tag}/%`)
  })

  it('sin sesión, 401', async () => {
    expect(
      (await subscriptionRoute('POST', { ...device.subscription, lang: 'en' }, null)).status,
    ).toBe(401)
    expect(
      (await subscriptionRoute('DELETE', { endpoint: device.subscription.endpoint }, null)).status,
    ).toBe(401)
  })

  it('un body inválido, 400', async () => {
    expect((await subscriptionRoute('POST', 'no json', cookieA)).status).toBe(400)
    expect(
      (
        await subscriptionRoute(
          'POST',
          { ...device.subscription, endpoint: 'https://10.0.0.1/x' },
          cookieA,
        )
      ).status,
    ).toBe(400)
    expect(
      (await subscriptionRoute('POST', { ...device.subscription, lang: 'fr' }, cookieA)).status,
    ).toBe(400)
  })

  it('guarda con la familia del padre y actualiza el idioma sin duplicar', async () => {
    expect(
      (await subscriptionRoute('POST', { ...device.subscription, lang: 'es' }, cookieA)).status,
    ).toBe(200)
    expect(
      (
        await subscriptionRoute(
          'POST',
          { ...device.subscription, lang: 'en', baby_id: a.babyId },
          cookieA,
        )
      ).status,
    ).toBe(200)
    const { data } = await admin
      .from('push_subscriptions')
      .select('family_id, user_id, lang')
      .eq('endpoint', device.subscription.endpoint)
    expect(data).toEqual([{ family_id: a.familyId, user_id: a.userId, lang: 'en' }])
  })

  it('con el bebé de otra familia, 403 y no guarda', async () => {
    const other = push.browser(`/${tag}/2`)
    const res = await subscriptionRoute(
      'POST',
      { ...other.subscription, baby_id: b.babyId },
      cookieA,
    )
    expect(res.status).toBe(403)
    const { data } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', other.subscription.endpoint)
    expect(data).toEqual([])
  })

  it('DELETE borra la de ese endpoint', async () => {
    const res = await subscriptionRoute(
      'DELETE',
      { endpoint: device.subscription.endpoint },
      cookieA,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: 1 })
    const { data } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', device.subscription.endpoint)
    expect(data).toEqual([])
  })
})

// ---------------------------------------------------------------- el check

describe('/api/push/nursing-check — quién entra', () => {
  it('sin token, 401', async () => {
    expect((await check(null)).status).toBe(401)
  })
  it('token revocado, 401', async () => {
    expect((await check(revokedA)).status).toBe(401)
  })
  it('token sin el scope push_check, 403', async () => {
    expect((await check(ingestA)).status).toBe(403)
  })
})

describe('/api/push/nursing-check — el aviso', () => {
  const tag = 'check'
  let phoneA: Browser // padre A, en español
  let phonePartner: Browser // el otro padre de A, en inglés

  beforeAll(async () => {
    phoneA = push.browser(`/${tag}/a`)
    phonePartner = push.browser(`/${tag}/partner`)
  })
  afterAll(async () => {
    await admin.from('push_subscriptions').delete().like('endpoint', `${push.origin}/${tag}/%`)
  })

  it('con 0 suscripciones no marca nada', async () => {
    const id = await openNursing(a.babyId, 45)
    const res = await check(checkA)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ subscriptions: 0, marked: 0, sent: 0 })
    expect(await alertSentAt(id)).toBeNull()
    await stopAllOpen(a.babyId)
  })

  it('marca UNA vez y manda un push cifrado, firmado y en el idioma de cada dispositivo', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, phoneA, 'es'))
    await partner.client
      .from('push_subscriptions')
      .insert(row(a.familyId, partner.userId, phonePartner, 'en'))
    const id = await openNursing(a.babyId, 31)

    const first = await check(checkA)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      subscriptions: 2,
      marked: 1,
      sent: 2,
      failed: 0,
      removed: 0,
      forbidden: 0,
      vapidSuspect: false,
      skipped: 0,
      released: 0,
    })
    expect(await alertSentAt(id)).not.toBeNull()

    const [toA] = requestsTo(`/${tag}/a`)
    const [toPartner] = requestsTo(`/${tag}/partner`)
    for (const r of [toA, toPartner]) {
      expect(r.headers['content-encoding']).toBe('aes128gcm')
      expect(r.headers.ttl).toBe('3600')
      expect(r.headers.urgency).toBe('high')
      expect(r.headers.topic).toBe(id.replace(/-/g, ''))
      verifyVapid(r.headers.authorization, {
        publicKey: vapid.publicKey,
        audience: push.origin,
        subject: vapid.subject,
      })
    }
    const es = JSON.parse(phoneA.decrypt(toA.body))
    expect(es).toEqual({
      title: 'Toma de 31 min',
      body: 'Bebe a · lado izquierdo · empezó hace 31 min. Si ya terminó, parala en Hoy.',
      tag: `nursing-long-${id}`,
      url: '/dashboard',
    })
    const en = JSON.parse(phonePartner.decrypt(toPartner.body))
    expect(en.title).toBe('Nursing for 31 min')
    expect(en.tag).toBe(`nursing-long-${id}`)

    // Segunda llamada: ya está avisada.
    const again = await check(checkA)
    expect(await again.json()).toMatchObject({ marked: 0, sent: 0 })
    expect(requestsTo(`/${tag}/a`)).toHaveLength(1)
    await stopAllOpen(a.babyId)
  })

  it('dos checks en paralelo: una marca, un envío por endpoint', async () => {
    const before = requestsTo(`/${tag}/a`).length
    await openNursing(a.babyId, 40)
    const results = await Promise.all([check(checkA), check(checkA), check(checkA)])
    const bodies = await Promise.all(results.map((r) => r.json()))
    expect(bodies.reduce((n, x) => n + x.marked, 0)).toBe(1)
    expect(requestsTo(`/${tag}/a`).length - before).toBe(1)
    await stopAllOpen(a.babyId)
  })

  it('GET hace lo mismo que POST (para un scheduler que solo manda GET)', async () => {
    const id = await openNursing(a.babyId, 33)
    const res = await check(checkA, 'GET')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ marked: 1 })
    expect(await alertSentAt(id)).not.toBeNull()
    await stopAllOpen(a.babyId)
  })

  it('respeta el umbral: 29 min no, 31 sí', async () => {
    const young = await openNursing(a.babyId, 29)
    expect(await (await check(checkA)).json()).toMatchObject({ marked: 0 })
    expect(await alertSentAt(young)).toBeNull()
    await stopAllOpen(a.babyId)
  })

  it('ignora una sesión terminada y una borrada', async () => {
    const ended = await openNursing(a.babyId, 50, {
      ended_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
    const voided = await openNursing(a.babyId, 50, { voided_at: new Date().toISOString() })
    expect(await (await check(checkA)).json()).toMatchObject({ marked: 0 })
    expect(await alertSentAt(ended)).toBeNull()
    expect(await alertSentAt(voided)).toBeNull()
  })

  it('no cruza de familia: el token de A no toca la sesión de B ni le manda a B', async () => {
    const phoneB = push.browser(`/${tag}/b`)
    await b.client.from('push_subscriptions').insert(row(b.familyId, b.userId, phoneB))
    const idB = await openNursing(b.babyId, 45)

    expect(await (await check(checkA)).json()).toMatchObject({ marked: 0 })
    expect(await alertSentAt(idB)).toBeNull()
    expect(requestsTo(`/${tag}/b`)).toHaveLength(0)

    // El de B, sí, y solo al teléfono de B.
    const beforeA = requestsTo(`/${tag}/a`).length
    expect(await (await check(checkB)).json()).toMatchObject({ marked: 1, sent: 1 })
    expect(requestsTo(`/${tag}/b`)).toHaveLength(1)
    expect(requestsTo(`/${tag}/a`)).toHaveLength(beforeA)
    await stopAllOpen(b.babyId)
  })

  it('un token clavado a un bebé no avisa por otro bebé de la familia', async () => {
    const { data: second } = await admin
      .from('babies')
      .insert({ family_id: a.familyId, name: 'Bebe a2', birth_date: '2026-09-01' })
      .select('id')
      .single()
    const other = await openNursing(second!.id, 45)
    expect(await (await check(checkPinnedA)).json()).toMatchObject({ marked: 0 })
    expect(await alertSentAt(other)).toBeNull()
    // El token de toda la familia sí la ve.
    expect(await (await check(checkA)).json()).toMatchObject({ marked: 1 })
    await stopAllOpen(second!.id)
  })

  it('el mismo endpoint en dos filas es UN envío; una fila de alguien que ya no es de la familia no recibe', async () => {
    // El socio "registró" el mismo navegador que A (dos filas, un endpoint).
    await partner.client
      .from('push_subscriptions')
      .insert(row(a.familyId, partner.userId, phoneA, 'en'))
    // Una fila de B (no es de la familia A) metida a mano con service_role.
    const stray = push.browser(`/${tag}/stray`)
    await admin.from('push_subscriptions').insert(row(a.familyId, b.userId, stray))

    const beforeA = requestsTo(`/${tag}/a`).length
    await openNursing(a.babyId, 35)
    const body = await (await check(checkA)).json()
    expect(body).toMatchObject({ marked: 1, subscriptions: 2, sent: 2, skipped: 1 })
    expect(requestsTo(`/${tag}/a`).length - beforeA).toBe(1)
    expect(requestsTo(`/${tag}/stray`)).toHaveLength(0)
    await stopAllOpen(a.babyId)
  })

  it('una suscripción que el servicio da por muerta (410) se borra', async () => {
    push.statusFor.set(`/${tag}/partner`, 410)
    const id = await openNursing(a.babyId, 32)
    const body = await (await check(checkA)).json()
    // A la de A sí le llegó: la marca queda.
    expect(body).toMatchObject({ marked: 1, removed: 1, released: 0 })
    expect(await alertSentAt(id)).not.toBeNull()
    expect(body.failed).toBeGreaterThanOrEqual(1)
    const { data } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', phonePartner.subscription.endpoint)
    expect(data).toEqual([])
    // La de A sigue.
    const { data: still } = await admin
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', phoneA.subscription.endpoint)
    expect(still!.length).toBeGreaterThan(0)
    await stopAllOpen(a.babyId)
  })

  it('un 500 del servicio no borra la suscripción y saca la marca: el próximo check reintenta', async () => {
    push.statusFor.set(`/${tag}/a`, 500)
    const beforeA = requestsTo(`/${tag}/a`).length
    const id = await openNursing(a.babyId, 32)
    try {
      const body = await (await check(checkA)).json()
      expect(body).toMatchObject({ marked: 1, sent: 0, failed: 1, removed: 0, released: 1 })
      expect(requestsTo(`/${tag}/a`).length - beforeA).toBe(1)
      expect(await alertSentAt(id)).toBeNull()
      const { data } = await admin
        .from('push_subscriptions')
        .select('id')
        .eq('endpoint', phoneA.subscription.endpoint)
      expect(data!.length).toBeGreaterThan(0)

      // El servicio vuelve (201): el siguiente check manda 1 y marca.
      push.statusFor.delete(`/${tag}/a`)
      expect(await (await check(checkA)).json()).toMatchObject({
        marked: 1,
        sent: 1,
        failed: 0,
        released: 0,
      })
      expect(requestsTo(`/${tag}/a`).length - beforeA).toBe(2)
      expect(await alertSentAt(id)).not.toBeNull()
      // Y ya no hay un tercero.
      expect(await (await check(checkA)).json()).toMatchObject({ marked: 0, sent: 0 })
    } finally {
      push.statusFor.delete(`/${tag}/a`)
      await stopAllOpen(a.babyId)
    }
  })

  it('si todas las suscripciones están muertas (410), se borran y la sesión queda sin marcar', async () => {
    const dead = push.browser(`/${tag}/dead`)
    // Solo una suscripción en la familia A, y muerta.
    await admin.from('push_subscriptions').delete().eq('family_id', a.familyId)
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, dead))
    push.statusFor.set(`/${tag}/dead`, 410)
    const id = await openNursing(a.babyId, 34)
    try {
      const body = await (await check(checkA)).json()
      expect(body).toMatchObject({ marked: 1, sent: 0, removed: 1, released: 1 })
      expect(await alertSentAt(id)).toBeNull()
      // Sin suscripciones, el próximo no marca nada.
      expect(await (await check(checkA)).json()).toMatchObject({ subscriptions: 0, marked: 0 })
      expect(await alertSentAt(id)).toBeNull()
    } finally {
      push.statusFor.delete(`/${tag}/dead`)
      await stopAllOpen(a.babyId)
    }
  })

  it('sin claves VAPID no marca nada (503)', async () => {
    const saved = process.env.VAPID_PRIVATE_KEY
    delete process.env.VAPID_PRIVATE_KEY
    try {
      const id = await openNursing(a.babyId, 40)
      expect((await check(checkA)).status).toBe(503)
      expect(await alertSentAt(id)).toBeNull()
    } finally {
      process.env.VAPID_PRIVATE_KEY = saved
      await stopAllOpen(a.babyId)
    }
  })
})

// ---------------------------------------------------------------- 403
describe('/api/push/nursing-check — 403 del servicio de push', () => {
  const tag = 'forbid'
  let live: Browser // esta sí recibe
  let dead: Browser // esta responde 403 siempre

  beforeAll(async () => {
    live = push.browser(`/${tag}/live`)
    dead = push.browser(`/${tag}/dead`)
  })
  afterAll(async () => {
    push.statusFor.delete(`/${tag}/live`)
    push.statusFor.delete(`/${tag}/dead`)
    await admin.from('push_subscriptions').delete().like('endpoint', `${push.origin}/${tag}/%`)
  })

  beforeEach(async () => {
    await admin.from('push_subscriptions').delete().eq('family_id', a.familyId)
    push.statusFor.delete(`/${tag}/live`)
    push.statusFor.delete(`/${tag}/dead`)
    await stopAllOpen(a.babyId)
  })

  async function streakOf(endpoint: string): Promise<number | null> {
    const { data } = await admin
      .from('push_subscriptions')
      .select('consecutive_403')
      .eq('endpoint', endpoint)
      .maybeSingle()
    return data ? (data.consecutive_403 as number) : null
  }

  it('selectivo: la que da 403 mientras la otra recibe se borra al TERCER chequeo', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, live))
    await partner.client.from('push_subscriptions').insert(row(a.familyId, partner.userId, dead))
    push.statusFor.set(`/${tag}/dead`, 403)

    // Chequeo 1 — una sesión larga por chequeo: el aviso sale una vez por sesión.
    await openNursing(a.babyId, 31)
    const first = await (await check(checkA)).json()
    expect(first).toMatchObject({
      marked: 1,
      sent: 1,
      forbidden: 1,
      vapidSuspect: false,
      removed: 0,
    })
    expect(await streakOf(dead.subscription.endpoint)).toBe(1)
    expect(await streakOf(live.subscription.endpoint)).toBe(0)
    await stopAllOpen(a.babyId)

    // Chequeo 2 — sigue viva, con la racha en 2.
    await openNursing(a.babyId, 31)
    const second = await (await check(checkA)).json()
    expect(second).toMatchObject({ sent: 1, forbidden: 1, removed: 0, vapidSuspect: false })
    expect(await streakOf(dead.subscription.endpoint)).toBe(2)
    await stopAllOpen(a.babyId)

    // Chequeo 3 — se borra SOLO la muerta.
    await openNursing(a.babyId, 31)
    const third = await (await check(checkA)).json()
    expect(third).toMatchObject({ sent: 1, forbidden: 1, removed: 1, vapidSuspect: false })
    expect(await streakOf(dead.subscription.endpoint)).toBeNull()
    expect(await streakOf(live.subscription.endpoint)).toBe(0)
    await stopAllOpen(a.babyId)
  })

  it('la racha es de chequeos SEGUIDOS: un envío que sale bien la devuelve a 0', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, live))
    await partner.client.from('push_subscriptions').insert(row(a.familyId, partner.userId, dead))

    push.statusFor.set(`/${tag}/dead`, 403)
    await openNursing(a.babyId, 31)
    await check(checkA)
    expect(await streakOf(dead.subscription.endpoint)).toBe(1)
    await stopAllOpen(a.babyId)

    push.statusFor.set(`/${tag}/dead`, 403)
    await openNursing(a.babyId, 31)
    await check(checkA)
    expect(await streakOf(dead.subscription.endpoint)).toBe(2)
    await stopAllOpen(a.babyId)

    // El servicio la vuelve a aceptar: la cuenta se reinicia y NO se borra.
    push.statusFor.delete(`/${tag}/dead`)
    await openNursing(a.babyId, 31)
    const back = await (await check(checkA)).json()
    expect(back).toMatchObject({ sent: 2, forbidden: 0, removed: 0 })
    expect(await streakOf(dead.subscription.endpoint)).toBe(0)
    await stopAllOpen(a.babyId)

    // Y desde cero: un 403 más no alcanza para borrarla.
    push.statusFor.set(`/${tag}/dead`, 403)
    await openNursing(a.babyId, 31)
    expect(await (await check(checkA)).json()).toMatchObject({ removed: 0, forbidden: 1 })
    expect(await streakOf(dead.subscription.endpoint)).toBe(1)
    await stopAllOpen(a.babyId)
  })

  it('todas a la vez: no borra ninguna, no toca las rachas y lo marca como VAPID', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, live))
    await partner.client.from('push_subscriptions').insert(row(a.familyId, partner.userId, dead))
    push.statusFor.set(`/${tag}/live`, 403)
    push.statusFor.set(`/${tag}/dead`, 403)

    // Tres chequeos seguidos con TODO en 403: si la regla fuera por suscripción
    // y no por contraste, acá se habrían borrado las dos.
    for (let i = 0; i < 3; i += 1) {
      const id = await openNursing(a.babyId, 31)
      const body = await (await check(checkA)).json()
      expect(body).toMatchObject({
        subscriptions: 2,
        marked: 1,
        sent: 0,
        forbidden: 2,
        vapidSuspect: true,
        removed: 0,
        // Nadie recibió: la marca vuelve y el próximo chequeo reintenta.
        released: 1,
      })
      expect(await alertSentAt(id)).toBeNull()
      expect(await streakOf(live.subscription.endpoint)).toBe(0)
      expect(await streakOf(dead.subscription.endpoint)).toBe(0)
      await stopAllOpen(a.babyId)
    }

    // Se arregla la VAPID del servidor (acá: el servicio vuelve a aceptar) y
    // las dos siguen ahí para recibir.
    push.statusFor.delete(`/${tag}/live`)
    push.statusFor.delete(`/${tag}/dead`)
    await openNursing(a.babyId, 31)
    expect(await (await check(checkA)).json()).toMatchObject({
      subscriptions: 2,
      sent: 2,
      forbidden: 0,
      vapidSuspect: false,
      removed: 0,
    })
    await stopAllOpen(a.babyId)
  })

  it('una sola suscripción en 403 nunca se borra sola: no hay con qué comparar', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, dead))
    push.statusFor.set(`/${tag}/dead`, 403)
    for (let i = 0; i < 4; i += 1) {
      await openNursing(a.babyId, 31)
      expect(await (await check(checkA)).json()).toMatchObject({
        subscriptions: 1,
        forbidden: 1,
        vapidSuspect: true,
        removed: 0,
      })
      await stopAllOpen(a.babyId)
    }
    expect(await streakOf(dead.subscription.endpoint)).toBe(0)
  })

  it('volver a suscribirse desde el navegador reinicia la racha', async () => {
    await a.client.from('push_subscriptions').insert(row(a.familyId, a.userId, live))
    await partner.client.from('push_subscriptions').insert(row(a.familyId, partner.userId, dead))
    push.statusFor.set(`/${tag}/dead`, 403)
    await openNursing(a.babyId, 31)
    await check(checkA)
    expect(await streakOf(dead.subscription.endpoint)).toBe(1)
    await stopAllOpen(a.babyId)

    // El otro padre toca "On" otra vez en ese teléfono: claves nuevas.
    const cookie = await sessionCookie(partner.email)
    const res = await subscriptionRoute(
      'POST',
      { ...dead.subscription, lang: 'en', baby_id: a.babyId },
      cookie,
    )
    expect(res.status).toBe(200)
    expect(await streakOf(dead.subscription.endpoint)).toBe(0)
  })
})
