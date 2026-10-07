'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useState, type RefObject } from 'react'
import { placePopover, popoverBus } from '@/lib/popover'

/**
 * Un popup no modal (el menú de navegación, el "⋯" de una fila) con la política
 * de capas de la app (lib/popover.ts):
 *
 *  - uno solo abierto a la vez (`popoverBus`),
 *  - toque afuera lo cierra (`pointerdown`: Safari de iOS no enfoca un botón
 *    tocado, así que `onBlur` solo no alcanza),
 *  - Escape lo cierra y devuelve el foco al botón,
 *  - si `listRef` está, decide si abre hacia arriba para no quedar debajo de
 *    la barra de abajo ni fuera de la ventana (`placement`).
 */
export function usePopover({
  wrapRef,
  buttonRef,
  listRef,
}: {
  wrapRef: RefObject<HTMLElement | null>
  buttonRef: RefObject<HTMLElement | null>
  listRef?: RefObject<HTMLElement | null>
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'down' | 'up'>('down')
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => popoverBus.subscribe(id, close), [id, close])

  useEffect(() => {
    if (!open) return
    popoverBus.opened(id)
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, id, wrapRef, buttonRef])

  // Se mide antes de pintar: el popup nunca se ve un cuadro en el lugar malo.
  useLayoutEffect(() => {
    if (!open || !listRef) {
      setPlacement('down')
      return
    }
    const list = listRef.current
    const btn = buttonRef.current
    if (!list || !btn) return
    const b = btn.getBoundingClientRect()
    let limitBottom = window.innerHeight
    const bar = document.querySelector('nav.nav')
    if (bar) {
      const r = bar.getBoundingClientRect()
      const pos = getComputedStyle(bar).position
      // La barra de abajo del teléfono: lo que quede detrás de ella no se ve.
      if (
        (pos === 'sticky' || pos === 'fixed') &&
        r.bottom >= window.innerHeight - 1 &&
        r.top > b.bottom
      )
        limitBottom = r.top
    }
    const gap = parseFloat(getComputedStyle(list).marginTop) || 0
    setPlacement(
      placePopover({
        anchorTop: b.top,
        anchorBottom: b.bottom,
        popoverHeight: list.offsetHeight,
        limitTop: 0,
        limitBottom,
        gap: Math.max(gap, 4),
      }),
    )
  }, [open, listRef, buttonRef])

  return { open, setOpen, placement }
}
