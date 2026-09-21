'use client'

import { useEffect, useRef } from 'react'

/**
 * Inline edit panels replace their row's Edit button while open, so closing
 * one (Cancel, or Save) left keyboard focus on <body>. This puts it back on
 * the Edit button of the row that was being edited.
 *
 * `openKey` is the row being edited, or null. `ready` is false while the page
 * is still busy: the Edit buttons are disabled then, and a disabled button
 * cannot take focus. Each Edit button carries `data-edit-for={key}`.
 */
export function useReturnFocus(openKey: string | null, ready: boolean) {
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    if (openKey !== null) {
      lastKey.current = openKey
      return
    }
    if (!ready || lastKey.current === null) return
    const button = document.querySelector<HTMLButtonElement>(
      `[data-edit-for="${CSS.escape(lastKey.current)}"]`,
    )
    lastKey.current = null
    // Gone (deleted, or filtered out by a refresh): leave focus alone.
    if (button && !button.disabled) button.focus()
  }, [openKey, ready])
}
