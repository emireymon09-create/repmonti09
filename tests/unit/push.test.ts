import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LONG_NURSING_MINUTES,
  LONG_NURSING_MS,
  isLongNursing,
  longNursingCutoff,
  minutesSince,
  nursingAlertPayload,
  nursingAlertTag,
  nursingAlertTopic,
  pickRecipients,
  subscriptionLang,
  type NursingCandidate,
} from '@/lib/push/nursing'
import {
  isAllowedPushEndpoint,
  parseEndpointBody,
  parseSubscriptionBody,
} from '@/lib/push/endpoint'
import {
  FORBIDDEN_STRIKES_BEFORE_DROP,
  decideForbidden,
  type SendOutcome,
  type SubscriptionAttempt,
} from '@/lib/push/retry'
import {
  alertsState,
  applicationServerKey,
  sameKey,
  turnAlertsOn,
  updateAlertsLang,
} from '@/lib/push/client'

// Un instante fijo en UTC: nada de esto puede depender de la TZ del sistema
// (pnpm test:tz lo corre bajo cuatro).
const NOW = new Date('2026-09-22T10:00:00.000Z')
const minutesAgo = (m: number, s = 0) =>
  new Date(NOW.getTime() - m * 60_000 - s * 1000).toISOString()

const open = (startedAt: string): NursingCandidate => ({
  started_at: startedAt,
  ended_at: null,
  voided_at: null,
  long_alert_sent_at: null,
})

describe('umbral de toma larga', () => {
  it('es de 30 minutos', () => {
    expect(LONG_NURSING_MINUTES).toBe(30)
    expect(LONG_NURSING_MS).toBe(30 * 60_000)
  })

  it('el corte es exactamente 30 min antes, en UTC', () => {
    expect(longNursingCutoff(NOW)).toBe('2026-09-22T09:30:00.000Z')
  })

  it('29 min no, 30 justos sí (inclusivo), 31 sí', () => {
    expect(isLongNursing(open(minutesAgo(29)), NOW)).toBe(false)
    expect(isLongNursing(open(minutesAgo(29, 59)), NOW)).toBe(false)
    expect(isLongNursing(open(minutesAgo(30)), NOW)).toBe(true)
    expect(isLongNursing(open(minutesAgo(31)), NOW)).toBe(true)
  })

  it('una terminada, borrada o ya avisada no califica', () => {
    const base = open(minutesAgo(45))
    expect(isLongNursing({ ...base, ended_at: minutesAgo(1) }, NOW)).toBe(false)
    expect(isLongNursing({ ...base, voided_at: minutesAgo(1) }, NOW)).toBe(false)
    expect(isLongNursing({ ...base, long_alert_sent_at: minutesAgo(10) }, NOW)).toBe(false)
  })

  it('una sesión con offset horario se compara por instante, no por texto', () => {
    // 09:31 UTC escrito en -07:00: hace 29 min, no califica.
    expect(isLongNursing(open('2026-09-22T02:31:00-07:00'), NOW)).toBe(false)
    expect(isLongNursing(open('2026-09-22T02:30:00-07:00'), NOW)).toBe(true)
  })

  it('minutos enteros hacia abajo, nunca negativos', () => {
    expect(minutesSince(minutesAgo(31, 59), NOW)).toBe(31)
    expect(minutesSince(minutesAgo(-2), NOW)).toBe(0)
  })
})

describe('payload del aviso', () => {
  const session = {
    id: '6f1c9a3e-8b2d-4c11-9e0f-0a1b2c3d4e5f',
    side: 'left' as const,
    started_at: minutesAgo(34),
    babyName: 'Amelia',
  }

  it('en inglés', () => {
    expect(nursingAlertPayload('en', session, NOW)).toEqual({
      title: 'Nursing for 34 min',
      body: 'Amelia · left side · started 34 min ago. If it’s over, stop it on Today.',
      tag: 'nursing-long-6f1c9a3e-8b2d-4c11-9e0f-0a1b2c3d4e5f',
      url: '/dashboard',
    })
  })

  it('en español, con el lado traducido', () => {
    const p = nursingAlertPayload('es', { ...session, side: 'right' }, NOW)
    expect(p.title).toBe('Toma de 34 min')
    expect(p.body).toBe('Amelia · lado derecho · empezó hace 34 min. Si ya terminó, parala en Hoy.')
    expect(p.url).toBe('/dashboard')
  })

  it('el tag y el topic son por sesión (un duplicado colapsa)', () => {
    expect(nursingAlertTag(session.id)).toBe(`nursing-long-${session.id}`)
    const topic = nursingAlertTopic(session.id)
    expect(topic).toBe('6f1c9a3e8b2d4c119e0f0a1b2c3d4e5f')
    // RFC 8030: base64url, a lo sumo 32 caracteres.
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('un idioma guardado desconocido cae en inglés', () => {
    expect(subscriptionLang('es')).toBe('es')
    expect(subscriptionLang('fr')).toBe('en')
  })
})

describe('a quién se le manda', () => {
  const sub = (id: string, user: string, endpoint: string, updated = '2026-09-01') => ({
    id,
    user_id: user,
    endpoint,
    p256dh: 'x',
    auth: 'y',
    lang: 'en',
    updated_at: updated,
  })
  const allowAll = () => true

  it('una vez por endpoint, la fila más reciente', () => {
    const { recipients } = pickRecipients(
      [
        sub('1', 'u1', 'https://fcm.googleapis.com/a', '2026-09-01'),
        sub('2', 'u2', 'https://fcm.googleapis.com/a', '2026-09-10'),
        sub('3', 'u1', 'https://fcm.googleapis.com/b'),
      ],
      ['u1', 'u2'],
      allowAll,
    )
    expect(recipients.map((r) => r.id).sort()).toEqual(['2', '3'])
  })

  it('no a alguien que ya no es de la familia, ni a un endpoint no permitido', () => {
    const { recipients, skipped } = pickRecipients(
      [
        sub('1', 'u1', 'https://fcm.googleapis.com/a'),
        sub('2', 'ex', 'https://fcm.googleapis.com/b'),
        sub('3', 'u1', 'https://169.254.169.254/latest'),
      ],
      ['u1'],
      (e) => isAllowedPushEndpoint(e),
    )
    expect(recipients.map((r) => r.id)).toEqual(['1'])
    expect(skipped).toBe(2)
  })
})

// Claves con la forma real: p256dh = punto P-256 sin comprimir (65 bytes, 0x04
// adelante), auth = 16 bytes.
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
const AUTH = Buffer.alloc(16, 9).toString('base64url')
const good = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def',
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
  lang: 'es',
}

describe('endpoint de push permitido', () => {
  it('los servicios de push reales', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://jmt17.google.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/QGx',
      'https://wns2-by3p.notify.windows.com/w/?token=x',
    ]) {
      expect(isAllowedPushEndpoint(e), e).toBe(true)
    }
  })

  it('nada de http, hosts internos, look-alikes, puertos ni credenciales', () => {
    for (const e of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://evilfcm.googleapis.com.test/x',
      'https://sites.google.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'no es una url',
      42,
      `https://fcm.googleapis.com/${'x'.repeat(2100)}`,
    ]) {
      expect(isAllowedPushEndpoint(e), String(e).slice(0, 60)).toBe(false)
    }
  })

  it('un origen extra se acepta solo si se pasa, y solo exacto', () => {
    expect(isAllowedPushEndpoint('https://127.0.0.1:4430/push/1', ['https://127.0.0.1:4430'])).toBe(
      true,
    )
    expect(isAllowedPushEndpoint('https://127.0.0.1:4431/push/1', ['https://127.0.0.1:4430'])).toBe(
      false,
    )
    expect(isAllowedPushEndpoint('http://127.0.0.1:4430/push/1', ['http://127.0.0.1:4430'])).toBe(
      false,
    )
  })
})

describe('body de la suscripción', () => {
  it('acepta lo que da PushSubscription.toJSON() + lang', () => {
    const r = parseSubscriptionBody(good)
    expect(r).toEqual({
      ok: { endpoint: good.endpoint, p256dh: P256DH, auth: AUTH, lang: 'es', babyId: null },
    })
  })

  it('lang por defecto en, y baby_id en minúsculas', () => {
    const id = '6F1C9A3E-8B2D-4C11-9E0F-0A1B2C3D4E5F'
    const r = parseSubscriptionBody({ ...good, lang: undefined, baby_id: id })
    expect('ok' in r && r.ok.lang).toBe('en')
    expect('ok' in r && r.ok.babyId).toBe(id.toLowerCase())
  })

  it('rechaza cada campo mal formado', () => {
    const bad: unknown[] = [
      null,
      'texto',
      { ...good, endpoint: 'http://fcm.googleapis.com/x' },
      { ...good, keys: undefined },
      {
        ...good,
        keys: {
          ...good.keys,
          p256dh: Buffer.alloc(65, 4).toString('base64url').replace(/^./, 'A'),
        },
      },
      { ...good, keys: { ...good.keys, p256dh: P256DH.slice(0, -2) } },
      { ...good, keys: { ...good.keys, p256dh: P256DH.replace(/.$/, '!') } },
      { ...good, keys: { ...good.keys, auth: Buffer.alloc(15).toString('base64url') } },
      { ...good, lang: 'fr' },
      { ...good, baby_id: 'la-bebe' },
    ]
    for (const b of bad)
      expect('error' in parseSubscriptionBody(b), JSON.stringify(b)?.slice(0, 80)).toBe(true)
  })

  it('DELETE solo pide un endpoint permitido', () => {
    expect(parseEndpointBody({ endpoint: good.endpoint })).toEqual({ ok: good.endpoint })
    expect('error' in parseEndpointBody({ endpoint: 'https://10.0.0.1/x' })).toBe(true)
    expect('error' in parseEndpointBody(null)).toBe(true)
  })
})

// ---------------------------------------------------------- claves y estado
//
// La otra mitad del "nada se presenta como prendido si no lo está": una
// suscripción que quedó de OTRO par de claves VAPID no sirve — el servicio de
// push contesta 403 a cada envío — y el menú no puede decir "On" por ella.

// Dos claves públicas con la forma real (punto P-256 sin comprimir, 65 bytes).
const KEY_A = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 11)]).toString('base64url')
const KEY_B = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 22)]).toString('base64url')
/** Lo que el navegador guarda en options.applicationServerKey: un ArrayBuffer. */
const keyBuffer = (b64url: string): ArrayBuffer =>
  Uint8Array.from(Buffer.from(b64url, 'base64url')).buffer

describe('la clave de la suscripción', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('la clave pública base64url se decodifica a los 65 bytes que pide subscribe()', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const key = applicationServerKey()
    expect(key).not.toBeNull()
    expect(key!.byteLength).toBe(65)
    expect(Buffer.from(key!).toString('base64url')).toBe(KEY_A)
  })

  it('sin clave, o con una que no es base64, no hay con qué suscribirse', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '')
    expect(applicationServerKey()).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'no es base64 ##')
    expect(applicationServerKey()).toBeNull()
  })

  it('el ArrayBuffer del navegador se compara byte a byte con la clave actual', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const key = applicationServerKey()!
    expect(sameKey(keyBuffer(KEY_A), key)).toBe(true)
    expect(sameKey(keyBuffer(KEY_B), key)).toBe(false)
  })

  it('un solo byte distinto, o un largo distinto, ya no es la misma clave', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const key = applicationServerKey()!
    const almost = Uint8Array.from(Buffer.from(KEY_A, 'base64url'))
    almost[64] = almost[64] ^ 1
    expect(sameKey(almost.buffer, key)).toBe(false)
    expect(sameKey(key.slice(0, 64).buffer, key)).toBe(false)
  })

  it('sin clave guardada (null/undefined) la respuesta es no, nunca "sí por las dudas"', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const key = applicationServerKey()!
    expect(sameKey(null, key)).toBe(false)
    expect(sameKey(undefined, key)).toBe(false)
  })

  it('también acepta un typed array, con su offset dentro de un buffer más grande', () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const key = applicationServerKey()!
    const padded = new Uint8Array(70)
    padded.set(key, 3)
    expect(sameKey(new Uint8Array(padded.buffer, 3, 65), key)).toBe(true)
    // El mismo buffer entero (70 bytes) no es la clave.
    expect(sameKey(padded, key)).toBe(false)
  })
})

// --------------------------------------------- el menú, con un navegador falso

type FakeSub = {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer | null }
  unsubscribed: boolean
  toJSON: () => unknown
  unsubscribe: () => Promise<boolean>
}

function fakeSub(keyB64: string, endpoint = 'https://fcm.googleapis.com/fcm/send/zz'): FakeSub {
  const sub: FakeSub = {
    endpoint,
    options: { applicationServerKey: keyBuffer(keyB64) },
    unsubscribed: false,
    toJSON: () => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } }),
    unsubscribe: async () => {
      sub.unsubscribed = true
      return true
    },
  }
  return sub
}

/**
 * Lo mínimo que mira lib/push/client.ts: service worker + PushManager +
 * Notification. `fetch` se espía para ver si se escribió la fila del server.
 */
function installBrowser(opts: {
  permission: NotificationPermission
  subscription: FakeSub | null
  /** Qué devuelve el POST/DELETE a /api/push/subscription. */
  respond?: () => Promise<Response>
}) {
  const state = { sub: opts.subscription, subscribeCalls: 0 }
  const pushManager = {
    getSubscription: async () => state.sub,
    subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      state.subscribeCalls += 1
      state.sub = fakeSub(Buffer.from(applicationServerKey).toString('base64url'))
      return state.sub
    },
  }
  const reg = { pushManager }
  const notification = {
    permission: opts.permission,
    requestPermission: async () => opts.permission,
  }
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    PushManager: class {},
    Notification: notification,
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
    maxTouchPoints: 0,
    serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
  })
  vi.stubGlobal('Notification', notification)
  const fetchMock = vi.fn(
    opts.respond ?? (async () => new Response('{}', { status: 200 })),
  ) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetch: fetchMock as unknown as ReturnType<typeof vi.fn> }
}

describe('estado de los avisos con una suscripción de otra clave', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('dice "off" y NO escribe la fila en el server', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const browser = installBrowser({ permission: 'granted', subscription: fakeSub(KEY_B) })
    expect(await alertsState('en', undefined)).toEqual({ state: 'off', error: null })
    expect(browser.fetch).not.toHaveBeenCalled()
    // No se la desuscribe por leer el menú: eso pasa al tocar "On".
    expect(browser.state.sub?.unsubscribed).toBe(false)
  })

  it('con la clave actual sí dice "on", y confirma la fila', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const browser = installBrowser({ permission: 'granted', subscription: fakeSub(KEY_A) })
    expect(await alertsState('es', 'b1')).toEqual({ state: 'on', error: null })
    expect(browser.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((browser.fetch.mock.calls[0][1] as RequestInit).body))
    expect(body.lang).toBe('es')
    expect(body.baby_id).toBe('b1')
  })

  it('si el server rechaza la confirmación, "unknown" con el motivo', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    installBrowser({
      permission: 'granted',
      subscription: fakeSub(KEY_A),
      respond: async () => new Response(JSON.stringify({ error: 'no session' }), { status: 401 }),
    })
    expect(await alertsState('en', undefined)).toEqual({ state: 'unknown', error: 'no session' })
  })

  it('al tocar "On" se desuscribe la vieja y se suscribe con la clave actual', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const stale = fakeSub(KEY_B, 'https://fcm.googleapis.com/fcm/send/vieja')
    const browser = installBrowser({ permission: 'granted', subscription: stale })
    expect(await turnAlertsOn('en', undefined)).toEqual({ state: 'on', error: null })
    expect(stale.unsubscribed).toBe(true)
    expect(browser.state.subscribeCalls).toBe(1)
    expect(browser.state.sub?.options.applicationServerKey).toEqual(keyBuffer(KEY_A))
    // Y la fila muerta se borra del server: si no, cada envío se rechaza para
    // siempre y cada check reintenta la sesión.
    const calls = browser.fetch.mock.calls.map((c) => [
      (c[1] as RequestInit).method,
      JSON.parse(String((c[1] as RequestInit).body)).endpoint,
    ])
    expect(calls).toEqual([
      ['DELETE', 'https://fcm.googleapis.com/fcm/send/vieja'],
      ['POST', 'https://fcm.googleapis.com/fcm/send/zz'],
    ])
  })

  it('el idioma tampoco se manda por una suscripción de otra clave', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const browser = installBrowser({ permission: 'granted', subscription: fakeSub(KEY_B) })
    expect(await updateAlertsLang('es', undefined)).toBeNull()
    expect(browser.fetch).not.toHaveBeenCalled()
  })
})

describe('"On" cuando el server no contesta', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const offline = async () => {
    throw new TypeError('Failed to fetch')
  }

  it('la suscripción que ya estaba NO se toca: su fila puede estar buena', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const existing = fakeSub(KEY_A)
    installBrowser({ permission: 'granted', subscription: existing, respond: offline })
    const res = await turnAlertsOn('en', undefined)
    expect(res.state).toBe('unknown')
    expect(res.error).toEqual({ kind: 'other', detail: 'Failed to fetch' })
    expect(existing.unsubscribed).toBe(false)
  })

  it('la que creó esta llamada sí se deshace: no dejar "On" por nada', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', KEY_A)
    const browser = installBrowser({ permission: 'granted', subscription: null, respond: offline })
    const res = await turnAlertsOn('en', undefined)
    expect(res.state).toBe('off')
    expect(browser.state.subscribeCalls).toBe(1)
    expect((browser.state.sub as FakeSub).unsubscribed).toBe(true)
  })
})

// ---------------------------------------------------------------- 403
// La regla entera está en lib/push/retry.ts: un 403 no dice por sí solo si la
// suscripción está muerta o si la VAPID del servidor está mal. Lo que lo dice
// es el contraste con el resto del lote.

const attempt = (id: string, outcomes: SendOutcome[], consecutive403 = 0): SubscriptionAttempt => ({
  id,
  consecutive403,
  outcomes,
})

describe('403 del servicio de push', () => {
  it('sin ningún intento no decide nada', () => {
    const d = decideForbidden([attempt('a', []), attempt('b', [])])
    expect(d).toEqual({ vapidSuspect: false, drop: [], strike: [], reset: [], forbidden: 0 })
  })

  it('403 en una mientras a otra le llega: suma, no borra', () => {
    const d = decideForbidden([attempt('muerta', ['forbidden']), attempt('viva', ['ok'])])
    expect(d.vapidSuspect).toBe(false)
    expect(d.forbidden).toBe(1)
    expect(d.strike).toEqual([{ id: 'muerta', consecutive403: 1 }])
    expect(d.drop).toEqual([])
  })

  it('al tercer chequeo seguido se borra esa suscripción, y solo esa', () => {
    const d = decideForbidden([
      attempt('muerta', ['forbidden'], 2),
      attempt('viva', ['ok']),
      attempt('recien', ['forbidden'], 0),
    ])
    expect(d.drop).toEqual(['muerta'])
    expect(d.strike).toEqual([{ id: 'recien', consecutive403: 1 }])
    expect(d.vapidSuspect).toBe(false)
  })

  it('el umbral es 3 y no 2: con racha 1 todavía no se borra', () => {
    const d = decideForbidden([attempt('x', ['forbidden'], 1), attempt('viva', ['ok'])])
    expect(d.drop).toEqual([])
    expect(d.strike).toEqual([{ id: 'x', consecutive403: 2 }])
    expect(FORBIDDEN_STRIKES_BEFORE_DROP).toBe(3)
  })

  it('TODAS en 403: no borra ninguna ni toca las rachas — es la VAPID', () => {
    const d = decideForbidden([
      attempt('a', ['forbidden'], 2),
      attempt('b', ['forbidden'], 2),
      attempt('c', ['forbidden'], 2),
    ])
    expect(d.vapidSuspect).toBe(true)
    expect(d.drop).toEqual([])
    expect(d.strike).toEqual([])
    expect(d.reset).toEqual([])
    expect(d.forbidden).toBe(3)
  })

  it('una sola suscripción en 403 también es "todas": no hay con qué comparar', () => {
    const d = decideForbidden([attempt('sola', ['forbidden'], 2)])
    expect(d.vapidSuspect).toBe(true)
    expect(d.drop).toEqual([])
  })

  it('un envío OK devuelve la racha a 0 — son chequeos SEGUIDOS', () => {
    const d = decideForbidden([attempt('vuelve', ['ok'], 2), attempt('otra', ['forbidden'])])
    expect(d.reset).toEqual(['vuelve'])
  })

  it('no gasta un update si la racha ya estaba en 0', () => {
    const d = decideForbidden([attempt('limpia', ['ok'], 0), attempt('otra', ['forbidden'])])
    expect(d.reset).toEqual([])
  })

  it('403 mezclado con errores de red y sin ningún OK: no suma ni resetea', () => {
    const d = decideForbidden([attempt('a', ['forbidden'], 1), attempt('b', ['failed'])])
    expect(d.vapidSuspect).toBe(false)
    expect(d.drop).toEqual([])
    expect(d.strike).toEqual([])
    expect(d.reset).toEqual([])
  })

  it('a la que le llegó al menos un aviso de varios está viva', () => {
    const d = decideForbidden([
      attempt('mixta', ['forbidden', 'ok'], 2),
      attempt('mala', ['forbidden', 'forbidden'], 0),
    ])
    expect(d.reset).toEqual(['mixta'])
    expect(d.strike).toEqual([{ id: 'mala', consecutive403: 1 }])
    expect(d.drop).toEqual([])
  })

  it('un 410 no cuenta como 403: lo borra el otro camino', () => {
    const d = decideForbidden([attempt('ida', ['gone'], 2), attempt('viva', ['ok'])])
    expect(d.forbidden).toBe(0)
    expect(d.drop).toEqual([])
    expect(d.strike).toEqual([])
  })
})
