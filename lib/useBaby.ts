'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'

export type Baby = { id: string; name: string; birth_date: string | null }

/**
 * Auth guard + "which baby am I looking at" in one hook, since every
 * page needs both. RLS already limits `babies` to the caller's family,
 * so an unscoped select can only ever return our own.
 */
export function useBaby() {
  const router = useRouter()
  const [baby, setBaby] = useState<Baby | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.replace('/login')
        return
      }
      const { data } = await supabase
        .from('babies')
        .select('id, name, birth_date')
        .order('created_at', { ascending: true })
        .limit(1)

      if (cancelled) return
      setUserId(user.id)
      setBaby(data && data.length > 0 ? (data[0] as Baby) : null)
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [router])

  return { baby, userId, loading }
}
