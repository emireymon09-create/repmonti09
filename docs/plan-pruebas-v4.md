# Plan de pruebas — Inventario de leche v4 (fases 1 y 2)

Escrito el 6 oct 2026 **antes** de implementar (hito H1), junto con
`docs/arquitectura-v4.md` (referida como **ARQ §n**). Requisitos y decisiones:
`docs/spec-feeding-v4.md` (**V4-xx**, **D-x**, casos límite **CL-n**); reglas de
papá: `docs/respuestas-papa-leche.md` (**R-n**); ajustes de la arquitectura:
**AJ-n**.

QA llena **Resultado** (`OK` / `FALLA` / `NO VERIFICADO: motivo`) y
**Evidencia** (comando y salida, archivo de test y nombre del caso, o consulta
SQL con su resultado). Un caso sin evidencia es `NO VERIFICADO`, nunca `OK`.

## 0. Cómo se corre

| Tipo | Dónde | Cómo |
|---|---|---|
| **U** unitaria | `tests/unit/milk.test.ts`, `milkBottles.test.ts` (nuevo), `milkEstimate.test.ts` (nuevo), `queue.test.ts`, `i18n.test.ts`, `activity.test.ts` | `pnpm test:tz` (UTC, LA, Tokio, Kiritimati). Reloj **inyectado** (`atMs`), nunca `Date.now()` |
| **I** integración | `tests/integration/milk.test.ts` + `milk-v4.test.ts` (nuevo) | `pnpm test:integration` contra el stack local con 0001–0015. Cada caso con escritura termina con `assertMilkInvariant` (ARQ §2.4) |
| **C** compatibilidad | worktrees de v0.12.1 (`0cbe798`) y v3-release (`71d4d0c`) contra la base 0001–0015 | suites puras + recorridos (`127.0.0.1:3131/3132/3133`) |
| **E** usuario real | build de producción de v4 en `127.0.0.1`, chrome-headless-shell, 390×844 y 1440×900, EN y ES | cada paso con **SQL de contraste** (`pnpm db:psql`) y la consulta de invariante (ARQ §2.4) al final de cada escenario |
| **R** reversa | Postgres efímero, misma imagen que el stack local | ARQ §10.3 |

Datos: familias descartables por `seedTwoFamilies` (A y B); al terminar, conteo 0
en las 19 tablas y `auth.users`. Consulta de invariante = **INV** abajo.
Concurrencia: dos clientes firmados como **padres distintos de la misma
familia** (A1, A2) lanzando la RPC con `Promise.all`, más una variante con
`pg_sleep` dentro de una transacción abierta por `adminClient` para forzar la
espera del lock.

"Topes" en cada RPC = `NaN`, `Infinity`, `-Infinity`, `-1`, `100000`, `1e400`
(como texto), y un texto que no es número; todos → `milk_bad_input`, base sin
cambios.

---

## 1. Unitarias (U)

| ID | Función | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|---|
| U-01 | `containerState` | anulado / con desecho vivo / `released_at` / vencido / vigente | `voided` / `discarded` / `free` / `expired` / `occupied`, en esa precedencia | ARQ §1.2, V4-14 | | |
| U-02 | `containerState` | `atMs == expires_at` exacto | `expired` (exclusivo) | V4-31 | | |
| U-03 | `containerState` | `atMs = expires_at − 1 ms` | `occupied` | V4-31 | | |
| U-04 | `containerExpiresAt` | `stored_at` el sábado previo al cambio de horario en LA, 4 días | `+96 h` exactas, no `+4 días de calendario` | V4-31, D-15 | | |
| U-05 | `containerExpiresAt` | `stored_at` 23:59:59.999 hora del hogar; 4 TZ del proceso | mismo ISO en las 4 | V4-31 | | |
| U-06 | `bottleSlots` | N=6, ocupados M3 (vigente) y M5 (vencido), M2 libre | M1…M6 en orden numérico; M3 `occupied` con contenedor; M5 `expired`; los demás `free` | V4-11, V4-12 | | |
| U-07 | `bottleSlots` | N=6, contenedor ocupado M9 | M9 en `outOfRange`, no en `slots` | D-1, CL-37 | | |
| U-08 | `bottleSlots` | N baja de 6 a 4 con M5 ocupado | slots M1–M4; M5 en `outOfRange` | D-2, CL-36 | | |
| U-09 | `bottleSlots` | contenedor `pending` (cola) en M2 | M2 ocupado y `pending` | V4-12 CA2 | | |
| U-10 | `bottleSlots` | M3 vaciado (`released_at`) y otro M3 ocupado más nuevo | M3 = el ocupado | V4-14 | | |
| U-11 | `isUsable`/`stashMl` | liberado con 0,1 ml; desechado; caducado; ocupado 2 oz | solo cuenta el ocupado vigente | V4-36, CL-8 | | |
| U-12 | `suggestPlan` | M6 lunes, M1 martes | sirve M6 primero | V4-13, R-3 | | |
| U-13 | `suggestPlan` | un liberado con 0,1 ml | no aparece | V4-14 | | |
| U-14 | `canDiscard` | vencido ocupado / vigente / desechado / libre | true / false / false / false | V4-33, D-6 | | |
| U-15 | `discardedTotalMl` | dos desechos vivos y uno anulado | suma de los vivos | V4-35, D-13 | | |
| U-16 | `containerBalance` | contenedor con servido, desecho y `lost_ml` | `served + discarded + lost + remaining = amount` | ARQ §2.1 | | |
| U-17 | `rebalance` serve | servir deja 0,1 ml | `released_at` puesto, `remaining` 0,1 | V4-14, CL-8 | | |
| U-18 | `rebalance` return | número libre | re-ocupa, `remaining += r` | V4-15, CL-9 | | |
| U-19 | `rebalance` return | número ocupado por otro | `lost_ml += r`, sigue libre | D-9, CL-10 | | |
| U-20 | `rebalance` return | desechado | `lost_ml += r` | D-9, CL-30 | | |
| U-21 | `rebalance` return | vencido ocupado | `remaining += r` (sigue caducada) | D-9 | | |
| U-22 | `rebalance` amount | desechado, sube 1 oz | desecho +1 oz | D-8 | | |
| U-23 | `rebalance` amount | baja: con remaining, lost y desecho | sale en orden remaining → lost → desecho; desecho en 0 → anulado | AJ-10 | | |
| U-24 | `planBottleEdit` | leche 3→2 oz, todo de M3 | vuelve 1 oz a M3 | V4-52, CL-21 | | |
| U-25 | `planBottleEdit` | 3→2 oz de M3 (1,75, más viejo) + M4 (1,25, más nuevo) | M4 baja a 0,25; M3 intacto | D-17, CL-22 | | |
| U-26 | `planBottleEdit` | baja más que la porción más nueva | la más nueva se anula, sigue con la siguiente | D-17 | | |
| U-27 | `planBottleEdit` | 2→3 oz, utilizables a esa hora M5 (lunes) y M6 (martes) | sale 1 oz de M5 | D-18, CL-23 | | |
| U-28 | `planBottleEdit` | sube con contenedor que la toma ya usa | crece su porción, no hay fila nueva | ARQ §3.8 | | |
| U-29 | `planBottleEdit` | sube y no alcanza | `not_enough` con ml disponibles exactos | V4-54, CL-24 | | |
| U-30 | `planBottleEdit` | solo fórmula 1→3 oz sin leche | ok, sin porciones tocadas | V4-54, CL-25 | | |
| U-31 | `planBottleEdit` | hora nueva posterior al vencimiento de M3 | `unusable: M3` | D-7, CL-26 | | |
| U-32 | `planBottleEdit` | hora nueva > ahora + 10 min | `future` | D-15, CL-27 | | |
| U-33 | `planBottleEdit` | candidatos: liberado, anulado, `stored_at > fed_at`, vencido a `fed_at` | ninguno se usa | D-18 | | |
| U-34 | `estimateLegacySplit` | sin extracciones legadas, toma 3 oz | 0 leche + 3 fórmula | D-14, CL-31 | | |
| U-35 | `estimateLegacySplit` | legada 2 oz el día antes, toma 3 oz | 2 + 1 | D-14, CL-32 | | |
| U-36 | `estimateLegacySplit` | legada de hace 5 días (regla 4) | 0 + 3 | D-14, CL-32 | | |
| U-37 | `estimateLegacySplit` | dos tomas comparten un pozo; extracciones con contenedor | se reparten FIFO; las con contenedor no entran; tomas con desglose no participan | V4-61 | | |
| U-38 | `estimateLegacySplit` | mismo input en 4 TZ y en otro orden de arrays | mismo resultado (determinista, desempate por id) | V4-65 | | |
| U-39 | `estimateLegacySplit` | empate exacto de hora extracción/toma | la extracción entra antes | ARQ §5 | | |
| U-40 | constantes | `FUTURE_TOLERANCE_MS` vs `interval '10 minutes'` en 0015 | coinciden (lee el texto de la migración) | ARQ §4 | | |
| U-41 | constantes | `EMPTY_ML` vs `0.15` en 0015 (constraint y `milk_rebalance`) | coinciden | ARQ §1.1 | | |
| U-42 | invariante | IDs de `assertMilkInvariant` vs los de la consulta SQL de ARQ §2.4 | mismos 9 chequeos | ARQ §2.4 | | |
| U-43 | `validateBottleCount` | `''`, `0`, `31`, `2.5`, `abc`, `1`, `30`, ` 6 ` | empty / range / range / whole / number / ok / ok / ok | V4-10 CA1, D-23 | | |
| U-44 | `validateLeftover` | sobró > total; = total; 0; negativo; vacío | problema / ok / ok / problema / null | V4-43, D-10, CL-20 | | |
| U-45 | `parseAmountMl` por lado | izq `2` oz, der `60` ml | 59,147… y 60 exactos | V4-01 CA1 | | |
| U-46 | `parseAmountMl` | `-1`, `1e400`, `abc`, `Infinity` | `number` | CL-3 | | |
| U-47 | `convertAmountText` | 2 oz → ml → oz | vuelve a `2` (sin deriva); vacío queda vacío | D-19, AJ-16 | | |
| U-48 | `convertAmountText` | 150 ml → oz | `5.07` | D-19 | | |
| U-49 | `applyPendingInventory` | `log_pumping_session` en cola con M3 | contenedor `pending`, ocupado, M3 tomado en `bottleSlots` | V4-12 CA2, V4-81 | | |
| U-50 | `applyPendingInventory` | `discard_container` en cola sobre M3 vencido | desecho `pending`, M3 en 0 y liberado | V4-39, CL-14 | | |
| U-51 | `applyPendingInventory` | `discard_container` con el desecho ya listado por el servidor | no se aplica dos veces | V4-81 | | |
| U-52 | `applyPendingInventory` | `discard_container` sobre M3 que para el teléfono no venció | no cambia nada (el servidor decide) | D-6 | | |
| U-53 | `applyPendingInventory` | `log_bottle_feed` que vacía M3 | M3 liberado `pending` | V4-14 | | |
| U-54 | `applyPendingInventory` | `void_bottle_feed` con M3 libre / con M3 reusado | re-ocupa / `lost_ml` | V4-15, D-9 | | |
| U-55 | `applyPendingInventory` | `edit_bottle_feed` a la baja y al alza | mismas porciones que `planBottleEdit`; Δ=0 si el servidor ya lo aplicó | V4-57 | | |
| U-56 | `applyPendingInventory` | `edit_bottle_feed` que no alcanza | no aplica nada, toma `pending` | V4-57 | | |
| U-57 | `applyPendingInventory` | no muta sus entradas | entradas iguales (deep equal) | lib/milk.ts | | |
| U-58 | `dependentsOf` | descartar `log_pumping_session` rechazada | se lleva `discard_container` y `edit_bottle_feed` que la refieren | V4-84 | | |
| U-59 | `isDeletion`/`describeWrite` | `discard_container` | "Leche desechada (nueva)" / "Discarded milk (new)" | V4-81 | | |
| U-60 | `milkErrorText` | cada código nuevo + `milk_label_taken` en línea y `sync` | texto de biberón (no cinta), en EN y ES; `milk_not_enough:37.5` → "1.27 oz" | V4-82, V4-84, AJ-1, AJ-12 | | |
| U-61 | `describeBottle` | con `leftover_ml` | "… · sobró 1 oz" | V4-44 | | |
| U-62 | `buildActivity` | desecho | entrada `discard`, "Leche desechada · M3 · 1.5 oz", no editable, EN/ES | V4-37 | | |
| U-63 | i18n | `es` = claves de `en`; mismas variables; claves `milk.tape*` y `bottle.timeOnly` borradas sin usos | pasa `tests/unit/i18n.test.ts` | §5.7 | | |
| U-64 | redondeo | `portionMl` con 1.75 oz mostrado sobre 51,7536 ml | toma 51,7536 exactos | v3 S-x | | |
| U-65 | `stashMl` | 4 TZ, medianoche del hogar | mismo total | V4-36 | | |

## 2. Integración (I)

Cada fila: base local 0001–0015, cliente firmado de la familia A salvo que diga
otra cosa, **INV = 0 filas al final**.

### 2.1 `log_pumping_session`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-01 | izq 59,147 / der 60, M3 libre | sesión total 119,147; contenedor M3 ocupado; INV | V4-01, V4-11 | | |
| I-02 | izq y der nulos (o 0 y 0), sin etiqueta | sesión sin total, sin contenedor | V4-04, CL-2 | | |
| I-03 | cantidad > 0 sin etiqueta | `milk_bad_input`, nada | CL-4 | | |
| I-04 | M3 ocupado | `milk_label_taken:M3`, nada | V4-16, CL-5 | | |
| I-05 | M3 **vaciado** por una toma | entra; dos contenedores M3, uno libre y uno ocupado | V4-14 CA1, R-5 | | |
| I-06 | M3 **desechado** | entra | V4-34 CA1 | | |
| I-07 | M9 con N=6; `M0`; `m3`; `M1234567` | M9 entra (D-1); los otros `milk_bad_input` | D-1, D-2 | | |
| I-08 | reenvío mismo id y misma carga | no-op, 1 sesión, 1 contenedor | V4-80 | | |
| I-09 | mismo id, otra etiqueta | `milk_idempotency_conflict` | V4-80, ARQ §3.2 | | |
| I-10 | mismo id, otro bebé / otro `container_id` | `milk_idempotency_conflict` | 0014 S-16 | | |
| I-11 | A1 y A2 eligen M3 a la vez | uno entra; el otro `milk_label_taken:M3`; un solo ocupado | V4-16, R-21, CL-6 | | |
| I-12 | familia B con `p_baby_id` de A | `milk_baby_not_found` | RLS | | |
| I-13 | `logged_by` | = `auth.uid()` de quien llama; un `p_logged_by` extra → `PGRST202` | actor | | |
| I-14 | topes en izq/der | `milk_bad_input` | topes | | |
| I-15 | anon | `401/42501`, nada | grants | | |

### 2.2 `update_pumping_session`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-16 | papá: M2 3 oz, servidas 2; bajar a 1,5 | `milk_served_exceeds_amount:M2`, nada | V4-19 CA, R-19 | | |
| I-17 | ídem, subir a 3,5 | OK, `remaining` 1,5 oz | V4-19 | | |
| I-18 | ídem, cambiar hora +2 días | OK, `stored_at`/`expires_at` corridas; la toma no se re-valida | D-7, CL-39 | | |
| I-19 | ídem, 2/1 → 1/2 mismo total | OK, `remaining` igual | V4-03 | | |
| I-20 | total 0 con servido | `milk_already_served:M2` | V4-18 | | |
| I-21 | total 0 sin servir, con desecho | contenedor y desecho anulados; "Leche desechada" baja | CL-17 | | |
| I-22 | desechado, subir 1 oz | desecho +1 oz, sigue libre | D-8 | | |
| I-23 | desechado, bajar hasta lo servido | desecho anulado, contenedor libre sin desecho | AJ-10 | | |
| I-24 | libre con número reusado, subir | `lost_ml` +Δ, "Lo que hay" igual | D-9, V4-19 | | |
| I-25 | libre con número libre, subir | re-ocupa con Δ | D-9 | | |
| I-26 | sesión sin contenedor gana cantidad con M4 libre / ocupado | nace M4 / `milk_label_taken:M4` | AJ-5 | | |
| I-27 | sesión legada: solo hora y nota | total intacto | 0014 S-22 | | |
| I-28 | reenvío del mismo pedido | no-op | V4-80 | | |
| I-29 | A1 edita mientras A2 sirve del mismo contenedor | serializa; INV | R-21 | | |
| I-30 | familia B sobre sesión de A | `milk_session_gone` | RLS | | |
| I-31 | topes | `milk_bad_input` | topes | | |

### 2.3 `void_pumping_session`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-32 | sin servir | sesión y contenedor anulados; número libre | V4-14 | | |
| I-33 | servida (ocupada, libre o desechada) | `milk_already_served:M#` | V4-18, CL-18 | | |
| I-34 | desechada no servida | anula también el desecho | CL-17 | | |
| I-35 | dos veces | no-op | 0014 | | |
| I-36 | familia B | no-op (no la ve), A intacta | RLS | | |

### 2.4 `discard_container`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-37 | M3 vencido con 1,5 oz | fila de 1,5 oz, `reason = expired`; M3 `remaining 0`, libre | V4-34, CL-12 | | |
| I-38 | M3 vencido y servido en parte | solo lo que queda | CL-16 | | |
| I-39 | M3 vigente según la base (teléfono adelantado: `p_discarded_at` futuro) | `milk_not_expired:M3`, nada | D-6, D-15, CL-13 | | |
| I-40 | `p_discarded_at` anterior a `expires_at` / futuro / nulo | guardado acotado a `[expires_at, now()]` / `now()` / `now()` | D-15 | | |
| I-41 | reenvío mismo `p_id` | no-op, 1 fila | V4-34 CA2 | | |
| I-42 | mismo `p_id`, otro contenedor | `milk_idempotency_conflict` | V4-80 | | |
| I-43 | A1 y A2 desechan M3 con ids distintos a la vez | 1 fila; el segundo sin error | V4-34 CA3, CL-15 | | |
| I-44 | ya desechado / libre / anulado | no-op | AJ-15 | | |
| I-45 | contenedor de B / inexistente | `milk_container_unusable` | RLS | | |
| I-46 | desechar mientras A2 sirve de M3 (lock) | serializa: o sirve y desecha el resto, o desecha y la toma recibe `milk_overdraw:M3` | D-22 | | |
| I-47 | INSERT/UPDATE directo en `milk_discards` | `milk_rpc_only` | guardas | | |
| I-48 | anon: select/insert/rpc | negado | grants | | |
| I-49 | borde: `now()` = `expires_at` exacto (fijando `stored_at` por SQL) | se permite (expiry exclusivo) | V4-31 | | |
| I-50 | sesión en `America/Los_Angeles`, contenedor guardado antes del cambio de horario | vence a +96 h exactas | D-15 | | |

### 2.5 `log_bottle_feed`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-51 | 3 oz de M3 con sobró 1 oz | M3 −3 oz; `leftover_ml` 29,57; desechada igual | V4-42, CL-19 | | |
| I-52 | sobró > total | `milk_bad_input`, nada | V4-43, CL-20 | | |
| I-53 | 6 argumentos (como v3) | entra, `leftover_ml` null | ARQ §3.6 | | |
| I-54 | la toma vacía M3 (queda 0,1) | M3 libre | V4-14, CL-8 | | |
| I-55 | de un liberado / desechado | `milk_overdraw:M#` | AJ-6, D-22 | | |
| I-56 | vencido a `p_fed_at` / anulado / de otro bebé | `milk_container_unusable:M#` | 0014 S-6 | | |
| I-57 | `p_fed_at` = now + 11 min / + 9 min | `milk_future_time` / entra | D-15 | | |
| I-58 | toma de las 2 a.m. con contenedor que venció a las 8, enviada a las 9 | entra | S-6 | | |
| I-59 | reenvío misma carga (incl. sobró) | no-op | V4-80 | | |
| I-60 | mismo id, otro sobró | `milk_idempotency_conflict` | V4-80 | | |
| I-61 | reenvío del alta después de un `edit_bottle_feed` | no-op | AJ-8 | | |
| I-62 | A1 y A2 sirven el último 1 oz de M3 | uno entra; otro `milk_overdraw:M3` | R-21 | | |
| I-63 | solo fórmula sin leche en la heladera | entra | V4-90 | | |
| I-64 | topes en fórmula, porciones y sobró | `milk_bad_input` | topes | | |
| I-65 | contenedor de B | `milk_container_unusable` | RLS | | |

### 2.6 `void_bottle_feed`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-66 | devuelve a M3 ocupado | `remaining` +; jsonb `returned_ml` | 0014 | | |
| I-67 | M3 vaciado y número libre | re-ocupa | V4-15, CL-9 | | |
| I-68 | M3 vaciado y número reusado | toma anulada; `lost_ml`; jsonb `lost:[{M3}]`; nunca dos M3 ocupados | D-9, CL-10 | | |
| I-69 | M3 desechado | `lost_ml`, desechada igual | D-9 | | |
| I-70 | M3 vencido | vuelve (caducada) | D-9 | | |
| I-71 | dos veces / inexistente | no-op `{"returned_ml":0,"lost":[]}` | 0014 | | |
| I-72 | A1 anula mientras A2 crea M3 nuevo (lock de etiqueta) | uno de los dos órdenes; INV, nunca dos M3 ocupados | INV-2 | | |
| I-73 | UPDATE directo `{voided_at}` | `milk_rpc_only` | guardas | | |

### 2.7 `edit_bottle_feed`

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-74 | leche 3→2 oz, todo M3 | M3 +1 oz | V4-52, CL-21 | | |
| I-75 | M3 1,75 + M4 1,25 → 2 oz | M4 0,25; M3 intacto | D-17, CL-22 | | |
| I-76 | 2→3 oz con M5 (lunes) y M6 (martes) | sale de M5 | D-18, CL-23 | | |
| I-77 | 2→5 oz con 1 oz a esa hora | `milk_not_enough:29.5735`, nada | V4-54, CL-24 | | |
| I-78 | fórmula 1→3 oz sin leche | guarda | V4-54, CL-25 | | |
| I-79 | hora a un momento en que M3 vencía | `milk_container_unusable:M3` | D-7, CL-26 | | |
| I-80 | hora futura | `milk_future_time` | CL-27 | | |
| I-81 | A1 y A2 editan con el mismo `p_expected` | uno entra; otro `milk_edit_conflict` | V4-51, CL-28 | | |
| I-82 | reenvío mismo `p_op_id` | no-op, devuelve el mismo `result` | AJ-3, CL-29 | | |
| I-83 | mismo `p_op_id`, otra carga | `milk_idempotency_conflict` | AJ-3 | | |
| I-84 | ABA: e1 A→B, e2 B→A (otro teléfono), reenvío de e1 | no-op (registrado); queda A | AJ-3 | | |
| I-85 | a la baja con M3 desechado | toma baja; `lost_ml`; jsonb lo dice | D-9, CL-30 | | |
| I-86 | baja a 0 la porción y vuelve a subir del mismo contenedor | porción reavivada, sin fila duplicada | ARQ §3.8 | | |
| I-87 | sobró > total nuevo | `milk_bad_input` | V4-43 | | |
| I-88 | toma sin desglose | `milk_not_inventory` | D-14b | | |
| I-89 | toma anulada / de B | `milk_feeding_gone` | RLS | | |
| I-90 | edición mientras A2 sirve del contenedor candidato | serializa; recalcula el plan con locks; INV | V4-83 | | |
| I-91 | `milk_feeding_edits`: `before`, `request`, `result`, `logged_by` | escritos; B no los ve; anon no | auditoría, RLS | | |
| I-92 | topes en leche, fórmula y sobró; `p_expected` mal formado | `milk_bad_input` | topes | | |

### 2.8 Triggers, columnas, ajustes

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| I-93 | UPDATE directo solo `fed_at` de toma con desglose, vigente | entra | V4-58 | | |
| I-94 | ídem a una hora en que su contenedor vencía / futura | `milk_container_unusable:M#` / `milk_future_time` | V4-58, CL-34 | | |
| I-95 | UPDATE directo de `leftover_ml` en toma con desglose | `milk_rpc_only` | AJ-13 | | |
| I-96 | UPDATE directo de `leftover_ml` en toma legada | entra; total por debajo después → `23514` | D-11b | | |
| I-97 | `babies.milk_bottle_count`: 0, 31, 2.5, `'NaN'` | rechazado por CHECK/tipo | V4-10, D-23 | | |
| I-98 | `saveMilkRules` con N=4 (padre A1), leído por A2 | ambos ven 4 | V4-10 CA2 | | |
| I-99 | familia B cambia N de A | 0 filas, `milk_baby_not_found` | RLS | | |
| I-100 | `listContainers`/`listDiscards`/`legacySplitInputs` sin limit | > 100 filas vienen todas | lectura | | |
| I-101 | `pg_class`: 19 tablas con `relrowsecurity`; grants de `milk_discards`/`milk_feeding_edits` sin `anon` ni `delete` | como ARQ §3.10 | §5.2 | | |
| I-102 | `pg_proc`: cada función nueva/recreada `security invoker`, `search_path=public`, sin EXECUTE de `anon`/`public` | como ARQ §3.0 | §5.3 | | |
| I-103 | una sola versión de `log_bottle_feed` y de `void_bottle_feed` | 1 fila cada una en `pg_proc` | AJ-7, ARQ §3.6 | | |
| I-104 | migración 0015 sobre una base con datos v3 (contenedores vaciados, M12, vencidos) | `released_at` de los vacíos; nada renumerado; INV en el `do` final | V4-14 CA3, V4-20, CL-37, CL-38 | | |
| I-105 | 0015 sobre datos que no cierran (sembrados a mano) | aborta con `milk_invariant_broken`, nada aplicado | ARQ §6 | | |
| I-106 | ninguna RPC de leche ni trigger toca `nursing_sessions`/`diaper_changes`/`sleep_sessions` | lactancia, pañal y sueño entran con el inventario en cualquier estado | V4-90, CL-40 | | |

## 3. Compatibilidad (C)

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| C-01 | Suite de integración de **v0.12.1 pura** sobre 0001–0015 | **118/118** | CLAUDE §0.1, compat §2 | | |
| C-02 | Suite de integración de **v3-release** sobre 0001–0015 | **151/151**; toda diferencia justificada contra ARQ §9.2 | ARQ §9.2 | | |
| C-03 | v0.12.1 alta/edición/borrado de extracción legada | entra; sin contenedor; no ocupa biberón; alimenta el pozo | compat B4, D-21, CL-35 | | |
| C-04 | v0.12.1 alta de biberón | toma legada, estimada en v4; "Lo que hay" igual | CL-35 | | |
| C-05 | v0.12.1 borra/edita cantidad de toma con desglose | `milk_rpc_only`, base igual | compat B1/B2 | | |
| C-06 | v0.12.1 cambia solo la hora, a hora válida / a hora con leche vencida | entra / `milk_container_unusable:M#`, base igual | compat B2c, CL-34 | | |
| C-07 | v0.12.1 borra/edita toma **editada con `edit_bottle_feed`** | `milk_rpc_only` | ARQ §9.1 | | |
| C-08 | v0.12.1 borra/edita extracción creada **con selector** | `milk_rpc_only` | compat B3 | | |
| C-09 | v0.12.1 borra/edita extracción **desechada** o **libre** | `milk_rpc_only`, desecho intacto | ARQ §9.1 | | |
| C-10 | v0.12.1 baja el total de una toma legada por debajo del sobró puesto por v4 | `23514` visible, base igual | D-11b | | |
| C-11 | v0.12.1 pasa a `nursing` una toma legada con sobró | entra; v4 no muestra el sobró | ARQ §3.11 | | |
| C-12 | v0.12.1 cola offline (extracción + biberón + pañal) sobre 0015 | 3 filas, sin duplicados | compat B5 | | |
| C-13 | cola **v4** inyectada en v0.12.1 (`discard_container`, `edit_bottle_feed`) | rechazo, Descartar, nada escrito | ARQ §9.1 | | |
| C-14 | v3 registra con cinta M15 (N=6) | entra, "fuera de M1–M6" en v4 | D-1 | | |
| C-15 | v3 registra con la cinta de un contenedor ocupado | `milk_label_taken:M#`, traducido por v3 | AJ-1 | | |
| C-16 | v3 sirve y anula biberones (6 args) con M3 reusado | anula; `lost_ml`; v3 sin error | AJ-7, D-9 | | |
| C-17 | v3 cambia la hora de una toma con desglose | re-valida (C-06) | V4-58 | | |
| C-18 | v3 Historial con extracción desechada | se muestra "servido" de más y bloquea borrar en el cliente; nada escrito | ARQ §9.2 | | |
| C-19 | v3 edita la división de una extracción desechada | entra; desecho intacto (Δ=0) | D-8 | | |
| C-20 | cola v4 inyectada en v3 con la base en 0015 | `discard_container` y `edit_bottle_feed` se aplican | ARQ §9.2 | | |
| C-21 | cola v4 inyectada en v3 con la base revertida | `PGRST202` → Descartar, nada escrito | ARQ §9.2 | | |
| C-22 | v4 edita/borra lo de v0.12.1 (toma legada 2→2,5 oz + sobró; nota de extracción legada; borrar ambos) | entra; inventario igual | compat B6, D-11b | | |
| C-23 | v4 da cantidad (lados) a una extracción legada eligiendo M2 | nace M2 ocupado | AJ-5, S-22 | PASS | `e_corregir.mjs` E-38: extracción legada + izq 1 oz + M1 → nace M1 ocupado 29.5735 |
| C-24 | `notify pgrst` tras 0015: RPC nueva 404 → 200 | medido en local; nube NO VERIFICADO | compat §3.3 | | |
| C-25 | `/api/quick/*` y `/api/ingest` con 0015 | sin cambios (no escriben leche) | §1 compat | PASS | `e_regresion.mjs` E-Reg-quick-api: `/api/quick/nurse` ×2, `/api/quick/diaper`, `/api/quick/status` → 200; sin token 401; contenedores iguales |

## 4. Usuario real en navegador (E)

> **QA H5 (6 oct 2026)** — evidencia de la sesión: scripts en el scratchpad de
> la sesión de QA (`qa/e_*.mjs`, resultados en `qa/results.json`), fuera del
> repo; build de producción en `127.0.0.1:3151`, chrome-headless-shell por
> Playwright, familias `qa-v4-*` borradas al final. Defectos: **QA-1**
> (`/feeding` → «Registrar uno pasado» → Biberón: dos hermanos con la misma
> `key`, el DOM crecía sin parar; prueba `tests/unit/jsxKeys.test.ts`) y
> **QA-2** (el aviso de D-9 duraba 2,5 s; prueba `tests/unit/flash.test.ts`),
> los dos corregidos.

Cada escenario: pantalla, paso, lo que se ve, y **SQL de contraste** (los
valores esperados en la base). INV al final de cada uno. 390 y 1440; EN y ES
(los textos nuevos en los dos); tema claro y oscuro donde haya layout nuevo.

### 4.1 Ana extrae (`/pumping`)

| ID | Escenario | Resultado esperado (pantalla + SQL) | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-01 | Izq 2 oz, der 60 ml (cambiando solo el selector derecho), elige M3 | "Sesión registrada en M3."; SQL `left_ml 59.147…, right_ml 60, amount 119.147`, contenedor M3 ocupado | V4-01 CA1–CA2, R-1 | PASS | `e_ana.mjs` (ES): banner «Sesión registrada en M3.»; SQL `left_ml 59.147, right_ml 60, amount_ml 119.147`, M3 ocupado 119.147. EN corto (`e_cortos.mjs`): «Session logged in M3.», mismo SQL. CA2: cambiar la unidad derecha deja la izquierda en oz y «2» |
| E-02 | Tipea 2 en izq con oz y pasa a ml | el campo muestra `59` (convierte); vuelve a oz → `2` | D-19, AJ-16 | PASS | `e_ana.mjs`: 2 oz → ml muestra `59`; vuelve a oz → `2`; 150 ml → oz `5.07` |
| E-03 | Después de guardar, los dos selectores vuelven a oz | ambos `aria-checked` oz | V4-01 CA3 | PASS | `e_ana.mjs`: tras guardar, los dos radiogroup con `aria-checked` en oz y los campos vacíos |
| E-04 | Lado derecho vacío | `right_ml null`, `side left` | V4-04, CL-1 | PASS | `e_ana.mjs`: izq 1.5 oz, der vacío → SQL `left_ml 44.3603, right_ml null, side left` |
| E-05 | Los dos vacíos | se guarda sin pedir biberón; 0 contenedores | V4-04, CL-2 | PASS | `e_ana.mjs`: sin cantidad el selector no se monta; sesión con `amount_ml null`, 0 contenedores nuevos. También 0 y 0 → sin selector ni contenedor |
| E-06 | Cantidad sin elegir biberón | "Elegí en qué biberón quedó."; 0 filas nuevas | V4-11 CA1, CL-4 | PASS | `e_ana.mjs`: «Elegí en qué biberón quedó.», foco al selector, 0 filas; EN «Choose which bottle the milk went into.»; selector sin preselección (D-4) |
| E-07 | Selector con M3 ocupado | M3 deshabilitado "M3 · 2.5 oz · 14:20"; vencido "M5 · Caducada" | V4-12 CA1 | PASS | `e_ana.mjs`: M3 `aria-disabled` «Tiene 4.03 oz · 9:24» y no se elige; M5 vencida (envejecida en la base) «Caducada» deshabilitada; EN «Has 4.03 oz · h:mm AM» |
| E-08 | M6 extraído el lunes, M1 el martes; Hoy → Biberón | sugerencia sirve M6 primero | V4-13, R-3 | PASS | `e_ana.mjs`: M6 guardada hace 2 días por «Cuándo» → Hoy sugiere «M6 2.5 oz + M1 0.5 oz = 3 oz» (M1 y M3 del mismo minuto: desempata el número, V4-13). Lista «Lo que hay» M5, M6 primero |
| E-09 | Ajustes N 6 → 4 con M5 ocupado | guarda; aviso D-2; selector M1–M4; M5 en la lista "fuera de M1–M4" | D-2, CL-36 | PASS | `e_ana.mjs`: N=8 → selector M1…M8; N=4 con M5/M6 llenos → «Guardado…» + aviso «M5, M6 todavía tienen leche…»; selector M1–M4 + M5/M6 «fuera de M1–M4» deshabilitados. V4-10 CA1: «», 0, 31, 2.5, abc → mensaje, base sigue en 4 |
| E-10 | Contenedor v3 M12 (sembrado por v3) | visible, utilizable, desechable; al vaciarse no aparece en el selector | D-1, CL-37 | PASS | `e_ana.mjs`: M9 sembrado por la RPC (como v3) → «M9 · quedan 2.03 oz · fuera de M1–M6», no elegible; extraer en M2 con M9 presente entra; M9 vencida → «Desechar» (confirm «¿Desechar M9 (2.03 oz)?…») y desaparece del selector |
| E-11 | Lectores de pantalla: dos `radiogroup` con nombres distintos | "Unidad izquierdo"/"Unidad derecho" | V4-01 CA5 | PASS | `e_ana.mjs`: radiogroups «Unidad del izquierdo» / «Unidad del derecho»; EN «Unit for the left/right side» |
| E-12 | Layout 390 ES: dos pares campo+selector y el selector de biberón | `scrollWidth − clientWidth = 0` en la tarjeta y la fila; targets ≥ 44 px | V4-01 CA4, §8 CLAUDE | PASS | `e_ana.mjs`: 390 ES con 12.25 oz / 300 ml: `horiz 0`, 0 contenedores con `scrollWidth−clientWidth>1`, 0 targets < 44 px |

### 4.2 Vencimiento y desecho

| ID | Escenario | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-13 | Contenedor con `stored_at` corrido 4 días + 1 min por SQL | "Caducada" + "Desechar"; no suma; no aparece en la sugerencia | V4-33, CL-11 | PASS | `e_vence.mjs` (EN): M3 envejecida 4 d + 1 min en la base → «Expired» + «Discard»; «What there is» 1 oz (solo M4); sugerencia «M4 1 oz + 2 oz of formula»; no se ofrece en el selector del biberón |
| E-14 | Desechar (confirm con número y cantidad) | M3 libre en el selector; "Leche desechada" +1,5 oz; Historial con la fila; SQL 1 fila `milk_discards` | V4-33, V4-34, V4-35, V4-37, CL-12 | PASS | `e_vence.mjs`: confirm «Discard M3 (1.5 oz)? …»; banner «M3 discarded — the bottle is free.»; SQL 1 fila `milk_discards` 44.3603 `expired`, M3 `remaining 0` liberado; «Discarded milk» 1.5 oz; M3 «Free»; Historial «Discarded milk · M3 · 1.5 oz» sin ⋯. ES corto: «¿Desechar M3 (2.03 oz)?…» y «M3 desechada — el biberón quedó libre.» |
| E-15 | Reloj del navegador adelantado (CDP `Emulation.setVirtualTimePolicy`/override de `Date`) con M3 vigente para la base | muestra "Desechar"; al tocar: "Todavía no venció según el servidor"; SQL sin cambios | D-15, CL-13 | PASS | `e_vence.mjs`: contexto con `Date` +5 días: se ofrece «Discard» en M4 (pinta con el reloj del teléfono); al tocar «By the server’s clock, the milk in M4 hasn’t expired yet. Nothing was thrown out.»; SQL igual, nada en cola. Reloj −5 días: M6 vencida en la base no ofrece «Discard» |
| E-16 | Desechar sin internet (CDP offline) | M3 libre y desechado con "Todavía sin sincronizar"; al volver, 1 fila | V4-39, CL-14 | PASS | `e_vence.mjs`: offline → «Saved on this device…», M5 sale de «What there is», «Discarded milk» 5.25 oz con «This includes entries not synced yet.», M5 «Free», 1 `discard_container` en IndexedDB, base sin desecho; al volver cola vacía y 1 fila. Nota: el botón M5 libre no lleva «Not synced yet» (la marca está en la tarjeta) |
| E-17 | Dos navegadores desechan M3 | 1 fila; ninguno ve error | V4-34 CA3, CL-15 | PASS | `e_vence.mjs`: dos contextos (EN y ES) desechan M6 a la vez → 1 fila; los dos ven «M6 discarded…» / «M6 desechada…», ningún error |
| E-18 | Ajustes: ambiente y congelador "Todavía no se usa", editables; nota de refri | visible EN/ES | V4-32, D-12 | PASS | `e_vence.mjs`: EN «AT ROOM TEMPERATURE · NOT USED YET» / «IN THE FREEZER · NOT USED YET» + «only the fridge rule is used», editables; ES 2× «Todavía no se usa» + «solo se usa esa regla» |

### 4.3 Luis alimenta (Hoy, `/feeding`)

| ID | Escenario | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-19 | "Registrar tal cual" sin sobró | descuenta; `leftover_ml null` | V4-41 | PASS | `e_luis.mjs` (ES): «Registrar tal cual» → toma 88.7205 leche, 0 fórmula, `leftover_ml null`; M3 vacía y liberada, M4 0.75 oz |
| E-20 | Con sobró 0,5 oz de 3 oz | inventario −3 oz; `leftover_ml 14.79`; desechada igual | V4-42, CL-19 | PASS | `e_luis.mjs`: sobró «0,5» → `leftover_ml 14.787`, leche 22.18 (0.75 oz de M4) + 66.54 fórmula; M4 liberada; desechos sin cambio; Historial «sobró 0.5 oz». Sobró en ml «15» → 15 exactos |
| E-21 | Sobró 4 oz de 3 | "Sobró más de lo que se sirvió."; nada | V4-43, CL-20 | PASS | `e_luis.mjs`: sobró 4 de 3 → «Sobró más de lo que se sirvió.», 0 filas; «-1» y «abc» → «Lo que sobró tiene que ser un número.»; EN «More was left over than was served.» |
| E-22 | Sugerencia v3: última toma 3,5 oz, M3 1,75 → "M3 1.75 oz + 1.75 oz fórmula" | igual que v3 | §7 spec | PASS | `e_luis.mjs`: sin toma previa «M3 1.75 oz + M4 1.25 oz = 3 oz»; última toma 3.5 oz → «M3 1.75 oz + 1.75 oz de fórmula = 3.5 oz»; faltante a fórmula «M4 0.75 oz + 2.25 oz de fórmula = 3 oz» |
| E-23 | La toma vacía M3 → selector de `/pumping` ofrece M3 | M3 libre | V4-14 CA1 | PASS | `e_luis.mjs`: tras la toma que vacía M3, /pumping ofrece M3 «Libre» |
| E-24 | "Registrar uno pasado" a una hora en que M3 no existía | M3 no se ofrece | D-18 | PASS | `e_luis.mjs`: «Registrar uno pasado» a −3 h: M5 (de −20 min) no se ofrece; a −5 min sí. **Encontró el defecto QA-1** (abajo), corregido antes de esta corrida |
| E-25 | Lactancia en curso | sin biberón; sin efecto de leche | CL-40, V4-90 | PASS | `e_luis.mjs`: con lactancia en curso no hay botón de biberón; 1 sesión abierta y el inventario igual; «Terminar la toma» la cierra |

### 4.4 Corregir (Historial ⋯ y `/feeding`)

| ID | Escenario | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-26 | Baja leche 3→2 oz de M3 | "Vuelve 1 oz a M3"; SQL M3 +29,57 | V4-52, CL-21 | PASS | `e_corregir.mjs` (EN): plan «1 oz goes back to M3»; SQL toma 59.147 leche, M3 59.147 (+29.57); banner «Saved». ES corto: «Vuelve 1 oz a M3» |
| E-27 | Toma de M3 + M4, baja 1 oz | vuelve a M4 | D-17, CL-22 | PASS | `e_corregir.mjs`: toma M5 1.75 + M6 1.25, leche 3→2: plan «1 oz goes back to M6»; SQL porciones M5 51.7536, M6 7.3934 |
| E-28 | Sube 1 oz | sale de la más vieja a esa hora | D-18, CL-23 | PASS | `e_corregir.mjs`: sube 1 oz a la hora de la toma: «0.25 oz comes out of M5» + «0.75 oz comes out of M6» (FIFO); SQL M4 29.57 + M5 7.39 + M6 22.18, M5 liberada |
| E-29 | Pide de más | "A esa hora había 1.25 oz de leche; no alcanza para 2 oz."; nada | V4-54, CL-24 | PASS | `e_corregir.mjs`: leche 20 oz → «There isn’t that much breast milk that could be used at that time — only N oz…», Guardar deshabilitado, SQL igual. ES «A esa hora no había tanta leche materna… solo N oz.» |
| E-30 | Solo fórmula 1→3 oz | guarda | CL-25 | PASS | `e_corregir.mjs`: fórmula 2→3 oz → «The breast milk doesn’t change.»; SQL fórmula 88.72, total 147.87, porciones iguales |
| E-31 | Cambia la hora a una válida / a una con M3 vencida / futura | guarda / "A esa hora M3 ya estaba caducada." / rechazo | D-7, CL-26, CL-27 | PASS | `e_corregir.mjs`: hora válida guarda; a una hora con M2 vencida → «M2 can’t be used for this bottle: … or it had expired by then», Guardar deshabilitado; futura (sin `max`) → «That time is in the future.»; SQL igual. Texto genérico, no «ya estaba caducada» |
| E-32 | Toma vieja (legada) | "≈ 2 oz leche + 1 oz fórmula (estimado)", solo lectura; editar total recalcula; no hay desglose en la base | V4-63, V4-64, CL-31–33 | PASS | `e_corregir.mjs`: toma legada (insert de v0.12.1) + extracción legada → «≈ 2 oz breast milk + 1 oz formula (estimated)»; panel sin campo de leche, con la estimación y el aviso; total 3→4 oz → «≈ 2 oz … + 2 oz formula», base `breast_milk_ml/formula_ml null` |
| E-33 | El mismo panel en `/feeding` | idéntico a Historial | D-16 | PASS | `e_corregir.mjs`: /feeding abre el mismo panel (hora, leche, fórmula, sobró); 2→1.5 oz → «0.5 oz goes back to M4» (el más nuevo por `stored_at`, D-17); SQL M4 14.79 + M5 7.39 + M6 22.18 |
| E-34 | Borrar extracción servida | "no se puede, ya se sirvió de M2"; SQL igual | V4-18, R-19 | PASS | `e_corregir.mjs`: borrar extracción M3 servida → «Milk from M3 was already served. Delete those bottles first…»; SQL igual |
| E-35 | Biberón equivocado: borrar extracción (no servida) y re-anotar en M4 | M3 libre, M4 ocupado | V4-17, R-18 | PASS | `e_corregir.mjs`: borrar extracción no servida (M1) → «Deleted», contenedor anulado, M1 «Free»; re-anotada en M7 → «Session logged in M7.» |
| E-36 | Anular toma con M3 reusado | "La leche no volvió a M3: ese biberón ya tiene otra extracción."; SQL `lost_ml` | D-9, CL-10 | PASS | `e_corregir.mjs`: M8 vaciado por una toma y reusado; borrar la toma → «Deleted 1 oz didn’t go back to M8: that bottle was discarded or already has another pumping session in it.»; SQL `lost_ml 29.5735`, un solo M8 ocupado. **QA-2**: ese aviso duraba 2,5 s (corregido) |
| E-37 | Editar extracción en Historial sigue en oz sin toggle | sin `AmountUnit` en ese panel | V4-05, D-20 | PASS | `e_corregir.mjs`: panel de extracción en Historial sin radiogroup oz/ml; campos «Left, oz» / «Right, oz» |
| E-38 | Edición de extracción legada dando lados | aparece el selector de biberón | AJ-5 | PASS | `e_corregir.mjs`: extracción legada + lados → aparece el selector; sin elegir «Choose which bottle…» y nada; con M1 → nace M1 ocupado 29.5735 (C-23) |

### 4.5 Sin internet y dos celulares

| ID | Escenario | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-39 | Offline sin lista conocida | selector deja elegir con "no se sabe qué biberones están ocupados" | V4-11 CA3, R-20 | PASS | `e_offline.mjs` (ES): sin copias guardadas y sin red, /pumping (desde el SW) → «Sin conexión: no se sabe qué biberones están ocupados. Si elegís uno ocupado, te va a avisar al sincronizar.»; M2 (ocupado en el servidor) se puede elegir |
| E-40 | Offline con copia guardada de Hoy | usa la copia y dice de cuándo | V4-11 CA3 | PASS | `e_offline.mjs`: con la copia de Hoy → «Sin conexión: los biberones como los vio este teléfono hace …»; M2 «Tiene 1 oz · 9:43» deshabilitado |
| E-41 | Dos teléfonos offline eligen M3; sincronizan | el segundo: "Otro teléfono ya puso leche en M3…" + "Descartar este registro"; el resto de la cola sigue | V4-84, R-22, CL-7 | PASS | `e_offline.mjs`: A (ES) y B (EN) offline eligen M3; A sincroniza; B: «Couldn’t sync — Bottle M3 already has milk… tap “Discard this entry”…» con el botón; el pañal encolado detrás entra después de Descartar (replay ordenado, mecanismo v3); 1 sola sesión M3, nada renumerado |
| E-42 | Dos teléfonos online compiten por el último 1 oz de M3 | uno guarda; el otro "milk_overdraw" en palabras y se relee | R-21 | PASS | `e_offline.mjs`: dos contextos online sirven el último 1 oz de M3 a la vez → 1 toma; el otro «M3 doesn’t have that much milk left — someone may have just served from it. Choose again.»; nada en cola |
| E-43 | A sirve M3 offline 7:50 (vencía 8:00); B desecha 8:05; A sincroniza | toma de A rechazada `milk_overdraw:M3` visible | D-22 | PASS | `e_offline.mjs`: M3 vence en 75 s (base); A sirve offline antes; B desecha después; A sincroniza → «No se pudo sincronizar — A M3 no le queda tanta leche…» con Descartar; 0 tomas, 1 desecho |
| E-44 | Edición offline encolada, reenviada dos veces (corte a mitad) | 1 efecto; `milk_feeding_edits` 1 fila | CL-29 | PASS | `e_offline.mjs`: edición offline («Guardado en este dispositivo…», «Todavía sin sincronizar»); al volver la 1.ª respuesta se pierde (`route.fetch` + `abort`) → 2 envíos, 1 efecto: `milk_feeding_edits` 1 fila, toma 59.147, M3 59.147 |
| E-45 | Dos teléfonos editan la misma toma | el segundo: "Otro teléfono cambió esta toma…" | CL-28 | PASS | `e_offline.mjs`: dos contextos editan la misma toma → el segundo «This feeding was changed on another phone while you were editing it. Nothing was saved…»; queda la del primero; ES «Esta toma se cambió desde otro teléfono…» |
| E-46 | Offline: extracción + toma de ella + desecho de otra + edición | todo "Todavía sin sincronizar"; "Lo que hay" y selector coherentes antes de sincronizar; después INV | V4-81 | PASS | `e_offline.mjs`: offline extracción M2 + desecho M5 + toma con sobró + edición de otra toma → «What there is» 3 oz con marca, M2 «Not synced yet» ocupado, M5 libre, 5 marcas en Historial, 4 ops en cola; al volver cola vacía, SQL 3 sesiones/1 desecho/2 tomas, sobró 14.79, sin marcas; INV 0. Además anular toma offline → al volver M3 re-ocupado con 3 oz |

### 4.6 Regresión

| ID | Escenario | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| E-47 | Hoy, Historial, Crecimiento, Médico, Ajustes, cambiador (`/api/quick/*`), `/pumping`, `/feeding`, `/diapers`, `/sleep`, `/statistics` | 0 errores de consola; 0 de hidratación | §8 CLAUDE | PASS | `e_regresion.mjs`: Hoy (pecho izq/der y terminar, pañal, sueño y despertar, biberón), Historial (editar pañal/lactancia/sueño/extracción/toma legada/biberón; borrar los seis tipos), Crecimiento, Médico, Ajustes; `/api/quick/nurse\|diaper\|status` con token de dispositivo de prueba (200; sin token 401; inventario igual). 0 errores de consola (fuera de los 400 de rechazos provocados). No hay página del cambiador (solo firmware) |
| E-48 | Barrido de layout 390 y 1440 × 2 temas × 2 idiomas en las pantallas tocadas | 0 scroll horizontal, 0 desborde (`scrollWidth − clientWidth`), 0 texto cortado, targets ≥ 44 px | §8 CLAUDE | PASS | `e_regresion.mjs` barrido 80 combinaciones (10 pantallas × 390/1440 × claro/oscuro × EN/ES, con el panel del biberón, el selector, el panel de edición y «Registrar uno pasado» abiertos): 0 scroll horizontal, 0 desborde de contenedores, 0 claves crudas, 0 targets < 44 px en las tocadas a 390, 0 errores de consola. N=30 ES 390: 30 botones, 0 desborde |
| E-49 | `pnpm exec tsc --noEmit`, `lint`, `format:check`, `build`, `test:all` | verdes | §8 CLAUDE | PASS | tras las correcciones de QA: `tsc` OK, `lint` OK, `format:check` OK, `build` OK, `scripts/test-tz.sh` 542/542 ×4 TZ, `vitest run tests/integration --maxWorkers=2` 293/293 |
| E-50 | Rendimiento: `listContainers` con 2 000 contenedores (sembrados) | lectura < 1 s en local; pantalla usable | AJ-18 | PASS | `e_perf.mjs`: 2 000 contenedores sembrados por SQL → lectura de `listContainers` 2000 filas en 48–74 ms; /pumping carga 1.4 s, selector 10 ms; /history 1 s; INV 0 |

## 5. Reversa (R)

| ID | Caso | Resultado esperado | Req/Dec | Resultado | Evidencia |
|---|---|---|---|---|---|
| R-01 | Base A (0001–0014 de cero) vs base B (0001–0015 + datos E-xx + `rollback-leche-v4.sql`): `pg_dump --schema-only --schema=public --no-owner` | `diff` vacío | ARQ §10.3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-02 | Rollback dos veces seguidas | sin error | ARQ §10.1 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-03 | Datos con números reusados (dos M3 no anulados) | índice `milk_containers_label_live` se recrea sin conflicto | ARQ §10.1 paso 3c | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-04 | Contenedores desechados y liberados con `lost_ml` | anulados por el rollback; v3 `void_bottle_feed` de sus tomas no resucita leche en "Lo que hay" | ARQ §10.1 paso 3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-05 | Pre-chequeo: ocupado con `lost_ml > 0` | `notice` lo lista; rollback sigue | ARQ §10.1 paso 1 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-06 | Después del rollback: `remaining = amount − servido` para todo no anulado (salvo R-05) | 0 filas | ARQ §10.3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-07 | Suite de v3-release contra B | **151/151** | ARQ §10.3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-08 | Suite de v0.12.1 contra B | **118/118** | ARQ §10.3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-09 | Bloque opcional `milk_backup_v4`: conteos = lo perdido (desechos, sobró, N, released, lost, ediciones); no visible por PostgREST | coinciden; `anon`/`authenticated` sin acceso | ARQ §10.2 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-10 | Re-aplicar 0015 sobre B | entra; INV 0 filas | ARQ §10.3 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-11 | Tomas editadas por v4 sobreviven con su desglose final y porciones | INV-6 en B | ARQ §10.2 | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |
| R-12 | `rollback-leche.sql` (0014) después de `rollback-leche-v4.sql` | deja 0001–0013 (encadenable) | docs/rollback-leche.sql | NO VERIFICADO: `docs/rollback-leche-v4.sql` no existe en `ac3f77b` | — |

## 6. Conteo

| Tipo | Casos |
|---|---|
| U | 65 |
| I | 106 |
| C | 25 |
| E | 50 |
| R | 12 |
| **Total** | **258** |

Cobertura por RPC (I): `log_pumping_session` 15, `update_pumping_session` 16,
`void_pumping_session` 5, `discard_container` 14, `log_bottle_feed` 15,
`void_bottle_feed` 8, `edit_bottle_feed` 19, triggers/columnas/esquema 14. Cada
RPC tiene éxito, idempotencia (mismo id), mismo id con otra carga (las que
crean), sobregiro o su equivalente, concurrencia, actor/RLS de otra familia y
topes.
