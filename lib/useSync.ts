'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushPending, pendingWrites } from '@/lib/db'
import { looksOffline, type PendingWrite } from '@/lib/queue'

/**
 * Connectivity and the offline write queue.
 *
 * Flushes on mount and whenever the browser says it is back online, and
 * hands the caller the still-pending writes so the UI can show them
 * rather than pretending they are saved.
 */
export function useSync(onFlushed?: () => void) {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState<PendingWrite[]>([])
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // Held in a ref so a caller passing an inline function doesn't
  // re-register the connectivity listeners on every render.
  const flushed = useRef(onFlushed)
  useEffect(() => {
    flushed.current = onFlushed
  })

  const reload = useCallback(async () => {
    setPending(await pendingWrites())
  }, [])

  const sync = useCallback(async () => {
    setSyncing(true)
    const result = await flushPending()
    setSyncing(false)
    await reload()

    // Still offline is not a failure worth showing; a server rejection is.
    setSyncError(result.error && !looksOffline(result.error) ? result.error : null)
    if (result.sent > 0 || result.dropped > 0) flushed.current?.()
  }, [reload])

  useEffect(() => {
    setOnline(navigator.onLine)
    reload()
    if (navigator.onLine) sync()

    const goOnline = () => {
      setOnline(true)
      sync()
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [reload, sync])

  return { online, pending, syncing, syncError, sync, reloadPending: reload }
}
