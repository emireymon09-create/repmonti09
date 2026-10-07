# Especificación — Inventario de leche v4 (fases 1 y 2 de las respuestas de papá)

Rama `feat/milk-inventory-v4` (worktree `../amelia_app-v4`, creada desde
`feat/milk-inventory-v3-release` @ `71d4d0c`, con los PR #1 y #2 mergeados;
ver `docs/progreso-feeding-v4.md`). Este documento se escribe **antes** del
código, igual que `docs/spec-feeding-v3.md`, para que sobreviva a una
compactación de contexto.

**Fuente de verdad:** `docs/respuestas-papa-leche.md` (las 22 respuestas y las
funciones nuevas). Donde contradiga a `docs/spec-feeding-v3.md`,
`docs/milk-business-logic.md`, `docs/milk-reglas-para-aprobar.md`,
`docs/reglas-de-uso-familia.md` o al código v3, **manda papá**. Mamá todavía
no firmó (`respuestas-papa-leche.md:157`): todo lo que sigue queda sujeto a su
revisión, y las decisiones de §4 están escritas para que las confirmen los dos.

Alcance: **fases 1 y 2** (1A, 1B, 1C, 1D, 2A, 2B) más las reglas 20–22, que
atraviesan todo. **Fuera de alcance** (fases 3–4, no se construyen): inventario
de Similac, "Abrí una Similac" / 48 h, biberón empezado 1 h, Enfriado, Combinar
biberones y Receta en Hoy (reglas 9, 10, 11 y 14 en su versión cambiada).

Convenciones de este documento: `archivo:línea` se refiere al worktree v4 tal
como está en `5439173`. **"Decisión tomada, a confirmar por mamá/papá"** marca
toda lectura elegida donde las respuestas no alcanzan (§4). Los nombres de
funciones, columnas y RPC de §1–§2 son **intención**: el arquitecto los
concreta; lo que no puede cambiar son los criterios de aceptación.

---

## 0. Punto de partida verificado (qué hay hoy en v3)

Verificado leyendo el código del worktree el 6 oct 2026 (no la documentación).

### 0.1 Esquema (0014)

- **Extracciones:** `pumping_sessions` ganó `left_ml` y `right_ml` (nullable,
  `>= 0 and < 100000`) — `supabase/migrations/0014_milk_inventory.sql:39-41`.
  El total `amount_ml` lo escribe el servidor como `left + right`
  (`0014:504-511`).
- **Contenedores:** tabla `milk_containers` (`0014:68-93`) con `label` libre
  `^M[1-9][0-9]*$` (`0014:76`), `amount_ml`, `remaining_ml`, `stored_at`,
  `location` (`'fridge'|'freezer'`, default `'fridge'`, `0014:82`),
  `expires_at`, `voided_at`. **No hay columna de "desechado" ni de "liberado".**
- **Unicidad de la cinta:** índice único parcial
  `milk_containers_label_live on (baby_id, label) where voided_at is null`
  (`0014:97-98`). **Consecuencia que hoy pasa inadvertida:** un contenedor
  vaciado por tomas (`remaining_ml = 0`) **no** está anulado, así que su cinta
  queda tomada para siempre (no se puede anular una extracción servida,
  `0014:658-663`). En v3 eso no molestaba porque la cinta sugerida siempre
  crecía (`lib/milk.ts:137-140`); con biberones físicos reusables (regla 3)
  **bloquearía M1–M6 en pocos días**. Es el cambio de esquema principal de 1B.
- **Porciones:** `milk_drawdowns` (`0014:108-128`), una fila por contenedor y
  toma (`unique (feeding_id, container_id)`, `0014:120`).
- **Desglose de la toma:** `feedings.breast_milk_ml` y `feedings.formula_ml`
  (`0014:45-48`). **No existe columna de "sobró".** `feeding_type` sigue siendo
  `('bottle','nursing','solid')` (`0001_init.sql:39`).
- **Reglas de conservación:** `babies.milk_room_hours`, `milk_fridge_days`,
  `milk_freezer_months` (`0014:54-64`). **No existe "cantidad de biberones".**
- **Guardas:** trigger `milk_guard_feedings` (`0014:194-226`): una toma **con**
  desglose solo puede cambiar `fed_at` y `notes` por fuera de las RPC — el
  cambio de hora **no re-valida la caducidad**. `milk_guard_pumping`
  (`0014:254-299`): deja pasar la forma legada de v0.12.1 (compatibilidad,
  `docs/compatibilidad-leche.md` §1).
- **Cinco RPC** `security invoker`: `log_pumping_session` (`0014:440-523`),
  `update_pumping_session` (`0014:525-632`), `void_pumping_session`
  (`0014:634-672`), `log_bottle_feed` (`0014:675-827`), `void_bottle_feed`
  (`0014:829-869`). Idempotentes por id del dispositivo, lock por id
  (`amelia_milk_op:`), `FOR UPDATE` en orden de id.

### 0.2 `stored_at` vs `pumped_at` (pedido explícito)

- `log_pumping_session` crea el contenedor con `p_stored_at = p_pumped_at`
  (`0014:517-519` → `milk_create_container`, insert en `0014:419-425`).
  `update_pumping_session` vuelve a poner `stored_at = p_pumped_at` y recalcula
  `expires_at` (`0014:601-605`).
- `pumped_at` es: con cronómetro, **la hora en que se apretó "Empezar"**
  (`app/pumping/page.tsx:293-295`, `startedAt`); a mano, la hora del campo
  "Cuándo" (no futura, `app/pumping/page.tsx:296-299`).
- O sea: **hoy la hora de entrada al refri es la hora de inicio de la
  extracción**, no la de "Terminar y registrar". Ver D-3.
- La caducidad la calcula el servidor (`milk_expires_at`, `0014:350-361`):
  refri = `n × 24 h` desde `stored_at`. Ambiente y congelador **no los usa
  nadie** (todo nace `'fridge'`, `0014:423`).

### 0.3 Cinta libre (lo que v4 reemplaza)

- `/pumping` tiene un campo de texto **"Cinta"** (`app/pumping/page.tsx:446-463`)
  prellenado con `suggestTape(takenTapes(...))` (`app/pumping/page.tsx:250-254`,
  `lib/milk.ts:553-569`): una más que la mayor M viva, sin rellenar huecos.
  Acepta cualquier número (`normalizeTapeLabel`, `lib/milk.ts:163-170`), valida
  ocupación contra los contenedores **no anulados** (`tapeInUse`,
  `lib/milk.ts:177-179`), y el servidor rechaza una cinta viva repetida con
  `milk_label_taken:M#` bajo advisory lock (`0014:408-416`).

### 0.4 Izquierdo / derecho y el selector oz/ml

- Dos campos (izquierdo, derecho) con **un solo** `AmountUnit` compartido
  (`app/pumping/page.tsx:118` estado `unit`, `:443` el control). Regla 1 pide
  uno **por lado**.
- `AmountUnit` (`components/AmountUnit.tsx:26-53`) es un `radiogroup` sin
  estado propio; vuelve a oz porque la página resetea su estado.
- El panel de edición de una extracción en Historial tiene izquierdo y derecho
  **solo en oz**, sin toggle (`app/history/page.tsx:806-830`), por la decisión
  de CLAUDE.md §6 (un número precargado en oz releído como ml destruye el dato).

### 0.5 Caducada

- `/pumping` lista los contenedores no anulados con leche (`shelf`,
  `app/pumping/page.tsx:394`), y a los vencidos les pone "Caducada — no
  cuenta" (`app/pumping/page.tsx:583-587`, `lib/i18n/es.ts:361`). **No hay
  acción**: no hay "Desechar", y el contenedor vencido **no se libera nunca**.
- `isUsable` = no anulado, `remaining_ml >= EMPTY_ML` (0,15 ml) y
  `expires_at > ahora` (`lib/milk.ts:99-104`). "Lo que hay" = `stashMl`
  (`lib/milk.ts:182-184`) solo de utilizables: **ya** excluye vencidos.

### 0.6 Toma de biberón y su edición

- Hoy (Today) registra con `fed_at = new Date()` del teléfono
  (`app/dashboard/page.tsx:490-495`). "Registrar uno pasado" en `/feeding`
  ofrece solo contenedores utilizables **a la hora elegida** y ya extraídos
  para entonces (`components/SectionPage.tsx:700-707`).
- `log_bottle_feed` valida la caducidad contra **`p_fed_at` que manda el
  teléfono** (`0014:791-796`), no contra la hora de la base (hallazgo de la
  auditoría, `docs/handoff-2026-10-06.md:100-102`).
- **Editar una toma con desglose = solo la hora.** Historial:
  `app/history/page.tsx:401-408` (llama `updateFeeding(id, {fed_at})`, un
  UPDATE directo, no una RPC) y el panel `:622-640` con `bottle.timeOnly`.
  `/feeding`: `components/SectionPage.tsx:508-516` y `:1050`. Para cambiar
  cantidades: borrar (`void_bottle_feed`, devuelve la leche) y volver a anotar.
- Las tomas **sin** desglose (anteriores a 0014 o de la app v0.12.1) se editan
  enteras por UPDATE directo: tipo, total y hora (`app/history/page.tsx:409-422`,
  `:644-680`), incluido pasarlas a `solid`/`nursing`.
- `isInventoryBottleFeed` = biberón con `breast_milk_ml` o `formula_ml` no nulo
  (`lib/milk.ts:261-263`).

### 0.7 Conservación en Ajustes

- Tarjeta `MilkStorageSettings` (`app/settings/page.tsx:313-419`): tres campos
  (ambiente h, refri días, congelador meses), validados juntos
  (`validateMilkRules`, `lib/milk.ts:304-329`), guardados **directo, sin cola**
  (`saveMilkRules`, `lib/db.ts:1088`). Ambiente y congelador **se guardan y no
  hacen nada** (`docs/handoff-2026-10-06.md:106-108`).

### 0.8 Cola offline

- Operación `kind: 'rpc'` (`lib/queue.ts:59-70`) con `effect`, `row`/`patch`,
  `creates` (contenedores que nacen) y `refs` (contenedores que necesita);
  `dependentsOf` descarta en cascada (`lib/queue.ts:380-406`).
  `sendOpWith` manda la RPC tal cual en el reenvío (`lib/db.ts:132-138`).
- `applyPendingInventory` (`lib/milk.ts:374-479`) refleja en pantalla las
  cinco RPC encoladas. **No conoce** ninguna operación nueva.

### 0.9 Otros hechos que condicionan v4

- **Producción es v0.12.1 y no tiene 0014.** La rama de release v3 no se
  pusheó (`docs/handoff-2026-10-06.md:3-8`). En local, el stack está migrado
  0001–0014 (`docs/progreso-feeding-v4.md:44`). Por eso "contenedores v3 con
  cintas libres" existen **en local y en cualquier base donde v3 llegue antes
  que v4**; la migración 0015 tiene que tolerarlos igual (D-1).
- La app v0.12.1 escribe `pumping_sessions` y `feedings` directo, en forma
  legada (`docs/compatibilidad-leche.md` §1, §3). v4 no puede romper eso.
- `/pumping` lee las sesiones con `recentPumping(babyId, 100)`
  (`app/pumping/page.tsx:199`): sirve para la lista, **no** para totales.

---

## 1. Trazabilidad: regla de papá → requisito v4

Leyenda de alcance: **1** / **2** = fase de esta entrega; **sin cambio** = ya
lo cumple v3 y v4 no lo rompe; **fuera** = fases 3–4, no se construye.
Pruebas: **U** unit (`tests/unit/`, bajo 4 TZ), **I** integración contra el
stack local, **N** recorrido en navegador / usuario (390 y 1440, EN y ES).

| Regla | Papá dice (resumen) | Alcance | Requisitos | Implementación prevista (intención) | Prueba prevista |
|---|---|---|---|---|---|
| R-1 | Un recipiente por extracción; la tarjeta pregunta izq y der, **cada uno con su oz/ml**; la división es solo estadística, el recipiente recibe el total | 1A | V4-01, V4-02, V4-03 | `app/pumping/page.tsx`: dos `AmountUnit` (uno por lado), estado `unitLeft`/`unitRight`; `log_pumping_session` sin cambios de semántica (total = izq + der) | U: parseo por lado con unidades distintas; I: total = suma; N: 2 oz + 60 ml |
| R-2 | Lados vacíos: se anota sin número | 1A / sin cambio | V4-04 | Ya en `0014:513-520`; el selector de biberón no se exige sin cantidad | I: sesión sin cantidad sin contenedor; N |
| R-3 | Las M son biberones físicos reusables M1–M6; se **elige de un selector**; el orden lo da la hora, no el número | 1B | V4-10, V4-11, V4-12, V4-13 | `babies.milk_bottle_count` (0015); `BottleSlotPicker` en `/pumping`; se retira el campo "Cinta"; FIFO por `stored_at` (`lib/milk.ts` `byAge` ya lo hace) | U: slots libres/ocupados, orden; I: elegir libre; N |
| R-4 | Un biberón con leche no se elige de nuevo hasta que se use, combine, deseche o borre | 1B | V4-14, V4-15 | Columna `released_at` + índice único `(baby_id, label) where voided_at is null and released_at is null` (0015) reemplaza a `milk_containers_label_live` | U, I: ocupado bloqueado; vaciado libera; desechado libera |
| R-5 | Cualquier biberón vacío queda libre | 1B | V4-14, V4-16 | `released_at` se fija al vaciarse (`remaining < EMPTY`), al desechar o al anular | I: tras la toma que lo vacía, se puede elegir |
| R-6 | Ambiente 4 h, refri 4 días, congelador 6 meses | sin cambio | V4-30 | `0014:54-64` | (existentes) |
| R-7 | La hora de anotar es la hora de entrada al refri; con eso vence | 1C | V4-31, V4-32 | Se documenta `stored_at = pumped_at` (D-3); Ajustes marca ambiente/congelador "Todavía no se usa" | U: caducidad; N: Ajustes |
| R-8 | Vencido: "Caducada" + "Desechar"; se anota como leche tirada (desperdicio) y el biberón queda libre | 1C | V4-33…V4-39 | Tabla `milk_discards` + RPC `discard_container` (0015); total en `/pumping`, detalle en Historial | U: `applyPendingInventory` con desecho; I: desechar, idempotencia, rechazo si no venció; N |
| R-9 | Sugerencia por tiempo desde la última toma (Receta) | **fuera** | — | Se mantiene la sugerencia v3 (`lib/milk.ts:194-202`) | (existentes) |
| R-10 | Receta: solo leche fría y vigente; elegir biberones | **fuera** | — | Se mantiene "más vieja primero" v3 (`lib/milk.ts:212-231`) | (existentes) |
| R-11 | Fórmula fija y reparto de leche entre tomas | **fuera** | — | Se mantiene "faltante a fórmula" v3 | (existentes) |
| R-12 | Cualquier cantidad vale | sin cambio | — | — | (existentes) |
| R-13 | Se puede anotar "sobró X oz", para estadística | 1D | V4-40…V4-44 | `feedings.leftover_ml` (0015); campo opcional en el panel del biberón, "Registrar uno pasado" y edición | U: validación; I: no toca inventario; N |
| R-14 | La app cuenta la Similac; nunca bloquea | **fuera** (inventario) / sin cambio (no bloquea) | V4-90 | La fórmula sigue siendo un número en la toma | I: toma solo fórmula sin leche disponible |
| R-15 | "Lo que hay": solo leche que sirve, en oz | sin cambio + 1C | V4-36 | `stashMl` ya excluye vencidos; v4 además excluye desechados | U |
| R-16 | Las tomas anteriores se completan con estimación leche/fórmula | 2B | V4-60…V4-65 | `estimateLegacySplit` puro en `lib/milk.ts`, **no persistido** (D-14) | U: casos de la regla; N: marca "estimada" |
| R-17 | Desde ⋯ de Historial se edita todo: hora, total, leche/fórmula; reacomoda; si falta leche, avisa y no guarda; la fórmula ajusta inventario | 2A (inventario de fórmula **fuera**) | V4-50…V4-58 | RPC `edit_bottle_feed` (0015); panel completo en Historial (y en `/feeding`, D-16) | U: plan de reacomodo; I: baja/sube/falta/concurrencia/idempotencia; N |
| R-18 | El número no se cambia después; borrar y re-anotar | 1B / sin cambio | V4-17 | El panel de edición no tiene selector de biberón | N |
| R-19 | No se borra una extracción ya dada ni se baja por debajo de lo dado; subir, cambiar hora o dividir izq/der siempre se puede | 1B / sin cambio + ajuste | V4-18, V4-19 | `update_pumping_session` reemplazada en 0015 para contar desechos y biberones liberados (D-8, D-9) | I: los cuatro casos del ejemplo de papá |
| R-20 | Sin internet se guarda y cuenta | transversal | V4-80, V4-81 | Toda escritura nueva es `kind:'rpc'` con id del dispositivo; `applyPendingInventory` aprende `discard_container` y `edit_bottle_feed` | U: cola; N offline |
| R-21 | Dos a la vez: gana el primero | transversal | V4-82, V4-83 | Locks `FOR UPDATE` + advisory lock por bebé para el número; `p_expected_*` en la edición | I: dos sesiones concurrentes |
| R-22 | Mismo biberón elegido sin internet: se corrige | transversal | V4-84 | `milk_label_taken:M#` al sincronizar → banner con "Descartar" y texto nuevo | U: `milkErrorText`; I |

---

## 2. Requisitos detallados

Cada requisito tiene **criterios de aceptación (CA)** verificables. Toda cifra
se guarda en ml (CLAUDE.md §5.4); toda pantalla muestra oz salvo el campo que
se está tipeando; todo texto nuevo entra por `lib/i18n/en.ts` y `es.ts`
(CLAUDE.md §5.7).

### 2.1 — 1A. Izquierdo y derecho, cada uno en oz o ml

- **V4-01 · Un selector por lado.** En los dos formularios de `/pumping`
  (terminar el cronómetro y registrar a mano), al lado de "Izquierdo" hay un
  `AmountUnit` y al lado de "Derecho" otro, independientes. Mismo componente
  que el biberón de Hoy (`components/AmountUnit.tsx`), sin forkearlo.
  - CA1: izquierdo `2` en oz y derecho `60` en ml guardan `left_ml = 59,147…`
    y `right_ml = 60` exactos; `amount_ml` = la suma (el servidor la calcula).
  - CA2: cambiar la unidad de un lado **no** cambia la del otro ni reinterpreta
    el número ya tipeado del otro lado.
  - CA3: los dos selectores vuelven a `oz` al montar la página y después de
    cada guardado exitoso (mismo contrato que `AmountUnit`, design.md §5.7).
  - CA4: a 390 px en español, los dos pares campo+selector no producen scroll
    horizontal ni desborde del contenedor (`scrollWidth - clientWidth` = 0,
    la métrica que pide CLAUDE.md §6); el piso táctil de 44 px se respeta.
  - CA5: cada selector tiene `aria-label` que nombra su lado (no dos
    `radiogroup` con el mismo nombre accesible).
- **V4-02 · Al cambiar de unidad no se convierte en silencio.** Si el campo
  tiene un número y se cambia la unidad, se aplica la misma regla que hoy
  (`AmountUnit` no convierte; la página tampoco): el número se lee en la
  unidad nueva. *Decisión tomada, a confirmar por mamá/papá* (D-19): es lo que
  ya hace el biberón de Hoy en `/dashboard`; `BottleBuilder` en cambio
  convierte (`components/BottleBuilder.tsx:14-17`). Se elige **convertir**
  como en `BottleBuilder` si el arquitecto lo puede reusar sin copia; si no,
  no convertir y documentarlo. Lo que **no** se acepta es que cambie según la
  pantalla sin estar escrito.
- **V4-03 · La división es solo estadística.** El contenedor recibe el total;
  izquierdo/derecho no se usan en ninguna cuenta de inventario.
  - CA: editar en Historial la división (2/1 → 1/2, mismo total) en una
    extracción ya servida **se acepta** y no cambia `remaining_ml`.
- **V4-04 · Lados vacíos.** Un lado vacío es `null`, nunca 0. Los dos vacíos =
  sesión válida, sin contenedor, **sin exigir biberón** (el selector se oculta
  o se ignora). Sin cambio de servidor.
- **V4-05 · Edición en Historial.** El panel de edición de una extracción
  **sigue en oz y sin toggle** (`app/history/page.tsx:806-830`), por la razón
  de CLAUDE.md §6. *Decisión tomada, a confirmar por mamá/papá* (D-20).

### 2.2 — 1B. Biberones físicos M1…MN

- **V4-10 · N configurable.** Ajustes → "Conservación de la leche" (o una
  tarjeta hermana "Biberones") tiene "Cantidad de biberones", entero
  **1–30**, default **6**. Se guarda en `babies.milk_bottle_count` (0015,
  `not null default 6 check (… between 1 and 30 and = trunc)`), igual que las
  reglas de conservación: de la familia, **directo, sin cola**, validado antes
  de mandar; sin conexión no se guarda y la tarjeta lo dice (mismo patrón que
  `MilkStorageSettings`, `app/settings/page.tsx:313-419`).
  - CA1: vacío, 0, 31, 2.5 o letras → mensaje legible, no se manda nada.
  - CA2: los dos teléfonos ven el mismo N tras recargar.
- **V4-11 · El selector reemplaza la cinta.** En los dos formularios de
  `/pumping`, el campo de texto "Cinta" se reemplaza por un selector de
  biberón con **M1…MN en orden numérico** (son objetos físicos; el número es
  su nombre, no su antigüedad).
  - CA1: el selector **no viene preseleccionado** (D-4). Con cantidad > 0 y
    sin biberón elegido, "Registrar sesión" muestra "Elegí en qué biberón
    quedó." y no manda nada. Con los dos lados vacíos no se pide.
  - CA2: el aviso al guardar dice el biberón elegido ("Sesión registrada en
    M3.") — ya no "escribí M# en la cinta", porque nadie escribe una cinta.
  - CA3: con la lista de contenedores **desconocida** (sin conexión, sin
    lectura y sin copia guardada — el caso de `takenTapes` que hoy devuelve
    `null`, `lib/milk.ts:553-564`) el selector igual deja elegir, con el aviso
    "Sin conexión: no se sabe qué biberones están ocupados. Si elegís uno
    ocupado, te va a avisar al sincronizar." (regla 20: tiene que funcionar en
    Yosemite). Con copia guardada de otra página, la usa y dice de cuándo es.
- **V4-12 · Ocupado = bloqueado, mostrando hora y cantidad.** Un biberón está
  **ocupado** si tiene un contenedor no anulado y no liberado (V4-14).
  - CA1: la opción ocupada está deshabilitada y dice el número, lo que le
    queda y la hora de entrada al refri: "M3 · 2.5 oz · 14:20" (fecha si no es
    de hoy). Si está vencido: "M3 · Caducada".
  - CA2: un contenedor encolado offline ocupa su biberón igual que uno del
    servidor (lo marca `pending`).
- **V4-13 · El orden lo da la hora.** "Lo que hay" y la sugerencia de la toma
  ordenan por `stored_at` (más viejo primero) y solo desempatan por número
  (`byAge`, `lib/milk.ts:112-117`, ya es así). La lista de `/pumping` deja de
  insinuar orden por número.
  - CA: M6 extraído el lunes y M1 el martes → la sugerencia sirve M6 primero.
- **V4-14 · Libre = vacío, desechado o anulado.** 0015 agrega
  `milk_containers.released_at timestamptz` y reemplaza el índice
  `milk_containers_label_live` por uno `where voided_at is null and released_at
  is null`. `released_at` se fija **en el servidor** cuando:
  (a) una toma deja `remaining_ml < 0,15 ml` (mismo umbral que `EMPTY_ML`,
  `lib/milk.ts:99`, como constante SQL); (b) se desecha (1C); (c) se anula
  (ya liberaba por `voided_at`).
  - CA1: después de la toma que vacía M3, M3 aparece libre en el selector y
    una extracción nueva en M3 se guarda.
  - CA2: el contenedor viejo de M3 sigue existiendo (historia, porciones,
    estadísticas); solo deja de ocupar el número.
  - CA3: la migración rellena `released_at` para los contenedores v3 ya
    vacíos (`remaining_ml < 0,15`), con `released_at = now()` de la migración.
- **V4-15 · Un biberón no se re-ocupa por la espalda.** Si una toma se anula o
  se edita a la baja y su leche volvería a un contenedor **liberado**:
  - si el número de ese biberón **sigue libre**, el contenedor vuelve a estar
    ocupado (`released_at = null`) con la leche devuelta;
  - si el número **ya lo ocupa otro contenedor**, la leche **no vuelve** a
    ningún lado (D-9): la anulación/edición se guarda igual y la pantalla lo
    dice ("La leche no volvió a M3: ese biberón ya tiene otra extracción.").
  - CA: nunca hay dos contenedores ocupados con el mismo número (el índice lo
    garantiza; la RPC lo decide antes, sin error crudo).
- **V4-16 · Concurrencia del número (regla 21).** Dos teléfonos que eligen M3
  a la vez: entra el primero (advisory lock por bebé, `0014:408`, + índice);
  el segundo recibe `milk_label_taken:M3` → "M3 ya lo ocupó otra extracción
  recién. Elegí otro biberón." y el selector se relee. No se guarda nada.
- **V4-17 · El número no se cambia después (regla 18).** El panel de edición
  de una extracción no tiene selector de biberón. Para corregirlo: borrar y
  anotar de nuevo — solo si no se sirvió leche (V4-18).
- **V4-18 · No se anula una extracción servida (regla 19).** Sin cambio de
  semántica: `milk_already_served:M#` (`0014:658-663`). La pantalla lo dice
  antes de mandar (`app/history/page.tsx:497-501`, ya existe).
- **V4-19 · Editar una extracción (regla 19).** Permitido siempre: subir el
  total, cambiar la hora, cambiar la división. Prohibido: bajar por debajo de
  **lo servido** (`milk_served_exceeds_amount:M#`). Con 0015:
  - `remaining = total − servido − desechado` en vez de `total − servido`.
  - Si el contenedor está **desechado**, el total nuevo cambia la cantidad
    desechada (`desechado = total − servido`, nunca < 0) y `remaining` sigue
    en 0 (D-8).
  - Si está **liberado y su número reusado**, el total cambia la estadística
    de la extracción y **no** devuelve leche al inventario (D-9).
  - Cambiar la hora recalcula `stored_at` y `expires_at` (como hoy,
    `0014:601-605`); **no** re-valida tomas ya servidas (D-7).
  - CA: el ejemplo de papá — M2 con 3 oz, servidos 2 oz: bajar a 1,5 oz →
    rechazo con el texto de `milkError.servedExceedsAmount`; borrar → rechazo;
    subir a 3,5 oz → OK, quedan 1,5 oz; cambiar hora → OK; 2/1 → 1/2 → OK.
- **V4-20 · Contenedores v3 con cintas libres.** Ver D-1 y D-2. La migración
  **no renumera** nada.

### 2.3 — 1C. Caducada y "Desechar"

- **V4-30 · Reglas sin cambio** (4 h / 4 días / 6 meses, editables).
- **V4-31 · Caducidad desde la entrada al refri.** `expires_at = stored_at +
  milk_fridge_days × 24 h`, calculada por el servidor al guardar (S-15 de v3,
  sin cambio). `stored_at` sigue siendo `pumped_at` (D-3).
- **V4-32 · Solo cuenta el refri.** En Ajustes, "A temperatura ambiente" y "En
  el congelador" quedan visibles con la marca **"Todavía no se usa"** y siguen
  editables (D-12). No se borra ninguna columna.
  - CA: la nota de la tarjeta dice que hoy toda la leche se cuenta en el refri.
- **V4-33 · Vencido muestra "Caducada" y "Desechar".** En `/pumping`, cada
  contenedor ocupado y vencido (`expires_at <= ahora` del dispositivo, solo
  para pintar) dice **"Caducada"** y tiene el botón **"Desechar"**.
  - CA1: no vencido → no hay botón (D-6).
  - CA2: "Desechar" pide confirmación (`window.confirm`, texto con número y
    cantidad: "¿Desechar M3 (1.5 oz)? Se anota como leche tirada y el biberón
    queda libre.").
- **V4-34 · Qué hace "Desechar".** RPC nueva `discard_container(p_id,
  p_container_id, p_discarded_at)` (0015), idempotente por `p_id` (id del
  dispositivo):
  - inserta una fila en `milk_discards` (tabla nueva: `id`, `family_id`,
    `baby_id`, `container_id`, `amount_ml`, `discarded_at`, `reason` con
    `check (reason in ('expired'))` ampliable, `voided_at`, `logged_by`,
    `created_at`; RLS por `family_id` directo, `revoke all` + grants mínimos,
    trigger de guarda como `milk_drawdowns`);
  - `amount_ml` = **todo** lo que le queda (D-5: total, no parcial);
  - el contenedor queda `remaining_ml = 0` y `released_at` fijado;
  - **se rechaza** si a la hora de la **base** (`now()`) el contenedor todavía
    no venció: `milk_not_expired:M#` (D-6, D-15);
  - `discarded_at` = `p_discarded_at` del teléfono acotado a
    `[expires_at, now()]` (D-15);
  - un contenedor ya desechado o anulado → no-op (no error), para que el
    segundo teléfono que desecha lo mismo no vea un rechazo.
  - CA1: después de desechar, el biberón aparece libre en el selector.
  - CA2: dos llamadas con el mismo `p_id` dejan una sola fila.
  - CA3: dos teléfonos que desechan el mismo contenedor con ids distintos dejan
    **una** fila (la segunda es no-op) — I, dos sesiones concurrentes.
- **V4-35 · Total de leche desechada en Milk.** `/pumping` muestra "Leche
  desechada: X oz" = suma de `milk_discards` no anuladas del bebé, **sin
  LIMIT**, desde que existe la función (D-13). Sin pantalla de estadísticas
  nueva.
- **V4-36 · Vencida no cuenta ni se ofrece.** Sin cambio: `stashMl` y
  `usableContainers` ya la excluyen. Lo nuevo: un desechado tampoco (queda en
  0 y liberado).
- **V4-37 · Detalle en Historial.** Cada desecho es una fila de Historial
  ("Leche desechada · M3 · 1.5 oz"), con la hora de `discarded_at`, **sin**
  editar ni borrar en v4 (D-11). `buildActivity` (`lib/db.ts:1245`) gana un
  `kind` nuevo, con texto en los dos idiomas.
- **V4-38 · Caducidad del lado de la toma con hora de la base.** Ver D-15:
  `log_bottle_feed` (reemplazada en 0015) agrega
  `p_fed_at <= now() + interval '10 minutes'` (`milk_future_time`). Sigue
  validando `expires_at > p_fed_at` (S-6, para no rechazar la toma de las 2
  a.m. que sincroniza a las 9). El riesgo residual queda escrito.
- **V4-39 · Desechar sin conexión.** Se encola (`kind:'rpc'`, `effect:'update'`
  sobre el contenedor, `refs:[container_id]`); `applyPendingInventory` lo
  refleja (contenedor en 0, liberado, `pending`). Si el contenedor todavía es
  un alta encolada, se encola detrás (`queueOnly`).

### 2.4 — 1D. "Sobró X oz"

- **V4-40 · Columna.** `feedings.leftover_ml numeric` nullable, `check
  (leftover_ml >= 0 and leftover_ml < 100000)` y `check (leftover_ml is null
  or amount_ml is null or leftover_ml <= amount_ml)` (0015).
- **V4-41 · Dónde se anota.** Campo opcional "Sobró" (con `AmountUnit`) en el
  panel del biberón de Hoy, en "Registrar uno pasado" de `/feeding` y en la
  edición de la toma (2A). Vacío = no se sabe / no sobró nada (`null`).
- **V4-42 · Solo estadística.** La toma **sigue descontando lo servido**
  (`breast_milk_ml`); "sobró" no devuelve leche a ningún contenedor ni cuenta
  como "leche desechada" (D-10).
  - CA: biberón de 3 oz de M3 con "sobró 1 oz" → M3 baja 3 oz, `leftover_ml`
    = 29,57 ml, el total de desechada no cambia.
- **V4-43 · Validación.** Sobró > total servido → "Sobró más de lo que se
  sirvió." y no se guarda (D-10). En el servidor, la misma regla
  (`milk_bad_input`).
- **V4-44 · Detalle en Historial.** La línea del desglose agrega "· sobró
  1 oz" cuando hay dato. Tomas **sin** desglose también pueden llevarlo (D-11b).

### 2.5 — 2A. Edición completa de una toma pasada

- **V4-50 · Dónde.** El ⋯ → Editar de Historial abre, para un biberón **con
  desglose**, un panel con: hora, leche materna (oz), fórmula (oz), total
  calculado (solo lectura) y sobró. Reemplaza a `bottle.timeOnly`
  (`app/history/page.tsx:622-640`). En `/feeding` se usa **el mismo
  componente** (D-16).
- **V4-51 · RPC única.** `edit_bottle_feed(p_id, p_fed_at, p_breast_ml,
  p_formula_ml, p_leftover_ml, p_notes, p_expected)` (0015): una transacción,
  `security invoker`, lock por id, `FOR UPDATE` sobre la toma y sus
  contenedores en orden de id. Todos los valores son **absolutos** (estado
  final), no deltas: un reenvío del mismo pedido es idempotente.
  - `p_expected` = `{fed_at, breast_milk_ml, formula_ml}` que vio la pantalla
    al abrir el panel. Si el estado actual **ya es** el pedido → no-op. Si no
    es ni el pedido ni el esperado → `milk_edit_conflict` ("Otro teléfono
    cambió esta toma. Revisala y volvé a guardar.") — regla 21.
- **V4-52 · Baja la leche.** La diferencia vuelve a los contenedores de origen,
  **en orden inverso al servido**: primero la porción del contenedor más nuevo
  (`stored_at` mayor) (D-17). Cada porción baja hasta 0 (y se anula si queda en
  0) antes de pasar a la siguiente.
  - La leche vuelve aunque el contenedor esté **vencido** (queda como leche
    caducada, lista para desechar).
  - No vuelve si el contenedor está **desechado**, **anulado**, o **liberado
    con su número reusado** (D-9): la porción baja igual, la leche no entra al
    inventario y la respuesta lo informa (`returned_ml` vs `lost_ml`).
- **V4-53 · Sube la leche.** La diferencia se toma de la leche **más vieja que
  era utilizable a la hora de la toma** (D-18): no anulada, no desechada, con
  `stored_at <= fed_at` y `expires_at > fed_at`, ordenada por `stored_at` y
  número; primero completando porciones existentes no hace falta — se aplica
  FIFO puro.
- **V4-54 · Falta leche.** Si no alcanza, `milk_not_enough` con la cantidad
  disponible ("A esa hora había 1.25 oz de leche; no alcanza para 2 oz.") y
  **no se guarda nada**. La fórmula **nunca** bloquea: subir o bajar fórmula
  siempre se guarda.
- **V4-55 · Cambiar la hora re-valida la caducidad** (D-7): cada porción que
  queda tiene que ser de un contenedor con `expires_at > p_fed_at` nuevo y
  `stored_at <= p_fed_at + 10 min`; si no, `milk_container_unusable:M#`
  ("A esa hora M3 ya estaba caducada.") y no se guarda. Hora futura →
  `milk_future_time`.
- **V4-56 · La fórmula solo se guarda.** `formula_ml` cambia y nada más (el
  inventario de Similac es fase 3, ver §6). El texto de papá "si cambia la
  fórmula, se ajusta el inventario" queda como enganche.
- **V4-57 · Sin conexión.** Encolada como `kind:'rpc'`, `effect:'update'`,
  `refs` = contenedores tocados. La pantalla aplica el mismo reacomodo con una
  función pura gemela (`planBottleEdit`) sobre lo que conoce; el servidor
  decide al sincronizar. Si la toma todavía es un alta encolada → `queueOnly`.
- **V4-58 · Compatibilidad.** El trigger `milk_guard_feedings` (reemplazado en
  0015) sigue dejando a v0.12.1 cambiar **solo la hora** de una toma con
  desglose por UPDATE directo, pero ahora re-valida la caducidad de sus
  porciones contra la hora nueva (error visible `milk_container_unusable`,
  sin cambios en la base). La app v4 **nunca** usa el UPDATE directo para una
  toma con desglose.
  - CA (todas I): baja 3→2 oz de una toma de M3 → M3 recupera 1 oz; baja una
    toma M3 1,75 + M4 0,5 en 1 oz → M4 0,5 y M3 0,5 (inverso); sube 1 oz con
    M5 (más vieja) y M6 → sale de M5; sube sin leche → rechazo, nada cambia;
    solo fórmula 1→2 oz sin leche en la heladera → guarda; dos ediciones
    concurrentes → una entra, la otra `milk_edit_conflict`; mismo pedido
    reenviado → no-op.

### 2.6 — 2B. Estimación hacia atrás

- **V4-60 · A qué se aplica.** A toda toma `bottle` **sin** desglose
  (`breast_milk_ml` y `formula_ml` nulos) y con `amount_ml > 0`: las de antes
  de 0014 y las que registre v0.12.1 durante la ventana.
- **V4-61 · La regla (D-14).** "Leche 0 salvo evidencia": se recorre el
  historial en orden de hora con un **pozo** de leche formado solo por las
  extracciones **sin contenedor** (forma legada), cada una vencida a los
  `milk_fridge_days` de su `pumped_at`; cada toma sin desglose toma del pozo,
  más viejo primero, como mucho su total; lo que no cubre el pozo es fórmula.
  La leche de contenedores (v3/v4) **no** entra al pozo: ya la descuentan las
  porciones reales.
- **V4-62 · No se guarda.** Es una función pura (`estimateLegacySplit`) que
  calcula al leer; **no** escribe `breast_milk_ml`/`formula_ml` (eso la
  volvería toma con desglose, trabada por el trigger y fuera del alcance de
  v0.12.1). No toca "Lo que hay" ni el inventario.
- **V4-63 · Se ve "estimada".** Donde se muestre el desglose de esas tomas
  (Historial, edición) dice "≈ 1.5 oz leche + 1.5 oz fórmula (estimado)".
- **V4-64 · Editar una toma estimada (D-14b).** Se edita como hoy una toma sin
  desglose (tipo, total, hora) más "sobró"; la estimación se muestra
  **solo lectura** y se recalcula. **No** se le puede fijar leche/fórmula en
  v4.
- **V4-65 · Pruebas.** U: sin extracciones legadas → todo fórmula; pozo
  suficiente → todo leche; pozo vencido → no cuenta; dos tomas que se reparten
  un pozo; determinismo en 4 husos.

### 2.7 — Transversales (reglas 20–22)

- **V4-80** Toda escritura nueva (`discard_container`, `edit_bottle_feed`,
  `log_bottle_feed` con sobró, `log_pumping_session` con biberón elegido) usa
  ids generados en el dispositivo y es idempotente por id.
- **V4-81** `applyPendingInventory` y `mergePending` reflejan las nuevas
  operaciones con la marca "Todavía sin sincronizar"; `describeWrite` las
  nombra en los dos idiomas.
- **V4-82** Un rechazo del servidor nunca se encola; se muestra con
  `milkErrorText`, que aprende `milk_not_expired`, `milk_not_enough`,
  `milk_edit_conflict`, `milk_future_time` y el texto nuevo de
  `milk_label_taken` (biberón, no cinta).
- **V4-83** Locks: el mismo orden (id) en `log_bottle_feed`, `void_bottle_feed`,
  `edit_bottle_feed` y `discard_container`, para no cruzarse.
- **V4-84** Mismo biberón elegido offline en dos teléfonos: al sincronizar, el
  segundo recibe "Otro teléfono ya puso leche en M3. Descartá este registro y
  anotalo de nuevo en otro biberón." con "Descartar este registro" (mecanismo
  v3, texto nuevo). No se renumera nunca.
- **V4-90** Ninguna regla de leche bloquea lactancia, pañal ni sueño, ni una
  toma solo de fórmula.

---

## 3. Contradicciones con v3 y lo que v4 revierte

| # | Qué hace v3 (dónde) | Qué pide papá | Qué hace v4 |
|---|---|---|---|
| X-1 | Campo "Cinta" de texto libre con sugerencia "una más que la mayor M viva" (`app/pumping/page.tsx:446-463`, `lib/milk.ts:137-170`; spec v3 S-5, S-24, S-26) | Regla 3: biberones físicos M1–M6, **selector** | **Revierte**: selector M1…MN; se retiran de la UI `normalizeTapeLabel`, `suggestTape`, `takenTapes` y los textos `milk.tape*` (el arquitecto decide si se borran o quedan sin uso) |
| X-2 | La sugerencia de cinta nunca rellena huecos (M1 + M5 → M6) | Regla 5: cualquier biberón vacío se reusa | **Revierte**: no hay "siguiente número"; se elige |
| X-3 | Un contenedor vaciado sigue ocupando su cinta (índice `where voided_at is null`, `0014:97-98`) | Reglas 4 y 5: libre cuando se usa, desecha o borra | **Revierte**: índice nuevo con `released_at` |
| X-4 | "Caducada — no cuenta", sin acción; el contenedor queda para siempre (`app/pumping/page.tsx:583-587`) | Regla 8: "Caducada" + "Desechar", anotada como desperdicio, biberón libre | **Revierte**: `discard_container`, `milk_discards` |
| X-5 | Toma con desglose: **solo la hora** (`app/history/page.tsx:401-408`, `:622-640`; spec v3 §1.3.10, S-10) | Regla 17: se edita todo | **Revierte**: `edit_bottle_feed` |
| X-6 | El cambio de hora de una toma con desglose es un UPDATE directo sin re-validar caducidad (`0014:210-224`) | (implícito en 17 + 8: vencida no se ofrece) | **Revierte**: la hora pasa por la RPC y re-valida; el trigger también (D-7) |
| X-7 | "Se asume que el bebé se terminó todo" (spec v3 §1.3.3; `reglas-de-uso-familia.md` §12) | Regla 13: "sobró X oz" | **Revierte**: `leftover_ml` (solo estadística) |
| X-8 | "Lo que hay arranca en 0" y las tomas viejas no tienen desglose (spec v3 S-9; regla vieja 16) | Regla 16: se estima hacia atrás | **Agrega** estimación no persistida; "Lo que hay" **sigue** arrancando en 0 |
| X-9 | Un solo `AmountUnit` para los dos lados (`app/pumping/page.tsx:118,443`) | Regla 1: uno por lado | **Revierte** |
| X-10 | Ambiente y congelador se guardan y no hacen nada, sin aviso (`docs/handoff-2026-10-06.md:106-108`) | Regla 7: solo cuenta el refri | Se **marca** "Todavía no se usa" |
| X-11 | Mensaje al guardar: "escribí M5 en la cinta" | Regla 3: nadie escribe la cinta | Se cambia por "Sesión registrada en M3." |
| X-12 | `reglas-de-uso-familia.md` §1, §9, §12, §13 y `milk-reglas-para-aprobar.md` describen la cinta libre, "solo la hora" y "se terminó todo" | — | Quedan **desactualizados**: se reescriben en H7 (no en este documento) |

Lo que v3 tenía y v4 **mantiene a propósito**: la sugerencia de la toma
(última toma, 3 oz si no hubo; más vieja primero; faltante a fórmula —
reglas 9–11 fuera de alcance), S-6 (caducidad a la hora de la toma, ahora con
tope de hora futura), S-15 (la caducidad la calcula el servidor), S-16
(idempotencia estricta), S-17 (no se exige `stored_at <= fed_at` al
**registrar**), S-21 (las reglas viven en `babies`), S-22/S-25 (sesiones
legadas), la excepción de forma legada para v0.12.1, y que `/pumping` no edita
en línea (se corrige desde Historial).

---

## 4. Ambigüedades y decisión conservadora

Cada una: **Decisión tomada, a confirmar por mamá/papá.**

- **D-1 · Contenedores v3 con números fuera de M1…MN o raros** (M9 con N = 6,
  M10, M999999). La migración **no renumera ni anula** nada: la cinta física
  puede estar escrita y renumerar sería mentirle a la heladera. Un contenedor
  ocupado con número > N aparece en "Lo que hay" con su número y la marca
  "fuera de M1–M6"; se usa, se desecha o se vacía como cualquiera, y al
  liberarse **desaparece del selector** (que solo ofrece 1…N). Un contenedor
  v3 con número ≤ N ocupa ese biberón. El servidor **no** valida número ≤ N
  (solo el formato `^M[1-9][0-9]*$` y la ocupación): N es de la pantalla.
  *Decisión tomada, a confirmar por mamá/papá.*
- **D-2 · Bajar N con biberones ocupados por encima del nuevo N.** Se permite
  guardar; Ajustes avisa "M7 y M8 todavía tienen leche: se siguen viendo hasta
  que se usen o se desechen." y se tratan como D-1. No se bloquea el cambio
  (no hay nada que se rompa) ni se toca ningún contenedor. Una extracción
  encolada offline con un número > N nuevo **se acepta** al sincronizar (el
  servidor no valida N). *Decisión tomada, a confirmar por mamá/papá.*
- **D-3 · Hora de entrada al refri = `pumped_at`.** Con cronómetro, es la hora
  de "Empezar"; a mano, la elegida. Se mantiene `stored_at = pumped_at` (como
  hoy, `0014:517-519`) en vez de la hora de "Terminar y registrar", porque es
  **más temprana**: la leche vence antes, nunca después de lo real. La hora de
  "frío" de la fase 3 (Enfriado) necesitará su propia columna (§6), donde lo
  conservador es lo contrario (más tarde). *Decisión tomada, a confirmar por
  mamá/papá.*
- **D-4 · El selector no viene elegido.** Elegir el biberón es la única forma
  de que la app coincida con la heladera; un valor preseleccionado se acepta
  sin mirar a las 3 a.m. Cuesta un toque. *Decisión tomada, a confirmar por
  mamá/papá.*
- **D-5 · Desechar es total.** Se tira todo lo que le queda al biberón (así lo
  describe papá: "queda libre"). No hay desecho parcial en v4. *Decisión
  tomada, a confirmar por mamá/papá.*
- **D-6 · "Desechar" solo en leche vencida.** Papá lo describe para la
  caducada; el servidor rechaza un desecho antes de `expires_at`
  (`milk_not_expired`). Para tirar leche que no venció (se volcó, olía mal)
  la salida de hoy sigue siendo borrar la extracción si no se sirvió; si se
  sirvió, **no hay salida en v4** — queda como pregunta abierta para fase 3–4
  ("biberón empezado 1 h" ya va a necesitar desechos por otro motivo; la
  columna `reason` está pensada para eso). *Decisión tomada, a confirmar por
  mamá/papá.*
- **D-7 · Editar la hora de una toma con desglose re-valida la caducidad** a
  la hora nueva (y que no sea futura); editar la hora de una **extracción**
  recalcula su caducidad pero **no** re-valida las tomas que ya salieron de
  ella (son historia; rechazar la edición contradiría "cambiar la hora siempre
  se puede", regla 19). Riesgo escrito: mover una extracción servida a una
  hora más tardía alarga su caducidad (hallazgo de `handoff-2026-10-06.md:103`).
  *Decisión tomada, a confirmar por mamá/papá.*
- **D-8 · Editar una extracción ya desechada.** El total nuevo mueve la
  cantidad desechada (`total − servido`), `remaining` queda en 0 y el biberón
  sigue libre. Bajar por debajo de lo servido sigue prohibido. *Decisión
  tomada, a confirmar por mamá/papá.*
- **D-9 · Leche que "vuelve" a un biberón que ya no la puede recibir.** Al
  anular o bajar una toma (o subir una extracción) cuyo contenedor de origen
  está **anulado, desechado, o liberado con el número reusado**, la leche
  **no vuelve** a ningún contenedor y **no** cuenta como desechada: la
  operación se guarda y la pantalla lo dice. Si el contenedor está liberado y
  el número **sigue libre**, vuelve y lo re-ocupa. Si está **vencido**,
  vuelve (y se ve como caducada). Lo más conservador para "Lo que hay": nunca
  aparece leche en un biberón que físicamente ya tiene otra cosa. *Decisión
  tomada, a confirmar por mamá/papá.*
- **D-10 · "Sobró" mayor que lo servido** → no se guarda (en pantalla y en el
  servidor). "Sobró" **no** suma a "leche desechada" (que es solo lo vencido,
  regla 8) aunque en la práctica se tire: son dos números distintos hasta que
  la fase 4 ("biberón empezado 1 h") decida unificarlos. *Decisión tomada, a
  confirmar por mamá/papá.*
- **D-11 · Desechar no se deshace en v4.** La leche ya estaba vencida (no se
  podía usar), así que deshacer solo corrige la estadística, y re-ocupar el
  biberón chocaría con D-9. Se protege con la confirmación. La fila de
  Historial es de solo lectura. *Decisión tomada, a confirmar por mamá/papá.*
- **D-11b · "Sobró" en tomas sin desglose.** Se permite (es solo estadística
  sobre el total); se guarda por UPDATE directo como el resto de la edición de
  una toma legada, y el CHECK `leftover_ml <= amount_ml` lo respalda. Si
  v0.12.1 baja después el total por debajo de lo sobrado, recibe un error
  visible. *Decisión tomada, a confirmar por mamá/papá.*
- **D-12 · Ambiente y congelador en Ajustes: se marcan, no se ocultan.** Ocultar
  escondería valores guardados que la fase 3–4 va a usar; marcar "Todavía no
  se usa" dice la verdad sin perder nada. Siguen editables. *Decisión tomada,
  a confirmar por mamá/papá.*
- **D-13 · "Leche desechada" en Milk = total histórico** (desde que existe
  Desechar), sin ventana de tiempo, leído sin LIMIT. Una ventana (7 días,
  semana de vida) es estadística y no se pidió. *Decisión tomada, a confirmar
  por mamá/papá.*
- **D-14 · Regla de estimación hacia atrás: "leche 0 salvo evidencia".** Se
  descartó "mitad y mitad" (inventa leche que pudo no existir) y "todo leche"
  (infla la estadística de leche materna). "Todo fórmula" es lo que nunca
  infla la leche, pero ignora extracciones que sí están registradas; por eso
  se toma la evidencia mínima: solo leche **anotada** en extracciones legadas,
  **no vencida** a la hora de la toma, más vieja primero, y nunca más que el
  total de la toma. Si la leche registrada se tiró sin anotarlo, la
  estimación queda por arriba de lo real: es el único sesgo y está acotado por
  lo extraído. Si mamá/papá prefieren cero estricto, es cambiar una función
  pura. *Decisión tomada, a confirmar por mamá/papá.*
- **D-14b · Editar una toma estimada.** La estimación se muestra y no se
  edita: fijarle leche/fórmula exigiría porciones de contenedores que para
  esa leche no existen, y la volvería una toma con desglose que v0.12.1 ya no
  puede tocar. Se editan tipo, total, hora y sobró, como hoy. *Decisión
  tomada, a confirmar por mamá/papá.*
- **D-15 · Hora de la base vs hora del teléfono.** Caducidad al **registrar**
  una toma: contra `p_fed_at` (S-6, sin cambio) más un tope nuevo: `p_fed_at`
  no puede ser más de 10 min futura según la base. Al **editar** una toma:
  igual, contra la hora nueva. Al **desechar**: el permiso se decide con
  `now()` de la base (un teléfono con el reloj adelantado no desecha leche
  que no venció) y la hora guardada es la del teléfono acotada a
  `[expires_at, now()]`. Riesgo residual escrito: un teléfono con el reloj
  **atrasado** puede servir leche vencida en una toma "de ahora"; usar
  `now()` al registrar rompería la toma offline de la madrugada. *Decisión
  tomada, a confirmar por mamá/papá.*
- **D-16 · La edición completa también en `/feeding`.** Papá nombra el ⋯ de
  Historial; `/feeding` hoy edita la misma fila con otra regla (solo hora,
  `components/SectionPage.tsx:508-516`). Tener dos reglas para la misma toma
  es peor que un panel de más; se usa **un** componente en los dos lugares.
  *Decisión tomada, a confirmar por mamá/papá.*
- **D-17 · Qué leche vuelve primero si la toma salió de varios biberones.** La
  del contenedor **más nuevo** (orden inverso al servido): la sugerencia sirve
  el más viejo entero y el más nuevo en parte, así que "di menos" casi siempre
  significa "saqué menos del último". Además es el que vence más tarde: la
  leche devuelta tiene más chance de seguir sirviendo. *Decisión tomada, a
  confirmar por mamá/papá.*
- **D-18 · "La hora de la toma" para elegir la leche más vieja al subir.** Es
  el `fed_at` **final** de la toma editada (si se cambia la hora y la leche a
  la vez, cuenta la hora nueva). Solo se toma de contenedores que existían y
  servían **a esa hora** (`stored_at <= fed_at`, `expires_at > fed_at`), no
  anulados ni desechados — lo mismo que ya filtra "Registrar uno pasado"
  (`components/SectionPage.tsx:700-707`). *Decisión tomada, a confirmar por
  mamá/papá.*
- **D-19 · Cambiar oz↔ml con un número ya tipeado** en los selectores de
  izquierdo/derecho: convertir (como `BottleBuilder`) si se puede reusar sin
  copiar; si no, no convertir y decirlo. Lo prohibido es que cada pantalla haga
  algo distinto sin escribirlo. *Decisión tomada, a confirmar por mamá/papá.*
- **D-20 · La edición de una extracción en Historial sigue sin toggle oz/ml.**
  Papá pide el selector "al anotarla"; en los paneles de edición CLAUDE.md §6
  ya decidió no ponerlo (un 4.1 precargado en oz releído como ml destruye el
  dato). *Decisión tomada, a confirmar por mamá/papá.*
- **D-21 · Tomas legadas de v0.12.1 durante la ventana.** Entran sin desglose,
  no descuentan leche (como hoy, `compatibilidad-leche.md` §5), se **estiman**
  (2B) y "Lo que hay" no cambia por la estimación. Una extracción legada de la
  ventana no ocupa ningún biberón (no tiene contenedor) y alimenta el pozo de
  la estimación. La salida para meterlas al inventario sigue siendo borrar y
  re-anotar en Leche eligiendo el biberón. *Decisión tomada, a confirmar por
  mamá/papá.*
- **D-22 · Desechar y una toma offline sobre el mismo biberón.** Si el
  teléfono A sirve de M3 sin conexión a las 7:50 (vencía a las 8:00) y el B
  desecha M3 a las 8:05, al sincronizar la toma de A recibe `milk_overdraw:M3`
  visible (regla 21: gana el primero que llegó al servidor). No se achica el
  desecho automáticamente. *Decisión tomada, a confirmar por mamá/papá.*
- **D-23 · Rango de N: 1–30, entero.** 30 cubre cualquier heladera doméstica y
  evita números absurdos en un selector. *Decisión tomada, a confirmar por
  mamá/papá.*

Total: **25** decisiones (D-1 … D-23, más D-11b y D-14b).

---

## 5. Casos límite (resultado esperado)

1. Extracción con izquierdo `1.5` oz y derecho vacío → `left_ml` 44,36,
   `right_ml` null, `side = 'left'`, contenedor con 1,5 oz en el biberón
   elegido.
2. Izquierdo `0` y derecho `0` → total 0: sesión sin contenedor, no se pide
   biberón (0 cuenta como "nada", igual que vacío, `0014:513`).
3. Izquierdo `-1` o `1e400` o `abc` → "La cantidad tiene que ser un número"
   y no se manda.
4. Cantidad > 0 sin biberón elegido → "Elegí en qué biberón quedó."; nada se
   guarda.
5. Elegir un biberón ocupado → imposible en pantalla (deshabilitado); si la
   lista era vieja, el servidor rechaza con `milk_label_taken:M#` y la página
   se relee.
6. Dos teléfonos eligen M3 a la vez con conexión → uno guarda; el otro ve
   "M3 ya lo ocupó otra extracción recién. Elegí otro biberón."
7. Dos teléfonos eligen M3 sin conexión → al sincronizar, el segundo queda con
   el banner de rechazo y "Descartar este registro"; la cola sigue con el resto.
8. La toma que deja M3 en 0,1 ml → M3 queda liberado (umbral 0,15 ml) y
   ofrecido en el selector; "Lo que hay" no cuenta esos 0,1 ml.
9. Se anula esa toma y M3 sigue libre → la leche vuelve y M3 vuelve a estar
   ocupado.
10. Se anula esa toma y M3 ya tiene otra extracción → la toma se anula, la
    leche no vuelve, el mensaje lo dice; nunca dos M3 ocupados.
11. M3 vencido → "Caducada" + "Desechar"; no aparece en la sugerencia ni suma.
12. "Desechar" M3 con 1,5 oz → fila en `milk_discards` de 1,5 oz, M3 libre,
    "Leche desechada" sube 1,5 oz, Historial muestra la fila.
13. "Desechar" con el reloj del teléfono adelantado (para la base todavía no
    venció) → `milk_not_expired:M3`, nada cambia.
14. "Desechar" sin conexión → M3 se ve libre y desechado con "Todavía sin
    sincronizar"; al volver la conexión, una sola fila.
15. Dos teléfonos desechan M3 → una fila; el segundo no ve error.
16. Desechar M3 que tiene leche ya servida a una toma → permitido (solo se
    tira lo que queda); la toma no cambia.
17. Anular una extracción ya desechada y no servida → se anulan extracción,
    contenedor y su desecho (el total de desechada baja).
18. Anular una extracción desechada y servida → `milk_already_served:M#`.
19. Toma de Hoy con sobró 0,5 oz de 3 oz → inventario baja 3 oz; sobró
    guardado; "Leche desechada" no cambia.
20. Sobró 4 oz en una toma de 3 oz → rechazo, nada se guarda.
21. Editar toma: leche 3 → 2 oz, todo de M3 → M3 recupera 1 oz.
22. Editar toma: leche 3 → 2 oz, de M3 (1,75) + M4 (1,25) → M4 baja a 0,25
    (vuelve 1 oz a M4), M3 intacto.
23. Editar toma: leche 2 → 3 oz, a esa hora utilizables M5 (lunes) y M6
    (martes) → sale 1 oz de M5.
24. Editar toma: leche 2 → 5 oz y a esa hora solo había 1 oz → rechazo
    "no alcanza", nada cambia.
25. Editar toma: fórmula 1 → 3 oz sin leche en la heladera → se guarda.
26. Editar la hora de una toma a un momento en que su M3 ya había vencido →
    `milk_container_unusable:M3`, nada cambia.
27. Editar la hora de una toma al futuro → rechazo.
28. Dos teléfonos editan la misma toma → el primero guarda; el segundo
    `milk_edit_conflict`.
29. Edición encolada offline reenviada dos veces → la segunda es no-op.
30. Edición a la baja de una toma cuyo M3 fue desechado → la toma baja, la
    leche no vuelve, el mensaje lo dice.
31. Toma sin desglose de 3 oz, sin extracciones legadas → "≈ 0 oz leche + 3 oz
    fórmula (estimado)".
32. Toma sin desglose de 3 oz con una extracción legada de 2 oz el día antes →
    "≈ 2 oz leche + 1 oz fórmula (estimado)"; con esa extracción de hace 5 días
    → "≈ 0 + 3 (estimado)".
33. Editar el total de una toma estimada → se recalcula la estimación; no se
    crea desglose.
34. v0.12.1 cambia solo la hora de una toma con desglose a un momento en que su
    leche estaba vencida → error visible, la toma no cambia.
35. v0.12.1 registra una extracción y un biberón durante la ventana → entran
    legados; "Lo que hay" no cambia; el biberón se estima.
36. N baja de 6 a 4 con M5 ocupado → se guarda; M5 sigue en "Lo que hay"
    marcado "fuera de M1–M4"; el selector ofrece M1–M4.
37. Contenedor v3 "M12" ocupado tras la migración → visible, utilizable,
    desechable; al vaciarse no vuelve a aparecer en el selector.
38. Contenedor v3 vacío (remaining 0) antes de la migración → `released_at`
    rellenado; su número queda libre.
39. Editar una extracción servida: subir la hora 2 días → caducidad se
    corre; las tomas ya servidas no se re-validan (D-7).
40. Lactancia en curso → la tarjeta de comida sigue sin botón de biberón
    (S-23 de v3, sin cambio); ninguna regla de leche toca la lactancia.

---

## 6. Puntos de enganche para fases 3–4 (solo documentar)

Nada de esto se construye; 0015 se diseña para que entre **sin migración
destructiva**:

- **Estados del biberón.** v4 los deriva de columnas: ocupado
  (`voided_at is null and released_at is null`), vencido (`expires_at`),
  desechado (fila en `milk_discards`), liberado (`released_at`). "Enfriando" /
  "Frío" (fase 3) entran como columna nueva `cold_at timestamptz` (null =
  enfriando; estimado por cantidad o confirmado a mano), con `fridge_at`
  separado de `stored_at` si hace falta distinguir la hora de entrada al refri
  de la de extracción (D-3). No se usa un enum de estado: evita migrar datos
  cuando aparezca uno nuevo.
- **Combinar biberones.** Una tabla de transferencias contenedor→contenedor
  (`milk_transfers`) o porciones con `target_container_id`; el destino toma la
  caducidad **más vieja** (papá). El índice de ocupación de 0015 ya libera el
  origen al quedar vacío; las estadísticas izq/der quedan en `pumping_sessions`
  (no se tocan).
- **Desechos por otros motivos.** `milk_discards.reason` nace con
  `check (reason in ('expired'))`: fase 4 agrega `'started_1h'`, `'manual'`,
  etc. reemplazando el CHECK (aditivo). Desecho parcial = otra fila con
  `amount_ml` menor.
- **Inventario de fórmula (Similac).** Tablas nuevas (`formula_packs`,
  `formula_bottles` con `opened_at` y vencimiento 48 h) y porciones de fórmula
  análogas a `milk_drawdowns`. `feedings.formula_ml` sigue siendo la verdad de
  cuánto llevó la toma; `edit_bottle_feed` ya recibe `p_formula_ml` absoluto,
  así que "si cambia la fórmula se ajusta el inventario" (regla 17) se agrega
  dentro de la misma RPC. **Nunca bloquea** (regla 14): el inventario de
  fórmula puede quedar negativo o avisar, no rechazar.
- **Receta en Hoy.** Reemplaza `suggestedTotalMl`/`suggestPlan`
  (`lib/milk.ts:194-231`) por una función pura nueva que lea la hora de la
  última toma (`lastFeedingEvent`, `lib/kpis.ts`), el objetivo y el "completar
  con 1 oz" (configurables por familia → `family_settings` o `babies`), y solo
  leche fría y vigente (`cold_at`). `BottleBuilder` ya acepta cualquier plan.
- **Biberón empezado 1 h.** `feedings` necesitaría `started_at` del biberón o
  un registro de "preparado"; lo sobrante se anota como `milk_discards` con
  `reason = 'started_1h'` (por eso D-10 no mezcla "sobró" con desechada).
- **Estadísticas.** `leftover_ml`, `milk_discards` y `estimateLegacySplit` son
  las fuentes; `/statistics` no se toca en v4.
- **Rollback.** `docs/rollback-leche.sql` hoy revierte 0014; 0015 necesita su
  propio bloque de reversa (H7), que **no** pierda `leftover_ml` ni los
  desechos sin avisar.

---

## 7. Qué no cambia

- Lactancia, pañal, sueño, crecimiento, médico, push, calendario, cambiador y
  rutas `/api/quick/*`: ninguna regla de leche los toca ni los bloquea.
- La sugerencia de la toma v3: total de la última toma de biberón (3 oz si
  nunca hubo), más vieja utilizable primero, faltante a fórmula, "Registrar tal
  cual" / "Registrar con cambios" (`lib/milk.ts:194-231`,
  `app/dashboard/page.tsx:452-525`). Solo se le suma el campo opcional "sobró".
- La fórmula sin inventario: un número en la toma, nunca bloquea.
- El cronómetro de extracción por dispositivo (`localStorage`, S-4).
- `/pumping` no edita en línea: se corrige y borra desde Historial (v0.11.0).
- Las reglas de conservación y su guardado directo sin cola.
- "Lo que hay" arranca en 0 con las extracciones con contenedor (S-9); la
  estimación de 2B no lo mueve.
- La forma legada de v0.12.1 (extracciones y tomas sin desglose) sigue
  entrando, editándose y borrándose directo.
- Unidades: base en ml, pantalla en oz, `DISPLAY_UNIT = 'oz'`.
- El borrado lógico (`voided_at`) en todo; ninguna tabla nueva tiene DELETE.
- Las tablas nuevas llevan `family_id` directo + `baby_id` con FK compuesta,
  RLS y grants en la misma migración (CLAUDE.md §5.2–5.3).
- 0001–0014 no se editan: todo cambio de función o índice va en **0015**
  (`create or replace`, `drop index` + `create index` sobre el mismo predicado
  ampliado), aditiva respecto de los datos.
