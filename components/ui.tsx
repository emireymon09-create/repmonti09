'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'

// One place for the palette so pages can't drift apart.
export const theme = {
  bg: '#211D1B',
  card: '#332B27',
  cardHi: '#3D342F',
  line: 'rgba(237,230,214,0.12)',
  text: '#EDE6D6',
  muted: '#C9BFA9',
  accent: '#E8A33D',
  action: '#8C3B2E',
  live: '#5C8A6B',
  danger: '#C4574A',
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '16px 16px 48px' }}>
      {children}
    </div>
  )
}

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: theme.card,
        border: `1px solid ${theme.line}`,
        borderRadius: 16,
        padding: '14px 16px',
        marginBottom: 12,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: theme.muted,
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  )
}

type BtnProps = {
  children: React.ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'action' | 'quiet' | 'live'
  disabled?: boolean
  style?: React.CSSProperties
}

// 52px min height — these get tapped one-handed, in the dark, holding a baby.
export function Btn({ children, onClick, type = 'button', variant = 'action', disabled, style }: BtnProps) {
  const bg = variant === 'quiet' ? theme.cardHi : variant === 'live' ? theme.live : theme.action
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        minHeight: 52,
        padding: '10px 12px',
        borderRadius: 12,
        border: variant === 'quiet' ? `1px solid ${theme.line}` : 'none',
        background: bg,
        color: theme.text,
        fontWeight: 600,
        fontSize: 15,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        WebkitTapHighlightColor: 'transparent',
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 46,
  padding: '10px 12px',
  borderRadius: 10,
  border: `1px solid ${theme.line}`,
  background: theme.bg,
  color: theme.text,
  fontSize: 16, // 16px keeps iOS from zooming the page on focus
  fontFamily: 'inherit',
}

export function Banner({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        background: kind === 'error' ? 'rgba(196,87,74,0.18)' : 'rgba(92,138,107,0.18)',
        border: `1px solid ${kind === 'error' ? theme.danger : theme.live}`,
        color: theme.text,
        borderRadius: 12,
        padding: '10px 14px',
        marginBottom: 12,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  )
}

const TABS = [
  { href: '/dashboard', label: 'Today' },
  { href: '/growth', label: 'Growth' },
  { href: '/appointments', label: 'Doctor' },
]

export function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18 }}>
      {TABS.map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              color: active ? theme.bg : theme.muted,
              background: active ? theme.accent : 'transparent',
              border: `1px solid ${active ? theme.accent : theme.line}`,
            }}
          >
            {tab.label}
          </Link>
        )
      })}
      <button
        onClick={signOut}
        style={{
          marginLeft: 'auto',
          background: 'none',
          border: 'none',
          color: theme.muted,
          fontSize: 13,
          cursor: 'pointer',
          padding: 8,
        }}
      >
        Sign out
      </button>
    </div>
  )
}
