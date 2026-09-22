# design.md — Lineamientos de UI/UX de Amelia

Todo lo que sigue está **extraído del código real** (`app/globals.css`,
`lib/tokens.ts`, `components/ui.tsx`, `components/SyncStatus.tsx`,
`app/manifest.ts`, `public/sw.js`). No hay nada inventado acá. Donde el
código no define algo, dice **"por definir"**.

**Auditado línea por línea contra el código el 20 de septiembre de 2026.**
Lo que se corrigió en esa pasada está anotado donde corresponde. Los
agregados del 21 sep 2026 (idioma, campos de fecha) se verificaron contra
`8d82cd6` y `8c7e320`. La tabla de verificación de §5 conserva los números de
línea del 20 sep: el i18n movió el código y **no se re-verificaron línea por
línea**; los textos citados ahora viven en `lib/i18n/en.ts`.

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
todo. Desde el 21 sep 2026 (pase de contraste) `--c-live-ink` y `--c-on-live`
ya **no** valen lo mismo que antes en oscuro — ver la tabla de contraste del
oscuro más abajo:

| Token | Oscuro | Claro | Para qué |
|---|---|---|---|
| `--c-on-accent` | `= --c-bg` | `#FDF5EF` | Texto sobre `--c-accent` (tab activo, segmento elegido) |
| `--c-on-live` | `#100E0D` (casi negro) | `= --c-text` | Texto sobre `--c-live` (`Btn live` "Stop nursing", el ✓ de `.check.is-done`) |
| `--c-live-ink` | `#84B091` (antes `= --c-live`) | `#2F6A45` | "En curso" como tinta/borde (`.side`, `.card.is-live`, `gain-up`, borde de `Banner ok`, `.dot.syncing`) |
| `--c-field` | `= --c-bg` (sin cambio visual) | `#F7EAE3` (el blush) | Relleno de `.input` y del segmento `.seg` del menú |
| `--o-past` | `0.8` (antes `.65`) | `0.88` | Opacidad de `.card.is-past` (turnos pasados) |
| `--c-danger-soft` / `--c-live-soft` / `--c-accent-soft` | los `rgba(…, .18)` de antes | tintes pastel | Fondos de `Banner` |
| `--shadow-menu` | la sombra de antes | más suave | Menú del engranaje |

`--c-live` (el relleno) **no cambió** en ningún tema: el `.check.is-done` de
Doctor depende de él (3.50:1 contra la tarjeta en oscuro, sobre el 3:1 de UI);
oscurecerlo lo habría bajado a 2.27:1. Por eso "Stop nursing" se arregló con
texto oscuro encima y no oscureciendo el verde.

Paleta clara: fondo **`#FFFFFF`** (blanco, 21 sep 2026 — antes `#F7EAE3`,
blush; el resto de la paleta no cambió), tarjeta `#FDF5EF`, elevado `#F3E0D5`,
texto `#3B2A23`, muted `#6B5147`, acento `#8F4F12`, acción `#F2B5A3` (coral
pastel, texto oscuro encima), live `#A9D4B6`, danger `#A63A2E`. Los `.input` y
el segmento `.seg` del menú (Theme/Language) usan `--c-field`, no `--c-bg`: con
el fondo blanco habían quedado blancos también; desde el 21 sep 2026 mantienen
el blush `#F7EAE3`. En oscuro `--c-field = --c-bg`, igual que siempre.

**Contraste del tema claro contra el fondo blanco, recalculado el 21 sep 2026**
(WCAG 2.x, rgba compuestos sobre el fondo; "Antes" es el valor contra el
`#F7EAE3` anterior). Todo lo que se apoya directo en el fondo mejora:

| Sobre `--c-bg` (`#FFFFFF`) | Ratio | Antes | Mínimo |
|---|---|---|---|
| `--c-text` | 13.62:1 | 11.57 | 4.5 |
| `--c-muted` | 7.26:1 | 6.16 | 4.5 |
| `--c-accent` (texto, enlaces, eyebrow) | 6.37:1 | 5.41 | 4.5 |
| `--c-accent` como anillo de foco | 6.37:1 | 5.41 | 3 |
| `--c-danger` | 6.43:1 | 5.46 | 4.5 |
| `--c-live-ink` | 6.43:1 | 5.46 | 4.5 |
| placeholder (ahora `--c-muted` sobre `--c-field` `#F7EAE3`, ver abajo) | 6.16:1 | 3.91 (`#757575` sobre el blush) | 4.5 |
| `--c-line` (borde, compuesto `#E4DFDD`) | 1.32:1 | 1.31 | — (decorativo) |
| `--c-text` sobre los tres `Banner` (`*-soft`) | ≥11.2:1 | ≥9.7 | 4.5 |

Lo que va dentro de tarjetas no cambió: muted ≥5.7:1 sobre tarjeta y elevado;
texto sobre acción 7.7:1 y sobre live 8.3:1; live-ink ≥5.5:1; danger ≥5.0:1.

**Campos contra `--c-field` en claro** (medido en el navegador el 21 sep 2026):
texto 11.57:1, placeholder (`--c-muted`) 6.16:1, segmento inactivo del menú
6.16:1. **Turnos pasados en claro:** con `.65` contra la página blanca el muted
caía a **2.99:1** y el título a 4.28:1 (no estaba anotado: la tabla de arriba
no contemplaba la opacidad); con `--o-past: .88`, 5.01:1 y 8.75:1.

**Tarjeta contra fondo: 1.08:1** (`#FDF5EF` sobre blanco; antes 1.09:1 contra
el blush). El relleno de la tarjeta casi no se distingue del fondo — nunca se
distinguía mucho: lo que la separa es el borde `--c-line` (1.32:1), igual que
antes. Cambió el sentido: antes la tarjeta era más clara que el fondo, ahora es
apenas más oscura. Elevado `#F3E0D5` 1.28:1, acción 1.76:1, live 1.64:1 contra
el fondo.

**Contraste del tema oscuro, medido el 21 sep 2026** (valores computados por
el navegador, rgba compuestos sobre su fondo real). Cumplen AA: texto 13.5:1
sobre fondo, 11.1:1 sobre tarjeta, 9.8:1 sobre elevado; muted 9.2 / 7.6 /
6.7:1; acento 7.8:1 sobre fondo y 6.4:1 sobre tarjeta; texto sobre acento
7.8:1; texto sobre acción 6.1:1; texto en los tres `Banner` ≥9.5:1.

**Los cuatro pares que no llegaban a AA, corregidos el mismo 21 sep 2026**
(con permiso explícito para tocar el oscuro; re-medidos en el navegador sobre
los elementos reales):

| Par | Antes | Después | Palanca |
|---|---|---|---|
| Texto sobre `--c-live` (`Btn live`, "Stop nursing") | 3.19:1 | **4.86:1** | `--c-on-live: #100E0D` (texto casi negro); el relleno `--c-live` no se tocó |
| `--c-live-ink` sobre `--c-surface` (`.side` "Right Side", `.gain-up`) | 3.50:1 | **5.67:1** | `--c-live-ink: #84B091`, separado de `--c-live` |
| `--c-muted` en `.card.is-past` | 4.14:1 (opacidad .65) | **5.47:1** (título 7.79:1) | `--o-past: .8` |
| placeholder de inputs | 3.63:1 (`#757575`, default del navegador) | **9.16:1** | `.input::placeholder { color: var(--c-muted); opacity: 1 }` |

Sigue sin cumplir, sin cambios porque no se usa:

| Par | Ratio | Mínimo | Dónde |
|---|---|---|---|
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
| `Card` | `.card` | Props `live` → borde `--c-live-ink`; `past` → `opacity: var(--o-past)` (.8 oscuro / .88 claro); `spanAll` → ocupa toda la fila |
| `Label` | `.label` | Mayúsculas, `letter-spacing .09em`, color `--c-muted` |
| `Btn` | `.btn` | Variantes `action` (default), `quiet`, `live`. `flex: 1`, `min-height: var(--tap)` |
| `Banner` | `.banner` | Tipos `error` / `ok` / `warn`. Lleva `role="status"`. **Desde el 22 sep 2026 vive en `components/Banner.tsx`**, no en `ui.tsx`: lo usa `NursingAlerts`, que `ui.tsx` renderiza, y el import de vuelta era circular. `ui.tsx` lo re-exporta, así que `@/components/ui` sigue funcionando |
| `Nav` | `.nav` | 5 tabs + menú de engranaje. En teléfono (<600px) es una barra inferior fija, ver §4 "Navegación" |
| `SyncBar` | `.syncbar` | En `components/SyncStatus.tsx`. Estado offline / pendientes. `role="status"`, y `.has-pending` cuando la cola no está vacía |
| `SyncStatus` | — | En `components/SyncStatus.tsx`. El que cablea `useSync()` con `SyncBar` y `SyncErrorBanner`; lo montan `/appointments` y `/pumping`. `/dashboard`, `/growth` y `/history` usan `useSync()` + `SyncBar` directo, porque necesitan releer al sincronizar y mostrar el error de sincronización |
| `SeenNote` | `.syncbar` | En `components/SyncStatus.tsx` (22 sep 2026). Offline, avisa que se muestra la copia guardada en el dispositivo y de cuándo es. Informativo, con el mismo aspecto que `SyncBar`, `role="status"`; no renderiza nada si la lectura anduvo |
| `SyncErrorBanner` | `.banner` (error) | En `components/SyncStatus.tsx` (22 sep 2026). "No se pudo sincronizar": nombra la entrada que el server rechazó (y de cuándo es) y ofrece **Descartar** (`Btn quiet`), siempre tras un `window.confirm` que dice qué se pierde (§5.6). Lo montan `/dashboard`, `/history`, `/growth` y, vía `SyncStatus`, `/appointments` y `/pumping` |
| `SectionPage` | — | En `components/SectionPage.tsx` (22 sep 2026). La pantalla entera de `/feeding`, `/diapers` y `/sleep`: dos `Card` de totales (`Today`, `Last 7 days`) con `.kpis`, el log completo debajo (`.feed`, con editar y borrar, un panel a la vez) y "Log a past one". Las tres páginas son 7 líneas cada una que le pasan `section`. Queda en ~1000 líneas: el panel de edición está **copiado** de `/history`, no compartido (seguimiento en `CLAUDE.md` §6) |
| `NursingAlerts` | `.nav-menu-group` | En `components/NursingAlerts.tsx` (22 sep 2026). El control "Nursing alerts" del menú de engranaje, con la misma forma de segmento que Theme y Language. Ver §5.9 |
| `NoBaby` | — | En `components/NoBaby.tsx`. Estado vacío cuando no hay perfil de bebé. Variante `offline` (22 sep 2026): sin conexión y sin nada guardado en el dispositivo dice eso, no "no hay perfil de bebé" |
| `ServiceWorker` | — | En `components/ServiceWorker.tsx`. No renderiza nada: registra `/sw.js`, **solo en producción** |

Los cuatro exports de `components/ui.tsx` que faltaban en la tabla original
—`SyncStatus`, `ServiceWorker` y la ubicación real de `SyncBar` y `NoBaby`—
se agregaron en la auditoría del 20 sep 2026. `ui.tsx` exporta siete
componentes: `Page`, `Grid`, `Card`, `Label`, `Btn`, `Banner`, `Nav` — aunque
desde el 22 sep 2026 `Banner` está definido en `components/Banner.tsx` y
`ui.tsx` solo lo re-exporta. Los demás viven en archivos propios.

**Clases utilitarias de layout:** `.stack` `.row` `.row-tight` `.between`
`.spread` `.grow`.

**Clases tipográficas:** `.title` `.name` `.age` `.eyebrow` `.value`
`.meta` `.empty` `.note` `.label` `.side` `.strike`.

**Controles adicionales:** `.input` (con `.narrow`), `.linkish`, `.pill`,
`.check` (con `.is-done`), `.tab`, `.gear`, `.nav-menu`,
`.nav-menu-item` (con `.is-danger`).

**Campos de fecha y hora** (`.input[type='date']`,
`.input[type='datetime-local']`, 21 sep 2026): llevan `appearance: none` y
`min-width: 0`, y el valor se alinea al inicio
(`.input::-webkit-date-and-time-value { text-align: start }`). Por qué: Safari
de iOS los dibuja como botón nativo y, cuando el ancho no es una longitud fija
y la apariencia es nativa, su tema pisa el nuestro
(`RenderThemeIOS::adjustInputElementButtonStyle`): `box-sizing: content-box`,
padding lateral `0.5em` y un `min-width` del ancho de la fecha más larga. Así
`width: 100%` se volvía 100% + padding + borde y el campo se salía por la
derecha de la tarjeta (+18px con fuente de 16px). Sin apariencia nativa ese
override no corre. **Verificado en un iPhone real** (confirmado por el
dueño del proyecto el 21 sep 2026, v0.4.0): los campos quedan dentro de la
tarjeta. Antes de eso ningún motor disponible acá había reproducido el bug; la
causa salió de leer el código de WebKit y de simular el override en Chromium
(60/70 inputs desbordaban antes, 0/70 después, a 390/320/600/1440px en los dos
temas).

**`select.input`** (tipo de turno en Doctor, 21 sep 2026): revisado contra el
código de WebKit (`RenderThemeIOS.mm`, `adjustMenuListButtonStyle` →
`adjustSelectListButtonStyle`). A un `<select>` iOS **no** le aplica el
override de los campos de fecha (no toca `box-sizing` ni `min-width`), así que
no desbordaba. Pero sí le pisa el `min-height` con uno derivado de la fuente
(20/11 × 16px ≈ 29px, por debajo del piso de 44px) y el padding lateral a
`0.5em`. Se le aplicó el mismo `appearance: none` + `min-width: 0`: sin
apariencia nativa ese ajuste no corre. La flecha nativa desaparece con eso; se
redibuja con dos `linear-gradient` en `--c-muted` (sin hex, sin px). Verificado
en Chromium a 390/320/600/1440px en los dos temas: 0 de 5 campos se salen de la
tarjeta, alto 52px (84px en la pared). **No verificado en un iPhone real.**

**Feed / historial:** `.feed` `.feed-item` `.feed-time` `.feed-what`
`.feed-actions` `.edit-panel`, y `.feed-span` (22 sep 2026: el
inicio–fin · duración de una sesión terminada, en su propia línea debajo de
la entrada).

**Totales de sección** (22 sep 2026): `.kpis` es un `<dl>` en grid de dos
columnas — etiqueta a la izquierda, número a la derecha con
`font-variant-numeric: tabular-nums` (§5.1) y una línea `--c-line` entre
filas. **No** es una fila de tiles de número gigante: a las 3 AM se lee de
arriba abajo, y con los números en columna "hoy" y "7 días" se comparan de un
vistazo. `.card-link` es el "Totals and log →" al pie de cada tarjeta del
dashboard: es texto (`.linkish`), pero con `min-height: var(--tap)` para que
el blanco táctil sea entero (52px en teléfono, 84px en la pared).

**Menú de engranaje** (22 sep 2026): `.menu-note` es la línea bajo un
segmento que dice qué va a hacer o por qué no puede — `--t-meta`,
`--c-muted`, y `width: 0; min-width: 100%` para que envuelva al ancho del
menú en vez de estirarlo con una frase larga en español. `.nav-menu-group
.banner` usa el mismo truco para el banner de error del control de avisos.
`.seg-btn:disabled` baja a `opacity: .45` y `cursor: default`: un segmento que
acá no puede hacer nada se lee como deshabilitado, igual que un ítem de menú.

**Navegación (5 tabs fijos):** Today · Milk · Growth · Doctor · History
(en español: Hoy · Leche · **Medidas** · Médico · Historial — ver §5.9).
**En teléfono (`max-width: 599px`) la barra baja al borde inferior** (21 sep
2026): fija, con ícono + label siempre visible por destino y el engranaje como
sexto ítem ("Settings"), cuyo menú abre hacia arriba. Por qué: los 5 tabs +
engranaje no entran en una línea por debajo de ~480px ("History" caía sola a
una segunda fila), y abajo quedan al alcance del pulgar a una mano. Se
descartó ícono-solo (a las 3 AM un ícono de "Milk" o "History" no se adivina)
y el scroll horizontal (esconde justo el tab que no entraba). Es el mismo
markup: los íconos (`NavIcon` en `components/ui.tsx`, SVG de trazo en
`currentColor`) se ocultan por encima de 599px, donde el nav de pills queda
exactamente como antes — salvo el del engranaje, que ahí es el ícono solo
(reemplazó al glifo `⚙`, 21 sep 2026). El destino activo se marca con `--c-accent` y un
relleno suave (`--c-accent-soft`) detrás del ícono. `.page` suma padding
inferior para que la barra no tape el final de la página, y la barra respeta
`env(safe-area-inset-bottom)`.
El tab activo se marca con `aria-current="page"` y se pinta con
`--c-accent` sobre `--c-bg` (`--c-on-accent`). El menú de engranaje es la
"Configuración" y contiene: Theme (Light / Dark / System), **Language
(System / English / Español)** justo debajo y con la misma forma de segmento
(21 sep 2026), **Nursing alerts (Off / On)** debajo de Language y con la misma
forma (22 sep 2026, §5.10), cambiar oz↔ml, "Reset milk total", Version
history, cerrar sesión. En el selector de idioma "System" va primero porque es lo que tiene un
dispositivo hasta que alguien elige; cada idioma se nombra en sí mismo
("Español") y el botón lleva `lang` para que un lector de pantalla lo lea con
las reglas de ese idioma. Se cierra con Escape
(el foco vuelve al engranaje) y con cualquier toque afuera — `onBlur` solo no
alcanza porque Safari de iOS no enfoca un botón tocado.

**Un solo panel de edición a la vez** (Growth, History, Milk): mientras una
entrada se edita, el Editar/Borrar de las demás queda deshabilitado, así
nunca se abre un segundo formulario ni un `confirm` encima de cambios sin
guardar. Al cerrar el panel (Cancel o Save) **el foco vuelve al botón Edit de
esa fila** (`lib/useReturnFocus.ts`, 21 sep 2026; cada Edit lleva
`data-edit-for`). Antes quedaba en `<body>`. No hay modales con overlay en la app: la edición es inline y la
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
- Offline, una página **no se vacía**: sigue mostrando lo último que devolvió
  el server, con la cola encima (`/dashboard`, `/history`, `/growth`, desde
  el 21 sep 2026). Y una edición offline se marca al instante: la página
  repinta desde la cola sin esperar a que la lectura se rinda.
- **Abrir sin conexión muestra la copia guardada** (22 sep 2026): las últimas
  filas buenas de cada página quedan en el dispositivo (`lib/lastSeen.ts`) y,
  mientras se muestran, `SeenNote` dice de cuándo son — con el aspecto de
  `.syncbar`, porque es información, no un error. Así la pantalla de pared no
  hace pasar filas de hace horas por el estado actual. Al volver una lectura
  buena, el aviso se va solo.
- **"Nada guardado" no es "no hay nada"**: offline y sin copia, las listas y
  tarjetas no dicen "No sleep logged yet" ni "Nothing scheduled" (sería una
  suposición); dicen que no hay nada guardado en el dispositivo, y las
  tarjetas muestran "—". Lo mismo `NoBaby offline`.
- En `/dashboard` las tres tarjetas (Comida, Pañal, Dormir) llevan
  `.pending-tag` en el último evento que muestran y en la sesión en curso.
  Desde el 22 sep 2026 la tarjeta de Comida muestra **lo último entre toma y
  lactancia terminada** (`lastFeedingEvent`, `lib/kpis.ts`), así que la marca
  sigue al evento que se ve, sea de la tabla que sea.
- **Los totales de `/feeding`, `/diapers` y `/sleep` incluyen lo que está en
  cola, y lo dicen** (22 sep 2026). Una fila encolada cuenta —es lo que el
  padre registró—, y un borrado encolado deja de contar; en los dos casos la
  tarjeta agrega `.pending-tag` → "These totals include entries not synced
  yet." Un número sin ese aviso es lo que el server tiene.
- **Sin copia guardada y sin conexión, los totales son "—", sin el aviso
  anterior.** Los dos juntos se contradecían (el auditor lo encontró el 22 sep
  2026): un "—" no incluye nada. Y el log dice que no hay nada guardado en
  este dispositivo, no "no hay entradas".
- **Un rechazo del server se muestra, no se traga.** `SyncErrorBanner` nombra
  la entrada que frena la cola y ofrece Descartar, siempre tras el `confirm`
  de §5.6 que dice qué se pierde (y cuántas ediciones de esa entrada se van
  con ella). Nada sale de la cola sin que alguien lo pida.
- Hueco: **las páginas no se releen solas** — solo al montar, al volver
  `online` y tras sincronizar. En la pared, lo que carga el otro padre no
  aparece hasta recargar, y un corte con la página quieta no muestra el aviso
  de copia guardada (ver `CLAUDE.md` §6).

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

Casi nunca se registra en el momento exacto en que pasó, así que siempre tiene
que haber forma de poner la hora real.

**Dónde vive, desde el 22 sep 2026:** ya **no** en `/dashboard`. Se fue de ahí
"Log a missed session" —con su banner de "backdating" y su `datetime-local`
suelto, que aplicaba a la próxima escritura sea cual fuera—, y en su lugar
cada página de sección tiene **"Log a past one"**: un formulario propio, con
los campos de esa sección (lado y tipo en Comida, tipo en Pañal) y la hora
adentro del mismo formulario. Lo que se registra es **una** fila, y la hora es
de esa fila: no queda un estado global que pueda fechar hacia atrás algo
posterior.

- Comida y Dormir, que son sesiones, eligen entre **"Finished"** (inicio y
  fin) y **"Still going"** (solo inicio: la sesión queda abierta desde esa
  hora y sigue corriendo). "Still going" está **bloqueado si ya hay una sesión
  activa** —servidor o cola—, con un texto que dice que hay que pararla desde
  Today. Nunca se abren dos por esta vía.
- Los botones del dashboard siguen estampando **ahora**, sin excepción.
- **Parar una sesión a una hora anterior** no tiene botón propio: se para
  (Today) y se corrige el fin desde el log de la sección. Es un rodeo
  consciente, no un olvido.
- Validación en `checkPastRange` (`lib/kpis.ts`): hace falta una hora, el fin
  tiene que ser posterior al inicio y nada puede estar en el futuro. El `max`
  nativo del campo ya frena casi todo el futuro; la validación está igual
  porque el `max` no se puede dar por hecho en todos los motores.

### 5.9 Idioma de la interfaz (21 sep 2026)

Inglés y español rioplatense (voseo), `lib/i18n/`. Preferencia **por
dispositivo** en `localStorage` (`amelia:lang`: `en` / `es` / `system`), como
el tema y oz↔ml; sin elección, o con "System", sigue a `navigator.languages`
(gana el primer idioma soportado; si ninguno, inglés).

- **Sin parpadeo inglés → español.** El server siempre renderiza inglés
  (páginas estáticas, cacheadas por el service worker; no se lee
  `Accept-Language`, a propósito). Un script inline en `<head>`
  (`lib/i18n/boot.ts`) fija `<html lang>` antes del primer pintado y, si el
  idioma no es inglés, pone `data-lang-pending`:
  `html[data-lang-pending] body { visibility: hidden }` — el fondo se ve, el
  texto no. `I18nProvider` lo saca apenas re-renderiza en el idioma correcto
  (en un layout effect, antes de pintar). **Tope de 1.5 s**
  (`LANG_PENDING_MAX_MS`): pasado eso la página se muestra igual, en inglés si
  el JS no llegó — una pantalla en blanco a las 3 AM es peor que un parpadeo.
- **`:lang(es) .side { text-transform: none }`.** En inglés `.side` capitaliza
  cada palabra ("Right Side"); en español solo va mayúscula la primera ("Lado
  derecho"), y los strings de `es.ts` ya vienen así.
- **"Medidas" en la barra inferior**, no "Crecimiento": no entra en la barra de
  teléfono a 320px. El título de la página sí dice "Crecimiento".
- **Fechas:** inglés fija `en-US` (el hogar está en Los Ángeles: "7:00 PM"
  aunque el dispositivo esté en otro idioma); español usa `es`, reloj de 24 h.
  Siempre en `America/Los_Angeles` (§5.3). Los ejemplos de §5.3 y §5.6 son del
  inglés.
- **El selector nativo de fecha/hora sigue el idioma del navegador, no el de
  la app.** No hay forma de forzarlo desde la página.
- **Queda en inglés por diseño:** las notas del CHANGELOG en `/version`
  (marcadas `lang="en"`, con un aviso "Las notas de cada versión están en
  inglés." cuando la app no está en inglés), el detalle crudo de un error de
  Supabase/Postgres dentro de un banner (el marco se traduce), y el
  manifest/metadata.

### 5.10 Avisos push (22 sep 2026)

"Nursing alerts" en el menú de engranaje, debajo de Language y con la misma
forma de segmento (Off / On). Es **por dispositivo**, como el tema y oz↔ml —
pero, a diferencia de ellos, también existe del lado del servidor, que es
quien manda la notificación.

- **No dice "On" hasta que es verdad.** "On" exige las dos cosas: la
  suscripción en este navegador **y** su fila confirmada en el servidor. Si no
  se puede preguntar, el estado es `unknown` y lo dice ("no se pudo
  verificar"), no "On" por las dudas.
- **Donde no se puede, se explica por qué** en vez de ofrecer un botón que no
  hace nada. Los estados, con su texto: `unsupported` (el navegador no recibe
  notificaciones), `install` (iPhone/iPad: hace falta agregar la app a la
  pantalla de inicio), `unavailable` (este servidor no tiene las claves
  configuradas), `denied` (las notificaciones están bloqueadas para el sitio:
  hay que permitirlas en la configuración del sitio). En `unsupported`,
  `install` y `unavailable` los dos segmentos quedan deshabilitados
  (`.seg-btn:disabled`); con `denied` siguen tocables —el segmento marcado es
  "Off"— porque tocar "On" es lo que vuelve a leer el permiso una vez que lo
  habilitaron en la configuración del sitio.
- El texto explicativo va en `.menu-note`, con `role="status"`; un fallo
  concreto sale como `Banner kind="error"` adentro del grupo.
- **La notificación se escribe en el idioma que se guardó con la
  suscripción**, no en el del servidor ni en el del navegador: el idioma es
  una columna de la fila y se actualiza cuando se cambia el idioma de la app
  con los avisos prendidos. Es el único texto de la app que **no** lo resuelve
  el cliente (§5.9): cuando llega, la app puede estar cerrada.
- **El texto de reserva del service worker queda en inglés, a propósito**
  (`public/sw.js`): si el payload no se puede leer, muestra "Amelia" / "Open
  Amelia to see what's new." El worker no tiene diccionarios, y un push que
  termina **sin** mostrar nada se le cuenta en contra al sitio. El aviso real
  llega ya escrito en el idioma del dispositivo.
- Dos avisos de la misma sesión comparten `tag`, así que el segundo
  **reemplaza** al primero en vez de apilar otro, y no vuelve a vibrar.
- Cerrar sesión apaga los avisos de ese dispositivo (borra la fila y la
  suscripción); iniciar sesión suelta la suscripción que hubiera quedado, para
  que el menú no arranque en "On" con la cuenta anterior.

### Verificación de esta sección (20 sep 2026)

Cada patrón de §5 afirma algo sobre el código. Se comprobó uno por uno:

| § | Afirma | Dónde está, verificado |
|---|---|---|
| 5.1 | `tabular-nums` en dígitos que cuentan | `app/globals.css:246` y `:484` |
| 5.2 | El cronómetro usa `elapsed()` | `lib/format.ts:107` |
| 5.3 | Relativo/absoluto con `timeAgo()` | `lib/format.ts:86`; TZ del hogar en `:16`. Cubierto por `tests/unit/format.test.ts` bajo cuatro timezones |
| 5.4 | "Not synced yet" en todos lados | `.pending-tag` en `app/globals.css:864`, usado en `app/dashboard/page.tsx:471` y `:497` (Lactancia: en curso / última), `:539` (biberón), `:583` (pañal), `:612` y `:639` (Sueño: en curso / último) (líneas al 22 sep 2026); sufijo `· not synced yet` en `lib/db.ts:745-746` (`mark`); `SyncBar` calla con conexión y cola vacía en `components/SyncStatus.tsx:22`; `SeenNote` como `.syncbar` en `:66-78`; Descartar con `window.confirm` en `SyncErrorBanner`, `:87` y `:116` |
| 5.5 | Todo error se muestra en un `Banner` | `components/ui.tsx:81-93`, con `role="status"` (líneas al 22 sep 2026) |
| 5.6 | Confirmación que dice qué se conserva | `components/ui.tsx:213` — textual: *"Zero out the \"in the stash\" total? Past sessions stay in History."* Y `app/history/page.tsx:320`, `app/pumping/page.tsx:151`, `app/growth/page.tsx:199`; descartar un registro rechazado, `components/SyncStatus.tsx:116` (líneas al 22 sep 2026) |
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
- Viewport: `width=device-width, initialScale=1, viewport-fit=cover`,
  `themeColor #211D1B`. `viewport-fit=cover` (21 sep 2026) es lo que hace que
  `env(safe-area-inset-*)` valga algo en un iPhone: `.page` suma el inset de
  arriba a su padding superior y usa `max(padding, inset)` a los costados y
  abajo; la barra inferior del teléfono hace lo mismo a los costados y abajo.
  Sin safe area (desktop, Chromium) todo vale 0 y los paddings computados son
  idénticos a antes (verificado a 390/800/1440px). Con insets emulados por CDP
  (59px arriba, 34px abajo) el contenido baja 59px y la barra suma 34px.
  **No verificado en un iPhone real.**
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
- **Contraste:** medido en ambos temas (§2). Los cuatro pares del oscuro bajo
  AA se corrigieron el 21 sep 2026; sólo queda `--c-danger` como texto sobre
  elevado (2.78:1), en una clase que hoy no usa nada.
- **Íconos del nav:** seis SVG dibujados a mano en `components/ui.tsx`; no son
  una librería. Desde el 21 sep 2026 el engranaje de tablet/pared también es el
  SVG `settings` (el mismo de la barra del teléfono, solo, 1.3em dentro del
  círculo de 44px), no el glifo `⚙`.
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
