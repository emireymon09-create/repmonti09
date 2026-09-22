'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { discardPending, flushPending, pendingFlushSettled, pendingWrites } from '@/lib/db'
import { looksOffline, onSyncNudge, retryDelay, syncOnce, type PendingWrite } from '@/lib/queue'

/**
 * Connectivity and the offline write queue.
 *
 * Flushes on mount and whenever the browser says it is back online, and
 * hands the caller the still-pending writes so the UI can show them
 * rather than pretending they are saved.
 *
 * `onFlushed` (the page's re-read) runs after anything was sent, after
 * another tab's flush finished — it may have sent this tab's entries, and
 * without a re-read they'd keep saying "not synced yet" — and every time
 * the device comes back online, so a saved offline copy or an "offline,
 * nothing here yet" gives way to fresh rows even with an empty queue.
 * A tab whose flush sent something also tells the others (BroadcastChannel
 * 'amelia-sync'), so a tab that never tried — it was online the whole
 * time — doesn't keep marks for entries another tab already sent.
 *
 * With entries still queued while connected — a request that hung and
 * was cut short, or another tab holding the queue — it tries again by
 * itself, waiting longer each time (retryDelay in lib/queue.ts), until
 * the queue empties, the device goes offline or the page closes. Going
 * back online starts the waits over. A server rejection is never retried
 * this way; it is shown, with the entry it stopped at (`syncFailed`) so
 * the user can choose to discard it (`discardFailed`) — otherwise every
 * entry queued behind it would wait forever.
 *
 * With bad wifi the browser keeps saying "online" and never fires the
 * event, so the same retries also start when an entry is queued and while
 * a page's reads fail for lack of network (nudges from lib/db.ts and
 * lib/lastSeen.ts); each retry reads the page again.
 */
const CHANNEL = 'amelia-sync'

export function useSync(onFlushed?: () => void) {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState<PendingWrite[]>([])
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncFailed, setSyncFailed] = useState<PendingWrite | null>(null)

  // Held in a ref so a caller passing an inline function doesn't
  // re-register the connectivity listeners on every render.
  const flushed = useRef(onFlushed)
  useEffect(() => {
    flushed.current = onFlushed
  })

  const channel = useRef<BroadcastChannel | null>(null)
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempt: number }>({
    timer: null,
    attempt: 0,
  })
  const cancelRetry = useCallback(() => {
    if (retry.current.timer) clearTimeout(retry.current.timer)
    retry.current.timer = null
  }, [])
  // A sync still running when the page closes must not schedule another.
  const alive = useRef(true)
  // The page's last read failed for lack of network (lastSeen nudges).
  const readsFailing = useRef(false)
  const schedule = useCallback((wait: number | null) => {
    if (wait === null || !alive.current) {
      retry.current.attempt = 0
      return
    }
    retry.current.attempt += 1
    // Each retry also reads the page again (as on 'online').
    retry.current.timer = setTimeout(() => syncRef.current(true), wait)
  }, [])
  // The retry timer calls the latest `sync` without being rescheduled.
  const syncRef = useRef<(cameOnline?: boolean) => Promise<void>>(async () => {})

  const reload = useCallback(async () => {
    setPending(await pendingWrites())
  }, [])

  const sync = useCallback(
    async (cameOnline = false) => {
      setSyncing(true)
      // The queue is shared: show what is waiting (maybe another tab's
      // entries) while this round runs, not only after it.
      await reload()
      const { result, reread } = await syncOnce(
        flushPending,
        pendingFlushSettled,
        cameOnline,
        () => navigator.onLine,
      )
      setSyncing(false)
      await reload()

      cancelRetry()
      schedule(retryDelay(result, retry.current.attempt, navigator.onLine, readsFailing.current))

      // Still offline is not a failure worth showing; a server rejection is.
      const rejected = !!result.error && !looksOffline(result.error)
      setSyncError(rejected ? result.error : null)
      setSyncFailed(rejected ? (result.failed ?? null) : null)
      if (result.sent > 0 || result.dropped > 0) channel.current?.postMessage('flushed')
      if (reread) flushed.current?.()
    },
    [reload, cancelRetry, schedule],
  )

  /** Only after the user confirmed it (components/SyncStatus.tsx). */
  const discardFailed = useCallback(
    async (ids: string[]) => {
      if (!syncFailed) return
      await discardPending(ids)
      setSyncFailed(null)
      setSyncError(null)
      await syncRef.current()
      // The discarded entry may have been on screen as "not synced yet".
      flushed.current?.()
    },
    [syncFailed],
  )
  useEffect(() => {
    syncRef.current = sync
  })

  useEffect(() => {
    alive.current = true
    setOnline(navigator.onLine)
    reload()
    if (navigator.onLine) sync()

    const goOnline = () => {
      cancelRetry()
      setOnline(true)
      retry.current.attempt = 0
      sync(true)
    }
    const goOffline = () => {
      setOnline(false)
      cancelRetry()
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // Another tab sent the queue (maybe this tab's entries): read again.
    const other = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    if (other) {
      other.onmessage = async () => {
        await reload()
        flushed.current?.()
      }
    }
    channel.current = other

    const stopNudges = onSyncNudge((kind) => {
      if (kind === 'read-ok') {
        readsFailing.current = false
        return
      }
      if (kind === 'read-failed') readsFailing.current = true
      if (kind === 'queued') reload()
      if (!retry.current.timer) {
        schedule(retryDelay(null, retry.current.attempt, navigator.onLine, true))
      }
    })

    return () => {
      stopNudges()
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      other?.close()
      channel.current = null
      alive.current = false
      cancelRetry()
    }
  }, [reload, sync, cancelRetry, schedule])

  return {
    online,
    pending,
    syncing,
    syncError,
    syncFailed,
    discardFailed,
    sync,
    reloadPending: reload,
  }
}
