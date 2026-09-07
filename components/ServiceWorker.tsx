'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker in production only.
 *
 * Deliberately not in dev: the worker caches build output, and a stale
 * chunk against `next dev`'s changing filenames produces errors that
 * look like application bugs rather than caching.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // An install failure costs offline support, not the app. The
        // page works; there is nothing useful to tell the user here.
      })
    }

    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
