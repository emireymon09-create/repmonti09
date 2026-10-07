# Lógica de negocio — inventario de leche, Similac y biberones (v5: 0014 + 0015 + 0016)

Cómo funciona **de verdad**, en el código de la rama `feat/milk-inventory-v5` (7 oct 2026).
Reescrito desde la versión de v3 (0014 sola): la leche ya **no** es la de v3 — los biberones
físicos M1…MN que se liberan y se desechan llegaron con v4 (0015, en producción con 0.13.0) y la
receta, el enfriado, combinar, la Similac y el biberón empezado con v5 (0016). Las reglas pedidas
están en `docs/respuestas-papa-leche.md`; los requisitos y decisiones en `docs/spec-feeding-v4.md`
(D-x) y `docs/spec-feeding-v5.md` (V5-xx, D5-x); el diseño de v4 en `docs/arquitectura-v4.md`.

Etiquetas: **[VERIFICADO]** = con una prueba que se corrió (citada); **[NO VERIFICADO]** = escrito
pero no ejercitado; el motivo va al lado.

> **Dónde está aplicada cada migración (7 oct 2026):** 0014 y 0015 en el stack local y, según el
> dueño, **en producción** (0.13.0); **0016 solo en el stack local**. En la nube se aplica a mano
> antes del código: `docs/runbook-despliegue-v5.md`. Desde el VPS no hay credenciales para mirar
> la nube.

---

## 1. Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Esquema y reglas del servidor | `supabase/migrations/0014_milk_inventory.sql`, `0015_milk_phase1_2.sql`, `0016_milk_phase3_4.sql` | Tablas, RLS, guardas (`milk_rpc_only`), funciones `security invoker`, invariante al final de cada migración |
| Constantes clínicas | `lib/milkParams.ts` | Las 12 de v5, cada una "decisión a confirmar"; cuatro tienen espejo en 0016 (`tests/unit/milkParams.test.ts` lee 0016) |
| Biberones físicos y cuentas | `lib/milkBottles.ts` | Estados, selector (`bottleSlots`), desechar, `containerBalance` y `rebalance` con transferencias, `milkInvariantFailures`, plan de edición de una toma |
| Lógica de siempre + cola | `lib/milk.ts` | Caducidad, utilizables, "Lo que hay", sugerencia de v3 (`suggestPlan`, hoy solo reparto interno), `applyPendingInventory`, `applyPendingFormula` |
| Enfriado | `lib/milkCooling.ts` | `isCold`, `coldReadyAt`, `coolingState` |
| Similac | `lib/formulaStock.ts` | `formulaStock`, `formulaOpenState`, `wholeDaysLeft` |
| Biberón empezado | `lib/startedBottle.ts` | `startedBottle` |
| Combinar | `lib/milkCombine.ts` | `combineProblem`, `combinedExpiry`, `combinationsOf`, `canUncombine` |
| Receta | `lib/milkRecipe.ts` | `recipe`, `recipeContainers`, `splitAcrossFeeds`, `recipeSummary` |
| Tomas viejas | `lib/milkEstimate.ts` | La estimación leche/fórmula de los biberones sin desglose |
| Única puerta a la base | `lib/db.ts` | Lecturas sin límite (`readAll`), las escrituras como operación `rpc` de la cola, `milkErrorText` |
| Componentes | `components/BottleBuilder.tsx`, `BottleEditPanel.tsx`, `BottleSlotPicker.tsx` | Filas del biberón, corrección de una toma, selector M1…MN |
| Pantallas | `app/dashboard` (receta, "Si llora", fórmula fija, empezado), `app/pumping` (enfriado, combinar, Similac), `components/SectionPage.tsx` ("Registrar uno pasado" con la receta), `app/history`, `app/settings` | |

## 2. La cuenta de un biberón (la regla que manda)

Para todo contenedor no anulado (`0016`, `milk_rebalance` e invariante INV-1):

```
amount + entra = servido + desechado + lost + remaining + sale
```

`amount` es siempre el de **su** extracción (INV-8: extracción viva = contenedor vivo, así las
cuentas izquierdo/derecho no se tocan nunca). `entra`/`sale` son las transferencias vivas de
"Combinar". `milk_rebalance` es la **única** función que reparte un cambio; su gemela TS es
`rebalance` en `lib/milkBottles.ts`. Desde 0016 un destino puede tener `remaining > amount` (se
quitó la CHECK `remaining ≤ amount`; la cuenta la cuida INV-1).
[VERIFICADO: invariante INV-1…INV-13 al final de 0016 y en `tests/helpers/milkInvariant.ts`,
corrida después de cada caso de integración (`afterEach`); 28 archivos / 391 pruebas]

## 3. Extracción y biberones físicos (v4, sin cambios de reglas en v5)

- Izquierdo y derecho por separado; el total lo escribe el servidor. El contenedor lleva el
  número **elegido** en el selector M1…MN (N en Ajustes, 1–30, por defecto 6); un número con
  leche no se puede elegir (`milk_label_taken:M#`). Un biberón se **libera** al vaciarse, al
  desecharse o al borrar la extracción.
- Caducidad: la calcula el servidor desde `stored_at = pumped_at` (refri `n × 24 h`, D-3).
- **Desechar** (`discard_container`): solo leche vencida según la hora **de la base**; tira
  todo y libera.
- "Leche desechada" (`discardedTotalMl`) suma **solo** desechos `expired` (D5-11).
- Detalle de v4 (estados, sobró, corrección completa de una toma, leche que no vuelve D-9):
  `docs/arquitectura-v4.md` y `docs/compatibilidad-v4.md`.

## 4. Enfriado (V5-20…V5-23)

- `milk_containers.fridge_at` = hora en que se tocó "Registrar" (la manda la app v5; la base la
  acota a `[pumped_at, now() + 10 min]`); la app 0.13.0 no la manda → `fridge_at = pumped_at`.
  Backfill de 0016: `fridge_at = stored_at` en todas las filas que ya había.
  [VERIFICADO: `milkV5Cooling` I-C1 (incluida la llamada de 10 argumentos), `milkV5Migration`]
- **Fría a la hora t** ⇔ `cold_at ≤ t` o `coalesce(fridge_at, stored_at) + 60 min ≤ t`
  (`milk_is_cold` en 0016, `isCold` en `lib/milkCooling.ts`, al milisegundo).
  [VERIFICADO: `tests/unit/milkCooling.test.ts` en 4 husos, bordes de 60 min]
- "Ya está fría" → `milk_mark_cold`: `cold_at` = hora del teléfono acotada a
  `[fridge_at, now()]`; idempotente por `op_id` (`milk_ops`); sobre un biberón ya libre, no-op.
  [VERIFICADO: `milkV5Cooling`, N-1 en navegador]
- La caducidad **no cambia** con el enfriado (V5-22). Es aviso, no bloqueo: la toma la acepta con
  la marca "Enfriando"; la receta no la propone; combinar la rechaza (`milk_not_cold:M#`, con
  `now()` de la base).

## 5. Combinar y deshacer (V5-30…V5-35)

- `milk_combine(p_op_id, p_baby_id, p_target_id, p_source_ids, p_expected)`: 1–24 orígenes, todos
  del mismo bebé, ocupados, vigentes y **fríos a la hora de la base**; cada origen pasa **todo**
  lo que le queda (`milk_transfers`, una fila por origen) y queda libre; el destino vence en el
  **mínimo** de todos (INV-13: un destino nunca vence después que la leche que recibió).
  `p_expected` = lo que vio la pantalla: distinto → `milk_combine_conflict` y nada cambia.
  Mismo `op_id` y carga → devuelve el resultado guardado; otra carga →
  `milk_idempotency_conflict`. Locks: op → contenedores `FOR UPDATE` en orden de id → número del
  bebé. [VERIFICADO: `milkV5Combine` (sesiones concurrentes, rechazos), N-4, N-8]
- `milk_uncombine`: anula las transferencias de esa combinación, devuelve a cada origen lo suyo
  (re-ocupa su número) y restaura la caducidad del destino acotada por la propia y la de otras
  combinaciones vivas. Rechaza si al destino le queda menos de lo recibido
  (`milk_combine_used:M#`, D5-8) o si el número de un origen ya lo ocupa otro
  (`milk_label_taken:M#`). [VERIFICADO: `milkV5Combine`, re-auditoría de `2dafaff`]
- Una extracción origen o destino con transferencias vivas no se anula ni se deja en 0
  (`milk_combined:M#`); bajar un origen por debajo de lo servido + lo pasado se rechaza; subirlo
  manda la diferencia a `lost_ml` (D5-19: nunca aparece leche en un biberón que físicamente se
  volcó). Corregir la hora de un origen hacia atrás acorta la caducidad de sus destinos, en
  cadena (S→D→E). [VERIFICADO: `milkV5Combine` I-M3]
- "Lo que hay" no cambia al combinar; las estadísticas izquierdo/derecho tampoco.

## 6. Similac (V5-01…V5-07)

- `formula_containers`: una fila por botella. Cerrada = sin `opened_at`; abierta = `opened_at`
  sin `finished_at`; terminada = `finished_at` (`empty`, `expired`, `replaced`). Índice único
  parcial: una abierta viva por bebé.
- RPC `formula_add` (1–24 botellas, ids del dispositivo, hora ni futura ni de hace más de 30
  días), `formula_open` (abre la cerrada pedida o, si no existe, crea una de 8 oz; la abierta
  anterior pasa a `replaced`), `formula_finish` (`empty` siempre; `expired` solo si a la hora
  **de la base** pasaron 48 h, si no `milk_not_expired:formula`), `formula_void`.
  [VERIFICADO: `milkV5Formula` (incluidos dos `formula_open` a la vez), N-5]
- **El consumo no se escribe** (D5-13): `formulaStock` reparte el `formula_ml` de las tomas
  `bottle` vivas sobre la abierta cuya ventana `[opened_at, finished_at)` contiene su hora.
  Editar la fórmula de una toma mueve la cuenta sola. Fórmula fuera de toda ventana =
  `unassignedMl` (se informa, no resta). Stock = cerradas × tamaño + max(0, abierta − usado); una
  abierta **caducada no suma** (O-1). Nunca negativo en pantalla (`overdrawn`, D5-16); por día =
  últimas 72 h / 3; aviso con ≤ 8 oz; "vence pronto" 6 h antes. [VERIFICADO:
  `tests/unit/formulaStock.test.ts` (48 h exactas en 4 husos), `milkV5Formula` V5-03]
- La fórmula **nunca bloquea** una toma (`log_bottle_feed` no se tocó). [VERIFICADO: integración]

## 7. Biberón empezado (V5-10…V5-12)

- El "Sobró" (`feedings.leftover_ml`, de 0015) de la última toma con sobró es el biberón
  empezado: sirve hasta `fed_at + 60 min` (a los 60:00 ya no). `startedBottle` en
  `lib/startedBottle.ts`. [VERIFICADO: `tests/unit/startedBottle.test.ts`, N-6]
- `discard_started_bottle(p_id, p_feeding_id, p_discarded_at)` → fila en `milk_discards` con
  `reason 'started_bottle_expired'`, `feeding_id` y **sin** contenedor (CHECK de forma
  `milk_discards_shape`; índices únicos parciales por contenedor y por toma). Antes de la hora
  según la base → `milk_not_expired:started`. Idempotente.
- Trigger `milk_sync_started_discard` (en `feedings`): cambiar el sobró después de desecharlo
  ajusta el desecho; sobró nulo/0, toma anulada, que deja de ser biberón o que cambia de bebé →
  desecho anulado (INV-10). [VERIFICADO: `milkV5Started`]

## 8. La receta (V5-40…V5-44)

`recipe()` en `lib/milkRecipe.ts`, usada por `app/dashboard/page.tsx` (con Similac y "Si llora")
y por "Registrar uno pasado" de `components/SectionPage.tsx` (sin "Si llora" ni avisos de
Similac, a la hora elegida):

- Total: 3.5 oz (`RECIPE_TARGET_OZ`). "Si llora" (apagado de entrada): si pasaron menos de
  120 min desde el **fin** de la última toma (`lastFeedingEvent`, `lib/kpis.ts`), solo 1 oz.
- Leche: solo utilizable **y fría**, más vieja primero (`byAge`), hasta total − fórmula fija; la
  que se enfría se informa con su hora de lista.
- Fórmula: la fija + lo que la leche no cubre. La fija vale solo para la toma completa; el
  complemento de "Si llora" usa leche fría primero (D5-20, QA-1).
- Avisos de Similac: ninguna abierta, vencida, vence pronto, poca. "La leche fría alcanza para N
  tomas así" (`splitAcrossFeeds`).
- Solo **pre-llena** `BottleBuilder`; todo editable, nunca bloquea.
  [VERIFICADO: `tests/unit/milkRecipe.test.ts` (bordes 119/120 min, QA-1), N-2, N-3]

## 9. Sin conexión y dos teléfonos

- Toda escritura nueva es una operación `kind:'rpc'` de la cola con ids del dispositivo.
  `applyPendingInventory` refleja combinar, deshacer, "ya está fría" y desechar el empezado;
  `applyPendingFormula`, las de Similac; una fila en cola se marca "Todavía sin sincronizar".
  [VERIFICADO: `tests/unit/milkPendingV5.test.ts`, `milkV5Replay` (el reenvío no duplica), N-7]
- Dos teléfonos a la vez: gana el primero (advisory lock por op, `FOR UPDATE` en orden de id,
  `p_expected`). [VERIFICADO: N-8, integración concurrente]
- Un rechazo se muestra en palabras (`milkErrorText`, con el contexto "combinar" para que un
  combinar rechazado no hable de la toma, QA-3). [VERIFICADO: `tests/unit/milkDb.test.ts`]

## 10. Compatibilidad y reversa

- La app 0.13.0 y la v0.12.1 sobre la base con 0016: suites 309/310 y 118/118; la única falla es
  un test que cuenta 19 tablas. Ninguna pantalla vieja se cae con datos v5 (lectura de código).
  Detalle y rarezas de la ventana: `docs/compatibilidad-v5.md`.
- Volver atrás 0016: `docs/rollback-leche-v5.sql` (probado en Postgres efímero: invariante de
  0015 = 0, esquema idéntico a 0001–0015, re-ejecutable, 0016 vuelve a entrar). Pierde Similac,
  desechos de empezado, enfriado y combinaciones.

## 11. Lo que NO se verificó

- iPhone / WebKit y la PWA instalada (en el VPS solo hay Chromium headless).
- Las esperas reales de 60 min (enfriado, empezado) y de 48 h (Similac): se probaron con reloj
  adelantado y horas por SQL.
- Red real (se probó cortando la red del navegador headless).
- La nube: 0016 no está aplicada allá.
