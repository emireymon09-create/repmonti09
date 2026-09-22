'use client'

/**
 * Nursing alerts, on the device's side: can this browser get them, are they
 * on, and turning them on and off. The server half (saving the subscription,
 * sending) is app/api/push/* + lib/push/server.ts.
 *
 * Honest by construction: every function returns the state it actually left
 * the device in, and an error string when something failed — never "on"
 * unless both the browser subscription and the server row exist.
 */

import type { Lang } from '@/lib/i18n'

export type AlertsState =
  /** No service worker / PushManager / Notification in this browser. */
  | 'unsupported'
  /** iPhone/iPad in the browser: push only exists in the installed app. */
  | 'install'
  /** The user (or the browser) blocked notifications for this site. */
  | 'denied'
  /** This deployment has no VAPID public key: nothing could ever be sent. */
  | 'unavailable'
  /**
   * The browser has a subscription but the server couldn't confirm its row
   * (no connection, session gone): neither "on" nor "off" would be true.
   */
  | 'unknown'
  | 'off'
  | 'on'

/**
 * Why a switch failed. `noWorker` and `notGranted` have their own copy; any
 * other failure carries the raw detail (like the banners do with Supabase).
 */
export type AlertsError = { kind: 'noWorker' | 'notGranted' } | { kind: 'other'; detail: string }

const ENDPOINT = '/api/push/subscription'
/** How long to wait for the service worker before telling the user. */
const WORKER_WAIT_MS = 8_000
/** Sign-out must never hang on this: past it, the session ends anyway. */
const SIGN_OUT_WAIT_MS = 4_000

function hasPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** iOS/iPadOS Safari outside the Home Screen app (where PushManager is missing). */
function isAppleMobileBrowser(): boolean {
  const ua = navigator.userAgent
  const appleMobile =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return appleMobile && !standalone
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

async function currentSubscription(): Promise<PushSubscription | null> {
  // getRegistration, not ready: ready never settles where no worker is
  // registered (dev), and reading the state must not hang the menu.
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/**
 * The subscription this deployment could actually send to: the one in the
 * browser, but only if it was made with the VAPID key pair this deployment
 * signs with. One made with an older pair is worth nothing — the push service
 * answers 403 to every send — so here it counts as no subscription at all.
 */
async function usableSubscription(key: Uint8Array<ArrayBuffer>): Promise<PushSubscription | null> {
  const sub = await currentSubscription()
  if (!sub) return null
  return sameKey(sub.options.applicationServerKey, key) ? sub : null
}

/**
 * What the browser alone says. 'on' here only means a usable subscription
 * exists in this browser — not that the server will send to it; alertsState()
 * checks that.
 *
 * A subscription left over from another key pair reads as 'off', not
 * 'unknown': nothing is uncertain about it — we know the service would refuse
 * it. 'off' is also what repairs it, because "On" stays tappable and
 * turnAlertsOn() drops the stale one and subscribes with the current key.
 */
async function browserState(): Promise<AlertsState> {
  if (!hasPush()) return isAppleMobileBrowser() ? 'install' : 'unsupported'
  const key = applicationServerKey()
  if (!key) return 'unavailable'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  try {
    return (await usableSubscription(key)) ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

/**
 * The state right now, without asking the user anything. "On" needs the
 * server's row too: with a usable browser subscription, the row is saved again
 * (an upsert, in the current language) with this parent's session, and only its
 * success says "on". If that fails the state is 'unknown', with the reason.
 *
 * A subscription made with another VAPID key pair never gets here: browserState
 * already reads it as 'off', so no row is written for something that could
 * never be signed for.
 */
export async function alertsState(
  lang: Lang,
  babyId: string | undefined,
): Promise<{ state: AlertsState; error: string | null }> {
  const state = await browserState()
  const key = applicationServerKey()
  if (state !== 'on' || !key) return { state, error: null }
  let sub: PushSubscription | null
  try {
    sub = await usableSubscription(key)
  } catch (e) {
    return { state: 'unknown', error: describe(e) }
  }
  if (!sub) return { state: 'off', error: null }
  const failed = await send('POST', { ...sub.toJSON(), lang, baby_id: babyId ?? null })
  return failed ? { state: 'unknown', error: failed } : { state: 'on', error: null }
}

/**
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY as the raw bytes `pushManager.subscribe` wants.
 * The env var is base64url (what `pnpm vapid-keys` prints); this is the same
 * 65-byte P-256 point the browser hands back in
 * `subscription.options.applicationServerKey`. Exported for the tests.
 */
export function applicationServerKey(): Uint8Array<ArrayBuffer> | null {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!key) return null
  try {
    const b64 = key.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
  } catch {
    // A key that isn't base64 can't be subscribed with: same as having none.
    return null
  }
}

/**
 * Is an existing subscription's key this deployment's key? `a` is what the
 * browser stores in `options.applicationServerKey`: an ArrayBuffer in Chrome,
 * and null where the browser doesn't keep it (then the answer is no — better
 * to re-subscribe than to claim "On" for something that may not be signable).
 * A typed-array is accepted too, for browsers that hand one back.
 * Exported for the tests.
 */
export function sameKey(
  a: ArrayBuffer | ArrayBufferView | null | undefined,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  if (!a) return false
  const view = ArrayBuffer.isView(a)
    ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    : new Uint8Array(a)
  if (view.byteLength !== b.byteLength) return false
  return view.every((byte, i) => byte === b[i])
}

async function send(method: 'POST' | 'DELETE', body: unknown): Promise<string | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method,
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    if (res.ok) return null
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    return data?.error ?? `HTTP ${res.status}`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

/**
 * Turn alerts on. MUST be called straight from a tap: the permission prompt
 * is the first thing it does, and browsers only show it on a user gesture.
 */
export async function turnAlertsOn(
  lang: Lang,
  babyId: string | undefined,
): Promise<{ state: AlertsState; error: AlertsError | null }> {
  if (!hasPush()) {
    return { state: isAppleMobileBrowser() ? 'install' : 'unsupported', error: null }
  }
  // Before the permission prompt: asking for it with nothing able to send
  // would leave the site allowed to notify for no reason.
  const key = applicationServerKey()
  if (!key) return { state: 'unavailable', error: null }
  let permission: NotificationPermission
  try {
    permission = await Notification.requestPermission()
  } catch (e) {
    return { state: 'off', error: { kind: 'other', detail: describe(e) } }
  }
  if (permission === 'denied') return { state: 'denied', error: null }
  if (permission !== 'granted') return { state: 'off', error: { kind: 'notGranted' } }

  const reg = await waitFor(navigator.serviceWorker.ready, WORKER_WAIT_MS)
  if (!reg) return { state: 'off', error: { kind: 'noWorker' } }

  let sub: PushSubscription
  /** Did THIS call create the subscription? Decides what to undo on failure. */
  let created = false
  try {
    let existing = await reg.pushManager.getSubscription()
    // Made with another key pair (keys rotated): the server can't sign for it.
    if (existing && !sameKey(existing.options.applicationServerKey, key)) {
      const dead = existing.endpoint
      await existing.unsubscribe()
      existing = null
      // And its row goes too: left there, every send to it would be refused
      // by the push service forever, and a nursing session whose alert
      // reached nobody is retried by every check (lib/push/server.ts).
      await send('DELETE', { endpoint: dead })
    }
    if (existing) {
      sub = existing
    } else {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      created = true
    }
  } catch (e) {
    return { state: 'off', error: { kind: 'other', detail: describe(e) } }
  }

  const failed = await send('POST', { ...sub.toJSON(), lang, baby_id: babyId ?? null })
  if (failed) {
    // Only undo what this call did. A subscription that was already here may
    // well have its row on the server (that's exactly the 'unknown' case: the
    // check couldn't reach it), and unsubscribing would kill alerts that work.
    // One this call just made has no row — leaving it would make the switch
    // look on for nothing.
    if (!created) return { state: 'unknown', error: { kind: 'other', detail: failed } }
    await sub.unsubscribe().catch(() => {})
    return { state: 'off', error: { kind: 'other', detail: failed } }
  }
  return { state: 'on', error: null }
}

/**
 * Turn alerts off: the server forgets this device and the browser drops the
 * subscription. If the server can't be reached, the browser side still goes —
 * its endpoint is then dead, and the next alert the server tries gets a 410
 * and deletes the row (lib/push/server.ts). Either way nothing arrives here.
 */
export async function turnAlertsOff(): Promise<{ state: AlertsState; error: AlertsError | null }> {
  if (!hasPush()) return { state: await browserState(), error: null }
  let sub: PushSubscription | null
  try {
    sub = await currentSubscription()
  } catch (e) {
    return { state: await browserState(), error: { kind: 'other', detail: describe(e) } }
  }
  if (!sub) return { state: await browserState(), error: null }
  await send('DELETE', { endpoint: sub.endpoint })
  try {
    await sub.unsubscribe()
  } catch (e) {
    return { state: await browserState(), error: { kind: 'other', detail: describe(e) } }
  }
  return { state: await browserState(), error: null }
}

/** The language changed: have the server write this device's alerts in it. */
export async function updateAlertsLang(
  lang: Lang,
  babyId: string | undefined,
): Promise<string | null> {
  if (!hasPush() || Notification.permission !== 'granted') return null
  const key = applicationServerKey()
  if (!key) return null
  let sub: PushSubscription | null
  try {
    // Same rule as everywhere else: no row is written for a subscription this
    // deployment couldn't sign for.
    sub = await usableSubscription(key)
  } catch {
    return null
  }
  if (!sub) return null
  return send('POST', { ...sub.toJSON(), lang, baby_id: babyId ?? null })
}

/**
 * After signing in (app/login): a subscription left in this browser belongs
 * to whoever used it before — maybe another parent whose sign-out couldn't
 * reach the server. It's dropped so the new session never starts at "On"
 * with someone else's alerts. Its row can't be deleted from here (it isn't
 * this session's): the endpoint is dead from now on, and the server's next
 * send gets a 410 and deletes it (lib/push/server.ts). Bounded, like
 * sign-out.
 */
export async function dropLocalAlerts(): Promise<void> {
  if (!hasPush()) return
  await waitFor(
    (async () => {
      const sub = await currentSubscription().catch(() => null)
      await sub?.unsubscribe().catch(() => false)
    })(),
    SIGN_OUT_WAIT_MS,
  )
}

/**
 * Before signing out (components/ui.tsx): this may be a shared screen, and the
 * next person must not get this family's alerts. Needs the session for the
 * DELETE, so it runs first; bounded, so a dead network can't block sign-out.
 */
export async function forgetAlertsOnSignOut(): Promise<void> {
  if (!hasPush()) return
  await waitFor(
    (async () => {
      const sub = await currentSubscription().catch(() => null)
      if (!sub) return
      await Promise.allSettled([send('DELETE', { endpoint: sub.endpoint }), sub.unsubscribe()])
    })(),
    SIGN_OUT_WAIT_MS,
  )
}
