/*
 * Amelia — service worker.
 *
 * Job: let the app OPEN with no connection. It does not try to make the
 * data work offline; that is lib/queue.ts, in the page where the user
 * can actually see what is pending.
 *
 * Hard rules:
 *   · Same-origin GET only. Supabase requests are never touched — they
 *     carry auth tokens and must never sit in a cache on a shared
 *     wall-screen browser.
 *   · Never cache a non-OK or opaque response, nor a REDIRECTED one:
 *     installed from /login with nobody signed in, /dashboard answers
 *     with the middleware's redirect to /login, and a redirected
 *     response kept for a navigation fails it (ERR_FAILED) offline.
 *   · The private pages are cached when a signed-in page asks for it
 *     ('warm' message, lib/offlinePages.ts) — static HTML plus the
 *     scripts it names, never data.
 *   · Never cache Next's RSC payloads; a stale one breaks navigation in
 *     ways that look like the app is broken rather than offline.
 */

const VERSION = 'amelia-v5'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`

// Enough to boot every screen with no network.
const PRECACHE = [
  '/dashboard',
  '/feeding',
  '/diapers',
  '/sleep',
  '/growth',
  '/appointments',
  '/pumping',
  '/history',
  '/settings',
  '/login',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

/** A response worth keeping: ours, OK, and not the end of a redirect. */
function keepable(response) {
  return !!response && response.ok && !response.redirected && response.type === 'basic'
}

/**
 * Fetch a page and keep it, plus the build files it names (its scripts
 * and styles), so it can boot with no network. Nothing kept if the
 * server redirected — e.g. to /login, with no session.
 */
async function keepPage(url) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' })
  if (!keepable(response)) return
  const html = await response.clone().text()
  await (await caches.open(SHELL)).put(url, response)

  const assets = await caches.open(ASSETS)
  const files = new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])
  await Promise.allSettled(
    [...files].map(async (file) => {
      if (await assets.match(file)) return
      const res = await fetch(file)
      if (keepable(res)) await assets.put(file, res)
    }),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Individually, so one 404 during a deploy can't fail the install.
    Promise.allSettled(PRECACHE.map((url) => keepPage(url))).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  )
})

function isCacheable(request, url) {
  if (request.method !== 'GET') return false
  if (url.origin !== self.location.origin) return false      // Supabase, fonts
  if (url.pathname.startsWith('/api/')) return false
  if (url.searchParams.has('_rsc')) return false
  return true
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (!isCacheable(request, url)) return

  // Documents: network first, so a connected phone always gets the
  // current app; the cache is the fallback, not the source of truth.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (keepable(response)) {
            const copy = response.clone()
            caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          return cached || (await caches.match('/dashboard')) || Response.error()
        }),
    )
    return
  }

  // Build output and icons are content-hashed or stable: cache first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (keepable(response)) {
          const copy = response.clone()
          caches.open(ASSETS).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})

// Lets the page tell a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
  // A signed-in page asking to keep the app's pages for offline.
  if (event.data && event.data.type === 'warm' && Array.isArray(event.data.urls)) {
    // Only this app's own page list: never a URL a message makes up.
    const urls = event.data.urls.filter((u) => PRECACHE.includes(u))
    event.waitUntil(Promise.allSettled(urls.map((url) => keepPage(url))))
  }
})

/*
 * Push: the "nursing is running long" alert (lib/push/server.ts sends it).
 * Only shows it — nothing here touches the caches above.
 *
 * Always shows SOMETHING: a push that ends without a notification counts
 * against the site in Chrome (userVisibleOnly), so a payload that doesn't
 * parse still gets a generic one. That fallback is in English: the worker
 * has no dictionaries; the real alert comes already written in the
 * device's language.
 */
const PUSH_ICON = '/icons/icon-192.png'

/** Only a path on this origin: a push can't send the app somewhere else. */
function sameOriginPath(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/dashboard', self.location.origin)
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/dashboard'
  } catch {
    return '/dashboard'
  }
}

self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  const ok = data && typeof data.title === 'string' && data.title
  const title = ok ? data.title : 'Amelia'
  const options = {
    body: ok && typeof data.body === 'string' ? data.body : 'Open Amelia to see what’s new.',
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    // Same tag = the same session's alert: a duplicate replaces it instead of
    // stacking a second one, and doesn't buzz again.
    tag: ok && typeof data.tag === 'string' ? data.tag : 'amelia',
    renotify: false,
    data: { url: sameOriginPath(ok ? data.url : undefined) },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = sameOriginPath(event.notification.data && event.notification.data.url)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const mine = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (mine) {
        const focused = await mine.focus()
        // navigate() only works on a window this worker controls.
        if (new URL(focused.url).pathname !== path && 'navigate' in focused) {
          try {
            await focused.navigate(path)
          } catch {
            /* focused is enough */
          }
        }
        return
      }
      await self.clients.openWindow(path)
    }),
  )
})
