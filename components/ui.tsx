'use client'

/**
 * The app's shared controls.
 *
 * Every visual value comes from a token in app/globals.css — there is
 * no hex, no px and no inline style here, per CONVENTIONS.md §3. That
 * is also what makes the wall screen work: the stylesheet re-points the
 * scale tokens above 1180px and these components grow with them.
 *
 * Destined for `packages/ui` when the monorepo lands.
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="page">{children}</div>
}

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid">{children}</div>
}

export function Card({ children, live, past, spanAll }: {
  children: React.ReactNode
  live?: boolean
  past?: boolean
  spanAll?: boolean
}) {
  const cls = ['card']
  if (live) cls.push('is-live')
  if (past) cls.push('is-past')
  if (spanAll) cls.push('span-all')
  return <div className={cls.join(' ')}>{children}</div>
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="label">{children}</div>
}

export function Btn({ children, onClick, type = 'button', variant = 'action', disabled }: {
  children: React.ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'action' | 'quiet' | 'live'
  disabled?: boolean
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={variant === 'action' ? 'btn' : `btn ${variant}`}
    >
      {children}
    </button>
  )
}

export function Banner({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return <div role="status" className={`banner ${kind}`}>{children}</div>
}

const TABS = [
  { href: '/dashboard', label: 'Today' },
  { href: '/growth', label: 'Growth' },
  { href: '/appointments', label: 'Doctor' },
]

export function Nav() {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/login')
  }

  return (
    <nav className="nav">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="tab"
          aria-current={pathname === tab.href ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
      <button className="signout" onClick={signOut}>Sign out</button>
    </nav>
  )
}
