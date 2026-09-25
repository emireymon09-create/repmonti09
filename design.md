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

**Puesto al día el 23 sep 2026 (cierre del pase de nav / 24 h / onzas /
offsets).** Lo que se corrigió: §4 (la tabla de `Nav` y `.card-link`), §5.6
(usaba como ejemplo una acción que ya no existe), §5.7 (describía el toggle
oz↔ml como preferencia por dispositivo: dejó de serlo), §5.11 y §5.15 (la
barra y el menú cambiaron de número), §5.14 (sus números eran **de caja**, y
la caja es una constante — ver el recuadro de esa sección), §8 ("doce SVG" →
trece), y §5.16, nueva. **Todo lo de este pase se midió en Chromium headless
shell 148 sobre Linux, a 390×844 y 1440×900. Nada se probó en un teléfono
real**, así que `env(safe-area-inset-*)` vale 0 en todas esas cifras: los
56,7 px de la barra no son el número que se ve en un iPhone.

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
dispositivo** en `localStorage` (`amelia:theme`, `lib/theme.ts`), como el
idioma. (Decía "como oz↔ml": esa preferencia dejó de existir el 23 sep 2026,
ver §5.7.)
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
| `--tap-min` | 44px | 44px — **no crece**, es el piso, no el tamaño (§5.19) |
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
| `Nav` | `.nav` | 6 tabs + botón **Menu**. Es **solo navegación** desde el 23 sep 2026: no recibe `babyId` y no tiene ningún ajuste adentro. El desplegable es una lista de **una columna con las diez pantallas** y el número de versión al pie. En teléfono (<600px) es una barra inferior fija de **cuatro** ítems — Today · Milk · Stats · Menu — y qué tab aparece ahí lo decide un `phone: boolean` explícito por ítem, no el orden de la lista. Ver §5.11 |
| `EmptyState` | `.empty-state` | En `components/ui.tsx` (23 sep 2026). Ícono de la sección + título + una línea que dice qué va a aparecer ahí. Se monta dentro de un `.empty-fill`, que ocupa el alto que sobra — ver §5.14 |
| `SyncBar` | `.syncbar` | En `components/SyncStatus.tsx`. Estado offline / pendientes. `role="status"`, y `.has-pending` cuando la cola no está vacía |
| `SyncStatus` | — | En `components/SyncStatus.tsx`. El que cablea `useSync()` con `SyncBar` y `SyncErrorBanner`; lo montan `/appointments` y `/pumping`. `/dashboard`, `/growth` y `/history` usan `useSync()` + `SyncBar` directo, porque necesitan releer al sincronizar y mostrar el error de sincronización |
| `SeenNote` | `.syncbar` | En `components/SyncStatus.tsx` (22 sep 2026). Offline, avisa que se muestra la copia guardada en el dispositivo y de cuándo es. Informativo, con el mismo aspecto que `SyncBar`, `role="status"`; no renderiza nada si la lectura anduvo |
| `SyncErrorBanner` | `.banner` (error) | En `components/SyncStatus.tsx` (22 sep 2026). "No se pudo sincronizar": nombra la entrada que el server rechazó (y de cuándo es) y ofrece **Descartar** (`Btn quiet`), siempre tras un `window.confirm` que dice qué se pierde (§5.6). Lo montan `/dashboard`, `/history`, `/growth` y, vía `SyncStatus`, `/appointments` y `/pumping` |
| `SectionPage` | — | En `components/SectionPage.tsx` (22 sep 2026). La pantalla entera de `/feeding`, `/diapers` y `/sleep`: dos `Card` de totales (`Last 24 hours`, `Last 7 days`) con `.kpis`, el log completo debajo (`.feed`, con editar y borrar, un panel a la vez) y "Log a past one". Las tres páginas son 7 líneas cada una que le pasan `section`. Queda en ~1000 líneas: el panel de edición está **copiado** de `/history`, no compartido (seguimiento en `CLAUDE.md` §6) |
| `NursingAlerts` | `.setting-group` | En `components/NursingAlerts.tsx` (22 sep 2026). El control "Nursing alerts", desde el 23 sep 2026 en **`/settings`** y no en el menú; misma forma de segmento que Theme y Language, con `role="radio"` dentro de un `radiogroup`. Ver §5.10 |
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
`.check` (con `.is-done`), `.tab`, `.gear`, `.nav-menu`, `.nav-menu-links`,
`.nav-menu-link`, `.nav-menu-version`, `.setting-group`, `.setting-note`.
`.nav-menu-item` y `.card-link` **se borraron el 23 sep 2026**: el primero
porque el menú ya no tiene botones (se fueron a `/settings`), el segundo
porque el pie "Totals and log →" de las tarjetas de Today se sacó.

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

**Movimiento** (23 sep 2026, los primeros tokens del proyecto — §8 los daba
por definir): `--motion-enter: 180ms`, `--motion-wait: 120ms` y
`--ease-out: cubic-bezier(.22,.61,.36,1)`. Un solo `@keyframes enter` (opacidad
0→1). Lo usa `.page > *:not(.nav):not(.loading-note)` cuando la página termina
de cargar, y `.loading-note` con `--motion-wait` de retraso, para que una carga
rápida no llegue a mostrar el "Loading…". El `<nav>` queda afuera a propósito.
Ver §5.13.

**Totales de sección** (22 sep 2026): `.kpis` es un `<dl>` en grid de dos
columnas — etiqueta a la izquierda, número a la derecha con
`font-variant-numeric: tabular-nums` (§5.1) y una línea `--c-line` entre
filas. **No** es una fila de tiles de número gigante: a las 3 AM se lee de
arriba abajo, y con los números en columna "hoy" y "7 días" se comparan de un
vistazo. (`.card-link`, el "Totals and log →" al pie de cada tarjeta del dashboard, se
borró el 23 sep 2026 — ver §5.12.)

**Ajustes de `/settings`** (23 sep 2026; hasta acá eran el menú de engranaje):
`.setting-note` es la línea bajo un segmento que dice qué va a hacer o por qué no puede — `--t-meta`,
`--c-muted`, y `width: 0; min-width: 100%` para que envuelva al ancho del
menú en vez de estirarlo con una frase larga en español. `.nav-menu-group
.banner` usa el mismo truco para el banner de error del control de avisos.
`.seg-btn:disabled` baja a `opacity: .45` y `cursor: default`: un segmento que
acá no puede hacer nada se lee como deshabilitado, igual que un ítem de menú.

> **Reescrito el 23 sep 2026 (segundo pase del día).** El párrafo de abajo
> describía la barra de 5 tabs + engranaje y un menú que era navegación y
> panel de control a la vez. Nada de eso sigue en pie: la barra del teléfono
> es de **cuatro** ítems, el menú es **solo navegación** con las **diez**
> pantallas en una columna, y los ajustes viven en **`/settings`** — sin la
> unidad oz↔ml ni "Reset milk total", que se fueron de la app. Ver §5.11,
> §5.15 y §5.7.

**Navegación.** `TABS` tiene seis destinos —Today · Milk · Stats · Growth ·
Doctor · History (en español: Hoy · Leche · **Datos** · **Medidas** · Médico ·
Historial — ver §5.9)— más el botón **Menu**.

**En teléfono (`max-width: 599px`) la barra baja al borde inferior** (21 sep
2026): fija, con ícono + label siempre visible por destino. Abajo quedan al
alcance del pulgar a una mano. Se descartó ícono-solo (a las 3 AM un ícono de
"Milk" o "History" no se adivina) y el scroll horizontal (esconde justo el tab
que no entraba). Es el mismo markup: los íconos (`NavIcon` en
`components/ui.tsx`, SVG de trazo en `currentColor`) se ocultan por encima de
599px, donde el nav de pills queda como siempre — salvo el del botón Menu, que
ahí es el ícono solo (reemplazó al glifo `⚙`, 21 sep 2026). **Qué tabs se ven
en el teléfono lo dice cada ítem** (`phone: boolean` en `components/ui.tsx`,
23 sep 2026), no el CSS por posición: hasta ese día la regla era
`.nav .tab:not(.tab-home)`, "todos menos el primero", y mover un destino de
lugar cambiaba en silencio lo que ve un teléfono.

El destino activo se marca con `aria-current="page"`, `--c-accent` sobre
`--c-bg` (`--c-on-accent`) y un relleno suave (`--c-accent-soft`) detrás del
ícono. La barra respeta `env(safe-area-inset-bottom)`.

**La barra es `sticky`, no `fixed` (23 sep 2026).** Con `position: fixed`,
Safari de iOS la despegaba del borde durante el scroll y la dejaba flotando
sobre el medio de la lista; al soltar volvía sola abajo. Confirmado en un
iPhone 16 Pro real con iOS 26.6.2, **app instalada desde la pantalla de
inicio**, en varias pantallas y en las dos orientaciones — y también en cada
transición cargando→cargado. No era nuestro CSS: en toda la hoja no hay un
solo `transform`, `filter`, `overflow`, `will-change` ni `contain` en ningún
ancestro de la barra (`html > body > .page > nav`), así que el containing
block estaba sano. Es WebKit, que trata los elementos fijos como capas atadas
al viewport y las reposiciona recién al terminar el gesto.

Una barra sticky viaja **dentro** del contenido scrolleado: no hay capa fija
que reposicionar. Cómo se sostiene, en tres piezas (`@media (max-width: 599px)`
en `app/globals.css`):

- `.page` es `display: flex; flex-direction: column` con `min-height: 100dvh`.
  Sticky solo puede quedarse abajo si su contenedor llega hasta abajo.
- `.nav` lleva `order: 1` y `margin-top: auto`. `order` la pone última en la
  columna **sin moverla del DOM** — el orden del HTML lo necesitan la barra
  ancha y la pared, donde la barra va arriba y nada de esto aplica — y el
  margen automático la manda al fondo cuando el contenido no llena la
  pantalla.
- `width: 100vw` con `margin: auto calc(50% - 50vw) 0` la saca del ancho de
  columna de `.page` (max-width 520px + padding lateral) y la deja de borde a
  borde, que es lo que hacía `left: 0; right: 0` cuando era fija. El
  porcentaje se resuelve contra el ancho de contenido de `.page`, así que la
  cuenta cierra igual a 390px que a 599px.

**Y `.page` ya no reserva el alto de la barra con padding inferior.** Hacía
falta con una barra fija, que tapa el final del documento para siempre; una
sticky se corre sola cuando el documento se termina, así que el último renglón
nunca queda debajo. Consecuencia medida: el documento de cada pantalla larga
del teléfono es **38 px más corto** (los 100 px que reservaba menos los 61,7
que mide la barra), y el estado vacío quedó **19,2 px más abajo** porque ahora
se centra contra la barra de verdad y no contra ese padding.

> **Sin verificar, y hay que decirlo:** que el salto desaparezca **en un
> iPhone**. Este servidor no tiene WebKit ni iOS —solo Chromium— y la
> emulación de dispositivo no implementa ni el toolbar dinámico de Safari ni
> el mecanismo de capas fijas de WebKit, que es justo el del bug. Lo que sí
> está medido acá es que el cambio no rompe nada (abajo) y que la barra queda
> pegada al borde en cada posición de scroll. La confirmación del bug en sí
> tiene que salir del teléfono de Luis.

El desplegable del botón Menu es **solo navegación** (§5.15). Se cierra con
Escape (el foco vuelve al botón) y con cualquier toque afuera — `onBlur` solo
no alcanza porque Safari de iOS no enfoca un botón tocado.

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

Las acciones destructivas —borrar una entrada del log, de `/growth`, de
`/history` o de Milk; descartar un registro que el server rechazó— pasan por
`window.confirm` con un texto que dice **qué se conserva** o qué se pierde
(y, en el caso del descarte, cuántas ediciones dependientes se van con la
entrada). Y el borrado es lógico (`voided_at`), nunca un `DELETE`.

> **Corregido el 23 sep 2026:** este párrafo usaba "Reset milk total" y su
> texto *"Past sessions stay in History."* como ejemplo. **Esa acción ya no
> existe** (§5.7): salió de Settings junto con `resetPumpingTotal` de
> `lib/db.ts` y sus seis claves de i18n. `babies.pumping_reset_at` sigue
> filtrando el total de Milk y **ya no tiene escritor**.

### 5.7 Entrada en la unidad que se habla

El consultorio dice "7 libras 4 onzas"; la bomba dice "4 oz". La app
**entra en esa unidad** y convierte a la métrica que guarda la base. Eso no
cambió. Lo que cambió el 23 sep 2026 es **quién elige la unidad**.

- **Mostrar: siempre onzas.** `DISPLAY_UNIT = 'oz'` en `lib/format.ts`. Se
  borró `lib/useVolumeUnit.ts` y con él la preferencia oz↔ml por dispositivo
  en `localStorage`. Este párrafo decía que era una preferencia por
  dispositivo; **dejó de serlo**.
- **Entrar: por campo, no por dispositivo.** Al lado del campo de cantidad de
  un biberón hay un toggle oz/ml (`components/AmountUnit.tsx`, clase
  `.seg-inline`): es el mismo segmento de Settings, con `role="radiogroup"` y
  dos `role="radio"`, y el `placeholder` del campo sigue a la unidad activa.
  Vale **para esa entrada y nada más**: no se guarda, vuelve a `oz` al montar
  la tarjeta **y después de cada guardado exitoso**. Ese reset importa: sin
  él, un "4" tipeado después de un guardado en ml se registra como 4 ml —
  0,1 oz— y parece una entrada normal. Es el modo de fallo más caro de esa
  fila.
- **Dónde NO va el toggle: en los paneles de edición.** Ese campo viene
  **precargado** con el valor de la fila en onzas (`mlToUnit(row.amount_ml,
  DISPLAY_UNIT)`). Si se pudiera cambiar la unidad ahí, un `4.1` precargado en
  oz pasaría a leerse como 4,1 **ml** al tocar el toggle, y guardar sin volver
  a tipear destruiría el dato en silencio. Los campos de creación arrancan
  vacíos y no tienen ese problema. **Consecuencia aceptada:** una cantidad
  tipeada en ml deja de ser editable sin redondeo (150 ml abiertos y guardados
  sin tocar nada quedan en 5,1 oz → 150,82 ml; deriva ±1,48 ml, una sola vez).
- **No se convierte ml → oz → ml al guardar.** La columna es `amount_ml`, la
  base de fase 2 sigue siendo métrica, y el viaje de ida y vuelta solo
  perdería precisión. Verificado contra la base: 150 tipeados en ml quedan
  `150`; 4 tipeados en oz quedan `118.294`; los dos se muestran en oz.
- **El toggle lb/oz/in de `/growth` no se tocó.** Ahí la unidad hablada sigue
  siendo una elección de la pantalla.

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
el tema; sin elección, o con "System", sigue a `navigator.languages`
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
forma de segmento (Off / On). Es **por dispositivo**, como el tema y el idioma —
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

### 5.11 La barra de abajo: de seis a dos, de dos a cuatro (23 sep 2026)

En el teléfono, la barra fija de abajo tiene **exactamente cuatro**:
**Today · Milk · Stats · Menu**.

Historia corta, porque el número cambió dos veces en dos días y conviene saber
por qué. Eran **seis** (cinco pestañas + el engranaje): a 390px eso deja ~65px
por ítem, las etiquetas largas se cortaban —"Historial", "Crecimiento", que ya
había tenido que abreviarse a "Medidas"— y el ícono quedaba apretado contra el
borde de su área táctil. El 22 sep bajaron a **dos** (Today y Menu), medio
ancho de pantalla cada uno. El 23 sep subieron a **cuatro**, al entrar
`/statistics`: con dos destinos más la barra sigue entrando cómoda y los tres
lugares que se miran sin registrar nada —lo de hoy, la leche guardada y los
datos— quedan a un toque, sin abrir el menú.

Medido a 390×844, build de producción, los cuatro ítems:

| ítem | x | ancho | alto táctil | cortado |
|---|---|---|---|---|
| Today / Hoy | 6 | 94,5 | 56,7 | no |
| Milk / Leche | 100,5 | 94,5 | 56,7 | no |
| Stats / Datos | 195 | 94,5 | 56,7 | no |
| Menu / Menú | 289,5 | 94,5 | 56,7 | no |

56,7 px está por encima del piso de 52 px de §1, y `horizScroll` es 0 en los
dos idiomas. A 320px los cuatro siguen entrando (77px cada uno).

Cuatro cosas deliberadas:

- **La etiqueta se acortó a `Stats` / `Datos`.** A 390px las palabras enteras
  entran (`Statistics` 58,3px, `Estadísticas` 74,5px sobre 94,5 disponibles).
  El motivo es **320px**: ahí el ítem mide 77px y "Estadísticas" mide 74,5 —
  pegada a los dos bordes. Es el mismo motivo por el que "Crecimiento" ya era
  "Medidas" (§5.9). El nombre completo vive en el `<h1>` de la página.
  Y **`Datos`, no `Gráficos`**: la pantalla todavía no dibuja nada, y una
  etiqueta que promete gráficos sería una etiqueta que miente (§5.4).
- **Qué tabs se ven en el teléfono lo dice cada ítem, no su posición.** Antes
  era `.nav .tab:not(.tab-home)` — "todos menos el primero" — así que mover un
  destino de lugar cambiaba en silencio lo que ve un teléfono. Ahora cada
  entrada de `TABS` lleva `phone: boolean`, incluidos los `false`.
- **El menú reusa el patrón de §5 tal cual**: `aria-haspopup="menu"` y
  `aria-expanded` en el botón, `role="menu"` con `aria-label` en el panel,
  `role="menuitem"` en cada link, Escape cierra y devuelve el foco al botón,
  y un `pointerdown` afuera cierra (no `onBlur`: en iOS un `<button>` tocado
  nunca recibe foco). No se inventó nada nuevo.
- **En tablet y en la pantalla de pared no cambia la naturaleza, sí el largo.**
  Los `.tab` siguen en el HTML y solo se apagan con `display: none` abajo de
  600px —lo que además los saca del árbol de accesibilidad, así que un lector
  de pantalla en el teléfono anuncia cuatro ítems y no siete—. A 1440px la
  barra pasó a **7** (6 pestañas + Menu), sin cortes ni scroll horizontal, en
  los dos idiomas.

### 5.15 Settings es una pantalla, el menú es una lista de diez (23 sep 2026)

El desplegable del botón Menu era **las dos cosas a la vez**: la única
navegación del teléfono y el panel de control de la app. Crecía sin techo —ocho
destinos más seis ajustes, con scroll propio— y obligaba a sostener abierto un
menú para tocar un segmento.

- **Los ajustes se mudaron enteros a `/settings`**: Theme, Language, Nursing
  alerts y cerrar sesión. **Ninguno quedó duplicado** (verificado en el DOM:
  0 `.seg` y 0 `.nav-menu-item` dentro de `.nav-menu`). La unidad oz↔ml y
  "Reset milk total" se mudaron con ellos y **el mismo día se fueron de la
  app**: no están ni en el menú ni en Settings (§5.6 y §5.7). Con eso
  `/settings` se quedó sin un solo `Banner` —su único error era el del reset—
  y sin `useState`.
- **Los roles cambian con el contenedor.** Adentro de un `role="menu"` los
  segmentos eran `menuitemradio`; en una página son `role="radio"` dentro de un
  `role="radiogroup"`. No es cosmético: un lector de pantalla anuncia otra cosa.
- **El menú es una columna de diez**, ícono + texto, filas de 52px, en el orden
  de las pantallas tal como se usan: **Today, Feeding, Diapers, Sleep, Milk,
  Stats, Growth, Doctor, History, Settings**. Dos columnas obligaban a barrer
  en zigzag. **Today y Milk se repiten con la barra a propósito:** el menú es
  el índice de la app, y un índice al que le faltan dos entradas obliga a
  acordarse de cuáles son; `aria-current="page"` marca dónde estás, así que la
  repetición no confunde.
- **La versión va al pie**, chiquita y a la derecha, y **es el enlace a
  `/version`**: esa pantalla salió de la lista y no tenía otra puerta. No es
  una fila más; el texto ya dice de qué habla, y lleva `aria-label` completo.
- **La accesibilidad no se tocó**: `aria-haspopup`/`aria-expanded`,
  `role="menu"`, los links con `role="menuitem"`, Escape cierra y devuelve el
  foco al botón, un `pointerdown` afuera cierra.

Verificado a 390×844 con el menú abierto: **10 links**, todos con el mismo
`left` (151) y el mismo ancho (226), **52px** de alto cada uno, ninguno
recortado en ninguno de los dos idiomas; **11 `role="menuitem"`** (los 10 más
la versión al pie); `aria-expanded` va false→true→false y el foco vuelve al
botón; `aria-current="page"` en la fila de la pantalla actual. El menú mide
**598px** en una ventana de 844 y `scrollHeight === clientHeight` (596/596):
con diez filas **todavía no necesita scrollear**. La regla de `max-height` +
`overflow-y: auto` sigue ahí para un teléfono apaisado o con el texto del
sistema agrandado. **Sin verificar:** el menú a 320px o en apaisado.

### 5.12 La cabecera y las tarjetas de Today (22 sep 2026)

**Nombre con la edad debajo, fecha arriba a la derecha.** Antes iban en tres
renglones apilados y el primero era la fecha. En una pantalla de pared lo
primero que se lee tiene que ser de quién es la pantalla, no qué día es. La
fecha usa `longDate()`, el mismo formato por idioma que ya usaba, y se apoya
en la misma línea de base que el nombre (`align-items: baseline` — alinear por
caja las dejaba flotando). En un teléfono angosto baja sola, por `flex-wrap`.

**La edad va en su propio renglón** (revertido el 23 sep 2026). El 22 se había
puesto en la misma línea que el nombre; se lee peor y se volvió atrás por
pedido de Luis. Sigue dentro del `<h1>` y pierde el peso y el tamaño del
título: es un dato, no un encabezado. Medido a 390 / 768 / 1440 px, la edad
arranca en el mismo `left` que el nombre y debajo de su primera línea. **A
390px no cambió nada**: el nombre y la edad ya envolvían a dos renglones
dentro de la columna angosta, así que la línea única solo existía de 768px
para arriba (la tinta de Today bajó 20 px a 768 y 27 px a 1440).

**Las tres tarjetas miden lo mismo, y cada una tiene su atajo.** El ícono de la
esquina abre esa sección; va en gris y solo se acentúa al tocarlo o enfocarlo.
Lleva `aria-label` porque no tiene texto. **Desde el 23 sep 2026 es la única
puerta**: el pie que lo decía con palabras ("Totals and log →") se sacó —
repetía en las tres tarjetas algo que la flecha ya dice y empujaba los botones
hacia abajo. El área táctil del ícono sigue siendo `--tap` entera (52px medidos
en teléfono) y el `aria-label` no cambió ("Feeding: totals and log").

Lo de "medir lo mismo" no es un alto fijo elegido a ojo: el grid las iguala con
`align-items: stretch` y el pie se apoya abajo con `margin-top: auto`. Las tres
comparten el padding de `.card` y la misma escala tipográfica, así que la
proporción interna también coincide. Medido en la pared: 455 / 455 / 455 px.
**En el teléfono no se igualan**, a propósito: apiladas de a una, forzar el
alto sería agregar 90px de aire a dos tarjetas para que empaten con la que
tiene el cronómetro abierto.

### 5.14 Una pantalla vacía termina en algo — y cómo se mide (23 sep 2026)

`/growth` y `/appointments`, sin una sola fila, terminaban en la tarjeta del
formulario y dejaban el resto en blanco hasta la barra de abajo. **El hueco no
estaba entre hermanos, estaba después del último** — por eso una medición de
huecos entre hermanos (el pase anterior) no lo encontró.

`.empty-fill` se queda con el alto que sobra (`.page:has(.empty-fill)` pasa a
flex column con `min-height: 100dvh`) y centra ahí un `EmptyState`: el ícono de
la sección en `--c-line`, el título en `--c-text` y una línea en `--c-muted`
que dice qué va a aparecer. El tono es el de una bitácora, no el de un formulario
vacío: *"Save the first one above — weight and length — and every visit after it
will line up here"*.

> **El hallazgo más importante del pase del 23 sep 2026 (segundo pase), y hay
> que leerlo antes que los números: `.empty-fill` es `flex: 1 1 auto` con
> `align-items: center`, así que su caja termina SIEMPRE a la misma distancia
> de la barra, pase lo que pase adentro.** Esa distancia era de 38,3 px
> mientras `.page` reservaba el alto de la barra con padding; desde que la
> barra es `sticky` y vive en el flujo (§5.11) la caja termina justo donde
> empieza la barra: **0,0 px, medido en las 16 combinaciones**. El número
> cambió; que sea una constante no. Medir la caja es medir el `flex: 1`: daba
> 38 px con 119 px de contenido y daría 38 px con nada. Esta sección decía
> *"Growth 412px → 38px, Doctor 686px → 38px"* y esos son **números de caja**:
> registraban el arreglo como hecho mientras el blanco seguía ahí. En Doctor
> eran 656 px de caja para 119 px de estado vacío — 268 px de aire arriba y
> 307 abajo.
>
> **La métrica correcta es la tinta:** el `getBoundingClientRect().bottom` del
> último elemento que tiene un nodo de texto propio o es un `<svg>`, ignorando
> los contenedores. Cualquier medición futura de "cuánto blanco queda" se hace
> así, no con la caja.

Medido a 390×844, tema oscuro, inglés, sin una sola fila, **por tinta**:

| pantalla | antes | después | `.empty-fill` |
|---|---|---|---|
| `/appointments` (Doctor) | **306,7 px** | **92,2 px** | sí (656 px) → sí (227 px) |
| `/dashboard` (Today) | **261,3 px** | **68,7 px** | no → sí (198 px) |
| `/growth` | 157,7 px | 157,7 px (sin cambio) | sí (394 px) |

`docH` = 844 en los tres: no se introdujo scroll. En español el hueco de Today
baja a 59,7 px (el texto envuelve una línea más).

**Remedido el 23 sep 2026, después de pasar la barra a `sticky` (§5.11):** los
tres huecos bajaron **19,2 px** exactos, porque `.empty-fill` ya no se centra
contra los 100 px de padding que reservaba la barra fija sino contra la barra
de verdad, y la mitad de esos 38,3 px de más le toca al aire de abajo. 390×844,
sin una sola fila, por tinta, las cuatro combinaciones de tema × idioma:

| pantalla | inglés | español |
|---|---|---|
| `/appointments` (Doctor) | 92,2 → **73,0 px** | **73,0 px** |
| `/dashboard` (Today) | 68,7 → **46,5 px** | **37,5 px** |
| `/growth` | 157,7 → **138,5 px** | **138,5 px** |
| `/statistics` | 286,7 → **267,5 px** | 277,7 → **258,5 px** |

El tema no cambia ni un píxel (claro y oscuro dan lo mismo en las cuatro), la
barra sigue arrancando en `top: 782,3` y `docH` sigue en 844: el cambio no
introdujo scroll en ninguna. **Las cifras "con datos" de más abajo no se
mueven**: ahí no hay `.empty-fill`, el contenido arranca donde arrancaba y a
la barra la baja `margin-top: auto` hasta el mismo `top: 782,3`.

Y el arreglo de Doctor **no fue CSS**: el blanco de una pantalla sin nada no se
arregla con CSS —no hay nada que poner ahí— se arregla poniendo algo. Su
formulario "New appointment" ahora **arranca abierto cuando no hay un solo
turno**, que es exactamente lo que `/growth` ya hacía y la razón por la que
Growth sin datos se leía bien. Today, que **nunca** tuvo `.empty-fill`, ahora
lo monta en su estado sin datos.

Cuatro cosas deliberadas:

- **Solo sin datos.** El `:has()` no matchea con una sola fila cargada, así que
  con datos `.page` sigue en `display: block` y `min-height: 0`. Verificado.
- **Y solo cuando se sabe que no hay datos.** El estado vacío de Today espera a
  que una primera lectura haya vuelto (§5.4): afirmar "acá arranca el registro"
  mientras todavía se está leyendo es afirmar un hecho falso, y con mala
  conexión duraba segundos.
- **El ícono no compite con `.card.is-live`** (§2, economía del color): va en
  `--c-line`, que es el borde, no un color.
- **Piso sin `:has()`**: el `min-height: 40dvh` de `.empty-fill` pasó a vivir
  dentro de `@supports not selector(:has(*))`. Donde `:has()` existe el
  `flex: 1` ya da el alto y ese piso **estorbaba**: con una tarjeta de
  formulario arriba empujaba la página a scrollear (documento de 955 px en una
  ventana de 844) por culpa de un bloque cuyo trabajo es no agregar alto.
  **Sin verificar:** un motor que no soporta **ni** `@supports selector()`
  **ni** `:has()` (Chrome ≤ 82) se queda sin piso.

Contraste del texto nuevo sobre el fondo: título 13.62:1 (claro) / 13.45:1
(oscuro), línea 7.26:1 / 9.16:1.

**Hueco conocido que este patrón NO cierra, medido y anotado:** con datos, las
tres pantallas siguen terminando donde termina su contenido —`.empty-fill`
solo existe en la rama "cero filas"— y eso da 620 px de tinta a barra en
Doctor con un solo turno, 335 px en Growth con una medición y 181 px en Today.
Y `/statistics`, que nació el mismo día, tiene **267,5 px** de tinta a barra
(258,5 en español; eran 286,7 y 277,7 antes de que la barra pasara a `sticky`)
— casi el número que Doctor tenía antes de arreglarse: un `<h1>` y un
`EmptyState` de 120 px centrados en el alto que sobra. Se deja así a propósito:
no hay nada honesto que poner hasta que existan las gráficas.

*(Ojo con una frase que acá decía y ya no es cierta: "`.page` es `display:
block` con `min-height: 0`". Desde el 23 sep 2026 eso vale solo **de 600px
para arriba**. En el teléfono `.page` es una columna flex de `min-height:
100dvh` — es lo que sostiene la barra sticky, §5.11. Los números de arriba no
cambian por eso, porque el contenido sigue arrancando arriba.)*

### 5.13 La app nunca se queda sin marco (22 sep 2026)

Había un "pantallazo" al cambiar de pantalla. La causa medida —cuadro por
cuadro con CDP, no supuesta— **no era el fondo**: el tema nunca se pierde
(0 cuadros con fondo claro o sin `data-theme`, en las dos direcciones). Era
que el `if (loading)` de las seis páginas devolvía `<Page>` con un
"Loading…" y **sin `<Nav>`**: durante esa ventana la pantalla quedaba entera
vacía, la barra de abajo incluida, y eso es lo que se ve como un parpadeo.

Regla nueva: **el estado de carga de una página también lleva el nav.** La
ventana sin contenido sigue existiendo (33 ms en este servidor, tanto más
cuanto peor esté la conexión) pero el marco no se mueve.

**Y desde el 23 sep 2026 tampoco salta.** Quedaba el corte seco entre
"Loading…" y el contenido. Dos reglas, con los tokens de movimiento de §4:
todo lo que la página pinta al cargar entra con un fundido de `--motion-enter`,
y el `"Loading…"` (`.loading-note`) arranca recién a los `--motion-wait`. Si la
página resuelve antes de eso —que es lo normal— **el texto no llega a verse**, y
entonces no hay dos estados sucesivos que comparar: no hay salto. Si tarda,
aparece fundido igual.

El `<nav>` queda **afuera** de la animación: ya estaba en pantalla, y fundirlo
sería el parpadeo que §5.13 arregló. React reusa ese nodo entre el estado de
carga y el cargado, así que la animación no se le dispara.

Medido cuadro por cuadro con `requestAnimationFrame` y un clic real en el
`<Link>` de Growth, a 390px:

| | Cuadros con "Loading…" visible | Opacidad del contenido |
|---|---|---|
| Antes | 3, a opacidad 1 | aparece directo en 1 |
| Después | **0** | 0 → .25 → .47 → .64 → .76 → .85 → 1 en ~180 ms |
| Después, CPU a 1/6 | **0** | mismo fundido, corrido 100 ms |
| Después, `reduced-motion` | 0 | 0 → 1 en un cuadro, sin fundido |

El nav midió opacidad 1 en todos los cuadros, y 0 cuadros sin nav.

### 5.16 Ventanas, correcciones y unidades (23 sep 2026)

Tres patrones nuevos del mismo pase. Los tres tienen la misma raíz: **una
pantalla no puede llamar a algo por un nombre que no es.**

**a · La ventana rodante de 24 h, y por qué la etiqueta no puede decir "hoy".**
La tarjeta corta de `/feeding`, `/diapers` y `/sleep` contaba desde la
medianoche del hogar. A las 00:05 los números se ponían en cero y una toma de
las 23:50 desaparecía de la pantalla: a esa hora, en esta app, es cuando más
se la mira. Ahora la ventana es `{ ahora − 24 h, ahora }`.

- **La propiedad también se renombró**: `kpiWindows().today` → **`last24h`**.
  Corregir la etiqueta y dejar la propiedad llamándose `today` habría dejado la
  mentira una capa más abajo, donde nadie la mira.
- **La etiqueta dice `Last 24 hours` / `Últimas 24 horas`.** "Hoy" sobre una
  ventana rodante es falso, y §5.4 aplica a los rótulos igual que a los datos.
- **El log de abajo sigue agrupado por día de calendario**, a propósito: un
  total responde *"cuánto comió desde más o menos esta hora de ayer"*, una
  lista responde *"qué pasó el martes"*. Son dos preguntas distintas y ahora la
  pantalla las escribe distinto. Consecuencia visible y aceptada: una fila del
  domingo puede aparecer bajo el encabezado del domingo y a la vez contar en la
  tarjeta de 24 h.
- **La de 7 días NO cambió** (sigue siendo hoy + los 6 días de calendario
  anteriores), así que la pantalla mezcla **tres** unidades de tiempo a
  propósito. Hay una pregunta abierta para el dueño (`CLAUDE.md` §7.7).

**b · Corregir el inicio de una sesión en curso.** "Empezó cinco minutos antes
de que tocara el botón" es el caso normal, no la excepción. Mientras hay una
lactancia corriendo, el lugar del campo de cantidad + Biberón lo ocupa un
**campo numérico abierto** más un botón; la tarjeta Sleep, que no tiene
selector de tipo, lo suma debajo de "She's awake".

- **Campo abierto, no un menú de minutos.** El atraso real nunca es una de tres
  cifras elegidas de antemano.
- **Acumulativo.** Cada aplicación corre el inicio que la fila tiene *ahora*.
  El cronómetro salta en pantalla porque la fila se relee (medido: 0:02 → 5:04
  → 8:06 → 10:39 aplicando 5, 3 y 2,5).
- **Topes: 240 minutos por aplicación y 12 h sobre el resultado.** El segundo
  se evalúa sobre el resultado justamente para que también frene una suma de
  correcciones chicas. Todo rechazo sale en el `Banner` de la página (§5.5),
  nunca en silencio, y no se manda la escritura.
- **Escribe por el camino de la cola**, no por uno nuevo:
  `updateNursing`/`updateSleep`, lo mismo que usa el panel de edición del log.
  Así hereda `mergePending` y la marca "Not synced yet" de §5.4. Medido sin
  conexión: a los 800 ms el cronómetro ya dice 9:02, hay `.pending-tag` y la
  `SyncBar` dice *"Offline · 1 entry saved on this device, not synced yet."*;
  la base no cambia hasta que vuelve la conexión, y ahí se mueve −9,000 min.
- **Antes de escribir se relee la fila.** Ninguna página de esta app se relee
  sola (§5.4, último punto), así que la pared puede estar mostrando desde hace
  horas una sesión que el otro teléfono ya paró. Sin la relectura, aplicar 60
  minutos sobre una toma terminada de 10 la dejaba **registrada como de 70**
  mientras la pantalla decía "Start moved back 60 min". Ahora no se escribe
  nada y el banner dice que esa sesión ya terminó y dónde corregirla. La
  relectura se saltea con el navegador `offline` (esperar una lectura condenada
  costaría ~7 s y el caso offline ya funcionaba) y cuando la fila todavía es un
  insert **en la cola** — ahí el UPDATE directo matchearía 0 filas, PostgREST
  lo llamaría éxito y la corrección se perdería con un "listo" en pantalla.
- **Lo que esto NO resuelve:** dos pestañas aplicando −5 a la vez sobre el
  mismo valor escriben el mismo resultado y una de las dos correcciones se
  pierde sin error. No hay optimistic locking en este repo.

**c · La unidad como propiedad del campo, no del dispositivo.** El detalle
está en §5.7. Lo que corresponde a esta sección es la forma: un `.seg-inline`
—el mismo segmento de Settings, sin el `margin-top` que lo separa de su label y
sin estirarse— pegado al campo, con el `placeholder` siguiendo a la unidad
activa. Los dos segmentos miden lo mismo entre sí (`min-width: 3em`) porque sin
ese piso quedaban en 27 y 29 px y el pill cambiaba de tamaño al tocarlo, que es
justo lo que §5.1 no quiere. *(Actualizado el 25 sep 2026: `3em` con
`--t-meta` a 12 px daba **36 px**, por debajo del piso táctil. Ahora es
`max(3em, var(--tap-min))` — el igualado se conserva y manda el mayor de los
dos. Ver §5.19.)*

**Y su área táctil vertical es `--tap`, no el piso de `--tap-min`.** `.seg-btn`
nace con `min-height: var(--tap-min)`, que es el piso de los controles
**secundarios** de §1
(tabs, pills, el engranaje) y le alcanza a un segmento de `/settings`, que se
toca una vez por mes. Éste vive en la fila de registro que se usa a una mano a
las 3 de la mañana, al lado de un campo y de un botón que sí miden `--tap`:
medía **36×44 px** en el teléfono y **51×44** en la pared, visiblemente más
bajo que sus vecinos. Con `min-height: var(--tap)` en `.seg-inline .seg-btn`
mide **52** y **84**. Como `.row-tight` no fija `align-items`, la fila entera
se empareja a 58 px en el teléfono y 92 en la pared — campo, toggle y botón
iguales. **El `.seg` de Settings no se tocó**: ahí el piso de `--tap-min` es el
que corresponde.

**Y el idioma no puede cambiar el alto de la pared.** En español y a 1440px el
botón "Biberón" bajaba a un segundo renglón, y como el grid iguala las tres
tarjetas de Today (§5.12) las tres crecían **96 px** (328 → 424). La causa
medida: el botón necesitaba **128,2 px** y tenía **127,2** — **1,1 px**. No se
tocó la palabra: se sacó el sobrante de al lado. `.input.narrow` estaba en
`6.5em`, o sea 136,5 px en la pared para escribir "150"; a `5.5em` el campo
sigue sobrado y la fila queda con ~21 px de aire, que es margen de verdad y no
un empate al pixel. Medido después: EN y ES a 1440 dan **290 / 290 / 290** en
las tres tarjetas, las dos en una sola línea, y a 390 la fila no cambió de
forma. La medida es relativa, así que vale igual en las dos superficies.

### 5.17 Gráficas, semana de vida y la tarjeta de cita (24 sep 2026)

**a · Las etiquetas del eje son HTML, no `<text>` adentro del SVG.** Es el
hallazgo del `impeccable audit` de este pase, y vale más que el arreglo:
`preserveAspectRatio="none"` es lo que deja que la gráfica llene el ancho de
la tarjeta, pero **estira X e Y por separado**, y eso deforma cualquier texto
que viva adentro. Medido con `<text>` adentro, antes de corregirlo:

| ancho | escala X | escala Y | deformación | "Mon" renderizado |
|---|---|---|---|---|
| 390px | 3,24 | 3,04 | 1,07× | 34,1 × 18,4 px |
| 1440px | 4,01 | 2,86 | **1,40×** | 42,2 × 16,4 px |

O sea: en **la pared**, que es el objetivo primario de diseño (§1), las letras
salían 40 % más anchas que altas y con 14,3 px de alto efectivo — **más chicas
que en el teléfono**, exactamente al revés de lo que esa pantalla necesita.
Sacándolas del SVG el texto vuelve a ser texto de la página: sin deformar y
con `--t-meta`, que ya se re-apunta de 12 px a 17 px arriba de 1180px. El
`<svg>` se quedó solo con geometría, y el eje pasó a ser un `border-top`.

**Tokens nuevos**, los tres con su variante de pared: `--chart-ratio`
(16/9 → **21/9**), `--chart-stroke` (1.4 → 1) y `--chart-axis-stroke`
(0.6 → 0.45). Son relaciones y unidades de `viewBox`, no píxeles de pantalla.

**b · Qué gráfica para qué, que no es decoración.** Barras por día para comida,
pañales y sueño: son cantidades discretas que se comparan entre sí ("¿el jueves
durmió menos?"). Línea para el peso: es una magnitud continua y lo que importa
es la pendiente; barras sugerirían que cada visita es independiente de la
anterior. **El eje Y del peso no arranca en cero**, a propósito: entre 3,9 y
4,3 kg un eje desde cero dibuja una línea plana y esconde el único dato que la
gráfica tiene para dar. Los números exactos están en los KPIs de arriba.

**c · Nada compite con `.card.is-live`** (§2, economía del color). Las barras y
la línea van en `--c-accent`, que ya es el color de "esto es un dato". La
tarjeta de próxima cita **no lleva borde de color**: una cita de mañana no
puede pelear la atención con una toma que está pasando ahora. El ícono del
estado vacío sigue en `--c-line`.

**d · El selector de semana**: dos flechas y el nombre en el medio, en vez de un
`<select>` con cuarenta opciones — lo que se hace casi siempre es mirar la
semana que corre o la anterior, y eso es un toque. Las dos flechas miden
`--tap` entera. La semana futura no se ofrece: no tendría datos.

**Barrido medido** (Chromium headless shell, 3 anchos × 2 temas × 2 idiomas ×
6 pantallas = **72 combinaciones**): **0 desbordes, 0 scroll horizontal y 0
targets táctiles por debajo de 44 px**. Contraste AA medido en el navegador
sobre los elementos reales, en los dos temas: etiqueta del eje 7,59:1 (oscuro)
/ 6,73:1 (claro), barras 6,42 / 5,91:1 (mínimo 3 para UI), números de KPI
11,14 / 12,64:1, flecha del selector 9,76 / 10,66:1. Todo por encima del
mínimo.

> **Y una advertencia sobre el propio método, porque casi me come:** la primera
> corrida de ese barrido dio "72 combinaciones, 0 desbordes" **midiendo la
> pantalla de login**. El `.next` estaba corrupto, los chunks daban 500, la
> sesión no se iniciaba y una página vacía no desborda nunca. El barrido ahora
> **falla con exit 3 si la URL medida es `/login`** y registra el `<h1>` de
> cada página. Un barrido que no puede distinguir "todo bien" de "no había
> nada" no es una medición.

### 5.18 La barra al cargar de cero, el "hace X", y el aire del selector (25 sep 2026)

Tres arreglos reportados desde el uso real. Los dos primeros son de medición,
no de gusto.

**a · La barra nacía unos píxeles arriba al abrir la app de cero.** Síntoma
parecido al de §5.11, **mecanismo distinto**: aquel se despegaba *durante* el
scroll y volvía sola al soltar; éste nace mal y **un solo scroll lo asienta
para toda la sesión**, hasta el próximo arranque en frío. iPhone 16 Pro, app
instalada, standalone.

*Qué se descartó primero.* `grep -rn "100dvh\|100vh" app/globals.css`: hay
**tres** lugares, y ninguno lo agregó el pase del 24 sep — `.page` en el
`@media (max-width: 599px)`, `.page:has(.empty-fill)`, y el `max-height` del
desplegable del menú. O sea que el sospechoso es el de siempre, no Statistics
ni la tarjeta de cita ni el selector de semana.

*La cadena, medida.* En el primer paint de cualquier pantalla el documento
mide exactamente el alto de la ventana (`docH` 844 = `innerHeight` 844 a
390×844): todavía no hay datos, así que **lo único que baja la barra hasta el
borde es el `min-height` de `.page`**, y ese `min-height` sale del `dvh`. Si
el `dvh` resuelve corto, la barra queda corta. Demostrado en el navegador
forzando exactamente eso, a 390×1400 y con la página ya cargada:

| `.page` | `pageH` | `navTop` | `navBottom` | hueco debajo de la barra |
|---|---|---|---|---|
| `min-height: 100dvh` (hoy) | 1400 | 1338,3 | 1400 | **0** |
| `min-height: 1340px` (dvh 60 px corto) | 1340 | 1278,3 | 1340 | **60** |
| cadena de porcentajes, con el dvh corto puesto | 1400 | 1338,3 | 1400 | **0** |

Es decir: un `dvh` que resuelve N píxeles corto pone la barra exactamente N
píxeles arriba. Eso **es** el síntoma reportado.

*El arreglo.* `html, body { height: 100% }` y una tercera declaración
`min-height: 100%` después de las de `vh`/`dvh`. Un porcentaje se resuelve
contra el bloque contenedor —el viewport de layout, fijado en el primer
layout— y no contra la unidad dinámica que WebKit recalcula tarde. Se eligió
sobre las dos alternativas con JavaScript (un listener de
`visualViewport.resize` al montar, o escribir `visualViewport.height` a una
custom property) porque **no agrega JavaScript a algo que hoy es CSS puro**:
las dos con JS dependen de que el valor que lee el JS ya esté asentado, que
es justamente lo que está en duda. Las líneas de `vh`/`dvh` se quedan de piso.
Cero cambios de JSX.

*Lo que NO se puede afirmar desde este VPS, y hay que decirlo entero:*
**Chromium no reproduce el bug de WebKit** — 24 combinaciones (4 viewports ×
6 pantallas), hueco debajo de la barra **0 en el primer paint, 0 con los datos
cargados y 0 después de un scroll**, antes y después del cambio. Y tampoco se
pudo emular `display-mode: standalone`: `Emulation.setEmulatedMedia` con esa
feature no mueve `matchMedia('(display-mode: standalone)')` en
chrome-headless-shell, que siguió diciendo `false`. Lo que sí está medido acá
es que el cambio **no mueve un píxel**: 18 combinaciones (3 anchos × 6
pantallas) con el mismo `docH`, el mismo `navTop` y el mismo `navBottom`.
**La confirmación depende del iPhone de Luis.**

**b · El "hace X" contaba desde que la toma EMPEZABA.** La tarjeta de Comida
de Today mostraba `timeAgo(lastFeed.at)`, y para una toma de pecho ese `at`
era `started_at`. Una toma de 45 minutos recién terminada decía **"1h 35m
ago"** cuando lo cierto era **"50m ago"** (medido en el navegador con esos
datos exactos). Es el mismo criterio que `lastFeedingEnd` (lib/schedule.ts) ya
aplicaba desde el 24 sep para el countdown: hasta hoy **las dos líneas de la
misma tarjeta se contradecían** — una fechaba el evento en su inicio y la otra
en su fin.

El campo se llama ahora `endedAt` y el instante también **ordena**: un biberón
de las 10:20 no es más reciente que una toma que empezó a las 10:00 y terminó
a las 10:40. Con el criterio viejo ganaba el biberón y la tarjeta nombraba el
evento equivocado. Hay test que falla si alguien lo revierte.

*Dónde más se buscó el patrón* (todos los usos de `timeAgo` del repo, no solo
el primero): `/dashboard` Pañal (`changed_at`) y Dormir (`ended_at`) ya
contaban bien; `/settings` (rotación y última lectura del feed de calendario)
y `components/SyncStatus.tsx` (copia guardada, rechazo encolado) son eventos
puntuales, no tienen fin. **El único sitio con el defecto era la tarjeta de
Comida.** `/history` y las tres pantallas de sección no muestran tiempo
relativo: muestran la hora y el rango.

**c · El selector de semana tocaba la primera tarjeta.** En `/statistics` el
selector vive en una tarjeta suelta **arriba** de la grilla, no adentro (en
`/feeding`, `/diapers` y `/sleep` está adentro, y ahí el `gap` de `.grid` ya
lo separa). Fuera de la grilla no recibe ese gap: medido, **0 px** entre el
borde de abajo del selector y el borde de arriba de la primera tarjeta, a 390
y a 1440. Ahora `var(--col-gap)` — el mismo separador que usan las tarjetas
entre sí — deja **12 px** en el teléfono y **20 px** en la pared. No es un
valor nuevo.

**Barrido de esta vuelta** (chrome-headless-shell, **12 pantallas × 3 anchos ×
2 temas × 2 idiomas = 144 combinaciones**, antes y después del cambio, con una
semana de datos sembrada): `horizScroll` **0 de 144**, texto cortado **0**,
fallas de contraste AA **0** sobre 7 760 elementos de texto en 48 cargas.
Idéntico antes y después: **0 regresiones**. Cada fila registra el `<h1>` real
y el `location.pathname`, y el barrido aborta si una pantalla privada
renderizó `/login` — la trampa de §5.17.

**Lo que el barrido encontró y NO se tocó** está en §8, marcado para decidir:
los targets táctiles de `.linkish` y del toggle oz/ml, y el desborde de
`/pumping` a 1440 en español.

### 5.19 El piso táctil, y la fila de lados que no entraba (25 sep 2026)

Los dos hallazgos que el barrido del 25 sep dejó anotados en §8 "para que
decida Luis". Los aprobó, y acá están con su medición antes/después. Los dos
son de medición, no de gusto.

**a · `--tap-min`: el piso táctil pasa a ser un token.**

Hasta hoy convivían dos números y un solo nombre. `--tap` (52 px en el
teléfono, **84 px en la pared**) es el tamaño **cómodo**, el que se toca a una
mano a las 3 de la mañana o desde parado del otro lado del cuarto. El **piso**
de la guía —44 px— no es eso: es el mínimo por debajo del cual un control no se
toca bien, y **no crece con la superficie**. Estaba escrito a mano en seis
reglas (`.pill`, `.tab`, `.gear`, `.nav-menu-version`, `.seg-btn` y una regla
suelta de `.feed-actions`) y no estaba en ninguna que lo necesitara.

Ahora es `--tap-min: 44px`, un token del `:root`, **sin** redefinición en el
`@media` de la pared — a propósito: un piso que crece no es un piso.

Lo que pasó a usarlo, y lo que medía antes (390/768/1440 px, dos temas, dos
idiomas, con una semana de datos sembrada):

| Control | Dónde | Antes | Después |
|---|---|---|---|
| `.linkish` "lb / in" | `/growth` | **47,6 × 18** (66,7 × 24 a 1440) | 47,6 × **44** (66,7 × 44) |
| `.linkish` del alta | `/login` | **219,5 × 18** (236,2 × 18 en español) | 219,5 × **44** |
| `.linkish` "Edit" | log de `/feeding`, `/diapers`, `/sleep`, `/pumping`, `/growth`, `/history` | **33,3 × 44** | **44** × 44 |
| `.seg-inline .seg-btn` oz/ml | `/dashboard` | **36 × 52** | **44** × 52 |

El "Edit" tenía el alto y no el ancho porque el alto se lo daba
`.feed-actions .linkish { min-height: 44px }` y el ancho no se lo daba nadie.
Esa regla **se borró**: el piso es de `.linkish`, en las dos dimensiones, y
`inline-flex` con el texto centrado — el área crece **alrededor** de la
palabra, no la corre de lugar. El segmento oz/ml no es `.linkish`: su
`min-width: 3em` es lo que iguala "oz" con "ml" para que el pill no baile al
cambiar de unidad, y con `--t-meta` a 12 px eso daba 36 px. Se conservó el
igualado y se le puso el piso: `max(3em, var(--tap-min))`.

*Medición.* Barrido de **144 combinaciones** (12 pantallas × 3 anchos × 2 temas
× 2 idiomas) antes y después, con el `<h1>` y el `location.pathname` de cada
fila registrados y la trampa de §5.17 armada (0 filas renderizaron `/login`).
Controles por debajo de 44 px en cualquiera de sus dos dimensiones:
**11 distintos → 0**. `horizScroll` 0 de 144 en las dos corridas.

*Y lo que mueve de espaciado, que es lo que hacía a esto una decisión.* Alto de
documento, 7 pantallas × 3 anchos × 2 idiomas = 42 combinaciones, antes → después:

| Pantalla | 390 | 768 | 1440 |
|---|---|---|---|
| `/growth` | +26 px | +26 px | +20 px |
| `/history` | +35 px (sólo inglés) | 0 | 0 |
| `/pumping` | 0 | 0 | +96 px (sólo español, ver **b**) |
| `/dashboard`, `/feeding`, `/diapers`, `/sleep` | 0 | 0 | 0 |

`/growth` sube exactamente lo que crece el toggle (44 − 18 = 26 en el teléfono,
44 − 24 = 20 en la pared), porque vive en un `.between` junto al título.
`/history` sube un renglón a 390 en inglés y sólo ahí: "Edit" pasa de 33,3 a
44 px de ancho y una fila del log envuelve una vez más. **Las otras 39
combinaciones dan 0 px de diferencia**, con **0 texto cortado** y **0 scroll
horizontal** antes y después.

**b · La fila de lados de `/pumping` no entraba, y la métrica vieja no lo veía.**

"Izquierdo / Derecho / Ambos" a 1440 px: `scrollWidth` **425** contra
`clientWidth` **401**. Veinticuatro píxeles que se salen de la caja. En inglés
("Left / Right / Both") entra; a 390 y 768 entra en los dos idiomas, porque el
tipo es más chico — el desborde existe **sólo** a 1440 en español, donde
`--t-body` pasa a 21 px.

Lo importante no es el desborde: es **por qué pasó por bueno el 23 sep**. Aquel
barrido medía `document.documentElement.scrollWidth - clientWidth`, o sea
scroll horizontal **de página**. Un hijo que se sale de un contenedor flex no
produce eso: la página no crece, el contenido se monta sobre el borde de la
tarjeta. La métrica que sí lo ve es **`scrollWidth - clientWidth` del propio
contenedor**, y es la que hay que usar de acá en adelante.

*El arreglo, y lo que deliberadamente no se tocó.* `.row` sigue siendo
`display: flex` **sin** `flex-wrap`. Eso es deliberado y `.row-wrap` existe
como clase aparte justamente para pedirlo donde hace falta (ya lo usaban la
fila del biberón de `/dashboard` y una de `SectionPage`). Así que el cambio son
**dos `className`** en `app/pumping/page.tsx` —el formulario de alta y el panel
de edición—, de `row` a `row row-wrap`. Cero CSS nuevo, cero token nuevo.

Después: desborde interno **24 → 0** en las 144 combinaciones, `horizScroll` 0
en todas. Cuesta **+96 px** de alto de documento a 1440 en español: "Ambos"
baja a un segundo renglón y en la pared un botón mide `--tap` = 84 px más el
`gap`. Envolver es lo que hace la fila del biberón por el mismo motivo.

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
| 5.7 | Unidad hablada; **mostrar** siempre en oz y **entrar** con un toggle por campo | `DISPLAY_UNIT` y `formatVolume()` / `unitToMl()` en `lib/format.ts`; `components/AmountUnit.tsx`. Reverificado el 23 sep 2026: `lib/useVolumeUnit.ts`, que esta fila citaba, **ya no existe** |
| 5.8 | Hora pasada en todas las acciones | los parámetros `at?: string` de `lib/db.ts` (`:202`, `:253`, `:303`, `:318`, `:362`…) |

Nada de §5 quedó sin verificar en aquella pasada. **§5.11, §5.12, §5.14,
§5.15 y §5.16 son posteriores** y traen sus mediciones adentro.

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
  en el botón Menu; `role="menu"` / `role="menuitem"` en el desplegable.
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
- **Tokens de movimiento / duración:** existen desde el 23 sep 2026 —
  `--motion-enter`, `--motion-wait`, `--ease-out` y un único `@keyframes
  enter` (§4). Es el mínimo para la transición de §5.13; una escala completa
  (salidas, movimiento, no solo opacidad) sigue por definir.
- **Estados de carga:** sigue siendo texto plano `"Loading…"` (`.empty
  .loading-note`), sin skeleton ni spinner — pero desde el 23 sep 2026 entra
  con retraso y fundido (§5.13), así que en una carga normal no se ve. Un
  skeleton con la forma del contenido sigue **por definir**.
- **Contraste:** medido en ambos temas (§2). Los cuatro pares del oscuro bajo
  AA se corrigieron el 21 sep 2026; sólo queda `--c-danger` como texto sobre
  elevado (2.78:1), en una clase que hoy no usa nada.
- **Íconos del nav:** **trece** SVG dibujados a mano en `components/ui.tsx`; no
  son una librería, y este repo no tiene ninguna instalada (se confirmó el 23
  sep 2026 contra `package.json`). El de `menu` —tres líneas verticales del
  mismo alto— se dibujó el 23 sep 2026 con la misma regla; el de `settings`
  (sliders), que era el del botón del menú, pasó a nombrar a Settings. El
  **decimotercero**, `statistics` (23 sep 2026), es un eje en L con **tres
  rectángulos** de altura distinta: se dibujó con rectángulos y no con tres
  líneas a propósito, porque en la misma barra queda al lado de `menu`
  (`M7 5v14 / M12 5v14 / M17 5v14`, tres líneas verticales iguales) y tiene
  que distinguirse también de `growth` (una línea que sube con flecha). Misma
  convención que el resto: grilla de 24, `viewBox="0 0 24 24"`, `fill="none"`,
  `stroke="currentColor"`, `strokeWidth="1.75"`. Desde el 21 sep 2026 el engranaje de tablet/pared también es el
  SVG `settings` (el mismo de la barra del teléfono, solo, 1.3em dentro del
  círculo de 44px), no el glifo `⚙`.
- *(Cerrado el 25 sep 2026, v0.10.3 — **targets táctiles por debajo de 44 px**.
  Medido en el barrido de 144 combinaciones, era todo **previo** a aquel pase:
  `.linkish` era `padding: 0` sin `min-height`, y sólo `.feed-actions .linkish`
  recibía el alto. Los números de antes: "lb / in" de `/growth` **47,6 × 18**
  (66,7 × 24 en la pared); "Need an account? Sign up" de `/login`
  **219,5 × 18**; el "Edit" del log en seis pantallas **33,3 × 44**; el toggle
  oz/ml de `/dashboard` **36 × 52**. Se dejó abierto porque mover el piso de
  `.linkish` mueve el espaciado de siete pantallas a la vez — una decisión de
  diseño, no un arreglo. Luis la tomó y está hecha: ver §5.19.)*
- *(Cerrado el 25 sep 2026, v0.10.3 — **`/pumping` desbordaba su tarjeta 24 px
  a 1440 px en español**. La fila "Izquierdo / Derecho / Ambos", `scrollWidth`
  425 contra `clientWidth` 401. No producía scroll horizontal de página, que
  es por lo que un chequeo a nivel página no lo veía. `.row` sigue **sin**
  `flex-wrap` —el no-wrap es deliberado y `.row-wrap` existe aparte— y lo que
  cambió son las dos filas de `/pumping`, que ahora son `row row-wrap`.
  Ver §5.19.)*
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
