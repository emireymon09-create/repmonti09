/**
 * The app's pages the service worker keeps for opening with no
 * connection (public/sw.js).
 *
 * The worker installs from whatever page registers it — usually /login,
 * with nobody signed in yet — and at that moment every private page
 * answers with the middleware's redirect to /login, which it must not
 * keep. So once someone is signed in and connected, the page asks it to
 * fetch and keep them (with their scripts). Pages only: the HTML is the
 * same static, English shell for everyone. Data never goes through the
 * worker (CLAUDE.md §5.5); offline data is lib/lastSeen.ts.
 */
export const OFFLINE_PAGES = [
  '/dashboard',
  '/feeding',
  '/diapers',
  '/sleep',
  '/history',
  '/growth',
  '/pumping',
  '/appointments',
]

let warmed = false

/** Once per page load; a no-op without a service worker (dev, old browsers). */
export function warmOfflinePages(): void {
  if (warmed || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  warmed = true
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'warm', urls: OFFLINE_PAGES }))
    .catch(() => {
      /* offline support is lost, not the app */
    })
}
