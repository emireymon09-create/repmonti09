/**
 * La política de capas de la app, en su parte PURA (sin React ni DOM).
 *
 * Amelia no tiene modales con overlay (design.md §4): lo que bloquea es un
 * `window.confirm` nativo, que el navegador ya serializa — uno a la vez, con
 * el foco atrapado y Escape para cancelar. Lo que flota son DOS popups no
 * modales: el menú de navegación y el "⋯" de una fila de Historial. La regla
 * para ellos (docs/politica-capas.md):
 *
 *   1. Uno solo abierto a la vez. Abrir uno cierra el otro, sin depender de
 *      que haya habido un `pointerdown` afuera: un lector de pantalla activa un
 *      botón con un `click` sin puntero y sin mover el foco, y ahí quedaban los
 *      dos abiertos, uno encima del otro.
 *   2. Un popup entra entero por encima de la barra de abajo: si debajo del
 *      botón no hay lugar, abre hacia arriba (`placePopover`).
 *   3. Escape lo cierra y devuelve el foco a su botón; un toque afuera lo
 *      cierra. (lib/usePopover.ts)
 *
 * El orden de apilado está en tokens (`--z-bar`, `--z-popover` en
 * app/globals.css): ningún z-index suelto.
 */

export type PopoverBus = {
  /** Avisa que `id` se abrió: todos los demás suscriptos se cierran. */
  opened(id: string): void
  /** `close` se llama cuando se abre OTRO popup. Devuelve la baja. */
  subscribe(id: string, close: () => void): () => void
}

export function createPopoverBus(): PopoverBus {
  const subs = new Map<string, () => void>()
  return {
    opened(id) {
      for (const [other, close] of Array.from(subs)) if (other !== id) close()
    },
    subscribe(id, close) {
      subs.set(id, close)
      return () => {
        if (subs.get(id) === close) subs.delete(id)
      }
    },
  }
}

/** El bus de la página: uno solo, compartido por todos los popups. */
export const popoverBus: PopoverBus = createPopoverBus()

/**
 * ¿El popup abre hacia abajo o hacia arriba del botón?
 *
 * `limitBottom` es hasta dónde se puede pintar sin que nada lo tape: el borde
 * de arriba de la barra de abajo (teléfono) o el alto de la ventana. Abajo
 * gana si entra; si no entra abajo pero sí arriba, arriba; si no entra en
 * ninguno, el lado con más lugar (el popup no se achica: se ve lo que entra y
 * la página sigue pudiendo scrollear).
 */
export function placePopover(o: {
  anchorTop: number
  anchorBottom: number
  popoverHeight: number
  limitTop: number
  limitBottom: number
  gap: number
}): 'down' | 'up' {
  const below = o.limitBottom - (o.anchorBottom + o.gap)
  const above = o.anchorTop - o.gap - o.limitTop
  if (below >= o.popoverHeight) return 'down'
  if (above >= o.popoverHeight) return 'up'
  return above > below ? 'up' : 'down'
}
