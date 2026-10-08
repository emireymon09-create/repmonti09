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
