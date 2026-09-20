import { createClient } from '@supabase/supabase-js'

// SERVICE ROLE KEY — bypasses RLS entirely. This file must only ever
// be imported from server-side code (API routes / route handlers),
// never from a 'use client' component or anything shipped to the
// browser. SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix) stays
// server-only by Next.js convention as long as you don't break that
// naming rule.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}
