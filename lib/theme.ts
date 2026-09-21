'use client'

import { useCallback, useEffect, useState } from 'react'
import { color, lightColor } from '@/lib/tokens'
import { THEME_KEY } from '@/lib/themeBoot'

export type Theme = 'light' | 'dark' | 'system'

const DEFAULT_THEME: Theme = 'dark'

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system'
}

function prefersLight(theme: Theme): boolean {
  if (theme === 'light') return true
  if (theme === 'dark') return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  // The status bar / browser chrome color follows the page, not the manifest.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', prefersLight(theme) ? lightColor.bg : color.bg)
}

/**
 * Light / dark / system. A per-device display preference — like the oz/ml
 * toggle (lib/useVolumeUnit.ts) — so it lives in localStorage, not in the
 * database: the wall screen and a phone can each keep their own.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY)
      if (isTheme(saved)) setThemeState(saved)
    } catch {
      // Storage unavailable (private mode, etc.) — stay on the default.
    }
  }, [])

  // "System" has to keep following the device if it flips while open.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    apply(next)
    try {
      window.localStorage.setItem(THEME_KEY, next)
    } catch {
      // Best-effort; this tab still switches either way.
    }
  }, [])

  return [theme, setTheme]
}
