# Plan de pruebas — inventario de leche v5 (fases 3 y 4)

Escrito en H1, **antes** de implementar. La columna "Resultado" se completa al
cerrar cada hito (H2…H6) con la salida real; nada se marca PASS sin comando.

Reglas: unitarias bajo `pnpm test:tz` (UTC, America/Los_Angeles, Asia/Tokyo,
Pacific/Kiritimati) con bordes exactos 1 h / 48 h / 4 d / 60 min; integración
contra el stack local (127.0.0.1:54321/54322); cada defecto encontrado
después de H1 entra con **una prueba que falla primero** (registrada en
`progreso-feeding-v5.md`).

## 1. Unitarias (U) — archivos nuevos

| Id | Archivo | Qué prueba |
|---|---|---|
| U-P1 | `tests/unit/milkParams.test.ts` | Constantes con nombre, valores por defecto, espejo con SQL (`milk_cooling_minutes()` = 60 leído del texto de 0016) |
| U-C1 | `tests/unit/milkCooling.test.ts` | Fría a `fridge_at + 60 min` exacto (no a −1 ms); `cold_at` confirmado gana; `fridge_at` nulo cae en `stored_at`; `readyAt`; 4 husos |
| U-F1 | `tests/unit/formulaStock.test.ts` | Cerradas/abierta/terminadas; consumo derivado por ventana; edición de fórmula mueve la cuenta; abierta 48 h exactas; aviso 6 h antes; aviso bajo ≤ 8 oz; stock negativo se muestra 0 + bandera; por día en 72 h; tomas anuladas/no bottle no cuentan |
| U-S1 | `tests/unit/startedBottle.test.ts` | Sobró sirve hasta `fed_at + 60 min`; a 60 min exactos ya no; sin sobró no hay empezado; desechado no se ofrece; última toma con sobró |
| U-R1 | `tests/unit/milkRecipe.test.ts` | Objetivo 3.5 oz; solo fría y vigente; más vieja primero; si llora 119/120 min desde el FIN; sin toma previa; fórmula fija; reparto `splitAcrossFeeds`; enfriando informada; aviso de Similac (sin abierta, vencida, baja); nunca total ≤ 0 |
| U-M1 | `tests/unit/milkCombine.test.ts` | Validación de combinar (fría, vigente, mismo bebé, ≥ 2, destino ≠ origen); plan; caducidad = mínimo; puede deshacer / por qué no |
| U-Q1 | `tests/unit/milkPendingV5.test.ts` | `applyPendingInventory` con combine/uncombine/cold/started encolados, reenvío no duplica, `pending`; `applyPendingFormula` con add/open/finish |
| U-I1 | `tests/unit/milkBottles.test.ts` (ampliado) | `rebalance` y `milkInvariantFailures` con transferencias (INV-1 nuevo, INV-11) |
| U-T1 | `tests/unit/i18n.test.ts` (existente) | Claves nuevas en ES y EN, mismas variables |
| U-E1 | `tests/unit/milkDb.test.ts` (ampliado) | `milkErrorText` de `milk_not_cold`, `milk_combine_conflict`, `milk_combine_used`, `milk_combined`, `milk_not_expired:started`, `milk_not_expired:formula` |

## 2. Integración (I) — `tests/integration/milkV5*.test.ts`

| Id | Qué prueba |
|---|---|
| I-S1 Esquema | 0016 aplicada: columnas, tablas, RLS habilitada en las 3 tablas nuevas, sin grants a `anon`, `security invoker` y `search_path` en cada función nueva, EXECUTE solo `authenticated` |
| I-S2 Guarda | INSERT/UPDATE directo a `milk_transfers`, `milk_ops`, `formula_containers` → `milk_rpc_only`; `milk_discards` con forma inválida → rechazo |
| I-F1 Fórmula | `formula_add` crea N, reenvío no-op; `formula_open` abre la más vieja, crea si no hay, reemplaza la abierta; dos `formula_open` concurrentes → una abierta; `formula_finish 'expired'` antes de 48 h → `milk_not_expired:formula`; después OK; RLS (otra familia no ve ni abre) |
| I-B1 Empezado | `discard_started_bottle` antes de 60 min → `milk_not_expired:started`; después crea fila `started_bottle_expired` con `amount = leftover`; reenvío no-op; dos ids concurrentes → una fila; editar el sobró sincroniza; anular la toma anula el desecho; filas `expired` previas intactas |
| I-C1 Enfriado | `log_pumping_session` con `p_fridge_at` acotado; sin él → `fridge_at = pumped_at` (app vieja); `milk_mark_cold` idempotente y acotado; RLS |
| I-M1 Combinar | combina 2 y 3; caducidad mínima; invariante 0; rechaza enfriando, vencida, libre, otro bebé, destino en orígenes; `p_expected` distinto → conflicto; mismo op → no-op; otra carga → conflicto; dos sesiones concurrentes → una gana |
| I-M2 Deshacer | vuelve todo; caducidad restaurada; destino servido → `milk_combine_used`; número reusado → `milk_label_taken`; reenvío no-op |
| I-M3 Interacción | servir del destino, desechar el destino vencido, editar la extracción origen (subir → lost; bajar bajo lo pasado → rechazo; anular → `milk_combined`), editar la extracción destino (caducidad no se alarga), `edit_bottle_feed` y `void_bottle_feed` sobre destino, invariante 0 tras cada paso |
| I-O1 Offline/reenvío | Replay de cada RPC nueva por `sendOpWith` en modo replay: no duplica |
| I-R1 Regresión | Las 19 suites existentes (0.13.0) pasan sin cambios |

## 3. Compatibilidad (C)

| Id | Qué |
|---|---|
| C-1 | Suite de v0.12.1 (`0cbe798`) sobre la base con 0016 |
| C-2 | Suite de 0.13.0 (`66462fa`) sobre la base con 0016 |
| C-3 | Petición exacta de la app 0.13.0 a `log_pumping_session` (10 args nombrados) resuelve y deja `fridge_at = pumped_at` |
| C-4 | `docs/rollback-leche-v5.sql` en Postgres efímero: esquema idéntico a 0001–0015, re-ejecutable, y 0016 vuelve a entrar |
| C-5 | `docs/verificar-antes-v5.sql` solo lectura (corre dentro de `begin read only`) |

## 4. Usuario real (N) — chrome-headless-shell 390×844, ES y EN, reloj controlado

Cada aserción se contrasta con SQL; invariante = 0 filas tras cada escenario.

| Id | Escenario |
|---|---|
| N-1 | Ana extrae (M2, 3 oz) → "Enfriando · lista ~HH:MM"; "Ya está fría" → fría |
| N-2 | Luis alimenta con Receta sin "si llora" (leche fría + Similac) |
| N-3 | Luis alimenta con "si llora" < 2 h → 1 oz |
| N-4 | Combinar M2 + M3 y deshacer |
| N-5 | Anotar compra, abrir Similac, avanzar reloj 48 h → caducada → desechar; agotamiento con aviso |
| N-6 | Biberón con sobró → "sirve hasta"; reloj +60 min → "Ya no sirve" → Desechar |
| N-7 | Sin internet: combinar, ya está fría, abrir Similac, desechar empezado → sincronizar sin duplicar |
| N-8 | Dos celulares compitiendo por combinar el mismo biberón |
| N-9 | Regresión: Hoy, Historial, Crecimiento, Médico, Ajustes, cambiador (`/api/quick/*`), `/pumping` |
| N-10 | Layout 390×844 ES y EN de `/dashboard`, `/pumping`, `/settings`: `scrollWidth − clientWidth` = 0, piso táctil 44 px |

## 5. Resultados

Salida pegada en `progreso-feeding-v5.md` (H0…H6, H5b/H7) y, para C, en
`compatibilidad-v5.md`. Al 7 oct 2026:

| Bloque | Resultado | Dónde |
|---|---|---|
| U-P1…U-E1 (unitarias) | PASS — `test:tz` 685 × 4 husos (rol DB, `2dafaff`) | progreso H6 |
| I-S1…I-O1 (integración v5) | PASS — 27 archivos / 385 (`2dafaff`); con `milkV5Rollback` **28 / 391** (H5b) | progreso H6, H5b |
| I-R1 (las 19 suites de 0.13.0 en la rama) | PASS, salvo `milkV4Schema` I-101 cambiado a propósito (19 → 22 tablas) y "INV-1 por SQL" con transferencias (QA-4) | progreso H2, H5 |
| **C-1** v0.12.1 sobre 0016 | **118/118** | compatibilidad §1 |
| **C-2** 0.13.0 sobre 0016 | **309/310** — I-101 cuenta 19 tablas (test del esquema viejo). "INV-1 por SQL" además falla con una combinación viva en la base (QA-4, reproducido) | compatibilidad §1 |
| **C-3** llamada de 10 argumentos de 0.13.0 | PASS — `milkV5Cooling` "I-C1 app vieja" | compatibilidad §2 |
| **C-4** `rollback-leche-v5.sql` | PASS — invariante de 0015 = 0, `pg_dump` idéntico a 0001–0015, dos corridas, RPC de 0015 después, 0016 vuelve a entrar (`milkV5Rollback`, 6/6); C-1 118/118 y C-2 **310/310** sobre la base local revertida | compatibilidad §4 |
| **C-5** `verificar-antes-v5.sql` | PASS — solo lectura (UPDATE rechazado); 0016 `f` + 0/21 sin 0016, `t` + 21/21 con 0016 (efímera y stack local) | compatibilidad §5 |
| N-1…N-10 (navegador, ES/EN) | PASS (N-3 y N-8 solo ES; N-9 solo ES) | progreso H5 |
| NO VERIFICADO | iPhone/WebKit, red real, esperas reales de 60 min y 48 h, la nube | runbook §8 |
