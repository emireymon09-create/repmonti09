# Progreso — inventario de leche y tomas v3

Memoria entre turnos. Spec: `docs/spec-feeding-v3.md`. Etiquetas:
**[VERIFICADO]** = con el comando citado; **[NO VERIFICADO]** = no se pudo
correr o comprobar.

## Estado por hito

| Hito | Estado | Verificado con |
|---|---|---|
| 0 · Lectura, exploración, plan, spec | Hecho (4 oct 2026) | — |
| 1 · Migración 0014 + `lib/milk.ts` + tests | Hecho | `vitest run tests/unit/milk.test.ts` 45/45; `tsc --noEmit` limpio; SQL en Postgres efímero (ver abajo) |
| 2 · Datos y cola + tests (+ página Leche) | Hecho | `pnpm test` 350/350; `tsc --noEmit` limpio; `pnpm test:integration` 107 pasan + 8 saltados (suite de leche: la base local no tiene 0014) |
| 3 · Interfaz + i18n | Hecho (código) | `tsc`, `lint`, `format:check`, `build` en verde; **comportamiento en pantalla NO VERIFICADO** (ver abajo) |
| 4 · Documentación y documento familiar | Hecho | `docs/milk-business-logic.md`, `docs/handoff-2026-10-04.md`, `docs/reglas-de-uso-familia.md`, índice de `docs/README.md`; grep de términos técnicos sobre el documento familiar: sin resultados |
| Revisión independiente (3 agentes + 2 vueltas sobre los arreglos) | Hecha | Hallazgos bloqueantes abiertos: 0 (tablas abajo) |
| 5 · Verificación local (0014 en el stack local, navegador, barrido) | Hecho (4 oct 2026) | `pnpm test:all` 4×351 + 115 (milk 9/9); recorrido a–f 13/13; barrido 64 combinaciones 16 → 0 hallazgos (ver al final) |

## Notas

- `tests/unit/milk.test.ts`: 45/45 en verde con `pnpm exec vitest run
  tests/unit/milk.test.ts` antes de la migración [VERIFICADO].

- **0014 validada sin aplicarla en ningún entorno** [VERIFICADO]: contenedor
  efímero `public.ecr.aws/supabase/postgres:17.6.1.167` **sin puertos
  publicados**, con 0001–0012 + la del inventario + 41 chequeos de comportamiento dentro de una
  sola transacción terminada en `ROLLBACK` (`to_regclass('public.milk_containers')`
  vacío después). Cubre: total = izq + der escrito por el servidor, M1 con
  caducidad del servidor, reenvíos no-op, `milk_label_taken`, sin cantidad sin
  contenedor y contenedor al darle cantidad, totales de la toma del servidor,
  `milk_overdraw`, `milk_container_unusable` (caducada a la hora de la toma,
  otra familia), solo fórmula válida, nada = inválido, edición que no baja de
  lo servido, `milk_already_served`, guardas `milk_rpc_only` (update/insert
  directos), toma vieja editable, la hora de una toma con desglose editable,
  anular devuelve cada porción, no-op de anulaciones, RLS entre familias,
  anon sin permiso, service_role sigue insertando tomas, catálogo (RLS, 6
  policies, WITH CHECK, invoker, grants), caducidad del congelador (28/29 feb)
  y del refrigerador (96 h exactas con TZ de sesión de Los Ángeles).
- **Concurrencia** [VERIFICADO], mismo contenedor efímero (esta vez con
  `commit`, base del contenedor descartable): dos sesiones sirven 70 ml de un
  M1 de 100 a la vez → la primera entra, la segunda espera el lock y recibe
  `milk_overdraw:M1`; quedan 1 toma, 1 porción, 30 ml. Contenedor borrado
  (`docker rm -f`), 0 contenedores `amelia-milk-scratch` después.
- El stack local `amelia-local-*` y la nube **no se tocaron**.

- **Hito 2.** `lib/queue.ts` (op `rpc`, `isDeletion`, `dependentsOf`
  transitivo con `creates`/`refs`), `lib/db.ts` (lecturas sin límite de
  contenedores y porciones, `lastBottleFeeding`, reglas, las cinco escrituras
  con `queueOnly`, `mergePending`/`describeWrite` con `rpc`, `milkErrorText`),
  `lib/lastSeen.ts` (página `pumping`), `components/SyncStatus.tsx` (rechazo
  legible). La página Leche se reescribió en este mismo hito porque era la
  única consumidora de las funciones viejas que se borraron
  (`logPumping`/`updatePumping`/`voidPumping`/`totalPumped`): sin eso el
  commit no compilaba.
- **Integración de la leche: NO VERIFICADA.** `tests/integration/milk.test.ts`
  está escrita y se salta sola contra una base sin 0014 (sonda sobre
  `milk_containers`). Las otras seis suites corren y pasan contra el stack
  local sin 0014 [VERIFICADO, `pnpm test:integration`].

- **Hito 3.** `components/BottleBuilder.tsx` (el constructor de filas, uno
  solo), Hoy (línea "Dale X oz", botón de mamila, panel inline con "Registrar
  tal cual" / "Registrar con cambios"), `/feeding` (Registrar uno pasado con
  el mismo constructor; tomas con desglose: solo la hora, borrar con
  `voidBottleFeed`, desglose debajo), Historial (lo mismo), Ajustes
  ("Conservación de la leche"), `Btn` con ícono/ref/aria, `.btn-icon`. Se
  borraron `logFeeding` (sin uso: un biberón ahora siempre lleva desglose) y
  tres claves de i18n que quedaron sin lector.
- **La interfaz NO se probó en un navegador contra datos reales** [NO
  VERIFICADO]: las pantallas leen tablas de 0014, y 0014 no está aplicada en
  el stack local (prohibido en este pase). Contra el stack actual, Leche, Hoy,
  /feeding e Historial mostrarían el error de lectura de `milk_containers`. Lo
  que sí está verificado es que compila, pasa lint y build, y que toda la
  lógica que la interfaz usa tiene tests unitarios.

## Revisión independiente (4 oct 2026) — hallazgos y resolución

Tres subagentes con contexto limpio, solo lectura, en paralelo. Ninguno
escribió código; ninguno de los que escribieron código revisó.

### Auditor de migración — veredicto: "sólida en RLS, grants y bloqueos"; 0 bloqueantes

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| 1 | IMPORTANTE | Un reintento que se solapa con la primera llamada (la cola corta a 15 s, el servidor sigue) daba sobregiro falso o `23505` | **Corregido**: `pg_advisory_xact_lock` por id en las cinco funciones. Verificado: el mismo id dos veces a la vez → 1 toma, 1 porción, sin error |
| 2 | IMPORTANTE | `"NaN"`/`"Infinity"` pasaban todos los chequeos (NaN > todo en Postgres) | **Corregido**: tope `< 100000` en todas las columnas y parámetros (`not (x >= 0 and x < tope)`). Verificado: 3 rechazos `milk_bad_input` |
| 3 | MENOR | `milk_create_container` recibía el actor y la familia por parámetro | **Corregido**: los deriva (`auth.uid()`, familia del bebé) |
| 4 | MENOR | Una sesión vieja recibe contenedor si se le escriben los lados | **Aceptado a propósito** (S-22): es una acción explícita de quien edita, y la pantalla lo avisa |
| 5 | MENOR | Un DELETE real de una sesión chocaba con la guarda (set null) | **Corregido**: la guarda deja pasar solo ese cambio. Verificado: borrar sesión y borrar familia entera |
| 6 | MENOR | Una porción podía apuntar a un contenedor de otra familia (sin FK) | **Corregido**: `unique (id, family_id)` + FK compuesta |
| 7 | MENOR | Insertar un biberón sin desglose por fuera de las funciones sigue posible | **Rechazado, justificado**: la app ya no tiene ningún camino que lo haga (`logFeeding` se borró); cerrarlo rompería `tests/integration/rls.test.ts:44` (inserta un biberón como padre) y las altas viejas encoladas en teléfonos con la versión anterior. Coincide con S-8 |

### Revisor de código — veredicto: "no mergeable" hasta resolver 1 bloqueante

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| 1 | **BLOQUEANTE** | Bucle de render: `usable` nuevo en cada render → `value` nuevo → `onChange` → re-render | **Corregido** en las dos puntas: `BottleBuilder` reporta solo si el valor cambió (firma JSON), y las páginas memorizan `usable` y el plan por contenido (`useMemo` sobre la firma). **Verificado en un navegador** (abajo) |
| 2 | IMPORTANTE | Editar una sesión anterior a 0014 le borraba el total | **Corregido** en el servidor (rama `v_legacy`) y en la pantalla (aviso + no manda el total en el patch). Verificado en SQL |
| 3 | IMPORTANTE | "Registrar uno pasado" ofrecía leche extraída después de la hora elegida | **Corregido** en el cliente (`stored_at <= hora`). En el servidor sigue sin chequeo: S-17 |
| 4 | IMPORTANTE | "Registrar con cambios" se habilitaba sin cambios (redondeo 0,15 ml) | **Corregido**: una fila sin tocar vale los ml EXACTOS del plan; comparación exacta |
| 5 | IMPORTANTE | Una relectura de fondo borraba lo tipeado | **Corregido**: con filas editadas no se reinicia; aviso "La sugerencia cambió mientras editabas" + "Empezar de nuevo desde ahí" |
| m1 | MENOR | Ref escrita durante el render | **Corregido**: `useMemo` sobre la firma |
| m2 | MENOR | Restos de 1e-10 ml contaban como leche | **Corregido**: `EMPTY_ML = 0.01` (test nuevo) |
| m3 | MENOR | `keepLastGood` puede mezclar contenedores de una lectura con porciones de otra | **Aceptado**: solo sin conexión y transitorio (la próxima lectura buena lo arregla); la honestidad no cambia: lo encolado se sigue marcando |
| m4 | MENOR | /feeding sugería 3 oz si la última toma de biberón no estaba en las 200 filas | **Corregido**: lee `lastBottleFeeding` como Hoy |
| m5 | MENOR | Una toma nueva podía adelantarse a una anulación encolada | **Corregido**: con cualquier operación de leche en la cola, la toma se encola detrás |
| m6 | MENOR | Escape en un `<select>` cerraba el panel | **Corregido** |
| m7 | MENOR | Ajustes podía decir "Guardado" sin guardar | **Corregido**: `.select('id')` y error si no volvió una fila |

### Verificador de reglas de negocio — veredicto: "todo §1 implementado"; 0 bloqueantes

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| I-1 | IMPORTANTE | = revisor de código #2 | **Corregido** |
| M-1 | MENOR | La cinta de un contenedor anulado se reutiliza | **Aceptado a propósito** (S-20), comentario corregido |
| M-2 | MENOR | = revisor de código m4 | **Corregido** |
| M-3 | MENOR | = revisor de código m7 | **Corregido** |
| M-4 | MENOR | Las reglas viven por bebé | **Aceptado** (S-21) |

**Hallazgos bloqueantes abiertos: 0.**

### Verificación del arreglo bloqueante, en un navegador [VERIFICADO]

`pnpm build` + `pnpm start -p 3100` (escuchando solo en 127.0.0.1) contra el
stack local **sin** 0014, una familia descartable sembrada y borrada al final,
chrome-headless-shell por CDP a 390×844. Con el panel del biberón abierto, el
hilo principal estuvo ocupado **10 ms de 4000** (un bucle lo dejaría cerca del
100 %); un "2.5" tipeado en Fórmula sobrevivió varios ticks del reloj y el
total lo siguió ("Total: 2.5 oz"); el foco entró al título del panel y
`aria-expanded` pasó a `true`; 0 errores de consola. En `/feeding` →
Biberón, el constructor se montó y el hilo estuvo ocupado 20 ms de 4000. Como
0014 no está en ese stack, las lecturas de leche fallan y el panel sugiere
todo fórmula: es lo esperado, y alcanza para ver el bucle.

### Revalidación de 0014 después de los arreglos [VERIFICADO]

Postgres efímero nuevo, 0001–0012 + la del inventario + **58** chequeos en una transacción con
`ROLLBACK` (nada quedó: `to_regclass` vacío), y concurrencia en el mismo
contenedor descartable: dos tomas distintas → una entra, otra
`milk_overdraw:M1`; la MISMA toma dos veces a la vez → una toma, una porción,
sin error. Contenedor borrado.

## Segunda vuelta de revisión (sobre `e7fc8f5`)

Dos subagentes nuevos, solo lectura, sobre los arreglos.

| Origen | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| Migración | IMPORTANTE | La excepción de la guarda para el DELETE real también dejaba pasar un PATCH a mano que desataba el contenedor | **Corregido**: solo con `pg_trigger_depth() > 1` (acción de la FK) y la sesión ya inexistente. Verificado: el PATCH ahora da `milk_rpc_only`; el borrado de sesión y de familia siguen andando |
| Migración | MENOR | Izquierda y derecha bajo el tope pero la suma no → error crudo de CHECK | **Corregido**: `v_total < 100000`. Verificado |
| Migración | MENOR | Una porción con un texto en vez de número/uuid → error crudo de cast | **Corregido**: se valida la forma antes del cast. Verificado |
| Migración | MENOR | La rama de sesión vieja ignora `p_side` | **Comentado** (es lo que hace el cliente también) |
| Código | IMPORTANTE | "Registrar uno pasado" no se reiniciaba tras guardar si se había editado (posible toma duplicada) | **Corregido**: `key={pPlanKey}` remonta el constructor después de cada guardado |
| Código | IMPORTANTE | Encolar TODA toma con cualquier operación de leche en la cola (atascaba tomas detrás de un rechazo) | **Corregido revirtiéndolo**: solo se encola detrás si una porción sale de un contenedor que todavía está en la cola. El caso que motivó la regla (una anulación encolada que todavía no devolvió la leche) queda como rechazo visible `milk_overdraw`, que es honesto; se reintenta al sincronizar |
| Código | MENOR | Cambiar oz↔ml perdía la exactitud de la sugerencia | **Corregido**: un campo sin tocar sigue valiendo los ml exactos en la otra unidad |
| Código | MENOR | Contenedores con 0,01–0,15 ml se ofrecían como "0 oz" | **Corregido**: `EMPTY_ML = 0.15` (lo que la pantalla mostraría como 0), con test |
| Código | MENOR | La leche extraída en el minuto en curso no aparece en "Registrar uno pasado" hasta cambiar la hora | **Aceptado**: es correcto para una toma pasada; el formulario de Hoy no tiene ese límite |

Revalidación de 0014 en un Postgres efímero nuevo: **61** chequeos en una
transacción con `ROLLBACK` [VERIFICADO], contenedor borrado.

## Tercera vuelta (sobre `0ee8b2f`)

Un subagente nuevo, solo lectura. **0 bloqueantes, 0 importantes.** Confirmó
con la semántica de Postgres que la guarda solo deja pasar la acción de la FK
(profundidad 2 en un borrado directo, 3+ en cascada) y que un PATCH llega a
profundidad 1. Tres menores, los tres **corregidos**: una línea vieja en
`docs/milk-business-logic.md` que describía la regla revertida; la lista de
Leche mostraba un contenedor de "0 oz" (ahora filtra con `EMPTY_ML`); cambiar
la unidad a mano y recibir una sugerencia nueva volvía a oz sin avisar (ahora
cuenta como edición y aparece "La sugerencia cambió mientras editabas").

**Hallazgos bloqueantes abiertos al cierre: 0.**

## Pase de verificación local (4 oct 2026)

Autorizado por el dueño **solo para el stack local**. Detalle completo en
`docs/handoff-2026-10-04.md` §2.1.

- **0014 aplicada al stack local** con `pnpm db:up` [VERIFICADO], tras probar
  que el destino era 127.0.0.1 y que no había credenciales de la nube en el
  entorno. Primero falló: el worktree no tenía `supabase/docker/.env` y el
  script generó claves nuevas; se restauró el `.env` real del stack y el
  segundo intento quedó sano.
- **`pnpm test:all`** [VERIFICADO]: 351/351 × 4 TZ; integración 115/115,
  `tests/integration/milk.test.ts` **9/9** (antes: 8 saltados). Nada que
  corregir.
- **Recorrido en navegador a–f** [VERIFICADO], familia descartable borrada:
  extracción izq+der → M1; toma M1 + M2 + fórmula desde el panel de Hoy;
  anularla devuelve la leche; editar una extracción mueve su contenedor; sin
  conexión la toma se marca, baja lo que hay y se reenvía una sola vez;
  el cronómetro sobrevive a recargar. 13/13, chequeado también en la base.
  **Ojo con cómo se llegó a 13/13**: la primera corrida dio 11/13 por dos
  aserciones mal escritas del script (editó M1 en vez de M2 porque el primer
  "Edit" era otro; y el chequeo de lo que hay sin conexión pasaba en vacío
  porque la regex no matcheaba). Se corrigieron las aserciones —no la app— y
  la corrida siguiente midió de verdad: "What there is 0 oz" sin conexión.
- **Barrido de layout** [VERIFICADO]: 64 combinaciones (5 pantallas + 3
  estados abiertos × 390/1440 × claro/oscuro × EN/ES). Hallazgo único, en
  Leche: placeholders de izquierdo/derecho cortados y sin etiqueta visible una
  vez tipeado el número. **Corregido** en `app/pumping/page.tsx` (etiqueta
  visible por lado, unidad en el placeholder, ids únicos). Después: 0 hallazgos
  en las 64, recorrido 13/13 otra vez.
- **Encontrado, NO corregido**: el ↗ de la tarjeta Dormir de Hoy se pisa con el
  título largo en español a 390 px. Previo a esta rama.

### Revisión independiente del arreglo de Leche

Un subagente nuevo, contexto limpio, solo lectura, sobre el diff de
`app/pumping/page.tsx`. **0 bloqueantes.**

| Sev. | Hallazgo | Resolución |
|---|---|---|
| IMPORTANTE | Inferido del CSS: `.row-tight` no tiene `align-items`, así que el toggle oz/ml se estiraría al alto "etiqueta + campo" y quedaría desalineado | **Descartado con medición**: en las capturas del barrido (390 y 1440, ES y EN) la etiqueta `.label` es inline y queda AL LADO del campo, no arriba. La fila no ganó alto y el toggle pasa a su propio renglón (`row-wrap`). Las 64 combinaciones dan 0 hallazgos |
| MENOR | Los ids con prefijo son defensivos: el cronómetro y el formulario manual son excluyentes (`stopping`) y hay un solo panel de edición | Aceptado, se dejan |
| MENOR | `aria-label` pisa al `<label>` como nombre accesible ("Left, oz"): incluye la palabra visible (WCAG 2.5.3) | Aceptado |
| MENOR | El `margin-bottom` de un `<label>` inline no hace nada; ya pasaba con `pump-at` | Aceptado, no es nuevo |

**Hallazgos bloqueantes abiertos al cierre: 0.**

## Pase "cinta elegible" (5 oct 2026)

Decisión del dueño (5 oct 2026): "si yo registro tales onzas en M5 y me salté
la secuencia, lo registras; trataremos de seguir el orden." Al empezar:
rama `feat/milk-inventory-v3` limpia en `3fb9c27`, `main` =
`9824e26812b80f23d7aa94a122c722ede15046e0` [VERIFICADO, `git rev-parse main`].

### Lo que encontró la exploración (subagente de solo lectura)

- La etiqueta se calcula en un solo lugar: `newContainer` (`lib/db.ts`) con
  `nextContainerLabel` sobre los contenedores vivos que la página conoce
  (cola incluida, vía `applyPendingInventory`). Ningún campo deja tipearla.
- El servidor **ya** es la autoridad completa sobre la etiqueta:
  `milk_create_container` rechaza un formato fuera de `^M[1-9][0-9]*$`
  (`milk_bad_input`) y una cinta con contenedor vivo (`milk_label_taken:M#`),
  bajo un lock por bebé; el índice único parcial lo respalda. Una cinta de un
  contenedor anulado se acepta (S-20). **Conclusión: 0014 no cambia.**
- `update_pumping_session` nunca cambia la etiqueta de un contenedor existente
  (y la guarda impide escribirla por fuera): no se puede renumerar, que es lo
  que el dueño tampoco pide.

### Plan

1. `lib/milk.ts`: `normalizeTapeLabel` (normaliza y devuelve la etiqueta o un
   motivo tipado `empty` | `format`), `suggestContainerLabel` (sobre los vivos,
   reusa `nextContainerLabel`) y `tapeInUse`. Tests unitarios.
2. `lib/db.ts`: `logPumpingSession` acepta la etiqueta elegida; sin ella usa la
   sugerencia, como hasta hoy. La cola no cambia (la etiqueta ya viaja en
   `p_container_label`, y `applyPendingInventory` ya la usa).
3. `app/pumping/page.tsx`: campo "Cinta" dentro del bloque de cantidades que
   comparten los dos formularios (cronómetro y a mano), prellenado con la
   sugerencia; validación de formato y de cinta viva antes de guardar; con los
   dos lados vacíos se ignora; tras guardar vuelve a la sugerencia nueva.
   i18n EN + ES.
4. `tests/integration/milk.test.ts`: saltar la secuencia, choque con viva,
   reutilizar tras anular, sesión sin cantidad con etiqueta escrita.
5. Revisión independiente (código + reglas), verificación completa,
   navegador a–f, barrido de la pantalla Leche, documentos.

### Estado por paso

| Paso | Estado | Verificado con |
|---|---|---|
| Lógica pura + unit | Hecho (`ee6bdfa`) | `vitest run tests/unit/milk.test.ts` 64/64 (15 nuevas) |
| Datos + UI + i18n + integración | Hecho (`393ade4`) | `tsc` limpio; `vitest run tests/integration/milk.test.ts` 14/14 contra 127.0.0.1 |
| Arreglos de la revisión | Hecho (`d403718` + cierre) | recorrido y barrido repetidos sobre el código final |
| Navegador a–h | Hecho | 35/35 (abajo) |
| Barrido de Leche | Hecho | 40 combinaciones, 0 hallazgos |

### Revisión independiente — hallazgos y resolución

Tres subagentes con contexto limpio, solo lectura; ninguno escribió código.

**Revisor de código** (sobre `ee6bdfa..393ade4`) — "sin bloqueantes, mergeable;
arreglar el importante".

| Sev. | Hallazgo | Resolución |
|---|---|---|
| IMPORTANTE | Guardando en línea con una sugerencia vieja (otro teléfono ya usó esa cinta; la página no se relee sola), el servidor rechaza y la pantalla mostraba "Otro teléfono ya usó la cinta… Borrá esta sesión", aunque no se guardó nada; y cada reintento mandaba la misma cinta | **Corregido**: ante `milk_label_taken` al guardar directo, "M6 ya lo tiene una extracción que sigue guardada. Elegí otro número." + relectura (S-27). Verificado en el navegador, paso (h) |
| MENOR | `M999999` aceptado → la sugerencia `M1000000` la rechazaba el propio tope | **Corregido**: el tope de 6 dígitos solo para lo tipeado (S-24) |
| MENOR | Justo después de guardar en línea el campo volvía a ofrecer la cinta recién usada hasta la relectura | **Corregido**: `justSaved` la cuenta como tomada hasta la próxima lectura buena |
| MENOR | "bottle/biberón" en el mensaje: en la app biberón es una toma | **Corregido**: "container" / "extracción" |
| MENOR | La cinta tipeada sobrevivía a "Descartar cronómetro" | **Corregido**: vuelve a la sugerencia |
| MENOR | El caso de integración "sin cantidad" prueba la tolerancia del servidor, no la pantalla | **Corregido el nombre**; la pantalla lo cubre el recorrido (g). No hay tests de componentes en el repo |

**Verificador de reglas** — reglas 1–5: **todas MET**. Confirmó que no se
construyó editar la cinta de una registrada, renumerar ni tendencias, y que el
camino de sincronización ("Otro teléfono ya usó la cinta…" + Descartar) sigue.

| Sev. | Hallazgo | Resolución |
|---|---|---|
| IMPORTANTE (F1) | = el importante del revisor de código | **Corregido** |
| MENOR (F2) | = la ventana justo después de guardar | **Corregido** |
| MENOR (F3) | Un número de 7+ dígitos recibe el mismo mensaje de formato, que no explica el tope | **Aceptado**: ninguna cinta real llega ahí; el mensaje sigue siendo verdad ("por ejemplo M6") |
| MENOR (F4) | Se aceptan espacios entre la M y el número aunque la regla dice "sin espacios" | **Aceptado a propósito**: el propio pedido normaliza `m 5` (S-24) |

**Segunda vuelta** (sobre `d403718`) — los seis arreglos correctos; **0
bloqueantes, 0 importantes**.

| Sev. | Hallazgo | Resolución |
|---|---|---|
| MENOR | `justSaved` podía quedar trabado (relectura fallida y el otro teléfono anula esa extracción → esa cinta rechazada hasta recargar, contra S-20) | **Corregido**: se libera con cualquier lectura buena del servidor posterior al guardado |
| MENOR | Borrar cualquier sesión liberaba `justSaved` | **Corregido**: esa línea se quitó (lo cubre la anterior) |
| MENOR | Tras `milk_label_taken`, si la relectura fallaba la sugerencia volvía a ofrecer la misma cinta | **Corregido**: la cinta rechazada se marca como tomada enseguida |
| MENOR | La sugerencia `M1000000` editada a mano pero igual se rechaza | **Aceptado**: inalcanzable en la práctica (haría falta haber escrito M999999); el mensaje lo dice |

**Hallazgos bloqueantes abiertos al cierre: 0.**

### Resultados

- **Navegador** [VERIFICADO]: `pnpm build` + `pnpm start -p 3120` (solo
  127.0.0.1), chrome-headless-shell por CDP a 390×844, inglés, familia
  descartable borrada al final (0 familias, 0 contenedores). Pasos (a)
  sugerencia tal cual, (b) `m 05` → M5 con M1, (c) repetir M5 / M0 / vacío,
  (d) anular M5 y volver a usarlo, (h) otro teléfono toma M6 por detrás, (e)
  cronómetro con M9, (f) sin conexión con M12 (enviado una sola vez), (g) sin
  cantidad con basura en la cinta: **35/35**, cada uno contra la base. En la
  primera corrida dieron FAIL dos aserciones **del script** (una medía la
  sugerencia con el campo vaciado a mano en el paso anterior; otra contaba el
  400 esperado de (h) como error de consola): se corrigieron las aserciones —
  ahora se registra cada respuesta ≥ 400 con su URL y se exige que la única sea
  `rpc/log_pumping_session` en (h)— no la app.
- **Barrido de Leche** [VERIFICADO]: formulario a mano con el campo, error de
  cinta a la vista, edición (sin el campo), cronómetro corriendo (el campo solo
  en el formulario a mano), formulario del cronómetro con el campo × 390/1440 ×
  claro/oscuro × EN/ES = **40, 0 hallazgos** (scroll horizontal, desborde por
  elemento, placeholder cortado, targets < 44 px, consola). Repetido sobre el
  código final: 40, 0 hallazgos.
- Scripts y capturas en el scratchpad de la sesión, fuera del repo.
- **Verificación final** [VERIFICADO], stack local en 127.0.0.1: `tsc
  --noEmit` exit 0; `pnpm lint` sin advertencias; `pnpm format:check` limpio;
  `pnpm build` compila; `pnpm test:all` 366/366 × 4 TZ + integración 120/120
  (`milk.test.ts` 14/14).
