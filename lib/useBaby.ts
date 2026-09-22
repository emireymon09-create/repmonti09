'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'
import { currentBaby } from '@/lib/db'
import { forgetSeen, readSeen, saveSeen, seenKey } from '@/lib/lastSeen'
import { looksOffline } from '@/lib/queue'
import { warmOfflinePages } from '@/lib/offlinePages'
import type { Baby } from '@/lib/types'

type SeenBaby = { userId: string; baby: Baby | null }

/**
 * "The server couldn't be asked", as opposed to "nobody is signed in".
 * Offline, getUser() fails even with a session on the device (it checks
 * with the server, and an expired access token can't be refreshed); a
 * missing session is a different error and always means the login page.
 */
function unreachable(error: { name?: string; message?: string } | null): boolean {
  if (!error || error.name === 'AuthSessionMissingError') return false
  return error.name === 'AuthRetryableFetchError' || looksOffline(error.message ?? null)
}

/**
 * Auth guard plus "which baby am I looking at", since every page needs
 * both. RLS scopes `babies` to the caller's family, so an unscoped
 * select can only return our own.
 *
 * Offline, with a session on the device that can't be checked, it falls
 * back to the baby this device last saw (lib/lastSeen.ts) so a reload
 * during an outage still opens the app. With nothing saved, `unreachable`
 * says so, and the page shows that instead of "no baby profile".
 *
 * Phase 2: this becomes the household + role hook — the caregiver role
 * in ARCHITECTURE.md §2 is checked here, once, rather than per page.
 */
export function useBaby() {
  const router = useRouter()
  const [baby, setBaby] = useState<Baby | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreachableNow, setUnreachable] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Showing the device's saved baby, or "offline, nothing saved": asked
    // again as soon as the connection is back, not on the next reload.
    let fromDevice = false

    async function load() {
      const {
        data: { user },
        error: authError,
      } = await createClient().auth.getUser()
      if (cancelled) return

      if (!user) {
        if (unreachable(authError)) {
          const seen = readSeen<SeenBaby>(seenKey.baby)
          setUserId(seen?.rows.userId ?? null)
          setBaby(seen?.rows.baby ?? null)
          setUnreachable(!seen)
          setLoading(false)
          fromDevice = true
          return
        }
        // Nobody signed in: nothing of the last family stays on the screen.
        forgetSeen()
        router.replace('/login')
        return
      }

      const { data, error } = await currentBaby()
      if (cancelled) return
      fromDevice = false
      if (!error) {
        saveSeen<SeenBaby>(seenKey.baby, { userId: user.id, baby: data })
        setBaby(data)
        setUnreachable(false)
        // Signed in and connected: have the service worker keep the app's
        // pages, so a reload with no connection still opens.
        warmOfflinePages()
      } else if (looksOffline(error)) {
        const seen = readSeen<SeenBaby>(seenKey.baby)
        const mine = seen && seen.rows.userId === user.id ? seen.rows.baby : null
        setBaby(mine)
        setUnreachable(!mine)
        fromDevice = true
      } else {
        setBaby(null)
        setUnreachable(false)
      }
      setUserId(user.id)
      setLoading(false)
    }

    const goOnline = () => {
      if (fromDevice) load()
    }
    load()
    window.addEventListener('online', goOnline)
    return () => {
      cancelled = true
      window.removeEventListener('online', goOnline)
    }
  }, [router])

  // Re-reads just the baby row — for the moment `birth_date` actually
  // changes (the "she's here" action) without re-running the auth check.
  const refreshBaby = useCallback(async () => {
    const { data, error } = await currentBaby()
    // Offline the read fails: keep the baby on screen rather than drop it.
    if (error) return
    setBaby(data)
  }, [])

  return { baby, userId, loading, refreshBaby, unreachable: unreachableNow }
}
