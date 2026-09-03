import { createBrowserClient } from '@supabase/ssr'

// Anon key only — this file is safe to ship to the browser.
// RLS policies in schema.sql are what actually protect the data.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
