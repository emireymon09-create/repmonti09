# Revisión de pantallas v5: capas, encimados y diseño (7 oct 2026)

Rama `feat/milk-inventory-v5` (worktree `../amelia_app-v5`). Disparador: Luis vio
"elementos nuevos que se enciman en Inicio". Sin push, nada contra la nube,
migraciones intactas. Todo lo que sigue se **midió** en Chromium headless shell
148 (`tests/e2e`), salvo lo marcado **[NO VERIFICADO]**.

Referencia de diseño: **`design.md`** (minúscula). `DESIGN.md` no existe en la
rama. Además `app/globals.css` (tokens), `CLAUDE.md` §5.7 y la política nueva
`docs/politica-capas.md`.

## 1. Inventario

### 1.1 Rutas

| Ruta | Qué es | En la matriz |
|---|---|---|
| `/` | redirige a `/dashboard` o `/login` | (redirección) |
| `/login` | inicio de sesión (sin sesión) | sí |
| `/dashboard` | **Inicio / Hoy** — incluye el estado "esperando" (sin `birth_date`), que hace de onboarding | sí, + 2 combos de estados |
| `/feeding`, `/diapers`, `/sleep` | secciones (`components/SectionPage.tsx`) | sí |
| `/pumping` | **Leche** | sí |
| `/statistics` | Datos | sí |
| `/growth` | Medidas / Crecimiento | sí |
| `/appointments` | Médico | sí |
| `/history` | Historial (único con ⋯ por fila) | sí, + ⋯ y cadenas |
| `/settings` | Ajustes | sí |
| `/version` | historial de versiones | sí |
| `/api/*` (8) | sin UI: `calendar/feed`, `calendar/[token]`, `ingest`, `push/nursing-check`, `push/subscription`, `quick/diaper`, `quick/nurse`, `quick/status` | no aplica |
| **Cambiador** | firmware propio contra `/api/quick/*` (`proposals/changer-display.md`); no usa estos componentes | no aplica |

### 1.2 Todo lo que flota, bloquea o avisa

Comprobación de ausencia (sin comentarios): `grep -rnE '<dialog|showModal|createPortal|[^a-z]Sheet|[Tt]oast|position:\s*fixed' app components lib` → **0**.
`position` en `app/globals.css`: tres `absolute` y un `sticky` (y una mención en
un comentario).

| Componente | Ruta(s) | Disparador | z-index | Contenedor |
|---|---|---|---|---|
| Barra de navegación `.nav` | todas las privadas | siempre | `var(--z-bar)` = 20 (teléfono, `sticky`); sin z en ≥600 px | `.page > nav.nav` |
| Menú `.nav-menu` (`role=menu`) | todas las privadas | botón Menú | `var(--z-popover)` = 30 | `nav.nav > .nav-settings` |
| ⋯ de fila `.row-menu-list` (`role=menu`) | `/history` | ⋯ de una fila | `var(--z-popover)` = 30 | `.feed-item > .row-menu` |
| Atajo de tarjeta `.card-quick` (`absolute`) | `/dashboard` (Comida, Pañal, Dormir), `/pumping` (Extracciones) | siempre | auto | `.card.has-quick` |
| `window.confirm` (nativo, bloqueante) | `/dashboard` desechar empezado; `/pumping` cancelar cronómetro, desechar biberón, combinar, deshacer combinación, reemplazar Similac abierta, terminar/desechar Similac; `/history`, `/growth`, `SectionPage` borrar; `/settings` rotar link; `SyncErrorBanner` descartar | acción del usuario | — (del navegador) | ventana |
| `SyncBar` | `/dashboard`, `/growth`, `/history`, `/pumping`, secciones, `/appointments` (vía `SyncStatus`) | sin conexión / cola | — (flujo) | zona de avisos de `.page` |
| `SeenNote` | `/dashboard`, `/growth`, `/history`, `/pumping`, `/statistics`, secciones | copia guardada offline | — | zona de avisos |
| `SyncErrorBanner` | `/dashboard`, `/growth`, `/history`, `/pumping`, secciones, `/appointments` | rechazo del server | — | zona de avisos |
| `Banner` error/ok/warn | todas las de arriba + `/login`, `/settings`, `/statistics`, `NursingAlerts` | error de lectura/acción, confirmación | — | zona de avisos (o dentro de su tarjeta en Ajustes) |
| `.pending-tag` "Todavía sin sincronizar" | `/dashboard`, `/growth`, `/pumping`, secciones | fila en cola | — | dentro de la fila/tarjeta |
| Avisos v5 en línea: receta, "si llora", tomas cubiertas, enfriando, aviso de fórmula (ninguna abierta / queda poca / vence pronto), biberón empezado vencido + Desechar | `/dashboard` (tarjeta Comida) | estado de la leche | — | `.meta` dentro de la tarjeta |
| Avisos v5 en línea: Caducada + Desechar, Enfriando · lista ~HH:MM + "Ya está fría", Combinado con … + Deshacer, tarjeta Combinar, tarjeta Similac | `/pumping` | estado de la leche | — | tarjetas de Leche |
| Panel del biberón (inline, `Card spanAll`) | `/dashboard` | botón Biberón | — | debajo de las tres tarjetas |
| Paneles de edición `.edit-panel` (uno a la vez) | `/history`, secciones, `/growth`, `/pumping` | Editar | — | dentro de la fila |
| `<details>` "Todavía no se usan" | `/settings` | toque | — | tarjeta de Conservación |
| `EmptyState` / `NoBaby` / `.loading-note` | varias | sin datos / sin bebé / cargando | — | `.page` |
| Banner de actualización / instalación de la PWA | — | **no existe** en la UI (el SW acepta `skip-waiting` por mensaje, ningún componente lo muestra) | — | — |

## 2. Cómo se midió

`pnpm test:layout` (`tests/e2e/README.md`): build de producción en
`127.0.0.1:3107`, un solo chrome-headless-shell, reloj del navegador fijo, dos
familias sembradas por las RPC reales con **todos los estados de Inicio a la
vez** (leche caducada + fría + enfriando + combinación viva + biberón empezado
vencido + Similac abierta por caducar con stock bajo + sueño abierto + turno en
< 36 h; la familia A además con lactancia abierta; la B con el panel del biberón
abierto) y un pañal anotado **sin conexión** (cola + barra de sincronización).
Por cada celda: la página, la página con el menú abierto (Escape cierra, el foco
vuelve), y en `/history` el ⋯ de la última fila, las dos cadenas con puntero y
sin puntero, y Escape del ⋯.

## 3. Matriz final (después de los arreglos y de endurecer el banco)

Corrida final del 7 oct 2026 sobre `c00f92d` + el banco endurecido por la
revisión independiente (barra y menús medidos por dentro, desborde vertical
recortado, barra contra `fixed`, sin 0016 falla, cadenas omitidas escritas).
Cada celda de Inicio es un estado completo; "datos+menú" es el mismo con el menú
abierto. Por celda: 0 scroll horizontal, 0 superposiciones, 0 capas cruzadas, 0
ítems tapados, 0 fuera de ventana, 0 desbordes, 0 objetivos < 44 px, 0 contraste
bajo, 0 botones mal formados, nunca más de un menú abierto.

| Página | 360x640 | 390x844 | 430x932 | 768x1024 | 600x960 | 1180x820 | 1440x900 |
|---|---|---|---|---|---|---|---|
| /dashboard | PASS 24/24 | PASS 24/24 | PASS 24/24 | PASS 24/24 | PASS 24/24 | PASS 24/24 | PASS 24/24 |
| /feeding | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /diapers | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /sleep | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /pumping | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /statistics | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /growth | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /appointments | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /history | PASS 24/24 | PASS 28/28 | PASS 28/28 | PASS 28/28 | PASS 28/28 | PASS 28/28 | PASS 27/27 |
| /settings | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /version | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 | PASS 8/8 |
| /login | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |

máximos sobre todas las celdas: hscroll=0 overlaps=0 layers=0 covered=0 offViewport=0 boxOverflow=0 smallTargets=0 lowContrast=0 btnText=0 menusOpen= 1
estados de Inicio: datos · datos+menú · comboB+biberón+offline · comboB+biberón+offline+menú · comboA+lactancia+sueño+offline · comboA+lactancia+sueño+offline+menú
celdas 891 FAIL 0

Omitidas (escritas por el banco, no son FAIL): `/history` "menú→⋯ con puntero" a
360×640 (las 4: el menú abierto tapa todos los ⋯) y a 1440×900 ES claro; la
cadena **sin puntero** sí se midió en todas.

Revisión independiente (re-ejecutó las dos matrices: 508/0 y 383/0): **SIN
BLOQUEANTES**. Sus hallazgos sobre el banco (M1, M2, m4, m5, m6) se cerraron antes
de esta corrida; m3 (texto suelto de un contenedor contra un control absoluto
hijo) queda anotado como teórico.

## 4. Defectos encontrados y arreglados

**Clasificación medida, no leída:** el mismo banco, con los mismos estados, contra
un build de **0.13.0** (`66462fa`, worktree desacoplado, `127.0.0.1:3113`) dio
**508 celdas, 258 FAIL** con exactamente las mismas clases de defecto. Por eso
**todos los defectos de esta tabla son preexistentes** (0.13.0 o antes). La
matriz de v5 **no encontró ningún defecto de capas introducido por v5**.

| # | Defecto | Medida antes | Prueba que falla primero | Arreglo | Después |
|---|---|---|---|---|---|
| D1 | El ⋯ de la última fila de `/history` se abre **debajo de la barra**: "Editar" y "Borrar" tapados por la pestaña "Datos" | `covered=2`, menú∩barra 144×61,7 px (390×844) | matriz e2e, celda `+⋯última` | `bac51c3`: abre hacia arriba si no entra (`placePopover`, `.opens-up`) + `--z-popover` > `--z-bar` | 0 |
| D2 | **Dos menús abiertos a la vez** al activar sin puntero (lector de pantalla): el menú de navegación tapa al ⋯ | `menusOpen=2`, `covered=2` | celdas `+menú→⋯(sin puntero)`, `+⋯→menú(sin puntero)` | `bac51c3`: `popoverBus` (uno a la vez), hook único `usePopover` | `menusOpen=1` |
| D3 | El atajo `.card-quick` (52×52) **pisa la primera fila** en `/pumping` ("3.04 oz · M4"); un toque ahí iba al Historial | `overlaps=2`, 36,8×18 px | celda `/pumping datos` | `bac51c3`: 44 px en la esquina y el primer hijo reserva ese alto y ancho | 0 |
| D4 | Contraste del ítem de la pantalla actual en el menú | 4,02:1 oscuro, 4,45:1 claro | celdas `+menú` | `bac51c3`: texto `--c-text`, acento en el ícono | 0 |
| D5 | "Borrar" del ⋯ en `--c-danger` sobre elevado | 2,78:1 | celda `+⋯última` | `bac51c3`: `--c-text` sobre `--c-danger-soft` | 0 |
| D6 | En la pared (1180 ES), "Ambos" de la tarjeta **Pañal** de Inicio se sale 48 px y pisa la tarjeta Dormir | `boxOverflow=2` (48 y 24 px) | celdas 1180×820 `/dashboard` | `dc96d5a`: `row-wrap` | 0 |
| D7 | "Abrir Médico" (`<a class="btn">`) subrayado y con el texto 8 px fuera de centro | `btnText=1`, `dy=8` | medida nueva `btnText`, todas las celdas de Inicio con turno | `dc96d5a`: `a.btn` centrado sin subrayado | 0 |
| D8 | En la pared (1180 ES), la fila de pañal de "Registrar uno pasado" desborda 52 px y la página scrollea **3 px en horizontal** | `hscroll=3`, `boxOverflow=5` | celdas 1180×820 `/diapers` | `017a942`: `row-wrap` (alta y edición) | 0 |

Del auditor de diseño (lectura de código, sin navegador): 0 bloqueantes, 0
mayores, 4 menores nuevos de la rama. **Arreglado:** el biberón empezado sin
"Todavía sin sincronizar" (`017a942`, sin prueba e2e propia: la siembra no deja
un empezado en cola). **Anotados, sin tocar** (son decisiones, no layout):
avisos de Similac caducada/sobregirada con peso de nota gris (`.meta`); un `'?'`
posible en `combine.rowNote` (`app/pumping/page.tsx:551`) si un biberón ya no
existe; `.choice input` usa `--s-5` como tamaño; `.recipe-line` es un cuarto
nivel tipográfico (ahora anotado en `design.md` §4).

## 5. Artefactos del banco que se corrigieron (no eran defectos)

- Un `click({force})` sobre un ⋯ tapado por el menú abierto **navegaba** y se
  medía la página siguiente a mitad de carga (ratios 1:1, "foco no vuelve").
- Lo de adentro de un `<details>` cerrado tiene caja pero no se pinta
  (`checkVisibility`): daba 11 "superposiciones" falsas en `/settings`.
- El menú a 640 px de alto **scrollea por dentro**: "Ajustes" recortado no está
  tapado, se alcanza scrolleando el menú.
- Medir antes de que termine el fundido de entrada da contrastes falsos: el
  banco espera a que no haya animaciones corriendo.

## 6. Lo que NO se reprodujo, y lo que no se puede ver desde acá

- **El encimado en Inicio que reportó Luis no se reprodujo en Chromium** con
  todos los estados a la vez, a 360/390/430/600/768 px, ES/EN, claro/oscuro. Lo
  único en Inicio fue de la pared (D6, D7) y del menú (D4). Hipótesis
  **[NO VERIFICADAS]**: (a) la barra de abajo elevada del iPhone (`CLAUDE.md` §6,
  v0.10.4, sigue abierta) que flota sobre el contenido; (b) una captura de página
  completa, donde la barra `sticky` aparece en el medio (pasa en las capturas
  `fullPage` de Playwright de este mismo banco); (c) el atajo ↗ sobre una leyenda
  larga de la última toma, que D3 cierra por construcción.
- WebKit/iOS, la PWA instalada, `safe-area-inset-*` reales, el teclado en
  pantalla y el botón Atrás de Android: **[NO VERIFICADO]**.
