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

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'
import { resetPumpingTotal } from '@/lib/db'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import { useTheme, type Theme } from '@/lib/theme'
import { APP_VERSION } from '@/lib/version'

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="page">{children}</div>
}

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid">{children}</div>
}

export function Card({
  children,
  live,
  past,
  spanAll,
}: {
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

export function Btn({
  children,
  onClick,
  type = 'button',
  variant = 'action',
  disabled,
}: {
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

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'ok' | 'warn'
  children: React.ReactNode
}) {
  return (
    <div role="status" className={`banner ${kind}`}>
      {children}
    </div>
  )
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const TABS = [
  { href: '/dashboard', label: 'Today' },
  { href: '/pumping', label: 'Milk' },
  { href: '/growth', label: 'Growth' },
  { href: '/appointments', label: 'Doctor' },
  { href: '/history', label: 'History' },
]

export function Nav({ babyId }: { babyId?: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [unit, setUnit] = useVolumeUnit()
  const [theme, setTheme] = useTheme()
  const settingsRef = useRef<HTMLDivElement>(null)
  const gearRef = useRef<HTMLButtonElement>(null)

  // onBlur alone can't close the menu: Safari on iOS never focuses a tapped
  // button, so a tap elsewhere wouldn't blur anything. Close on any press
  // outside, and on Escape (focus back to the gear, where it came from).
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (!settingsRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      gearRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/login')
  }

  function switchUnit() {
    setMenuOpen(false)
    setUnit(unit === 'oz' ? 'ml' : 'oz')
    // Every page that shows an amount reads the unit once on mount —
    // reloading is the simplest way to make the switch take everywhere
    // at once, matching how "Reset milk total" already refreshes.
    window.location.reload()
  }

  async function resetMilkTotal() {
    if (!babyId || resetting) return
    // Close the menu first: the confirm must never sit on top of it.
    setMenuOpen(false)
    if (!window.confirm('Zero out the "in the stash" total? Past sessions stay in History.')) return
    setResetting(true)
    const { error } = await resetPumpingTotal(babyId)
    setResetting(false)
    if (error) {
      window.alert(`Couldn't reset — ${error}`)
      return
    }
    window.location.reload()
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
      <div
        ref={settingsRef}
        className="nav-settings"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setMenuOpen(false)
        }}
      >
        <button
          ref={gearRef}
          className="gear"
          aria-label="Settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {'\u2699'}
        </button>
        {menuOpen && (
          <div className="nav-menu" role="menu" aria-label="Settings">
            <div className="nav-menu-group" role="group" aria-labelledby="theme-label">
              <div className="label" id="theme-label">
                Theme
              </div>
              <div className="seg">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === t.value}
                    className="seg-btn"
                    onClick={() => setTheme(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <button role="menuitem" className="nav-menu-item" onClick={switchUnit}>
              Switch to {unit === 'oz' ? 'ml' : 'oz'}
            </button>
            {babyId && (
              <button
                role="menuitem"
                className="nav-menu-item"
                onClick={resetMilkTotal}
                disabled={resetting}
              >
                {resetting ? 'Resetting…' : 'Reset milk total'}
              </button>
            )}
            <button
              role="menuitem"
              className="nav-menu-item"
              onClick={() => {
                setMenuOpen(false)
                router.push('/version')
              }}
            >
              Version history · v{APP_VERSION}
            </button>
            <button role="menuitem" className="nav-menu-item" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </nav>
  )
}
