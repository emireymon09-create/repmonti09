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
import { forgetSeen } from '@/lib/lastSeen'
import { forgetAlertsOnSignOut } from '@/lib/push/client'
import { NursingAlerts } from '@/components/NursingAlerts'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import { useTheme, type Theme } from '@/lib/theme'
import { APP_VERSION } from '@/lib/version'
import { useLanguageChoice, useT } from '@/lib/i18n/react'
import type { LangChoice, MessageKey } from '@/lib/i18n'

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="page">{children}</div>
}

export function Grid({ children, even }: { children: React.ReactNode; even?: boolean }) {
  // `even`: las tarjetas de la fila miden todas lo mismo. Lo usa Today con sus
  // tres tarjetas — ver .grid.even y .card.is-even en app/globals.css.
  return <div className={even ? 'grid even' : 'grid'}>{children}</div>
}

export function Card({
  children,
  live,
  past,
  spanAll,
  even,
  quickLink,
}: {
  children: React.ReactNode
  live?: boolean
  past?: boolean
  spanAll?: boolean
  /** Dentro de un <Grid even>: estira la tarjeta al alto de la más alta. */
  even?: boolean
  /** Ícono de acceso rápido en la esquina, a la sección de esta tarjeta. */
  quickLink?: { href: string; label: string }
}) {
  const cls = ['card']
  if (live) cls.push('is-live')
  if (past) cls.push('is-past')
  if (spanAll) cls.push('span-all')
  if (even) cls.push('is-even')
  if (quickLink) cls.push('has-quick')
  return (
    <div className={cls.join(' ')}>
      {quickLink && (
        <Link href={quickLink.href} className="card-quick" aria-label={quickLink.label}>
          <NavIcon name="open" />
        </Link>
      )}
      {children}
    </div>
  )
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

export { Banner } from '@/components/Banner'

const THEMES: { value: Theme; label: MessageKey }[] = [
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
  { value: 'system', label: 'theme.system' },
]

// Same shape as the theme picker, right under it. "System" first: it is what
// a device gets until someone chooses, and it follows the phone's language.
const LANGUAGES: { value: LangChoice; label: MessageKey }[] = [
  { value: 'system', label: 'language.system' },
  { value: 'en', label: 'language.en' },
  { value: 'es', label: 'language.es' },
]

// Stroke icons for the phone's bottom bar, drawn on a 24-unit grid in
// currentColor so they follow the tab's state and the theme. The wall and
// tablet nav hide them on the tabs (app/globals.css) — there the labels have
// room — and keep only the gear's, which is an icon everywhere.
const ICONS = {
  today: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  milk: [
    'M10.5 5.5c0-1.6.6-3 1.5-3s1.5 1.4 1.5 3',
    'M8.5 5.5h7V8h-7z',
    'M9 8l-.5 2v10a1.5 1.5 0 0 0 1.5 1.5h4a1.5 1.5 0 0 0 1.5-1.5V10L15 8',
    'M8.5 13.5h3M8.5 17h3',
  ],
  growth: ['M3 20.5h18', 'M4 16l5-5 4 3 7-7', 'M15 7h5v5'],
  feeding: ['M7 3v7a3 3 0 0 0 6 0V3', 'M10 13v8', 'M18 3c-1.5 1.5-2 3.5-2 6v4h2'],
  diapers: ['M4 5h16v5a9 9 0 0 1-8 9 9 9 0 0 1-8-9z', 'M9 19.5c1-2 5-2 6 0'],
  sleep: ['M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z', 'M15 4.5h4l-4 4h4'],
  version: ['M12 3.5 20 8v8l-8 4.5L4 16V8z', 'M12 12v8.5', 'M4 8l8 4 8-4'],
  /** Esquina de una tarjeta de Today: "abrir esta sección". */
  open: ['M8 16 16 8', 'M10 8h6v6'],
  doctor: ['M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3.5 3.5V8H8', 'M12 7.5V12l3 2'],
  settings: [
    'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1',
    'M15 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M9 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  ],
} as const

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[name].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  )
}

/**
 * La barra ancha (tablet y pantalla de pared): los destinos que entran en una
 * línea. En el teléfono, app/globals.css deja visible SOLO el primero — ver
 * SECTIONS.
 */
const TABS = [
  { href: '/dashboard', label: 'nav.today', icon: 'today' },
  { href: '/pumping', label: 'nav.milk', icon: 'milk' },
  { href: '/growth', label: 'nav.growth', icon: 'growth' },
  { href: '/appointments', label: 'nav.doctor', icon: 'doctor' },
  { href: '/history', label: 'nav.history', icon: 'history' },
] as const

/**
 * Las 8 pantallas que NO son Today, adentro del menú.
 *
 * En el teléfono la barra inferior es de dos ítems —Today y Menu— porque con
 * seis no entraba: a 320px las etiquetas se cortaban y el área táctil de cada
 * una quedaba por debajo de lo que se puede acertar con el pulgar a las 3 de
 * la mañana. Todo lo demás vive acá.
 *
 * Y de paso cierra un hueco viejo: /feeding, /diapers y /sleep existen desde
 * el 22 sep 2026 y no tenían ninguna entrada de navegación — solo se llegaba
 * desde el pie de su tarjeta en Today.
 */
const SECTIONS = [
  { href: '/feeding', label: 'nav.feeding', icon: 'feeding' },
  { href: '/diapers', label: 'nav.diapers', icon: 'diapers' },
  { href: '/sleep', label: 'nav.sleep', icon: 'sleep' },
  { href: '/pumping', label: 'nav.milk', icon: 'milk' },
  { href: '/growth', label: 'nav.growth', icon: 'growth' },
  { href: '/appointments', label: 'nav.doctor', icon: 'doctor' },
  { href: '/history', label: 'nav.history', icon: 'history' },
  { href: '/version', label: 'nav.version', icon: 'version' },
] as const

export function Nav({ babyId }: { babyId?: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [unit, setUnit] = useVolumeUnit()
  const [theme, setTheme] = useTheme()
  const [langChoice, setLangChoice] = useLanguageChoice()
  const { t } = useT()
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
    // First, and whatever signOut() does offline: this screen is shared,
    // and the family's rows saved for offline must not outlive the session.
    forgetSeen()
    // Then this device's nursing alerts: the next person on this screen must
    // not get this family's notifications. Before signOut() — deleting the
    // server row needs the session — and bounded, so it can't block it.
    await forgetAlertsOnSignOut()
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
    if (!window.confirm(t('menu.resetConfirm'))) return
    setResetting(true)
    const { error } = await resetPumpingTotal(babyId)
    setResetting(false)
    if (error) {
      window.alert(t('menu.resetFailed', { error }))
      return
    }
    window.location.reload()
  }

  return (
    <nav className="nav">
      {TABS.map((tab, i) => (
        <Link
          key={tab.href}
          href={tab.href}
          // `tab-home` es el único que sobrevive en el teléfono: la barra de
          // abajo son dos ítems, Today y Menu (app/globals.css, @max-599px).
          className={i === 0 ? 'tab tab-home' : 'tab'}
          aria-current={pathname === tab.href ? 'page' : undefined}
        >
          <NavIcon name={tab.icon} />
          {t(tab.label)}
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
          aria-label={t('nav.menu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <NavIcon name="settings" />
          <span className="gear-label" aria-hidden="true">
            {t('nav.menu')}
          </span>
        </button>
        {menuOpen && (
          <div className="nav-menu" role="menu" aria-label={t('nav.menu')}>
            {/* Las 8 pantallas que no son Today. En el teléfono es la ÚNICA
                forma de llegar a ellas; en la pared duplica la barra de
                arriba, y aun así suma: /feeding, /diapers y /sleep no estaban
                en ninguna barra. */}
            <div className="nav-menu-group" role="group" aria-labelledby="goto-label">
              <div className="label" id="goto-label">
                {t('menu.goTo')}
              </div>
              <div className="nav-menu-links">
                {SECTIONS.map((s) => (
                  <Link
                    key={s.href}
                    href={s.href}
                    role="menuitem"
                    className="nav-menu-link"
                    aria-current={pathname === s.href ? 'page' : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    <NavIcon name={s.icon} />
                    <span className="nav-menu-link-text">{t(s.label)}</span>
                    {s.href === '/version' && (
                      <span className="nav-menu-link-meta">v{APP_VERSION}</span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
            <div className="nav-menu-group" role="group" aria-labelledby="theme-label">
              <div className="label" id="theme-label">
                {t('menu.theme')}
              </div>
              <div className="seg">
                {THEMES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === option.value}
                    className="seg-btn"
                    onClick={() => setTheme(option.value)}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="nav-menu-group" role="group" aria-labelledby="language-label">
              <div className="label" id="language-label">
                {t('menu.language')}
              </div>
              <div className="seg">
                {LANGUAGES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={langChoice === option.value}
                    className="seg-btn"
                    // Each language is named in itself; this tells a screen
                    // reader to read "Español" with Spanish rules.
                    lang={option.value === 'system' ? undefined : option.value}
                    onClick={() => setLangChoice(option.value)}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>
            <NursingAlerts babyId={babyId} />
            <button role="menuitem" className="nav-menu-item" onClick={switchUnit}>
              {t('menu.switchUnit', { unit: unit === 'oz' ? 'ml' : 'oz' })}
            </button>
            {babyId && (
              <button
                role="menuitem"
                className="nav-menu-item"
                onClick={resetMilkTotal}
                disabled={resetting}
              >
                {resetting ? t('menu.resetting') : t('menu.resetMilk')}
              </button>
            )}
            {/* "Version history" ya no está acá abajo: es una de las 8 de
                "Go to", con su número de versión al costado. Una sola puerta
                a la misma pantalla. */}
            <button role="menuitem" className="nav-menu-item" onClick={signOut}>
              {t('menu.signOut')}
            </button>
          </div>
        )}
      </div>
    </nav>
  )
}
