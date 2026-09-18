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
 *   · Never cache a non-OK or opaque response.
 *   · Never cache Next's RSC payloads; a stale one breaks navigation in
 *     ways that look like the app is broken rather than offline.
 */

const VERSION = 'amelia-v2'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`

// Enough to boot every screen with no network.
const PRECACHE = [
  '/dashboard',
  '/growth',
  '/appointments',
  '/pumping',
  '/history',
  '/login',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // Individually, so one 404 during a deploy can't fail the install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
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
          if (response && response.ok) {
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
        if (response && response.ok && response.type === 'basic') {
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
})
