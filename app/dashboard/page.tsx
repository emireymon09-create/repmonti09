'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'

type Baby = { id: string; name: string }

export default function Dashboard() {
  const supabase = createClient()
  const router = useRouter()
  const [baby, setBaby] = useState<Baby | null>(null)
  const [lastFeeding, setLastFeeding] = useState<string | null>(null)
  const [lastDiaper, setLastDiaper] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      // find the first baby belonging to a family this user is in
      const { data: babies } = await supabase
        .from('babies')
        .select('id, name')
        .limit(1)

      if (babies && babies.length > 0) {
        setBaby(babies[0])

        const { data: feedings } = await supabase
          .from('feedings')
          .select('fed_at')
          .eq('baby_id', babies[0].id)
          .order('fed_at', { ascending: false })
          .limit(1)
        if (feedings && feedings[0]) setLastFeeding(feedings[0].fed_at)

        const { data: diapers } = await supabase
          .from('diaper_changes')
          .select('changed_at')
          .eq('baby_id', babies[0].id)
          .order('changed_at', { ascending: false })
          .limit(1)
        if (diapers && diapers[0]) setLastDiaper(diapers[0].changed_at)
      }
      setLoading(false)
    }
    load()
  }, [])

  async function logFeeding(type: 'bottle' | 'nursing' | 'solid') {
    if (!baby) return
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('feedings').insert({
      baby_id: baby.id,
      feeding_type: type,
      logged_by: user?.id,
    })
    setLastFeeding(new Date().toISOString())
  }

  async function logDiaper(type: 'wet' | 'dirty' | 'both') {
    if (!baby) return
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('diaper_changes').insert({
      baby_id: baby.id,
      diaper_type: type,
      logged_by: user?.id,
    })
    setLastDiaper(new Date().toISOString())
  }

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>

  if (!baby) {
    return (
      <div style={{ padding: 24 }}>
        <p>No baby profile found yet for your account.</p>
        <p style={{ fontSize: 13, color: '#C9BFA9' }}>
          Add one directly in Supabase (Table Editor &gt; babies) —
          make sure your user is in family_members for the same
          family_id first, or the RLS policy will hide it from you.
        </p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#E8A33D' }}>
        {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
      <h1 style={{ fontSize: 30, margin: '4px 0 24px' }}>{baby.name}</h1>

      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: '#C9BFA9', textTransform: 'uppercase' }}>Last feeding</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {lastFeeding ? new Date(lastFeeding).toLocaleTimeString() : '—'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => logFeeding('bottle')} style={btnStyle}>Bottle</button>
          <button onClick={() => logFeeding('nursing')} style={btnStyle}>Nursing</button>
          <button onClick={() => logFeeding('solid')} style={btnStyle}>Solid</button>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: '#C9BFA9', textTransform: 'uppercase' }}>Last diaper</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {lastDiaper ? new Date(lastDiaper).toLocaleTimeString() : '—'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => logDiaper('wet')} style={btnStyle}>Wet</button>
          <button onClick={() => logDiaper('dirty')} style={btnStyle}>Dirty</button>
          <button onClick={() => logDiaper('both')} style={btnStyle}>Both</button>
        </div>
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#332B27',
  border: '1px solid rgba(237,230,214,0.1)',
  borderRadius: 16,
  padding: '16px 18px',
  marginBottom: 12,
}

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: '9px 0',
  borderRadius: 10,
  border: 'none',
  background: '#8C3B2E',
  color: '#EDE6D6',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
}
