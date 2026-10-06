# Comparación: inventario de leche v3 frente a v4 (6 oct 2026)

Qué cambia la rama **`feat/milk-inventory-v4`** respecto de
**`feat/milk-inventory-v3-release`** (`71d4d0c`), por qué, y qué queda igual.
Fuente de las reglas: `docs/respuestas-papa-leche.md` (manda sobre v3). Detalle
de cada requisito: `docs/spec-feeding-v4.md`; del diseño: `docs/arquitectura-v4.md`;
de lo verificado: `docs/progreso-feeding-v4.md`.

Etiquetas: **[VERIFICADO]** = comprobado con un comando en esta sesión (6 oct
2026). **[NO VERIFICADO]** = con el motivo.

## 0. Puntos de partida [VERIFICADO con `git rev-parse` / `git log`]

| Ref | Hash | Qué es |
|---|---|---|
| `origin/main` | `0cbe798` | **Producción v0.12.1** (sin 0014 ni 0015). Último `git fetch` hecho en esta entrega: al empezar H0 (`progreso-feeding-v4.md`); no se volvió a traer el remoto |
| `main` local | `9824e26` | Atrás de `origin/main`; el worktree `~/proyectos/amelia_app` tiene cambios sin commitear (no se usa para publicar) |
| `feat/milk-inventory-v3` | `16cf390` | Rama original del inventario, respaldo intacto |
| `feat/milk-inventory-v3-release` | `71d4d0c` | v3 montada sobre v0.12.1. **Nunca se publicó** |
| `origin/chore/pin-node-24` (PR #1) | `5bdbbec` | 0.12.2, Node 24. Integrado acá en `436de96` |
| `origin/docs/display-priority` (PR #2) | `93b4b36` | 0.12.3, solo notas. Integrado acá en `7e94c65` |
| **`feat/milk-inventory-v4`** | `7bd8fd0` al escribir esto | v3-release + PR #1 + PR #2 + v4. Versión **0.12.3**, sin bump propio |

`git merge-base --is-ancestor origin/main feat/milk-inventory-v4` → verdadero:
publicar la rama sobre `origin/main` es un avance rápido. Tamaño:
`git diff --shortstat 71d4d0c HEAD` = 59 archivos, +16 844 / −554 (casi la
mitad son documentos y pruebas).

## 1. Qué revierte v4 de v3, y por qué

| # | v3 (lo que se reemplaza) | Pedido de papá | v4 | Por qué |
|---|---|---|---|---|
| X-1 | Campo de texto **"Cinta"** prellenado con "la M más alta + 1" (`suggestTape`, `normalizeTapeLabel`, `takenTapes`) | Regla 3: las M son **biberones físicos** M1–M6 | **Selector** M1…MN (`components/BottleSlotPicker.tsx`); las funciones y textos `milk.tape*` se borraron (prueba U-63) | Nadie escribe una cinta: se agarra un biberón de la alacena. La sugerencia "máx + 1" no tiene sentido con 6 objetos que se reusan |
| X-2 | La sugerencia nunca rellenaba huecos (M1 + M5 → M6) | Regla 5: cualquier vacío se reusa | No hay "siguiente número": se elige, **sin preselección** (D-4) | Una preselección se acepta sin mirar a las 3 a.m. |
| X-3 | **Índice de cinta** `milk_containers_label_live` (`where voided_at is null`): un contenedor vaciado seguía ocupando su número para siempre | Reglas 4–5: libre al usarse, desecharse o borrarse | Columna `released_at` + índice nuevo `milk_containers_label_occupied` (`… and released_at is null`) | Con el índice de v3, M1–M6 quedaban bloqueados en pocos días |
| X-4 | "Caducada — no cuenta", sin acción; el contenedor vencido no se liberaba nunca | Regla 8: "Caducada" + "Desechar", se anota como desperdicio | `discard_container` + tabla `milk_discards`, total "Leche desechada" y fila en Historial | Liberar el biberón y medir el desperdicio |
| X-5 | Toma con desglose: **solo la hora** (`bottle.timeOnly`); para cambiar cantidades, borrar y re-anotar | Regla 17: se edita todo | **Edición completa**: `edit_bottle_feed` + `components/BottleEditPanel.tsx` en Historial **y** en `/feeding` (D-16) | Corregir sin perder la hora ni el historial; la app reacomoda la leche sola |
| X-6 | Cambiar la hora de una toma con desglose era un UPDATE directo **sin** re-validar caducidad | (implícito en 8 + 17) | La hora pasa por la función y re-valida; la guarda de la tabla también (para la app vieja) | Mover una toma a una hora en que su leche ya había vencido no debe entrar |
| X-7 | "Se asume que se terminó todo" | Regla 13: "sobró X oz" | `feedings.leftover_ml`, campo opcional (`components/LeftoverField.tsx`), solo estadística | Saber cuánto toma de verdad |
| X-8 | Las tomas viejas no tenían desglose | Regla 16: estimar hacia atrás | `lib/milkEstimate.ts`, **no se guarda**, se muestra "(estimado)" | Estadística sin inventar leche (D-14) |
| X-9 | Un solo selector oz/ml para los dos lados | Regla 1: uno por lado | Dos `AmountUnit`, y al cambiar de unidad **se convierte** (`convertAmountText`, AJ-16) | Cada lado puede medirse distinto |
| X-10 | Ambiente y congelador se guardaban y no hacían nada, sin aviso | Regla 7 | Marcados "Todavía no se usa" + nota de que solo cuenta el refri | Decir la verdad sin perder los valores (D-12) |
| X-11 | Aviso "escribí M3 en la cinta" | Regla 3 | "Sesión registrada en M3." | Nadie escribe la cinta |
| X-12 | `reglas-de-uso-familia.md` y `milk-reglas-para-aprobar.md` describían lo de arriba | — | `reglas-de-uso-familia.md` reescrito (marca lo que cambió); `milk-v4-para-aprobar.md` nuevo; `milk-reglas-para-aprobar.md` queda como historia | — |

Cambios de **contrato con la base** que trae la reversión (relevantes para la
convivencia, `docs/compatibilidad-v4.md`):

- `log_bottle_feed` pasa de 6 a **7 argumentos** (`p_leftover_ml`) y
  `void_bottle_feed` devuelve `jsonb` (antes `void`): las dos con drop + create.
  La app v3 llama sin el argumento nuevo y sigue funcionando (suite v3 150/151,
  `compatibilidad-v4.md` §1) [VERIFICADO].
- **Tope de 10 min al futuro** (D-15, y m-2 para extracciones): una toma o
  extracción con hora más de 10 min adelante según la base se rechaza con
  `milk_future_time`. Es la única falla de la suite v3 sobre 0015, y v3 no
  traduce ese código [VERIFICADO].
- El código de "biberón ocupado" **sigue siendo `milk_label_taken:M#`** (AJ-1),
  para que la app v3 cacheada lo traduzca; cambia solo el texto en v4.
- Un total de extracción entre 0 y 0,15 ml se rechaza (`milk_bad_input`, M-1).

## 2. Qué agrega v4 (fases 1 y 2)

- **1A** — izquierdo y derecho con su propio oz/ml.
- **1B** — biberones físicos M1…MN, N en Ajustes (`babies.milk_bottle_count`,
  1–30, default 6, sin cola), ocupado/libre, números fuera de rango visibles con
  "fuera de M1–MN" (D-1, D-2).
- **1C** — "Desechar" en leche vencida (decide la hora de la base), total
  "Leche desechada" en Leche, filas en Historial (solo lectura).
- **1D** — "Sobró" en el panel del biberón, en "Registrar uno pasado" y en la
  edición.
- **2A** — edición completa de una toma, con plan visible ("Vuelve 1 oz a M3"),
  idempotente (`p_op_id` + `milk_feeding_edits`) y con detección de conflicto
  entre teléfonos (`p_expected`).
- **2B** — estimación leche/fórmula de tomas sin desglose ("leche 0 salvo
  evidencia").
- **Leche que no vuelve** (D-9): columna `lost_ml` y aviso en pantalla cuando el
  biberón de origen ya tiene otra extracción o se desechó.
- **Cola sin conexión** para todo lo nuevo (`applyPendingInventory` conoce
  `discard_container` y `edit_bottle_feed`).
- **Lectura en páginas de 1000** (`lib/readAll.ts`): el tope `max_rows` de la
  nube cortaba en silencio las lecturas que suman. **Toca también lecturas que
  no son de leche**: `feedingsSince`, `nursingSince`, `diapersSince`,
  `sleepSince`, `listGrowth`, `listAppointments` [VERIFICADO con `grep readAll(`
  en `lib/db.ts`].
- **Reversa propia** (`docs/rollback-leche-v4.sql`) y chequeo previo
  (`docs/verificar-antes-v4.sql`); 0015 se puede volver a aplicar después de la
  reversa (R-10).
- Arreglos de QA: el formulario de biberón pasado que crecía sin parar (QA-1) y
  el aviso de "leche que no volvió" que duraba 2,5 s (QA-2, `lib/flash.ts`).

## 3. Qué no cambia

- **La sugerencia de la toma** (`suggestedTotalMl`, `suggestPlan`): lo del
  último biberón (3 oz si nunca hubo), la leche más vieja utilizable primero,
  el faltante a fórmula, "Registrar tal cual" / "Registrar con cambios". La
  revisión de cobertura confirmó que son idénticas a v3 [VERIFICADO por el
  revisor, H6]. La "Receta" de papá (reglas 9–11) es fase 4.
- La fórmula sin inventario; nunca bloquea.
- Reglas de conservación (4 h / 4 días / 6 meses) y su guardado directo.
- Caducidad calculada por el servidor desde `stored_at = pumped_at` (D-3).
- No se borra una extracción servida ni se baja por debajo de lo servido.
- `/pumping` no edita en línea (se corrige en Historial).
- La forma legada de v0.12.1 sigue entrando y editándose directo.
- Lactancia, pañal, sueño, crecimiento, médico, push, calendario y
  `/api/quick/*` (regresión E-Reg 21/21 y `/api/quick/*` 7/7 en QA).
- `public/sw.js` no cambió (sigue `amelia-v6`) [VERIFICADO: no figura en el diff].
- 0001–0014 sin editar (`git diff 71d4d0c -- supabase/migrations/00{01..14}*`
  vacío, H2).

## 4. Lo que trajeron los PR integrados (no es de la leche)

- **PR #1** (`436de96`): `engines.node >=24`, `.nvmrc` = `24`, CHANGELOG 0.12.2.
- **PR #2** (`7e94c65`): notas del proyecto (`CLAUDE.md`, `PROJECT.md`,
  `README.md`, `design.md`, prioridad de pantallas y cámara), CHANGELOG 0.12.3.
- Conflicto en `package.json` y `CHANGELOG.md` al integrar el PR #2, resuelto a
  **0.12.3** con las entradas 0.12.3 → 0.12.2 → 0.12.1 (H0).

## 5. Commits — `git log --oneline feat/milk-inventory-v3-release..HEAD`

Al 6 oct 2026, 18:19 UTC (HEAD `7bd8fd0`). Los commits que el director agregue
después de esta fecha (auditoría y documentos de H6–H7) no figuran: volver a
correr el comando.

| Commit | Hora (UTC) | Qué |
|---|---|---|
| `92deb6e` | 05 oct 10:17 | PR #1: chore: pin Node.js to 24 LTS |
| `8582a6b` | 06 oct 06:17 | PR #1: merge de `origin/main` en su rama |
| `5bdbbec` | 06 oct 06:22 | PR #1: notas de Node 24 (0.12.2) |
| `93b4b36` | 06 oct 06:24 | PR #2: el teléfono primero, notas de la cámara (0.12.3) |
| `2aebe24` | 06 oct 14:52 | Respuestas de papá al repo |
| `436de96` | 06 oct 14:52 | Merge del PR #1 |
| `7e94c65` | 06 oct 14:52 | Merge del PR #2 (conflicto de versión resuelto a 0.12.3) |
| `5439173` | 06 oct 14:55 | Registro de progreso v4 |
| `e61d362` | 06 oct 15:19 | Spec, arquitectura y plan de pruebas (antes del código) |
| `9486fed` | 06 oct 15:46 | Migración 0015 + lógica pura + pruebas de integración |
| `ce819f0` | 06 oct 16:01 | Capa de datos y cola sin conexión |
| `ac3f77b` | 06 oct 16:16 | Interfaz: selector, oz/ml por lado, desechar, edición completa |
| `2abeae9` | 06 oct 17:11 | QA-1 y QA-2 |
| `00d8018` | 06 oct 17:31 | Compatibilidad y reversa documentadas |
| `76b015a` | 06 oct 17:51 | R-10 (volver a v4 tras la reversa) y lectura en páginas de 1000 |
| `7bd8fd0` | 06 oct 18:19 | B-1, M-1, m-2 de la auditoría |
