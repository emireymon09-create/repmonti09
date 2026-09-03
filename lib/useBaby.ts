'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'
import { currentBaby } from '@/lib/db'
import type { Baby } from '@/lib/types'

/**
 * Auth guard plus "which baby am I looking at", since every page needs
 * both. RLS scopes `babies` to the caller's family, so an unscoped
 * select can only return our own.
 *
 * Phase 2: this becomes the household + role hook — the caregiver role
 * in ARCHITECTURE.md §2 is checked here, once, rather than per page.
 */
export function useBaby() {
  const router = useRouter()
  const [baby, setBaby] = useState<Baby | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data: { user } } = await createClient().auth.getUser()
      if (!user) {
        router.replace('/login')
        return
      }
      const { data } = await currentBaby()
      if (cancelled) return
      setUserId(user.id)
      setBaby(data)
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [router])

  return { baby, userId, loading }
}
