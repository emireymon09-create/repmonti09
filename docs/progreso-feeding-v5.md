# Progreso — inventario de leche v5 (fases 3 y 4)

Rama `feat/milk-inventory-v5`, worktree `../amelia_app-v5`, desde
`origin/main` @ `66462fa` (0.13.0). Sin push. Nada contra la nube.

## Estado inicial (7 oct 2026) [VERIFICADO]

- `main` = `9824e26`, `origin/main` = `66462fa` (se registran igual al cierre).
- Node `v24.16.0`, pnpm 11.7.0. Stack local en 127.0.0.1:54321/54322 migrado
  0001–0015 (`supabase_migrations.schema_migrations` = 15 filas).

## H0 — línea base [VERIFICADO]

| Comando | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm lint` | exit 0, sin warnings |
| `pnpm format:check` | exit 0 |
| `pnpm test:tz` | 561/561 × 4 husos |
| `pnpm test:integration` | 19 archivos, 310/310 |
| `pnpm build` | exit 0 |

## H1 — spec, arquitectura y plan de pruebas

`docs/spec-feeding-v5.md` y `docs/plan-pruebas-v5.md` escritos antes del código.

## H2 — base de datos 0016 [VERIFICADO por el director]

Commit `d64ac91` (rol DB) + `a11e916` (D5-19 en la spec). 0016 aplicada en el
stack local (registrada en `supabase_migrations`), una transacción, invariante
INV-1…INV-12 al final. `git diff --stat origin/main -- supabase/migrations/`:
solo `0016_milk_phase3_4.sql | 1651 +`. RLS en `milk_ops`, `milk_transfers`,
`formula_containers` = t. `pnpm test:integration` (director): 26 archivos,
368/368. Par falla→pasa del rol DB: bajar la extracción de un destino
(`total + entra < servido + sale`). Suite vieja cambiada a propósito:
`milkV4Schema` I-101 (19 → 22 tablas).

Desvíos a confirmar (rol DB): sin CHECK `remaining <= amount` (un destino
combinado tiene más que su extracción; lo cuida INV-1); lock de etiqueta después
de los `FOR UPDATE` (orden global de 0015); el trigger también anula el desecho
empezado si la toma deja de ser `bottle`; adelantar la hora de un origen acorta
la caducidad de su destino; `milk_uncombine` restaura `least(prev, otros
orígenes vivos)`; `milk_mark_cold` sobre un libre = no-op; `formula_void` sobre
una terminada = `milk_bad_input`.

## H3 — lógica pura y capa de datos [VERIFICADO por el director]

Commit `0deefa2` (rol lógica). `lib/milkParams.ts` (12 constantes "decisión a
confirmar"), `milkCooling`, `formulaStock`, `startedBottle`, `milkCombine`,
`milkRecipe`; `rebalance`/invariante TS con transferencias; cola
(`applyPendingInventory` + `applyPendingFormula`); `lib/db.ts` lecturas y 8
escrituras nuevas; `milkErrorText`/`describeWrite` EN+ES. Director: `tsc` 0,
`test:tz` 670/670 × 4 husos. Rol lógica: integración 27/375, build 0, lint y
format 0. Spec corregida: caso límite 8 y D5-8 (deshacer se permite si al
destino le queda al menos lo recibido — así lo hace 0016).

## H4 — UI [VERIFICADO por el director]

Commit `5aa0834` (rol UI): Hoy con Receta, "Si llora", fórmula fija, biberón
empezado; `/pumping` con Enfriando/"Ya está fría", Combinar/Deshacer y tarjeta
Similac; Historial (desecho empezado, combinaciones); Ajustes con `<details>`
"Todavía no se usan". Rol UI: tsc/lint/format 0, test:tz 673×4, integración
27/375, build 0; barrido 390×844 ES/EN de /dashboard, /pumping, /settings:
scrollH 0, desborde 0, targets<44 0, consola 0.

### QA-1 (director, revisando la captura de Hoy) — prueba que falla → pasa
Con "Si llora" (+1 oz) y "Fórmula fija 1 oz", la receta proponía "1 oz de
Similac" con 7.5 oz de leche fría. Prueba `QA-1` en `tests/unit/milkRecipe.test.ts`:
**antes** `Tests 1 failed | 18 passed (19)`; arreglo en `lib/milkRecipe.ts` (la
fija solo aplica a la toma completa, D5-20); **después** `19 passed (19)`.
Copy ES del confirm del empezado corregido ("¿Tirar lo que sobró … ({amount})?").
