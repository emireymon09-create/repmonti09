# Ensayo general pre-deploy 0.13.0 → 0.14.0 (8 oct 2026)

Todo local (127.0.0.1, stack Docker `amelia-local` y Postgres efímeros sin red).
Sin push, sin nube. `main` = `9824e26`, `origin/main` = `66462fa` al inicio.

## E0 — línea base (rama `feat/milk-inventory-v5` @ `db170b7`)

| Comando | Resultado |
|---|---|
| `git status --short` | vacío |
| `node -v` / `.nvmrc` | `v24.16.0` / `24` |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm lint` | exit 0, sin warnings |
| `pnpm format:check` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test:all` | unit 30 archivos / **691** × 4 husos; integración 28 archivos / **391** (stack local en 0016) |

Incidente de proceso: el `test:all` de E0 arrancó con el monitor otra vez en
ALERTA (load1 6.33 > 6, causado en parte por el build). Desde ahí todo lanzamiento
pesado pasa por una compuerta que espera el OK.

## E1 — réplica de producción (stack local reseteado a 0001–0015)

`pnpm db:reset` desde el worktree de 0.13.0 (`66462fa`): historial
`0013,0014,0015`, `to_regclass('public.milk_transfers')` nulo. Siembra con
`seed-replica.mjs` (semilla fija 20261008; leche SOLO por las RPC de 0015 con el
JWT de un padre; 264 llamadas, 0 errores). Dos familias (A con 2 padres, B con 1),
dos bebés.

| Tabla | Filas |
|---|---|
| feedings | 128 (bebé A 110) |
| pumping_sessions | 110 (A 93) |
| nursing_sessions | 385 (A 345) |
| sleep_sessions | 111 (A 91) |
| diaper_changes | **1160** (A 1100: pasa la página de 1000 de `lib/readAll.ts`) |
| milk_containers / milk_drawdowns / milk_discards / milk_feeding_edits | 108 / 135 / 19 / 10 |

Casos incómodos: 1 caducado sin desechar, 2 con `lost_ml` > 0, 10 tomas editadas,
7 extracciones editadas, 2 tomas anuladas, 19 desechos de caducada, 1 lactancia y
1 sueño abiertos, 10 tomas y 2 extracciones de app vieja (sin desglose/lados), 1
extraída hace < 60 min, 1 toma de la última hora con "Sobró".

**Paso 2 del runbook ensayado:** `pg_dump -Fc` (393 KB, 0,17 s) → `pg_restore -l`
lista `milk_containers`, `milk_drawdowns`, `milk_discards` y ninguna de 0016.
**Primera restauración probada de este proyecto** (Postgres efímero de la misma
imagen, `--network none`): `pg_restore` sale con **exit 1 y 370 errores**, todos
de esquemas de Supabase (`auth`, grants, privilegios por defecto); **las 19 tablas
de `public` quedan idénticas** (mismo conteo y md5 por tabla que la réplica). Pero
`auth.users` **no** entra (columnas distintas en una imagen limpia) y por eso
**no se recrean 10 de las 13 claves foráneas a `auth.users`**: un dump restaurado
"tal cual" en un proyecto nuevo no deja entrar a nadie. Anotado en el runbook §2.

## E2 — el runbook al pie de la letra, por el "SQL Editor"

Para que sea el Editor y no `psql`: un `postgres-meta` v0.99.0 (el servicio al
que el SQL Editor de Supabase manda cada "Run": `POST /query` con el texto
entero) en `127.0.0.1:18080`, conectado a la réplica como `postgres`, que acá
—igual que en la nube— **no** es superusuario (`rolsuper = f`,
`rolbypassrls = t`). El Editor muestra el resultado de la **última** sentencia
que devuelve filas.

| Paso | Esperado (runbook) | Obtenido | |
|---|---|---|---|
| 1·c1 huellas | 0014 t, 0015 t, 0016 f | t / t / f | = |
| 1·c2 objetos | 21 filas `false` | 21 `false` | = |
| 1·c3 invariante 0015 | 0 en todas | 8 filas, todas 0 | = |
| 1·c4 backfill | informativo | 108 contenedores; 1 "Enfriando"; 3 fríos vigentes; 19 desechos; 0 sin contenedor; 34 tomas con sobró (1 de la última hora); 686 ml de fórmula en 72 h | = |
| 1·c5 historial | informativo | `0014_milk_inventory, 0015_milk_phase1_2` | = |
| 1·c6 volumen | anotar | feedings 128/126 · pumping 110/110 · containers 108/108 · drawdowns 135/133 · babies 2 | anotado |
| 1·c7 abiertas | 0 y 0 | **1 y 1** (sembradas a propósito) | ambiguo → **H-R3** |
| 2 respaldo | dump con 0014/0015 y sin 0016 | sí (ver E1); restauración probada por primera vez | **H-R1** |
| 3.1 aplicar 0016 | "Success. No rows returned" | HTTP 200 en **92 ms**, el Editor muestra **una tabla de una fila, columna `set_config`, vacía** (última sentencia con filas: `select set_config('amelia.milk_rpc', '', true)`) | distinto → **H-R2** |
| 3.2 c1 / c2 | 0016 t / 21 `true` | t / 21 `true` | = |
| 3.2 por objetos | una fila toda `true` | 15 columnas `true` | = |
| 3.2 c6 de nuevo | mismos números | idénticos | = |
| 3.3 notify | inocuo | "Success. No rows returned" | = |
| 6.3 invariante | 0 filas | **0 filas** (y `count(*)` = 0) — pero la instrucción "cambiar `do` por `select`" no es ejecutable tal cual | **H-R4** |

**Tiempo y bloqueos (con 128 tomas / 108 contenedores / 1160 pañales):** 0016
tarda **92 ms** de punta a punta. Un sondeo en paralelo (lecturas de
`milk_containers`, `feedings`, `nursing_sessions`; alta de pañal y UPDATE de
`milk_containers` en transacciones que se deshacen) dio **0 esperas por lock en
19 muestras** y latencia máxima 99 ms (= el costo de `docker exec`, sin
bloqueo). Qué locks toma, medido dentro de la transacción: E3.

**Ejecución doble (accidental, durante E2):** un `curl` de diagnóstico mandó 0016
**otra vez** al Editor. Resultado: HTTP 400,
`column "fridge_at" of relation "milk_containers" already exists` (42701), y la
base **sin cambios** (c1/c2 iguales, 0 sesiones `idle in transaction`). Es el
mensaje que vería Luis si corre 0016 dos veces.

## E3 — integridad de datos, doble ejecución, a medias y reversa

**Antes/después de 0016** (`snapshot.sh`: por cada una de las 19 tablas de 0.13.0,
conteo + md5 de **sus columnas de 0.13.0** ordenadas por PK; sumas de ml por bebé
—extraído, "lo que hay", perdida, servido, desechado, tomas, fórmula— y md5 de
cada contenedor): **`diff` vacío**. Ningún dato de 0.13.0 cambió.

Backfill: `fridge_at = stored_at` en 108/108, `cold_at` nulo en 108/108, 19/19
desechos con la forma de caducada (`container_id` sí, `feeding_id` no, `reason =
'expired'`), `milk_ops`/`milk_transfers`/`formula_containers` vacías y con RLS;
22/22 tablas de `public` con RLS. Invariante de 0016: **0 filas**.

| Prueba | Resultado |
|---|---|
| 0016 dos veces (Editor) | HTTP 400 `42701 column "fridge_at" of relation "milk_containers" already exists`; base sin cambios |
| 0016 pegada **cortada a mitad de una sentencia** | HTTP 400 `42601 syntax error at end of input`; nada aplicado |
| 0016 pegada **cortada en un fin de sentencia** (línea 729, sin `commit`) | **HTTP 200 y el Editor muestra `on`** — parece éxito — y **nada aplicado** (0016 `false`, 0/21, datos idénticos, 0 sesiones `idle in transaction`) → **H-R5** |
| 0016 **interrumpida** (pausa inyectada y `pg_terminate_backend`) | nada aplicado, datos idénticos |
| Locks de 0016 (medidos a mitad) | `AccessExclusiveLock` en `milk_containers` y `milk_discards` hasta el `commit`; `ShareRowExclusiveLock` en `feedings`, `babies`, `families`. Una lectura de Leche espera a que termine: en la práctica ≤ ~92 ms |
| Éxito real de 0016 | el Editor recibe `[{"set_config":""}]`: una tabla con la columna `set_config` **vacía** |

**Reversa** (`docs/rollback-leche-v5.sql` por el Editor, con el bloque
`milk_backup_v5` descomentado) sobre la réplica **con uso de v5** (2 extracciones
de 11 argumentos, "ya está fría", una combinación viva con una toma de 120 ml
servida de un destino de extracción 90, una combinación deshecha, 6 Similac con 1
abierta, 1 desecho de biberón empezado). Ensayo en seco previo con `psql`
(`commit` → `rollback`) para ver los NOTICE, que **el Editor no muestra** (H-R6):
`1 combinación(es) viva(s), 6 Similac anotada(s) (1 abierta(s)), 1 desecho(s) de
biberón empezado, 0 biberón(es) todavía enfriando`; "Lo que hay" A 343 → 343 ml,
B 65 → 65 ml.

| Qué | Resultado |
|---|---|
| Después | 0016 `false`, 0/21; invariante de 0015 (consulta 3): 8 × 0 |
| Esquema `public` vs 0001–0015 | igual salvo 6 líneas de envoltorio de la herramienta (`CREATE SCHEMA public`, su `COMMENT` y 4 `GRANT USAGE ON SCHEMA`, que `pg_dump --schema` emite y `pg_restore -n` no) |
| Contenedores | **0** con `remaining`/`lost`/liberado distinto |
| La toma servida por encima de la extracción | igual (`120 | 120 | 0`); porciones `M5 120` → `M5 60 + M6 60` |
| **Se pierde** | 6 Similac (1 abierta), 6 operaciones, 1 combinación viva + 1 deshecha, 1 "ya está fría", 1 desecho de empezado (el "Sobró" queda). "Lo que hay": 0 ml |
| Segunda reversa | sin error, datos idénticos |
| Tercera, con el bloque de respaldo | HTTP 400 `42P01 relation "public.formula_containers" does not exist` (el bloque solo sirve con 0016 puesta); nada cambia |
| 0016 de nuevo encima | entra (`[{"set_config":""}]`), 21/21, invariante 0, datos de 0015 idénticos |

## E4 — la ventana: 0.13.0 y v5 sobre la misma base (ya en 0016)

Builds de producción servidos en `127.0.0.1:3113` (0.13.0, worktree
desacoplado `../amelia_app-c013` en `66462fa`) y `127.0.0.1:3114` (v5), contra la
réplica en 0016. Chromium headless 390×844, ES; Ana en 0.13.0 y Luis en v5 (dos
contextos = dos teléfonos). Después de **cada** paso, la invariante de 0016.

| Paso | App | Resultado |
|---|---|---|
| A1 extracción | 0.13.0 | PASS · sesiones 96→97; contenedor M1 59.15 ml, `fridge_at = stored_at`, `cold_at` nulo · INV 0 |
| A2 biberón "tal cual" | 0.13.0 | PASS · 120 ml = M2 68 + M5 30 + **M3 22 (M3 estaba "Enfriando" para v5)** · INV 0 |
| A3 desechar caducada | 0.13.0 | PASS · M4, desechos 18→19, `reason = expired` · INV 0 |
| A4 editar toma pasada | 0.13.0 | PASS · fórmula 0→1 oz, `milk_feeding_edits` 10→11 · INV 0 |
| A5 sin conexión → sincronizar | 0.13.0 | PASS · aviso de pendiente; base sin cambios offline; al volver 113/1100 → 114/1101 y 3 s después igual (sin duplicar) · INV 0 |
| B1 extracción + "ya está fría" | v5 | PASS · "Enfriando" en pantalla; `cold_at` puesto · INV 0 |
| B2 biberón con la receta | v5 | PASS · 104 ml = M1 89 + fórmula 15 · INV 0 |
| D1 combinar M2 → M1 | v5 | PASS · 44.4 ml; destino 103.5 (extracción 59.1); "lo que hay" igual · INV 0 |
| D2 Leche, origen combinado | 0.13.0 | muestra "Ya se sirvieron 1.5 oz de acá" en M2 (riesgo 1, esperado) |
| D3 servir 3 oz del destino (más que su extracción) | 0.13.0 | PASS · 88.7 ml de M1 (extracción 59.1, le quedan 14.8) · INV 0 |
| D4 borrar la extracción del origen | 0.13.0 | PASS · banner crudo `milk_combined:M2` (riesgo 2, esperado), nada anulado · INV 0 |
| D5 deshacer con el destino servido de más | v5 | PASS · no ofrece "Deshacer"; transferencias 1→1 · INV 0 |
| D6 0.13.0 anula la toma → v5 deshace | ambas | PASS · transferencias 1→0; M1 59.1 y M2 44.4 de vuelta · INV 0 |
| Errores JS (`pageerror`) | ambas | 0 y 0 |

Nota (no es defecto, es **D5-5** pendiente de firma): una extracción cargada desde
v5 **con hora pasada** queda "Enfriando" una hora desde que se tocó "Registrar"
(`fridge_at` = 08:25 para una extracción de las 06:15). La misma cargada desde
0.13.0 queda fría al instante (`fridge_at = pumped_at`, spec caso 15).

## E5 — flujos de usuario real de v5 (390×844, ES y EN)

`e5.mjs <es|en>` contra el build de v5 en `127.0.0.1:3114`: una familia nueva por
idioma (dos padres = dos teléfonos), textos sacados de `lib/i18n/{es,en}.ts`,
preparación por las RPC con horas pasadas, `page.clock` para los bordes (59/61
min) y cada aserción contra SQL; invariante de 0016 después de cada escenario.

| Escenario | ES | EN | Evidencia (ES) |
|---|---|---|---|
| S6 caducada → Desechar | PASS | PASS | "Caducada"; confirm "¿Desechar M1 (3.38 oz)?…"; 1 desecho `expired` |
| S1 extraer y enfriar | PASS | PASS | "Enfriando · lista ~9:…"; "M1 ya está fría" → `cold_at` |
| S3 biberón empezado 59/61 min (reloj fijo) | PASS | PASS | 59 min "Sobró 0.68 oz · sirve hasta 8:…"; 61 min "· ya no sirve"; Desechar → `started_bottle_expired` |
| S2 receta sin / con "Si llora" | PASS | PASS | "Próximo biberón: 3.5 oz de leche" → con llanto "1 oz de leche" + "Para completar: pasaron menos de 2 h…"; registrado 3.50 oz |
| S4 Similac: compra, abrir, agotamiento, 48 h | PASS | PASS | compra 1 y abrir; tras 200 ml, Leche "Queda poca: 1.24 oz o menos"; Hoy lo avisa cuando la receta lleva Similac (con fija 1 oz: "Queda poca Similac: 1.…"); abierta hace 48 h 01 → "Caducada" + Desechar → `finish_reason = expired` |
| S5 combinar y deshacer | PASS | PASS | transferencias vivas 0→1→0; "lo que hay" 315.213 igual en los tres momentos |
| S7 editar toma pasada (Historial) | PASS | PASS | fórmula +0.5 oz; `milk_feeding_edits` +1 |
| S8 estimación de toma vieja + correr el inicio | PASS | PASS | "≈ 3.04 oz de leche + 1.01 oz de fórmula (estimado)"; inicio de la lactancia corrido 600 s |
| S9 sin conexión: cola rpc → sincronizar | PASS | PASS | offline la base no cambia; cola IDB `log_pumping_session:rpc`, `log_bottle_feed:rpc`, `insert:diaper_changes`; tras sync +1/+1/+1 y 4 s después igual |
| S10 dos teléfonos combinan a la vez | PASS | PASS | 1 sola transferencia; el otro ve "Estos biberones cambiaron desde otro teléfono… No se combinó nada" |
| S10b dos teléfonos sirven del mismo biberón | PASS | PASS | +1 toma; el otro: "No se pudo guardar (biberón) — A M3 no le queda tanta leche…" |
| S12 regresión: /dashboard /history /growth /appointments /settings /statistics /pumping /feeding /diapers /sleep /version, /login, ruta privada sin sesión → /login | PASS ×13 | PASS ×13 | h1 correcto, sin error de carga; /version dice 0.13.0 (la rama no lleva el bump) |
| Errores JS (2 teléfonos) | 0 | 0 | |
| **Total** | **37/37** | **37/37** | invariante 0 en todos |

**Cola vieja de 0.13.0 reproducida por v5** (mismo origen `127.0.0.1:3115`,
mismo IndexedDB `amelia-pending`: 0.13.0 encola sin conexión, se baja su
servidor, se levanta v5 en el mismo puerto y se abre con conexión): 4 operaciones
(extracción con la firma de **10** argumentos, pañal, biberón "tal cual", edición
de una toma) → base `100/117/1101/13` → `101/118/1102/14`, igual 4 s después
(sin duplicar), cola restante 0, invariante 0. La extracción reproducida quedó con
`fridge_at = stored_at`: viajó la firma vieja (sin `p_fridge_at`) y la base usó
el default. 0 errores JS.

Observación de producto (no defecto, coincide con la spec V5-04/V5-05): Hoy avisa
"Queda poca Similac" **solo si la receta lleva Similac**; si hay leche de sobra, el
aviso de comprar está solo en Leche. Para confirmar con mamá y papá (D5-14).

## E6 — teléfonos simulados (y el encimado de Inicio que vio Luis)

**Motores.** `playwright-core install webkit firefox`: *"Playwright does not
support webkit/firefox on ubuntu26.04-x64"*. Con el build de Ubuntu 24.04 bajan,
pero **no arrancan**: faltan bibliotecas del sistema (`libgtk-4.so.1`,
`libcairo.so.2`, `libicu*.so.74`… para WebKit; GTK3/xcb para Firefox) que solo
se instalan con `sudo apt-get`. No se instaló nada del sistema; los binarios
bajados se borraron. **WebKit y Firefox: NO VERIFICADOS.** Todo lo de abajo es
Chromium 148 emulando.

**Banco extendido** (`tests/e2e/layout.e2e.ts` + README): `E2E_DEVICE`
(descriptor de Playwright: DPR, táctil, `isMobile`, UA), `E2E_ZOOM` (texto
grande del sistema = zoom de página), `E2E_SAFE_AREA` (CDP
`Emulation.setSafeAreaInsetsOverride`: medido, `env(safe-area-inset-top)` =
59 px) y `E2E_STANDALONE` (PWA instalada; `display-mode` sobrescrito porque
headless no lo emula — la app solo lo usa en `lib/push/client.ts`).

| Perfil (`pnpm test:layout`, ES/EN × oscuro/claro, 12 pantallas + combos de Inicio + menús) | Celdas | FAIL |
|---|---|---|
| iPhone 15 PWA 393×852, safe-area 59/0/34/0 | 124 | **0** |
| iPhone SE (1.ª) 320×568 PWA · iPhone SE (3.ª) 375×667 PWA · iPhone 14 390×844 PWA | 124 · 124 · 124 | **0 · 0 · 0** |
| Pixel 7 412×915 · Galaxy S24 360×780 · Galaxy S9+ 320×658 | 128 · 124 · 124 | **0 · 0 · 0** |
| Apaisado: iPhone 15 852×393 (safe-area 0/59/21/59) · Pixel 7 915×412 | 124 · 124 | **0 · 0** |
| Texto grande 130 % / 150 % (iPhone 15 PWA) | 124 / 124 | 16 / 56 |
| **Mismo banco y zoom contra 0.13.0** | 124 / 122 | **88 / 102** |

Clasificación del texto grande, elemento por elemento: a 130 % las 4 clases de
v5 están también en 0.13.0; a 150 %, 46 de 50, y las 4 restantes (filas del
registro de `/diapers`, "7:00 Mojado Editar Borrar" +11 px) **también** pasan en
0.13.0 medidas una por una (200/200 filas, +11 px ES y +5 px EN, iguales en las
dos versiones): el auditor solo lista 6 casos por medida y ahí quedaban tapadas.
**Todas preexistentes** (selector de semana, Izquierdo/Derecho de lactancia,
fila de /growth, selector de idioma). A 200 % las dos versiones quedan más anchas
que la pantalla (ventana de diseño 241 px en v5, 286 px en 0.13.0, contra 197
visibles) y la barra cae fuera de lo visible; v5 necesita 45 px menos.

**Rotación en caliente, teclado y todos los estados de Inicio** (`e6-rot.mjs`:
iPhone SE, iPhone 15, iPhone 15 al 150 % y Pixel 7; ES/EN; con lactancia+sueño
abiertos y con la receta visible; biberón empezado vencido + Similac por vencer
+ enfriando + sueño abierto + fórmula fija + un pañal en cola sin conexión):
**86 PASS / 11 FAIL**, y los 11 son las dos clases preexistentes/por diseño: (a)
en apaisado 568 px la barra va de borde a borde a propósito (`width: 100vw`,
CLAUDE.md §6) y sobresale de la caja de `.page` 24 px — idéntico en 0.13.0,
cargando de cero o rotando, sin scroll horizontal; (b) Izquierdo/Derecho a 150 %.
0 errores JS; invariante 0.

**Teclado** (`kbd.mjs`, todos los campos de Inicio y Leche): en el modo en que el
teclado achica la ventana (`resizes-content`) y el navegador lleva el campo al
borde (`nearest`), la barra `sticky` tapa el campo con foco **en las dos
versiones** (0.13.0: 4 campos en Pixel 7 y 5 en iPhone SE; v5: 2 y 6 — v5 suma
"Fórmula fija", campo nuevo en la misma zona); centrado, 0 en las dos. La app no
declara `interactive-widget`, así que en Chrome Android ≥ 108 (`resizes-visual`)
y en Safari la barra queda detrás del teclado. **Preexistente**, reportado
aparte (P-3), sin tocar.

**El encimado de Inicio reportado por Luis: NO reproducido** en Chromium con
ningún perfil, táctil, safe-area, PWA, texto grande, rotación ni teclado, con
todos los estados nuevos a la vez. Lo único de Inicio que falla es preexistente y
**anterior a v5** (Izquierdo/Derecho a 150 %). Queda **NO VERIFICADO en
WebKit/iPhone real**, donde siguen en pie las hipótesis de `revision-ui-v5.md` §6
(sobre todo la barra elevada del iPhone, `CLAUDE.md` §6, todavía abierta).
