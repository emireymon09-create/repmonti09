# Especificación — Inventario de leche v5 (fases 3 y 4 de las respuestas de papá)

Rama `feat/milk-inventory-v5` (worktree `../amelia_app-v5`, creada desde
`origin/main` @ `66462fa` = producción 0.13.0, con 0014 y 0015 aplicadas).
Escrita **antes** del código (H1), igual que `spec-feeding-v4.md`.

**Fuente de verdad:** `docs/respuestas-papa-leche.md` — "Funciones nuevas"
(Enfriado, Combinar, Receta, Inventario de fórmula, biberón empezado) y las
reglas 9, 10, 11, 14 y 17 en su versión cambiada. Las preguntas de la sección
F del reporte de fases 1–2 quedaron **sin responder**: se usan las decisiones
por defecto del pedido (§4) y todas quedan como **decisión a confirmar**.

**Fuera de alcance:** desecho parcial o "se volcó/huele mal" (D-6 de v4 sigue),
congelador, ambiente, estadísticas nuevas en `/statistics`, avisos push nuevos.

Convenciones: **U** unit (`tests/unit/`, 4 husos), **I** integración contra el
stack local, **N** usuario real en chrome-headless-shell 390×844 (ES y EN),
**C** compatibilidad (suites viejas / Postgres efímero).

---

## 0. Punto de partida verificado (0.13.0, `66462fa`)

- Contenedores (`milk_containers`): `stored_at = pumped_at` (D-3),
  `expires_at` lo calcula el servidor (`0015:436-478`), `released_at`/`lost_ml`
  (0015). Reparto único `milk_rebalance` (`0015:324-430`):
  `amount = servido + desechado + lost + remaining`.
- `milk_discards.reason` tiene `check (reason in ('expired'))` y
  `container_id not null`; índice `milk_discards_one_live (container_id) where
  voided_at is null` (`0015:144-171`).
- La sugerencia de Hoy es la de v3: `suggestedTotalMl` (último biberón o 3 oz)
  + `suggestPlan` (más vieja utilizable primero, faltante a fórmula),
  `lib/milk.ts:205-258`.
- La fórmula es solo un número en la toma (`feedings.formula_ml`); no hay
  inventario. Nunca bloquea.
- `feedings.leftover_ml` ("Sobró") es solo estadística (D-10).
- N (`milk_bottle_count`) vive en `babies`.
- Invariante en `0015:1392-1460` (INV-1…INV-9) y su gemela TS
  `milkInvariantFailures` (`lib/milkBottles.ts:663+`).

---

## 1. Tabla regla → requisito → implementación → prueba

| Regla | Qué pide | Req. | Implementación | Prueba |
|---|---|---|---|---|
| Similac-1 | Anotar compra (paquete 6 × 8 oz) | V5-01 | `formula_containers` + RPC `formula_add` (0016) | U `formulaStock`; I alta, idempotencia, RLS; N |
| Similac-2 | "Abrí una Similac" inicia 48 h | V5-02 | RPC `formula_open`; `FORMULA_OPEN_MAX_H = 48` | U borde 48 h (4 husos); I una sola abierta, concurrencia; N |
| Similac-3 | Cada biberón descuenta la fórmula que usó | V5-03 | Derivado, no escrito: `formulaStock()` reparte `feedings.formula_ml` vivas sobre la abierta en su ventana | U; I (editar la fórmula de una toma mueve la cuenta, regla 17) |
| Similac-4 | Muestra cuánta queda, consumo por día, avisa cuando se acaba | V5-04 | `formulaStock` → `{closed, open, remainingMl, perDayMl, low}`; `FORMULA_LOW_WARN_OZ` | U; N |
| Similac-5 | La receta usa primero la abierta y avisa antes de que venza | V5-05 | `recipe()` lee el estado de la abierta; `FORMULA_OPEN_WARN_H` | U; N |
| Similac-6 | Nunca bloquea una toma (regla 14) | V5-06 | `log_bottle_feed` no se toca; el stock puede ir a negativo (se muestra 0 + aviso) | I toma con fórmula sin inventario; U |
| Similac-7 | La abierta que vence se desecha | V5-07 | RPC `formula_finish(reason 'expired'|'empty')`; `expired` solo si a la hora de la BASE pasaron 48 h | I `milk_not_expired`; U; N |
| Empezado-1 | Lo que sobra de un biberón dura 1 h | V5-10 | "Sobró" (`leftover_ml`) = biberón empezado; vence `fed_at + BOTTLE_STARTED_MAX_MIN` (60) | U borde 60 min (4 husos) |
| Empezado-2 | Pasada la hora: "Ya no sirve" + Desechar | V5-11 | RPC `discard_started_bottle` → `milk_discards` con `reason = 'started_bottle_expired'`, `feeding_id` | I idempotencia, rechazo antes de la hora, RLS, concurrencia; N |
| Empezado-3 | Ampliar `reason` y el índice único sin romper filas | V5-12 | 0016: CHECK nuevo, `container_id` nullable, `feeding_id`, CHECK de forma, dos índices únicos parciales | I filas `expired` existentes intactas; C |
| Enfriado-1 | Al anotar, el biberón queda "Enfriando" | V5-20 | `milk_containers.fridge_at` (hora de entrada al refri) y `cold_at` (confirmado frío); frío = `cold_at <= t` o `fridge_at + COOLING_MIN_MINUTES <= t` | U borde 60 min; I |
| Enfriado-2 | Se puede confirmar antes ("Ya está fría") | V5-21 | RPC `milk_mark_cold` | I idempotencia, RLS; N |
| Enfriado-3 | La caducidad sigue desde `pumped_at` | V5-22 | `expires_at` no cambia de fórmula; `fridge_at` solo afecta "fría" | I/U borde 4 d |
| Enfriado-4 | Es aviso, no bloqueo | V5-23 | Biberón y toma aceptan leche enfriándose (con aviso en pantalla); la **Receta** no la propone; **Combinar** la rechaza | U; I |
| Combinar-1 | Unir biberones fríos y vigentes del mismo bebé en uno | V5-30 | RPC `milk_combine(p_op_id, p_baby_id, p_target_id, p_source_ids, p_expected)`; tabla `milk_transfers` | I atomicidad, RLS, concurrencia |
| Combinar-2 | Destino toma la caducidad del más viejo | V5-31 | `expires_at = least(...)`, y `update_pumping_session` la respeta después | I; U |
| Combinar-3 | El origen queda libre; "Lo que hay" no cambia; izq/der quedan | V5-32 | Origen → `remaining 0`, `released_at`; `pumping_sessions` no se tocan; INV-8 intacta | I invariante = 0; U |
| Combinar-4 | Solo fría con fría, ninguno caducado | V5-33 | Rechazos `milk_not_cold:M#`, `milk_container_unusable:M#` a la hora de la base | I; U |
| Combinar-5 | Idempotencia (`p_op_id`) y conflicto (`p_expected`) | V5-34 | `milk_ops` registra la operación; `p_expected = {container_id: remaining_ml}`; distinto → `milk_combine_conflict` | I reenvío no-op, dos celulares |
| Combinar-6 | Deshacer | V5-35 | RPC `milk_uncombine(p_op_id, p_combine_op_id)`; rechaza si el destino ya se usó (`milk_combine_used:M#`) o si un número de origen se ocupó (`milk_label_taken:M#`) | I; N |
| Receta-1 | Reemplaza `suggestPlan` de v3: "2.5 oz leche + 1 oz Similac" | V5-40 | `lib/milkRecipe.ts` `recipe()`; Hoy y "Registrar uno pasado" usan la receta; `suggestPlan` queda solo como función interna de reparto | U; N |
| Receta-2 | Solo leche fría y vigente, más vieja primero | V5-41 | `recipeContainers()` = utilizables ∧ fríos, `byAge` | U |
| Receta-3 | "Si llora": < 2 h → 1 oz; ≥ 2 h → toma completa | V5-42 | `RECIPE_CRY_EXTRA_OZ = 1`, `RECIPE_CRY_WINDOW_MIN = 120`, desde el FIN de la última toma (`lastFeedingEnd`) | U bordes 120 min |
| Receta-4 | Fórmula fija opcional; reparto de la leche entre tomas | V5-43 | `recipe({fixedFormulaMl})`; `splitAcrossFeeds()` → "Alcanza para N tomas" | U |
| Receta-5 | Siempre editable, nunca bloquea | V5-44 | La receta solo pre-llena `BottleBuilder`; "Registrar con cambios" sigue | N |
| Transv-1 | Sin internet se guarda y cuenta (regla 20) | V5-80 | Toda RPC nueva es `kind:'rpc'` con id del dispositivo; `applyPendingInventory` aprende combine/uncombine/cold/started; `applyPendingFormula` | U; N offline |
| Transv-2 | Dos a la vez: gana el primero (regla 21) | V5-81 | advisory lock por op + lock de etiqueta + `FOR UPDATE` en orden de id + `p_expected` | I concurrencia |
| Transv-3 | Calidad: RLS, GRANT, WITH CHECK, security invoker, reloj inyectable, ES+EN | V5-82 | 0016 + `now` inyectado en toda función pura | I RLS; U i18n |
| Compat | Fase 1–2 intacta; apps 0.12.1/0.13.0 sobre 0016 | V5-90 | 0016 aditiva; firmas viejas resuelven | C |
| Ajustes | Aclarar u ocultar "Todavía no se usa" | V5-91 | Ambiente y congelador pasan a un `<details>` "Todavía no se usan" con la explicación | N |

---

## 2. Requisitos detallados (criterios de aceptación)

### 2.1 Fórmula Similac (V5-01 … V5-07)

- **Modelo.** `formula_containers(id, family_id, baby_id, size_ml, added_at,
  opened_at, finished_at, finish_reason, voided_at, logged_by, created_at)`.
  Cerrada = `opened_at is null`; abierta = `opened_at` sin `finished_at`;
  terminada = `finished_at` (`'empty'`, `'expired'`, `'replaced'`).
  Índice único parcial: **una abierta viva por bebé**.
- **V5-01 Compra.** "Anotar compra" agrega `FORMULA_PACK_COUNT` (6) botellas
  de `FORMULA_BOTTLE_OZ` (8 oz) cerradas, editable a otra cantidad (1–24).
  CA: 6 filas con ids del dispositivo; reenvío = no-op.
- **V5-02 Abrir.** "Abrí una Similac" abre la cerrada más vieja; si no hay
  cerrada, crea una abierta de 8 oz (nunca bloquea). Si ya había una abierta,
  pasa a `finished_at = opened_at nueva`, `finish_reason 'replaced'`. CA:
  nunca dos abiertas (índice + lock); dos celulares a la vez → una abierta.
- **V5-03 Consumo derivado.** No se escribe consumo: la fórmula de las tomas
  `bottle` vivas con `formula_ml > 0` y `fed_at` dentro de la ventana de una
  abierta (`[opened_at, finished_at ó ∞)`) se descuenta de esa. Editar la
  fórmula de una toma (edición completa de fase 2) mueve la cuenta sola
  (regla 17: "si cambia la fórmula, se ajusta el inventario"). Fórmula de
  tomas fuera de toda ventana = "sin botella abierta" (se informa, no resta).
- **V5-04 Stock.** `restante = cerradas × tamaño + max(0, abierta − usado)`;
  `por día` = fórmula de las últimas 72 h / 3; **aviso** si
  `restante ≤ FORMULA_LOW_WARN_OZ` (8 oz). Texto: "5 cerradas + 1 abierta con
  3.2 oz".
- **V5-05 / V5-07 Caducidad de la abierta.** Vence a `opened_at + 48 h`
  exactas (al llegar, ya venció). Aviso "vence pronto" desde
  `FORMULA_OPEN_WARN_H` (6 h) antes. Vencida → "Caducada" + "Desechar"
  (`formula_finish 'expired'`, rechazado por la base antes de las 48 h con
  `milk_not_expired:formula`). "Se terminó" (`'empty'`) siempre se puede.
- **V5-06** La fórmula nunca bloquea: sin inventario, con la abierta vencida o
  con stock negativo, la toma se guarda igual; la receta lo avisa.

### 2.2 Biberón empezado (V5-10 … V5-12)

- **V5-10** El "Sobró X" de una toma (`leftover_ml > 0`) es el biberón
  empezado: sirve hasta `fed_at + 60 min` (al llegar, ya no sirve).
- **V5-11** En Hoy, debajo de la tarjeta de comida, la última toma con sobró
  muestra "Sobró 1 oz · sirve hasta 14:20"; pasada la hora, "Ya no sirve" +
  "Desechar". `discard_started_bottle(p_id, p_feeding_id, p_discarded_at)`:
  idempotente por `p_id`; ya desechado → no-op; antes de la hora según la
  **base** → `milk_not_expired:started`; `amount_ml = leftover_ml`;
  `discarded_at` acotado a `[fed_at + 60 min, now()]`.
- Editar el sobró de la toma después de desecharlo sincroniza el desecho
  (trigger): nuevo sobró > 0 → mismo monto; nulo/0 o toma anulada → desecho
  anulado (INV-10).
- **V5-12** `milk_discards`: `reason in ('expired','started_bottle_expired')`,
  `container_id` nullable, `feeding_id` nuevo, CHECK de forma (expired ⇒
  contenedor y sin toma; started ⇒ toma y sin contenedor), índices únicos
  parciales por contenedor y por toma. Las filas `expired` existentes cumplen
  todo sin tocarlas.
- "Leche desechada" de `/pumping` sigue sumando **solo** `expired` (leche
  materna caducada); el biberón empezado se ve en Historial como
  "Biberón empezado desechado · 1 oz".

### 2.3 Enfriado (V5-20 … V5-23)

- **V5-20** `fridge_at` = hora en que se tocó "Registrar" (la manda el
  teléfono, la base la acota a `[pumped_at, now() + 10 min]`); la app vieja no
  la manda → `fridge_at = pumped_at`. Filas existentes: `fridge_at = stored_at`
  (backfill), o sea ya frías.
- Fría a la hora `t` ⇔ `cold_at <= t` **o** `fridge_at + 60 min <= t`.
  "Enfriando · lista ~15:20" mientras no.
- **V5-21** "Ya está fría" (termómetro, 40 °F / 4 °C) → `milk_mark_cold`
  (`cold_at = hora del teléfono` acotada a `[fridge_at, now()]`), idempotente.
- **V5-22** `expires_at` sigue `stored_at + días × 24 h` (`stored_at =
  pumped_at`), sin cambio: la caducidad de 4 días no se mueve por el enfriado.
- **V5-23** Es aviso: el selector de leche de una toma la ofrece con la marca
  "Enfriando"; la Receta no la propone; Combinar la rechaza
  (`milk_not_cold:M#`, decidido con `now()` de la base).

### 2.4 Combinar (V5-30 … V5-35)

- **Modelo.** `milk_transfers(id, op_id, family_id, baby_id,
  from_container_id, to_container_id, amount_ml, target_prev_expires_at,
  created_at, voided_at, logged_by)` y `milk_ops(op_id, family_id, baby_id,
  kind, request, result, created_at, logged_by)` (registro de operaciones
  para idempotencia; solo insert/select).
- **Cuenta nueva (INV-1):** `amount + entra = servido + desechado + lost +
  remaining + sale`. `amount_ml` del contenedor sigue siendo el de su
  extracción (INV-8 intacta): las estadísticas izq/der no se tocan.
- **V5-30 Combinar.** 2 o más biberones del mismo bebé, ocupados, vigentes y
  fríos **a la hora de la base**; uno es el destino. Cada origen pasa todo lo
  que le queda al destino y queda **libre**. `p_expected` = lo que la pantalla
  vio (`{id: remaining_ml}`); si difiere (otro celular sirvió o desechó) →
  `milk_combine_conflict` y nada cambia.
- **V5-31** `expires_at(destino) = min` de todos. Editar después la hora de la
  extracción del destino no le alarga la caducidad por encima de la de sus
  orígenes vivos.
- **V5-33 Rechazos:** destino entre los orígenes, menos de un origen, bebé
  distinto, anulado/libre (`milk_container_unusable:M#`), vencido
  (`milk_container_unusable:M#`), enfriando (`milk_not_cold:M#`).
- **V5-34** Mismo `p_op_id` y misma carga → devuelve el resultado guardado;
  otra carga → `milk_idempotency_conflict`.
- **V5-35 Deshacer.** `milk_uncombine(p_op_id, p_combine_op_id)`: anula las
  transferencias de esa combinación, devuelve a cada origen lo suyo (vuelve a
  ocupar su número) y restaura la caducidad del destino. Rechazos: el destino
  ya no tiene lo que recibió (se sirvió o desechó) → `milk_combine_used:M#`;
  el número de un origen ya lo ocupa otra extracción → `milk_label_taken:M#`.
  Ya deshecha → no-op. La pantalla ofrece "Deshacer" en el aviso de éxito y en
  la fila del destino mientras se pueda.
- Una extracción **origen** de una combinación no se puede anular ni bajar
  por debajo de lo servido + lo pasado (`milk_combined:M#` /
  `milk_served_exceeds_amount:M#`); subirla manda la diferencia a `lost_ml`
  (la leche física está en el destino). La extracción **destino** no se puede
  anular mientras tenga entradas vivas (`milk_combined:M#`).

### 2.5 Receta (V5-40 … V5-44)

- **V5-40** `recipe({now, lastFeedingEndMs, cry, containers, coolingInfo,
  formulaState, fixedFormulaMl, targetMl})` devuelve `{totalMl, portions,
  formulaMl, reason ('full'|'cry_top_up'), coolingMl, formulaWarning,
  feedsCovered}`. Texto corto en Hoy: "2.5 oz leche + 1 oz Similac".
- **V5-41** Leche: solo utilizable (no vencida, no liberada, no anulada) y
  **fría**, más vieja primero (`byAge`). La que se enfría se informa
  ("1.5 oz enfriando, lista 15:20").
- **V5-42** Objetivo normal `RECIPE_TARGET_OZ = 3.5`. "Si llora" (opcional,
  apagado por defecto): si pasaron **menos de 120 min** desde el **fin** de
  la última toma → `RECIPE_CRY_EXTRA_OZ = 1` oz; con 120 min o más → la toma
  completa. Sin toma previa → completa.
- **V5-43** Fórmula fija opcional (campo "Fórmula fija" en la tarjeta, vacío
  = sin fijar): la leche es `objetivo − fija` (acotada a lo disponible). Reparto
  más antiguo primero: `splitAcrossFeeds(leche fría, leche por toma)` →
  "La leche alcanza para N tomas así".
- **V5-44** La receta pre-llena el constructor (`BottleBuilder`); todo es
  editable; "Registrar con cambios" y elegir otros biberones siguen; nunca se
  bloquea por falta de leche o fórmula. La fórmula se toma de la abierta; si no
  hay o está vencida, la receta lo dice ("Abrí una Similac").

---

## 3. Arquitectura (resumen; detalle en el código de 0016)

- **0016 (`supabase/migrations/0016_milk_phase3_4.sql`)**, una transacción
  `begin; … commit;`, aditiva: columnas nuevas nullables o con default,
  tablas nuevas con RLS + `revoke all` + grants mínimos + guarda
  `milk_guard_inventory` (escritura solo dentro de una RPC), CHECK y CHECK de
  forma en `milk_discards`, índices únicos parciales, funciones nuevas
  `security invoker` con `search_path` fijo, `create or replace` de
  `milk_rebalance`, `update_pumping_session`, `void_pumping_session`,
  `milk_create_container`; `log_pumping_session` se recrea con un parámetro
  más **con default** (`p_fridge_at`), igual que 0015 hizo con
  `log_bottle_feed`, para que la llamada de 0.13.0 siga resolviendo. Termina
  con la invariante INV-1…INV-12 (aborta si falla) y `notify pgrst`.
- **Locks:** advisory por op (`amelia_milk_op:`), por etiqueta del bebé
  (`amelia_milk_label:`) cuando se ocupa/libera un número, por bebé para la
  fórmula (`amelia_formula:`), y `FOR UPDATE` en orden de id.
- **Lógica pura:** `lib/milkParams.ts` (todas las constantes clínicas, cada
  una "decisión a confirmar"), `lib/milkCooling.ts`, `lib/formulaStock.ts`,
  `lib/milkRecipe.ts`, `lib/milkCombine.ts`; el reparto TS (`rebalance`) y
  `milkInvariantFailures` aprenden las transferencias. Toda función recibe
  `nowMs`.
- **Cola:** `kind:'rpc'` con `fn` nuevo; `applyPendingInventory` refleja
  `milk_combine`, `milk_uncombine`, `milk_mark_cold`, `discard_started_bottle`;
  `applyPendingFormula` refleja `formula_*`.
- **`lib/db.ts`**: lecturas nuevas (`formulaContainers`, `milkTransfers`,
  `milkOps` de combinar) sin `limit` (`readAll`); escrituras nuevas;
  `milkErrorText` aprende los códigos nuevos.

## 4. Decisiones (todas **a confirmar por papá/mamá/pediatra**)

| # | Decisión por defecto | Por qué |
|---|---|---|
| D5-1 | Reparto: más antiguo primero | Pedido por defecto; minimiza caducidad |
| D5-2 | "Si llora": +1 oz opcional, < 120 min desde el FIN de la última toma | Papá; el FIN es lo que usa "hace X" (v0.10.1) |
| D5-3 | Objetivo de toma completa 3.5 oz (constante) | Ejemplo de papá; no se guarda por familia todavía |
| D5-4 | Enfriado 60 min fijos, sin escala por cantidad | Pedido por defecto; papá dio rangos (30–90) |
| D5-5 | `fridge_at` = hora de "Registrar" (acotada); caducidad sigue desde `pumped_at` | Enfriado: lo prudente es tarde; caducidad: temprano (D-3) |
| D5-6 | Enfriando: aviso en la toma; la Receta no la usa; Combinar la rechaza | "Es aviso, no bloqueo"; "nunca mezclar caliente con fría" |
| D5-7 | Combinar solo fría + fría, en refri, mismo bebé, ninguna vencida | Pedido por defecto |
| D5-8 | Deshacer combinar solo si el destino conserva lo recibido | Si se sirvió, la leche ya no es separable |
| D5-9 | Biberón empezado = el "Sobró", 60 min desde `fed_at` | No existe "preparado"; la toma se anota al darla |
| D5-10 | Desechar el empezado es manual (botón), no automático | Papá: "se ofrece Desechar" |
| D5-11 | "Leche desechada" en Milk = solo caducada; el empezado se ve en Historial | No mezclar leche materna con mezcla |
| D5-12 | Fórmula abierta 48 h desde "Abrí"; desechar con botón | Pedido por defecto |
| D5-13 | Consumo de fórmula derivado de las tomas, no escrito | Editar una toma ajusta solo; offline gratis |
| D5-14 | Aviso de fórmula baja ≤ 8 oz; aviso de vencimiento 6 h antes | Una botella; a confirmar |
| D5-15 | Compra por defecto 6 × 8 oz, editable 1–24 | Papá |
| D5-16 | Stock nunca negativo en pantalla (0 + aviso "más de lo anotado") | Regla 14 |
| D5-17 | Desecho parcial / volcada: fuera de alcance | Pedido |
| D5-18 | Ambiente/congelador en Ajustes: dentro de "Todavía no se usan" (plegado) | Aclarar sin perder valores |

## 5. Casos límite

1. Toma a los 59:59 del sobró → todavía sirve; a 60:00 → ya no sirve.
2. Abierta a 47:59:59 → vigente; 48:00:00 → caducada.
3. Leche registrada a las 10:00 → fría a las 11:00 exactas; a las 10:59:59
   enfriando. Confirmada a las 10:30 → fría desde 10:30.
4. Leche de 4 días y 0 ms → caducada aunque esté fría.
5. Combinar M5 (vence lunes) + M6 (vence martes) en M6 → M6 vence lunes, M5
   libre, "Lo que hay" igual.
6. Combinar con M6 enfriando → `milk_not_cold:M6`.
7. Dos celulares combinan M5+M6 a la vez con ops distintos → uno entra; el
   otro `milk_combine_conflict` (o `milk_container_unusable`).
8. Deshacer después de servir 1 oz del destino → `milk_combine_used:M6`.
9. Deshacer con M5 ya ocupado por otra extracción → `milk_label_taken:M5`.
10. Si llora a 119 min → 1 oz; a 120 min → completa.
11. Sin leche fría → receta "3.5 oz Similac"; con 2 oz fría → "2 oz leche +
    1.5 oz Similac".
12. Sin Similac abierta → la receta igual propone fórmula y avisa "Abrí una
    Similac".
13. Sin conexión: combinar, deshacer, "ya está fría", abrir, desechar empezado
    → se ven con "Todavía sin sincronizar"; al volver, sin duplicados.
14. Editar la fórmula de una toma de 1 → 2 oz → la abierta baja 1 oz más.
15. App 0.13.0 registra una extracción → `fridge_at = pumped_at`.
