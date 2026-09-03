import { redirect } from 'next/navigation'

// Nothing lives at "/" — send people to the dashboard, which bounces
// them to /login if they don't have a session yet.
export default function Home() {
  redirect('/dashboard')
}
