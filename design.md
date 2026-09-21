# design.md — Lineamientos de UI/UX de Amelia

Todo lo que sigue está **extraído del código real** (`app/globals.css`,
`lib/tokens.ts`, `components/ui.tsx`, `components/SyncStatus.tsx`,
`app/manifest.ts`, `public/sw.js`). No hay nada inventado acá. Donde el
código no define algo, dice **"por definir"**.

**Auditado línea por línea contra el código el 20 de septiembre de 2026.**
Lo que se corrigió en esa pasada está anotado donde corresponde.

> **Antes de proponer cualquier decisión de diseño nueva** — un color, un
> componente, un patrón de interacción, una tipografía, una animación —
> **pasá por la skill `impeccable`** (v4.3.1, instalada como plugin en este
> VPS; verificado el 20 sep 2026). Este documento describe lo que *ya
> existe*; `impeccable` es lo que gobierna lo que *se agrega*. Extender esta
> paleta o inventar un componente sin pasar por ahí no es una decisión
> válida. Los comandos que más se usan acá están en §9.

---

## 1. El principio que ordena todo

**Dos superficies, un solo set de componentes.**

La pantalla de pared de 27" es el objetivo **primario**; el teléfono es
secundario. No hay componentes bifurcados: la hoja de estilos
**re-apunta los tokens de escala** por encima de 1180px y el mismo markup
se renderiza como columna de teléfono o como display legible desde el
otro lado del living.

Consecuencias que no se negocian:

- **Sin afordancias que dependan de hover.** Es una pantalla táctil.
- **Sin hex ni px crudos en componentes.** Todo valor visual sale de un
  token de `app/globals.css`.
- **Targets táctiles:** 52px en teléfono, 84px en la pared, con piso duro
  de 44px para los controles secundarios (tabs, pills, engranaje).
- El contexto de uso es **las 3 de la mañana, a una mano, con wifi malo**.
  Cada decisión se juzga contra eso.

---

## 2. Paleta

Definida dos veces y a propósito: en `lib/tokens.ts` (para consumidores
no-CSS: manifest, theme-color) y como custom properties en
`app/globals.css`. **Los dos archivos deben coincidir.**

| Token CSS | TS | Valor | Para qué |
|---|---|---|---|
| `--c-bg` | `color.bg` | `#211D1B` | Fondo de página. También `theme_color` y `background_color` del manifest. |
| `--c-surface` | `color.surface` | `#332B27` | Superficie de tarjeta |
| `--c-surface-raised` | `color.surfaceRaised` | `#3D342F` | Menú desplegable, botón `quiet` |
| `--c-line` | `color.line` | `rgba(237,230,214,0.12)` | Bordes y separadores |
| `--c-text` | `color.text` | `#EDE6D6` | Texto principal |
| `--c-muted` | `color.muted` | `#C9BFA9` | Texto secundario, labels, metadata |
| `--c-accent` | `color.accent` | `#E8A33D` | Acento: tab activo, foco, enlaces, pendiente de sync |
| `--c-action` | `color.action` | `#8C3B2E` | Fondo del botón de acción primaria |
| `--c-live` | `color.live` | `#5C8A6B` | **Semántico:** algo está en curso / hecho. Deliberadamente separado del acento. |
| `--c-danger` | `color.danger` | `#C4574A` | Error, acción destructiva |

**Dos temas: oscuro (default) y claro pastel** (21 sep 2026). El oscuro de
arriba es el default y **no cambió**: sin atributo `data-theme`, o con
`data-theme="dark"`, se renderiza exactamente como antes. El claro vive en
`:root[data-theme='light']` (y se repite bajo
`@media (prefers-color-scheme: light)` para `data-theme="system"`). Se elige
en el engranaje → Theme (Light / Dark / System); es preferencia **por
dispositivo** en `localStorage` (`amelia:theme`, `lib/theme.ts`), como oz↔ml.
Un script inline en `<head>` (`lib/themeBoot.ts`) aplica el tema antes del
primer pintado, así el claro no parpadea en oscuro.

Roles nuevos, porque un tema claro no puede reusar los colores del oscuro para
todo. En oscuro valen exactamente lo de antes:

| Token | Oscuro | Claro | Para qué |
|---|---|---|---|
| `--c-on-accent` | `= --c-bg` | `#FDF5EF` | Texto sobre `--c-accent` (tab activo, segmento elegido) |
| `--c-live-ink` | `= --c-live` | `#2F6A45` | "En curso" como tinta/borde (`.side`, `.card.is-live`, `gain-up`) |
| `--c-danger-soft` / `--c-live-soft` / `--c-accent-soft` | los `rgba(…, .18)` de antes | tintes pastel | Fondos de `Banner` |
| `--shadow-menu` | la sombra de antes | más suave | Menú del engranaje |

Paleta clara: fondo `#F7EAE3`, tarjeta `#FDF5EF`, elevado `#F3E0D5`, texto
`#3B2A23`, muted `#6B5147`, acento `#8F4F12`, acción `#F2B5A3` (coral pastel,
texto oscuro encima), live `#A9D4B6`, danger `#A63A2E`. **Contraste medido**
(WCAG): texto 11.6:1 sobre fondo; muted ≥5.7:1 sobre fondo, tarjeta y
elevado; acento ≥5.4:1; texto sobre acción 7.7:1 y sobre live 8.3:1;
live-ink ≥5.5:1; danger ≥5.0:1.

**Contraste del tema oscuro, medido el 21 sep 2026** (valores computados por
el navegador, rgba compuestos sobre su fondo real). Cumplen AA: texto 13.5:1
sobre fondo, 11.1:1 sobre tarjeta, 9.8:1 sobre elevado; muted 9.2 / 7.6 /
6.7:1; acento 7.8:1 sobre fondo y 6.4:1 sobre tarjeta; texto sobre acento
7.8:1; texto sobre acción 6.1:1; texto en los tres `Banner` ≥9.5:1.
**No cumplen AA** (sin cambios, a propósito — el oscuro no se toca sin una
decisión explícita):

| Par | Ratio | Mínimo | Dónde |
|---|---|---|---|
| `--c-text` sobre `--c-live` | 3.19:1 | 4.5 | `Btn live` ("Stop nursing"). En la pared el texto es grande (21px bold) y ahí sí pasa el 3:1 |
| `--c-live-ink` sobre `--c-surface` | 3.50:1 | 4.5 | `.side` ("Right Side"), `.gain-up` |
| `--c-muted` en `.card.is-past` (opacidad .65) | 4.14:1 | 4.5 | metadata de turnos pasados |
| placeholder (`#757575`, default de Chromium, sin estilo propio) | 3.63:1 | 4.5 | todos los inputs. **En claro también falla: 3.91:1** |
| `--c-danger` como texto | 2.78:1 sobre elevado | 4.5 | solo `.nav-menu-item.is-danger`, que hoy no usa ningún componente |

Informativo (1.4.11 no lo exige porque el botón se identifica por su texto):
el relleno de `--c-action` contra la tarjeta es 1.83:1.

**Regla de economía del color:** el borde de color se gasta en **un solo
lugar** — la tarjeta de una sesión en curso (`.card.is-live`, borde
`--c-live`). Es lo único que tiene que leerse desde el otro lado del
cuarto. Agregar un segundo borde de color compite con ese y rompe la
jerarquía.

---

## 3. Escala: teléfono y pared

Un solo breakpoint de escala: **1180px** (`surface.wallMinWidth` en
`lib/tokens.ts`). Aparte, y solo para la forma del nav, hay uno de layout en
**600px** (barra inferior por debajo; ver §4).
Por encima, `:root` redefine los tokens; ningún componente se reescribe.

| Token | Teléfono | Pared (≥1180px) |
|---|---|---|
| `--t-label` | 11px | 15px |
| `--t-meta` | 12px | 17px |
| `--t-body` | 15px | 21px |
| `--t-value` | 17px | 27px |
| `--t-title` | 26px | 40px |
| `--t-name` | 30px | 54px |
| `--t-clock` | 32px | 68px |
| `--s-1` … `--s-6` | 2 / 6 / 8 / 12 / 16 / 24px | 3 / 8 / 12 / 18 / 24 / 36px |
| `--r-card` | 16px | 22px |
| `--r-control` | 12px | 16px |
| `--tap` | 52px | 84px |
| `--measure` | 520px | 1500px |
| `--col-gap` | 12px | 20px |
| `--cols` | 1 | 3 |

**Tipografía:** `system-ui, -apple-system, "Segoe UI", sans-serif`, con
`-webkit-font-smoothing: antialiased`. **No hay fuente custom y no se
carga ninguna webfont.** Un kiosco no debería depender de una descarga
externa para renderizar texto.

---

## 4. Componentes existentes

Todos en `components/ui.tsx`. Sin estilos inline, sin hex, sin px.
Destinados a mudarse a `packages/ui` cuando llegue el monorepo.

| Componente | Clase | Notas |
|---|---|---|
| `Page` | `.page` | Contenedor con `max-width: var(--measure)`, centrado |
| `Grid` | `.grid` | `repeat(var(--cols), …)` — 1 col en teléfono, 3 en la pared |
| `Card` | `.card` | Props `live` → borde `--c-live`; `past` → `opacity .65`; `spanAll` → ocupa toda la fila |
| `Label` | `.label` | Mayúsculas, `letter-spacing .09em`, color `--c-muted` |
| `Btn` | `.btn` | Variantes `action` (default), `quiet`, `live`. `flex: 1`, `min-height: var(--tap)` |
| `Banner` | `.banner` | Tipos `error` / `ok` / `warn`. Lleva `role="status"` |
| `Nav` | `.nav` | 5 tabs + menú de engranaje. En teléfono (<600px) es una barra inferior fija, ver §4 "Navegación" |
| `SyncBar` | `.syncbar` | En `components/SyncStatus.tsx`. Estado offline / pendientes. `role="status"`, y `.has-pending` cuando la cola no está vacía |
| `SyncStatus` | — | En `components/SyncStatus.tsx`. El que cablea `useSync()` con `SyncBar`; es lo que las páginas montan |
| `NoBaby` | — | En `components/NoBaby.tsx`. Estado vacío cuando no hay perfil de bebé |
| `ServiceWorker` | — | En `components/ServiceWorker.tsx`. No renderiza nada: registra `/sw.js`, **solo en producción** |

Los cuatro exports de `components/ui.tsx` que faltaban en la tabla original
—`SyncStatus`, `ServiceWorker` y la ubicación real de `SyncBar` y `NoBaby`—
se agregaron en la auditoría del 20 sep 2026. `ui.tsx` exporta siete
componentes: `Page`, `Grid`, `Card`, `Label`, `Btn`, `Banner`, `Nav`. Los
otros cuatro viven en archivos propios.

**Clases utilitarias de layout:** `.stack` `.row` `.row-tight` `.between`
`.spread` `.grow`.

**Clases tipográficas:** `.title` `.name` `.age` `.eyebrow` `.value`
`.meta` `.empty` `.note` `.label` `.side` `.strike`.

**Controles adicionales:** `.input` (con `.narrow`), `.linkish`, `.pill`,
`.check` (con `.is-done`), `.tab`, `.gear`, `.nav-menu`,
`.nav-menu-item` (con `.is-danger`).

**Feed / historial:** `.feed` `.feed-item` `.feed-time` `.feed-what`
`.feed-actions` `.edit-panel`.

**Navegación (5 tabs fijos):** Today · Milk · Growth · Doctor · History.
**En teléfono (`max-width: 599px`) la barra baja al borde inferior** (21 sep
2026): fija, con ícono + label siempre visible por destino y el engranaje como
sexto ítem ("Settings"), cuyo menú abre hacia arriba. Por qué: los 5 tabs +
engranaje no entran en una línea por debajo de ~480px ("History" caía sola a
una segunda fila), y abajo quedan al alcance del pulgar a una mano. Se
descartó ícono-solo (a las 3 AM un ícono de "Milk" o "History" no se adivina)
y el scroll horizontal (esconde justo el tab que no entraba). Es el mismo
markup: los íconos (`NavIcon` en `components/ui.tsx`, SVG de trazo en
`currentColor`) se ocultan por encima de 599px, donde el nav de pills queda
exactamente como antes. El destino activo se marca con `--c-accent` y un
relleno suave (`--c-accent-soft`) detrás del ícono. `.page` suma padding
inferior para que la barra no tape el final de la página, y la barra respeta
`env(safe-area-inset-bottom)`.
El tab activo se marca con `aria-current="page"` y se pinta con
`--c-accent` sobre `--c-bg` (`--c-on-accent`). El menú de engranaje es la
"Configuración" y contiene: Theme (Light / Dark / System), cambiar oz↔ml,
"Reset milk total", Version history, cerrar sesión. Se cierra con Escape
(el foco vuelve al engranaje) y con cualquier toque afuera — `onBlur` solo no
alcanza porque Safari de iOS no enfoca un botón tocado.

**Un solo panel de edición a la vez** (Growth, History, Milk): mientras una
entrada se edita, el Editar/Borrar de las demás queda deshabilitado, así
nunca se abre un segundo formulario ni un `confirm` encima de cambios sin
guardar. No hay modales con overlay en la app: la edición es inline y la
confirmación es `window.confirm`.

---

## 5. Patrones de interacción ya establecidos

### 5.1 Números que no bailan

Cualquier dígito que cuenta o se alinea en columna lleva
`font-variant-numeric: tabular-nums` (`.clock`, `.feed-time`). Un
cronómetro que salta de ancho a cada segundo es ruido visual.

### 5.2 El cronómetro en vivo

Sesión en curso → tarjeta con `live`, `.clock` grande, y el lado o la
fuente al lado en `.side`. Formato `elapsed()`: `7:42`, o `1:07:42`
pasada la hora.

### 5.3 Tiempo relativo adentro del día, absoluto afuera

`timeAgo()` en `lib/format.ts`: `just now` → `42m ago` → `3h 10m ago` →
`Mon 2:14 PM` (dentro de la semana) → `Aug 28, 2:14 PM`.

Todo se renderiza en `America/Los_Angeles` (`HOUSEHOLD_TZ`),
**independientemente del reloj del dispositivo** — la pantalla de pared y
un teléfono en otro huso tienen que coincidir sobre cuándo pasó algo.

### 5.4 Nada se muestra como guardado si no lo está

Es el patrón de UX más importante del proyecto.

- Una escritura en cola se marca `.pending-tag` → "Not synced yet",
  **en todos los lugares donde aparece** (tarjeta, feed, historial).
- En el timeline el texto lleva el sufijo `· not synced yet`.
- `SyncBar` **no dice nada** cuando hay conexión y la cola está vacía.
  Aparece solo cuando hay algo que informar.
- Estar offline se comunica como **información, no como error**: en una
  habitación de bebé es una condición normal.

### 5.5 Errores visibles, nunca silenciosos

Toda escritura devuelve un `Result<T>` con `error`. La página lo muestra
en un `Banner kind="error"`. Ninguna acción falla en silencio.

### 5.6 Confirmación antes de destruir

Las acciones destructivas ("Reset milk total", borrar una entrada) pasan
por `window.confirm` con un texto que dice **qué se conserva**:
*"Past sessions stay in History."*
Y el borrado es lógico (`voided_at`), nunca un `DELETE`.

### 5.7 Entrada en la unidad que se habla

El consultorio dice "7 libras 4 onzas"; la bomba dice "4 oz". La app
**entra en esa unidad** y convierte a la métrica que guarda la base. El
toggle oz↔ml es una preferencia **por dispositivo** (`localStorage`), no
un dato de la familia.

### 5.8 Registrar con hora pasada

Todas las acciones aceptan una hora anterior a la actual — casi nunca se
registra en el momento exacto en que pasó.

### Verificación de esta sección (20 sep 2026)

Cada patrón de §5 afirma algo sobre el código. Se comprobó uno por uno:

| § | Afirma | Dónde está, verificado |
|---|---|---|
| 5.1 | `tabular-nums` en dígitos que cuentan | `app/globals.css:246` y `:484` |
| 5.2 | El cronómetro usa `elapsed()` | `lib/format.ts:107` |
| 5.3 | Relativo/absoluto con `timeAgo()` | `lib/format.ts:86`; TZ del hogar en `:16`. Cubierto por `tests/unit/format.test.ts` bajo cuatro timezones |
| 5.4 | "Not synced yet" en todos lados | `.pending-tag` en `app/globals.css:552`, usado en `app/dashboard/page.tsx:447` y `:485`; sufijo `· not synced yet` en `lib/db.ts:587`; `components/SyncStatus.tsx:29` |
| 5.5 | Todo error se muestra en un `Banner` | `components/ui.tsx:76-84`, con `role="status"` |
| 5.6 | Confirmación que dice qué se conserva | `components/ui.tsx:121` — textual: *"Zero out the \"in the stash\" total? Past sessions stay in History."* Y `app/history/page.tsx:249`, `app/pumping/page.tsx:143` |
| 5.7 | Unidad hablada, preferencia por dispositivo | `lib/useVolumeUnit.ts` + `formatVolume()` en `lib/format.ts:182` |
| 5.8 | Hora pasada en todas las acciones | los parámetros `at?: string` de `lib/db.ts` (`:202`, `:253`, `:303`, `:318`, `:362`…) |

Nada de §5 quedó sin verificar.

---

## 6. Accesibilidad y comportamiento de kiosco

Todo esto ya está en `app/globals.css` y `app/layout.tsx`:

- `:focus-visible` → outline de 2px `--c-accent`, offset 2px.
- `@media (prefers-reduced-motion: reduce)` → animaciones y transiciones
  a `0.01ms`.
- `overscroll-behavior: none` — sin rebote elástico en la pantalla fija.
- `-webkit-tap-highlight-color: transparent` — sin flash al tocar.
- Inputs con `font-size: max(16px, var(--t-body))` — el piso de 16px
  impide que iOS haga zoom al enfocar.
- `role="status"` en `Banner` y en `SyncBar`.
- `aria-current="page"` en el tab activo; `aria-haspopup` / `aria-expanded`
  en el engranaje; `role="menu"` / `role="menuitem"` en el desplegable.
- Viewport: `width=device-width, initialScale=1`, `themeColor #211D1B`;
  con el tema claro el script de arranque y `lib/theme.ts` lo cambian a
  `lightColor.bg` (`lib/tokens.ts`). El manifest sigue en oscuro.
  **No se bloquea el zoom del usuario.**

**Contraste:** medido en los dos temas — ver §2 (claro y oscuro), con los
pares que no llegan a AA listados.

---

## 7. App instalada (PWA)

`app/manifest.ts` + `public/sw.js`.

- `display: 'standalone'`, `start_url: '/dashboard'`, `scope: '/'`.
- Colores de fondo y tema tomados de `color.bg` — **importados del token,
  no escritos a mano**. Ese es el patrón a seguir para cualquier
  consumidor no-CSS.
- **Ocho** íconos (48, 72, 96, 144, 192, 256, 384, 512) más uno `maskable`
  de 512 con la marca dentro de la safe zone, porque Android recorta según
  el launcher. Nueve archivos en total. (Este documento decía "9 íconos más
  uno maskable"; contados contra `app/manifest.ts:25-42`, son ocho más uno.)
- Accesos directos: Milk, Growth, Doctor.
- El service worker cachea **solo el app shell del mismo origen**. Nunca
  una respuesta de Supabase (llevan tokens de auth y esto corre en una
  pantalla compartida), nunca `/api/`, nunca payloads RSC de Next.
- Se registra **solo en producción** — en dev un chunk viejo parece un bug
  de la aplicación.

**Íconos:** no hay archivo fuente (SVG/Figma) en el repo, solo los PNG
exportados. **Por definir.**

---

## 8. Huecos conocidos

- **Íconos:** no hay fuente vectorial versionada — por definir.
- **Tokens de movimiento / duración:** no existen. Hoy no hay animaciones
  salvo el guard de `prefers-reduced-motion` — por definir.
- **Estados de carga:** hoy es texto plano `"Loading…"` con clase
  `.empty`. No hay skeleton ni spinner — por definir.
- **Contraste:** medido en ambos temas (§2). Quedan pares del oscuro bajo AA
  y el placeholder bajo AA en los dos temas, sin corregir hasta decidirlo.
- **Íconos del nav de teléfono:** seis SVG dibujados a mano en
  `components/ui.tsx`; no son una librería. El engranaje de tablet/pared sigue
  siendo el glifo `⚙`.
- **`docs/design/preview.html`** es una preview visual standalone (storage
  temporal del browser, sin backend). **Puede desincronizarse del dashboard
  real** — no lo trates como fuente de verdad de diseño. Vivía en la raíz
  del repo sin que nada la referenciara; se movió acá el 20 sep 2026.

---

## 9. Antes de proponer diseño nuevo

1. **Pasá por la skill `impeccable`.** No es opcional. Está instalada en este
   VPS (v4.3.1). Los comandos que aplican a esta app, con su uso real acá:

   | Comando | Cuándo usarlo en Amelia |
   |---|---|
   | `/impeccable critique <pantalla>` | Review de UX con scoring heurístico. Es por donde se empieza cuando algo "se siente mal" pero no está claro qué. |
   | `/impeccable audit <pantalla>` | Chequeos técnicos: accesibilidad, performance, responsive. El que cierra el hueco de contraste de §6 y §8. |
   | `/impeccable polish <pantalla>` | Pasada final antes de dar algo por terminado. |
   | `/impeccable adapt <pantalla>` | Lo más pertinente de todo en este proyecto: las dos superficies, teléfono y pared a 1180px+. |
   | `/impeccable clarify <pantalla>` | Copy de UI, labels y mensajes de error. |
   | `/impeccable harden <pantalla>` | Estados de error, edge cases, i18n. |
   | `/impeccable extract <target>` | Sacar tokens y componentes reutilizables. Es la puerta natural al `packages/ui` de la fase 2. |
   | `/impeccable document` | Regenera un `DESIGN.md` desde el código. Ojo: **no** reemplaza a este archivo sin una decisión explícita. |

   Sin argumento, `/impeccable` presenta su menú según contexto y no ejecuta
   nada solo.

   **El modo de esta app es `Operate`**, no `Persuade`: quien la usa viene a
   completar una tarea a las 3 de la mañana, no a ser convencido de nada. Si
   una propuesta prioriza expresión sobre escaneabilidad, está en el modo
   equivocado.

2. Verificá si el patrón ya existe en `app/globals.css`. Probablemente sí.
3. Si necesitás un valor nuevo → **token nuevo**, definido en
   `app/globals.css` (y en `lib/tokens.ts` si algo no-CSS lo consume),
   con su variante de pared. Nunca un hex ni un px suelto.
4. Chequeá que funcione en **las dos superficies**: columna de teléfono
   y pared a 1180px+.
5. Chequeá que se lea **a las 3 de la mañana**: ¿se puede tocar a una
   mano? ¿se entiende sin leer texto chico? ¿sobrevive estar offline?
6. Si tu propuesta agrega un segundo elemento que compite con
   `.card.is-live` por la atención, replanteala.
