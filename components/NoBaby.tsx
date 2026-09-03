'use client'

import { Card } from '@/components/ui'

export function NoBaby() {
  return (
    <Card>
      <p style={{ marginTop: 0 }}>No baby profile found for your account yet.</p>
      <p style={{ fontSize: 13, color: '#C9BFA9', marginBottom: 0 }}>
        Add a row in Supabase (Table Editor &gt; babies). Your user has to be
        in <code>family_members</code> for the same <code>family_id</code> first,
        or the RLS policy will hide it from you.
      </p>
    </Card>
  )
}
