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
