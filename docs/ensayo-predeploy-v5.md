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
