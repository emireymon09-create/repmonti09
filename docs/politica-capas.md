# Política de capas: modales, menús y avisos (7 oct 2026)

Una sola regla para todo lo que puede quedar **encima** de otra cosa en la
pantalla. Nació de un reporte de Luis ("elementos nuevos se enciman en Inicio") y
de la matriz de `tests/e2e`, que la verifica en cada viewport, idioma y tema.

## 1. Qué capas existen (y cuáles no)

| Capa | Qué es | Cuántas a la vez |
|---|---|---|
| **Bloqueante** | `window.confirm` nativo (confirmar antes de borrar, desechar, deshacer, combinar, rotar el link…) | **Una**, por construcción: el navegador detiene la página hasta que se contesta. No se puede abrir un segundo encima |
| **Popup no modal** | El menú de navegación (`Nav`) y el "⋯" de una fila de Historial (`RowMenu`) | **Uno** (`lib/popover.ts`, `popoverBus`) |
| **Barra** | La barra de abajo del teléfono (`.nav`, `sticky`) | Una |
| **En flujo** | Todo lo demás: banners, avisos de la leche, la receta, el panel del biberón, tarjetas | No flota: no puede encimarse |

**No hay modales con overlay, sheets, toasts ni popovers flotantes** en la app
(design.md §4), y esta política **no** los agrega. Los "avisos" de v5 —agotamiento
o caducidad de la Similac, biberón empezado vencido, leche caducada, "Enfriando",
la receta, Combinar— son **líneas dentro de su tarjeta**: van en el flujo y
empujan lo de abajo. Si alguna vez hace falta un modal de verdad, entra en esta
tabla como bloqueante y respeta la sección 4.

## 2. Orden de apilado: tokens, nunca números

En `app/globals.css`, bloque "capas":

| Token | Valor | Lo usa |
|---|---|---|
| `--z-bar` | 20 | `.nav` en el teléfono (sticky) |
| `--z-popover` | 30 | `.nav-menu`, `.row-menu-list` |

Todo `z-index` de la hoja usa uno de estos tokens. Comprobación:

```bash
grep -rnE 'z-?[iI]ndex' app components lib --include=*.tsx --include=*.ts --include=*.css | grep -v 'var(--z-'
# solo comentarios
```

## 3. Reglas de los popups (`lib/usePopover.ts`)

1. **Uno a la vez.** Abrir uno avisa al bus y el otro se cierra — también cuando
   la activación no trae `pointerdown` (un lector de pantalla manda `click` sin
   puntero y sin mover el foco: así quedaban **dos** menús abiertos, uno tapando
   al otro; medido en la matriz del 7 oct 2026).
2. **Entero y arriba de la barra.** Antes de pintar se mide: si debajo del botón
   no entra entre el botón y el borde de arriba de la barra, abre **hacia arriba**
   (`placePopover`, `.row-menu-list.opens-up`). El menú de navegación ya abre
   hacia arriba desde la barra en el teléfono y, si no entra, scrollea por dentro
   (`max-height`).
3. **Se cierra** con un toque afuera (`pointerdown`: Safari de iOS no enfoca un
   botón tocado, `onBlur` no alcanza), con Escape (el foco vuelve a su botón) y al
   elegir un ítem.
4. **Sin trampa de foco ni bloqueo de scroll**, a propósito: son menús no modales
   (patrón ARIA `menu`), no diálogos. El fondo sigue siendo usable y tocarlo cierra
   el menú.
5. **El botón Atrás del sistema no se usa para cerrarlos.** Para eso habría que
   empujar una entrada al historial al abrir, y el App Router de Next 15 se queda
   con esa entrada: parchea `history.pushState` (le copia su marca `__NA`) y todo
   `popstate` lo despacha como una navegación de su router
   (`dispatchTraverseAction`; sin la marca, `location.reload()` —
   `next/dist/client/components/app-router.js`, leído el 7 oct 2026 en 15.5.26).
   Un menú no puede ser una navegación. El Atrás navega como en cualquier
   pantalla y el menú se va con ella. **[NO VERIFICADO en Android]**.

## 4. Si algún día entra un modal de verdad

Una sola capa bloqueante a la vez (cola por prioridad: primero lo que pide una
acción sobre datos que vencen, después recordatorios), `--z-modal` por encima de
`--z-popover`, foco atrapado y devuelto al cerrar, Escape cierra, scroll del fondo
bloqueado, `env(safe-area-inset-*)` en el padding, y el botón de acción por encima
del teclado. Y entra en la matriz de `tests/e2e` antes de mergear.

## 5. Avisos no bloqueantes: zona definida

Arriba de la página, debajo de la cabecera y antes del contenido, en este orden y
**en el flujo** (uno debajo del otro, nunca superpuestos):
`SyncBar` (sin conexión / pendientes) → `SeenNote` (copia guardada) →
`SyncErrorBanner` (rechazo) → `Banner` de error de lectura → `Banner` de error de
acción → `Banner` ok. Los avisos propios de una tarjeta (la leche, la Similac, el
biberón empezado) van **dentro** de esa tarjeta, como líneas `.meta`.

## 6. El atajo de las tarjetas (`.card-quick`)

Es la única capa `absolute` de contenido. Va en la esquina con el área táctil del
piso secundario (`--tap-min`, 44 px), y **el primer elemento de la tarjeta reserva
ese alto y ese ancho** (`.card.has-quick > .card-quick + *`): nada del flujo puede
quedar debajo. Antes reservaba solo el ancho del título, y en `/pumping` el área
táctil tapaba "3.04 oz · M4" de la primera fila.
