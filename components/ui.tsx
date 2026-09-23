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
import { usePathname } from 'next/navigation'
import { APP_VERSION } from '@/lib/version'
import { useT } from '@/lib/i18n/react'

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

// Stroke icons for the phone's bottom bar, drawn on a 24-unit grid in
// currentColor so they follow the tab's state and the theme. The wall and
// tablet nav hide them on the tabs (app/globals.css) — there the labels have
// room — and keep only the menu button's, which is an icon everywhere.
//
// They are NOT from an icon library: this repo has none installed, and adding
// one for nine paths would ship a dependency to a kiosk that has to boot
// offline. Hand-drawn here is the established pattern (design.md §8).
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
  /** Sliders: desde el 22 sep 2026 nombra a Settings, no al botón del menú. */
  settings: [
    'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1',
    'M15 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M9 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  ],
  /**
   * El botón "Menu" de la barra de abajo: tres líneas VERTICALES del mismo
   * alto. No es el hamburger horizontal —que en una barra inferior se lee como
   * "más opciones del sistema"— ni los sliders, que ahora nombran a Settings,
   * que es donde viven los ajustes desde este pase.
   */
  menu: ['M7 5v14', 'M12 5v14', 'M17 5v14'],
} as const

export function NavIcon({ name }: { name: keyof typeof ICONS }) {
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
 * Una pantalla que todavía no tiene nada que mostrar.
 *
 * No es solo la frase de antes: es ícono + frase + una línea que dice qué
 * hacer, en un bloque que ocupa el alto que sobra (`.empty-fill` en la
 * página). Sin datos, /growth y /appointments dejaban media pantalla en
 * blanco hasta la barra de abajo — el hueco no estaba ENTRE hermanos, estaba
 * DESPUÉS del último, que es por lo que una medición de huecos no lo vio.
 */
export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: keyof typeof ICONS
  title: string
  hint?: string
}) {
  return (
    <div className="empty-state">
      <span className="empty-art" aria-hidden="true">
        <NavIcon name={icon} />
      </span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
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
 * Las 8 pantallas que NO son Today, adentro del menú: UNA COLUMNA, el ícono a
 * la izquierda y el texto al lado, todas las filas del mismo alto.
 *
 * En el teléfono la barra inferior es de dos ítems —Today y Menu— porque con
 * seis no entraba: a 320px las etiquetas se cortaban y el área táctil de cada
 * una quedaba por debajo de lo que se puede acertar con el pulgar a las 3 de
 * la mañana. Todo lo demás vive acá.
 *
 * Y de paso cierra un hueco viejo: /feeding, /diapers y /sleep existen desde
 * el 22 sep 2026 y no tenían ninguna entrada de navegación — solo se llegaba
 * desde el pie de su tarjeta en Today.
 *
 * Desde el 22 sep 2026 el menú es SOLO navegación: los ajustes (tema, idioma,
 * avisos, unidad, reset de leche, cerrar sesión) se mudaron enteros a
 * /settings, que es la octava entrada. "Version history" salió de la lista: el
 * número de versión al pie del menú ES el enlace a esa pantalla, así que sigue
 * habiendo una sola puerta y ningún control vive en dos lados.
 */
const SECTIONS = [
  { href: '/feeding', label: 'nav.feeding', icon: 'feeding' },
  { href: '/diapers', label: 'nav.diapers', icon: 'diapers' },
  { href: '/sleep', label: 'nav.sleep', icon: 'sleep' },
  { href: '/pumping', label: 'nav.milk', icon: 'milk' },
  { href: '/growth', label: 'nav.growth', icon: 'growth' },
  { href: '/appointments', label: 'nav.doctor', icon: 'doctor' },
  { href: '/history', label: 'nav.history', icon: 'history' },
  { href: '/settings', label: 'nav.settings', icon: 'settings' },
] as const

export function Nav() {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const { t } = useT()
  const settingsRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  // onBlur alone can't close the menu: Safari on iOS never focuses a tapped
  // button, so a tap elsewhere wouldn't blur anything. Close on any press
  // outside, and on Escape (focus back to the button, where it came from).
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (!settingsRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      menuBtnRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

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
          ref={menuBtnRef}
          className="gear"
          aria-label={t('nav.menu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <NavIcon name="menu" />
          <span className="gear-label" aria-hidden="true">
            {t('nav.menu')}
          </span>
        </button>
        {menuOpen && (
          <div className="nav-menu" role="menu" aria-label={t('nav.menu')}>
            {/* Las 8 pantallas que no son Today, una debajo de la otra. En el
                teléfono es la ÚNICA forma de llegar a ellas; en la pared
                duplica la barra de arriba, y aun así suma: /feeding, /diapers
                y /sleep no están en ninguna barra. */}
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
                </Link>
              ))}
            </div>
            {/* La versión, al pie y chiquita — no una fila más de la lista.
                Es un enlace porque /version tenía su entrada acá hasta ahora y
                quitarle la única puerta sería perder una pantalla; el texto
                dice de qué versión habla, así que no necesita más nombre. */}
            <Link
              href="/version"
              role="menuitem"
              className="nav-menu-version"
              aria-label={t('menu.versionHistory', { version: APP_VERSION })}
              onClick={() => setMenuOpen(false)}
            >
              v{APP_VERSION}
            </Link>
          </div>
        )}
      </div>
    </nav>
  )
}
