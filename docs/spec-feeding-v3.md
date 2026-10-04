# Especificación — Inventario de leche materna y registro de tomas v3

Rama `feat/milk-inventory-v3` (worktree `../amelia_app-milk`, creado desde
`main` @ `9824e26` el 4 oct 2026). Este documento se escribe **antes** del
código para que sobreviva a una compactación de contexto. Las reglas de §1
son la especificación de producto (pedido del dueño, 4 oct 2026) reescrita;
§2 son las lecturas que elegí donde el pedido no decía nada o chocaba con el
repo; §3 es el plan por archivos.

Estado de cada pieza: ver `docs/progreso-feeding-v3.md`.

---

## 0. Punto de partida verificado (no supuesto)

- Rama de trabajo `feat/milk-inventory-v3`, worktree aparte; `main` tiene dos
  archivos sin commitear (`CLAUDE.md` §7.8 y `docs/handoff-2026-09-25.md`) que
  **no** se tocan ni se arrastran.
- La última migración es `0012`. No existe ningún inventario de leche, ni
  tabla de fórmula, ni opción "Avent", ni `lib/milk.ts` (grep de `formula`,
  `avent`, `STANDARD_FEED`, `drawdown`, `container`, `M1`: sin resultados de
  código, explorado el 4 oct 2026).
- Hoy `/pumping` registra **un total** con un lado (`left|right|both`), sin
  cronómetro, y el "stash" es la suma de las últimas 100 sesiones
  (`recentPumping(babyId, 100)`), filtrada por `babies.pumping_reset_at`.
  **Ese total estaba cortado en silencio a 100 filas**: es justamente lo que la
  regla "las lecturas de totales no llevan LIMIT" prohíbe. Se reemplaza.
- `/pumping` no usa `mergePending`/`keepLastGood`/`useSync`: una sesión
  encolada no se veía en la página. Se corrige en este pase.
- **No existe ninguna regla "sin cifras en la página principal"** en
  `design.md`, `CLAUDE.md` ni `PROJECT.md` (grep, 4 oct 2026). La tarjeta de
  Comida ya mostraba la cantidad del último biberón. El pedido manda
  "eliminarla": no hay nada que eliminar; se deja anotado como diferencia
  entre el pedido y el repo.
- **No existen "días de reserva"** en `main`. Por la regla del pedido ("se
  conservan solo si ya existen") no se construyen.
- **Docker está arriba** (`amelia-local-*` healthy). Pero el pedido prohíbe
  aplicar migraciones en cualquier entorno, local incluido: los tests de
  integración de la función nueva se escriben y **no se corren** (§2, S-1).

---

## 1. Reglas de negocio

### 1.1 Extracción

1. Una sesión con la bomba doble es **un** registro con **dos** cantidades:
   izquierda y derecha. Nunca un total repartido mitad y mitad.
2. Cualquiera de los dos lados puede quedar vacío. Los dos vacíos es una
   sesión válida **sin cantidad** y sin contenedor.
3. Si la sesión tiene cantidad, se crea en la **misma transacción** un
   contenedor físico con etiqueta consecutiva **M1, M2, M3…** (la cinta del
   biberón Medela): una más que la mayor etiqueta M que ya tenga el bebé.
   Cantidad inicial = izquierda + derecha.
4. Se registra en vivo (cronómetro que sobrevive a recargar la página) o a
   mano con hora pasada.
5. Se puede editar y anular. Al editar la cantidad, el contenedor la sigue,
   **nunca por debajo de lo ya servido**. Si no tenía cantidad y se le da una,
   el contenedor se crea en ese momento.
6. **No se puede anular una extracción de la que ya se sirvió leche**: primero
   hay que borrar esas tomas.

### 1.2 Conservación y caducidad

1. Tres reglas por familia (las del pediatra): **ambiente 4 h, refrigerador
   4 días, congelador 6 meses**, valores iniciales. Se editan en Ajustes →
   tarjeta "Conservación de la leche".
2. Son de la familia, no del dispositivo: se guardan **directo al servidor**,
   sin cola offline, validadas juntas (un campo vacío nunca se guarda como 0),
   con mensajes legibles.
3. La caducidad se calcula **al guardar** la extracción. Refrigerador: días
   exactos (N × 24 h). Congelador: meses de calendario; si el día no existe en
   el mes de destino se **recorta al último día** de ese mes (el lado seguro).
   Todo en UTC: el mismo resultado en cualquier huso.
4. **Utilizable** = no anulada, con leche restante y no caducada.
5. Hoy todo va al refrigerador. "Pasar al congelador" **no** se construye; la
   columna y la regla quedan listas.

### 1.3 Toma de biberón

1. Una toma = **porciones de leche materna** (cada una: extracción M# +
   cantidad) + **fórmula opcional** (una sola cantidad, puede ser 0).
   Total = suma de porciones + fórmula.
2. Solo leche, solo fórmula, o mezcla. Siempre se puede responder **de qué
   extracción(es) fue y cuánta fórmula llevó**.
3. Se asume que el bebé se terminó todo. No hay sobrante.
4. **No hay inventario de fórmula.** Vive solo como cantidad dentro de la
   toma: sin saldo, sin tabla, sin "+ Agregar fórmula", sin rechazo por falta.
   La falta de leche o de fórmula **nunca bloquea** un registro.
5. **No existe "Avent"**: los biberones son recipientes.
6. **No hay estándar fijo de 3 oz.** Sugerencia = total de la **última toma de
   biberón** registrada; si nunca hubo, 3 oz (solo como valor inicial).
7. Reparto sugerido: primero la extracción utilizable **más antigua**,
   combinando varias si hace falta; el faltante, **fórmula**. Ejemplo: 3 oz y
   M3 con 1.75 → "M3 1.75 oz + 1.25 oz de fórmula = 3 oz". Sin leche
   utilizable, todo fórmula. Es una sugerencia, no una obligación.
8. Se puede cambiar todo: otra extracción, otras cantidades, más o menos
   filas, otra fórmula, otro total.
9. Al registrar se descuenta cada porción de su extracción. **Nunca más de lo
   que tiene**: si dos teléfonos sirven del mismo contenedor a la vez, el
   servidor rechaza al segundo, que vuelve a elegir.
10. Una toma con desglose **solo** edita la hora. Para cambiar cantidades o
    composición se borra y se registra de nuevo; el borrado devuelve cada
    porción a su extracción en una sola operación. Las tomas antiguas sin
    desglose siguen editables como siempre.

### 1.4 Lo que hay (stash)

1. = suma de lo que queda en las extracciones **utilizables**, en onzas
   totales. Solo leche materna. Sin fórmula y sin "cantidad de tomas".
2. Se ve en Leche (lista de M# con lo que queda y su caducidad; las caducadas
   marcadas y sin contar) y dentro del panel de la toma.
3. Las lecturas que alimentan totales **no llevan LIMIT**.

### 1.5 Pantalla de inicio — tarjeta Comida

1. Una línea corta ("Dale X oz") y un **botón con ícono de mamila**.
2. El botón abre un panel con: la sugerencia desglosada; filas editables
   (extracción + oz, fórmula + oz) con "+ Agregar fila" y total calculado;
   la leche materna que queda; botón principal **"Registrar tal cual"** (un
   toque) y una acción para registrar con los cambios.
3. La cantidad se tipea con el selector oz/ml que ya existe, en oz por
   defecto.

### 1.6 /feeding

"Registrar una pasada" usa **el mismo componente** de filas que el panel de
inicio, con hora pasada.

### 1.7 Sin conexión

Toma, extracción o anulación sin internet: queda en el dispositivo, marcada
"Sin sincronizar", y **ya se refleja** en lo que hay y en la sugerencia. Se
reenvía en orden. Un reintento no duplica (ids generados en el dispositivo).
Un rechazo del servidor es un error visible, nunca algo encolado en silencio.

---

## 2. Supuestos (la lectura más conservadora donde el pedido no alcanza)

- **S-1 · Ninguna migración se aplica, ni en local.** El pedido lo prohíbe "en
  cualquier entorno (local o nube)" y a la vez pide integración "si hay
  Docker". Para correr esa integración habría que aplicar `0013` al stack
  local. Gana la prohibición: `tests/integration/milk.test.ts` se escribe y se
  reporta **NO VERIFICADO**. Las suites de integración existentes no dependen
  de `0013` y se pueden correr contra el stack tal como está.
- **S-2 · `family_id` directo además de `baby_id`.** `CLAUDE.md` §5.3 prohíbe
  tablas nuevas con scope por un join a través de `baby_id` (fase 2). El
  pedido describe las tablas con `baby_id`. Se ponen **las dos**:
  `baby_id` (lo pide el pedido) y `family_id` (lo pide CLAUDE.md, que manda),
  atadas con una FK compuesta `(baby_id, family_id) → babies(id, family_id)`
  —la misma que usa `device_tokens` (0007)— para que no puedan discrepar. RLS
  por `family_id` directo.
- **S-3 · Panel inline, no modal.** `design.md` §4: "No hay modales con
  overlay en la app". El "popup/hoja" del pedido es un panel inline: una
  tarjeta de ancho completo debajo de las tres de Inicio, con el foco que
  entra al abrir y vuelve al botón de mamila al cerrar.
- **S-4 · El cronómetro en vivo es por dispositivo.** `pumping_sessions` no
  tiene inicio/fin. La hora de arranque se guarda en `localStorage` de ese
  dispositivo (sobrevive a recargar); el registro se crea al terminar, con la
  hora de inicio. El otro teléfono no ve el cronómetro corriendo.
- **S-5 · La etiqueta M# la propone el dispositivo** (sin conexión tiene que
  poder mostrarla para escribirla en la cinta) y el servidor la **verifica**:
  si otro dispositivo ya usó esa etiqueta para el mismo bebé, la extracción se
  **rechaza** con un mensaje legible en vez de renumerarla en silencio (la
  cinta ya puede tener escrito el número). Es raro (dos extracciones sin
  conexión a la vez) y es honesto.
- **S-6 · Caducidad contra la hora de la toma.** Una porción es válida si la
  extracción no estaba caducada **a la hora en que se dio** (`fed_at`), no a
  la hora en que llega al servidor: una toma registrada sin conexión a las
  2 a.m. y sincronizada a las 9 no se rechaza porque la leche caducó a las 8.
- **S-7 · Redondeo de onzas.** La app muestra onzas con hasta 2 decimales en
  el inventario ("1.75 oz"). Si se tipea exactamente lo que la extracción
  muestra que le queda, se toma **todo** lo que le queda (en ml exactos), para
  que el redondeo de pantalla no deje 0,004 ml huérfanos ni provoque un
  rechazo por pedir 0,004 ml de más. Pedir más de lo que hay es un error en
  pantalla, nunca un recorte.
- **S-8 · Las tomas con desglose se protegen también en el servidor.** Un
  trigger impide cambiar cantidad, composición, tipo o anular una toma con
  desglose fuera de las funciones de la migración (y lo mismo para las
  extracciones y sus contenedores). Así una versión vieja de la app cacheada
  en un teléfono no puede desarmar el inventario con un `update` directo:
  recibe un rechazo visible.
- **S-9 · Las sesiones viejas no crean contenedores.** Las extracciones
  anteriores a `0013` no tienen izquierda/derecha ni contenedor, y no se
  inventa qué quedó de ellas: lo que hay arranca en 0 y crece con cada
  extracción nueva. `babies.pumping_reset_at` deja de usarse para el total
  (sigue en la base, sin lector ni escritor nuevo).
- **S-10 · Una toma solo de fórmula también tiene desglose** (leche 0 +
  fórmula X): se registra por la misma vía y queda con la hora como único
  campo editable, igual que el resto de las tomas nuevas.
- **S-11 · "Registrar tal cual"** registra exactamente la sugerencia mostrada;
  "Registrar con cambios" se habilita solo cuando las filas difieren de la
  sugerencia.
- **S-12 · La regla de ambiente (4 h)** se guarda y se valida, pero ninguna
  extracción la usa hoy (todas van al refrigerador).
- **S-13 · Diferencias con `docs/handoff-metodologia.md`.** El repo dice "sin
  subagentes por default" y "si algo es ambiguo, se pregunta". Este pedido
  pide subagentes y prohíbe preguntar: manda el pedido explícito del dueño
  para esta sesión. La documentación oficial de Claude Code (best practices,
  sub-agents, /goal) coincide con el repo en lo demás: explorar y planear
  antes, verificar con comandos reales, y que revise un agente distinto del
  que escribió.
- **S-14 · `CLAUDE.md` dice que `predictNextFeeding`/`predictNextNap` se
  borraron (24 sep 2026)**: siguen en `lib/db.ts:1032-1082`. Diferencia
  doc/código reportada, fuera de alcance; no se toca.

---

- **S-15 · La caducidad la calcula el servidor.** El dispositivo la calcula
  igual (`containerExpiresAt`) para mostrarla sin conexión, pero lo que queda
  guardado sale de las reglas de la familia en el servidor: si alguien cambió
  las reglas mientras otro teléfono estaba sin conexión, gana la regla
  vigente. `p_container_expires_at` se conserva en la firma y se ignora.
  Refrigerador = `n × interval '24 hours'` (no `days`, que se corre con el
  cambio de horario); congelador = meses sumados en UTC (Postgres recorta al
  fin de mes, igual que `lib/milk.ts`).
- **S-16 · Idempotencia estricta sobre lo que no cambia.** "Misma carga"
  compara lo que una edición posterior **no** puede cambiar: en una toma, el
  bebé, la fórmula y las porciones (la hora y la nota se editan); en una
  extracción, el bebé y el contenedor que creó (las cantidades se editan).
  Si no, un reenvío tardío después de una edición del otro teléfono daría un
  conflicto falso. Distinto en eso = excepción `milk_idempotency_conflict`.
- **S-17 · Rechazado: "no servir leche antes de extraída"** (`stored_at <=
  fed_at`), propuesto por el plan. No lo pidió nadie y con dos teléfonos con
  relojes distintos rechazaría tomas reales. Se deja anotado.
- **S-19 · Cómo se validó 0013 sin aplicarla.** En un Postgres **efímero**
  (imagen de Supabase, sin puertos publicados, borrado al terminar), nunca en
  el stack local ni en la nube: primero dentro de una transacción con
  `ROLLBACK`, y la prueba de concurrencia (dos sesiones) en la base de ese
  mismo contenedor descartable. Es la lectura que respeta la prohibición (ningún
  entorno de la app tiene `0013`) sin entregar SQL sin correr.
- **S-18 · Orden de despliegue.** La app nueva lee columnas de `0013`
  (`recentFeedings`, Leche, Ajustes): **`0013` tiene que estar aplicada en la
  nube antes de que esta rama llegue a `main`**. `currentBaby`,
  `feedingsSince` y el resto de las lecturas que usan los tests de
  integración existentes no cambian.

---

## 3. Plan por archivos

Resultado del subagente de planificación (4 oct 2026), revisado contra §1 y
el pedido. Orden secuencial: las capas comparten `lib/types.ts` e i18n.

### Hito 1 — migración y lógica pura

- `supabase/migrations/0013_milk_inventory.sql` (nueva, **sin aplicar**):
  columnas (`pumping_sessions.left_ml/right_ml`, `feedings.breast_milk_ml/
  formula_ml`, `babies.milk_room_hours/milk_fridge_days/milk_freezer_months`);
  tablas `milk_containers` y `milk_drawdowns` con `family_id` + `baby_id` y FK
  compuesta, RLS, políticas select/insert/update con `WITH CHECK`, `revoke all`
  + `grant select, insert, update`; índice único parcial `(baby_id, label)`
  sobre las no anuladas; triggers de guarda en INSERT y UPDATE
  (`feedings` con desglose, `pumping_sessions` con cantidad, contenedores y
  porciones solo dentro de una función de la migración — bandera de
  transacción `amelia.milk_rpc`, defensa en profundidad, no frontera de
  seguridad); cinco funciones `security invoker`, `search_path = public`,
  actor `auth.uid()`, `pg_advisory_xact_lock` por bebé al asignar etiqueta,
  `FOR UPDATE` en orden de id, `remaining = amount − porciones activas`;
  `grant execute` solo a `authenticated`.
- `lib/milk.ts` + `tests/unit/milk.test.ts`: caducidad, utilizables,
  etiquetas, sugerencia, reparto, stash, porciones, `applyPendingInventory`,
  tomas viejas, texto del desglose, reglas.

### Hito 2 — datos y cola

- `lib/queue.ts`: operación `rpc`; `isDeletion` la cubre; `dependentsOf`
  transitivo y siguiendo `creates`/`refs`.
- `lib/db.ts`: `Db` con `rpc`; `sendOpWith` rama `rpc`; `mergePending` y
  `describeWrite` con `rpc`; `listContainers`, `listDrawdowns`,
  `lastBottleFeeding`, `milkRules`/`saveMilkRules` (directo, sin cola),
  `logPumpingSession`/`updatePumpingSession`/`voidPumpingSession`,
  `logBottleFeed`/`voidBottleFeed` (con `queueOnly` cuando el blanco o un
  contenedor todavía es una alta en la cola), `milkErrorText`; se borran
  `logPumping`/`updatePumping`/`voidPumping`/`totalPumped`.
- `lib/lastSeen.ts`: página `pumping`.
- Tests: `queue.test.ts` (orden, timeout, rechazo, descarte en cascada,
  `isDeletion`), `pending.test.ts` (`mergePending` y `describeWrite` con
  `rpc` en EN y ES, `milkErrorText`), `tests/integration/milk.test.ts`
  (escrito, salta solo si la base no tiene `0013`; **NO VERIFICADO**).

### Hito 3 — interfaz

- `components/BottleBuilder.tsx`: filas extracción + cantidad, fórmula,
  "+ Agregar fila", total, selector oz/ml existente (`AmountUnit`).
- `app/dashboard/page.tsx`: "Dale X oz" + botón de mamila (`ICONS.milk`), panel
  inline de ancho completo, foco de ida y vuelta, "Registrar tal cual" /
  "Registrar con cambios"; lee contenedores, porciones y la última toma de
  biberón.
- `components/SectionPage.tsx` y `app/history/page.tsx`: "Registrar uno
  pasado" con `BottleBuilder`; tomas con desglose → solo la hora, borrar con
  `voidBottleFeed`; desglose debajo de cada toma.
- `app/pumping/page.tsx`: en vivo, a mano (izquierda/derecha), lo que hay
  (lista de M#), historial con editar/borrar; sin conexión como `/growth`.
- `app/settings/page.tsx`: tarjeta "Conservación de la leche".
- `components/SyncStatus.tsx`: el rechazo pasa por `milkErrorText`.
- `lib/i18n/en.ts` + `es.ts`.
- **No** se tocan `package.json` ni `CHANGELOG.md` (lo prohíbe el pedido; el
  plan proponía MINOR — queda como propuesta en el handoff).

### Hito 4 — documentación

`docs/milk-business-logic.md`, `docs/handoff-2026-10-04.md`, índice de
`docs/README.md`, y al final `docs/reglas-de-uso-familia.md`.
