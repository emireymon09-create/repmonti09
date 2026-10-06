# Progreso — inventario de leche v4 (fases 1 y 2 de `respuestas-papa-leche.md`)

Documento vivo: sobrevive a compactaciones de contexto. Etiquetas
**[VERIFICADO]** (comando ejecutado en esta sesión, contra 127.0.0.1) y
**[NO VERIFICADO]** (con motivo).

## Estado inicial (6 oct 2026) [VERIFICADO]

| Ref | Hash |
|---|---|
| `main` | `9824e26812b80f23d7aa94a122c722ede15046e0` |
| `origin/main` | `0cbe798e4befdbe267a36c5182ff55ad138c18a1` (no avanzó tras `git fetch`) |
| `feat/milk-inventory-v3` | `16cf3904436d2732e98b15c2e290bb3cbf040834` |
| `feat/milk-inventory-v3-release` | `71d4d0cb13d1b32f93319c759489866e504f8ab6` |
| `origin/chore/pin-node-24` (PR #1) | `5bdbbece41c4a0efd840cdc0727931a1f78e64ce` |
| `origin/docs/display-priority` (PR #2) | `93b4b36c244dec4d617b32eb2ca4236738803b46` |

Ninguna rama remota tiene una migración 0015: se usa `0015_milk_phase1_2.sql`.

## Hitos

| Hito | Estado | Commit |
|---|---|---|
| H0 integración de PR + línea base | hecho | `2aebe24` (respuestas del papá), `436de96` (merge PR #1), `7e94c65` (merge PR #2) |
| H1 spec + arquitectura + plan de pruebas | hecho | ver `git log` |
| H2 migración 0015 + lógica pura | hecho | ver `git log` |
| H3 capa de datos y cola | hecho | ver `git log` |
| H4 interfaz | hecho | ver `git log` |
| H5 QA | hecho (navegador); compatibilidad y reversa en H5b/H7 | ver `git log` |
| H6 auditorías | pendiente | |
| H7 documentos y runbook | pendiente | |

## H0 [VERIFICADO]

- Worktree `../amelia_app-v4`, rama `feat/milk-inventory-v4` desde `71d4d0c`.
- Merge de PR #1 sin conflicto (0.12.2, `engines.node >=24`, `.nvmrc` = 24).
- Merge de PR #2 con conflicto en `package.json` y `CHANGELOG.md`: resuelto a
  versión **0.12.3**; CHANGELOG con 0.12.3 → 0.12.2 → 0.12.1 conservadas. Sin
  bump propio.
- Entorno local: `.env.local`/`.env.test` copiados del worktree de release
  (apuntan a `http://127.0.0.1:54321` y `127.0.0.1:54322`; 0 apariciones de
  `supabase.co`); `supabase/docker/.env` copiado e idéntico (`cmp`) al de
  `../amelia_app`. Contenedores `amelia-local-*` en 127.0.0.1.
- `pnpm db:reset` aplicó 0001–0014 desde cero.
- Línea base con Node v24.16.0: `tsc` OK, `lint` sin avisos, `format:check`
  limpio, `build` OK, unitarias **379/379** en UTC, LA, Tokio y Kiritimati,
  integración **151/151**.

## H1

- `docs/spec-feeding-v4.md` (analista): trazabilidad R-1…R-22, 25 decisiones
  D-x a confirmar, 12 reversiones de v3, 40 casos límite, enganches fases 3–4.
- `docs/arquitectura-v4.md` (arquitecto): estados del biberón por columnas
  (`released_at`, `lost_ml`, tabla `milk_discards`), índice de ocupación nuevo,
  invariante contable INV-1…INV-9 (consulta SQL §2.4), RPC nuevas
  `discard_container` y `edit_bottle_feed` (idempotente por `p_op_id` +
  `milk_feeding_edits`), N en `babies.milk_bottle_count` (1–30, default 6),
  19 ajustes a la spec (§12). AJ-1: el código de biberón ocupado sigue siendo
  `milk_label_taken` (la app v3 cacheada ya lo traduce) — aceptado.
- `docs/plan-pruebas-v4.md`: 258 casos (65 U, 106 I, 25 C, 50 E, 12 R) escritos
  antes de implementar.

## Control de recursos (§4.1)

Máquina: 4 núcleos, 7740 MB RAM, swap 4095 MB, 114 GB libres. Topes: memoria
disponible ≥ 1.55 GB, load1 ≤ 6, disco ≥ 3 GB, swap sin crecer. Máx. 2
subagentes a la vez (1 si hay build/integración/navegador); vitest
`--maxWorkers=2`; tareas pesadas en serie.

| Momento | RECURSOS |
|---|---|
| H2 en curso (15:41) | disp. 3968 MB · swap 1432 MB · load1 2.99 · disco 114 GB |

## H2 [VERIFICADO por el director]

- Lógica pura [VERIFICADO por el ingeniero, se re-verifica al cerrar H2]:
  `lib/milkBottles.ts`, `lib/milkEstimate.ts`, ampliación de `lib/milk.ts` y
  `lib/types.ts`; `pnpm test:tz` 518/518 en las 4 zonas (379 previas + 139).
- Migración `0015_milk_phase1_2.sql` + 7 archivos `tests/integration/milkV4*.test.ts`
  + `tests/helpers/milk{Invariant,V4}.ts`. Prueba previa ajustada:
  `milk.test.ts` M7 (la toma 96 h en el futuro ahora da `milk_future_time`
  por D-15; la extracción pasa a vencer en 5 min para seguir probando
  caducidad).
- Verificación del director (15:50): `tsc` OK, `lint` sin avisos,
  `format:check` limpio, unitarias **518/518** en UTC/LA/Tokio/Kiritimati,
  integración **282/282** (151 previas + 131), 0 omitidas;
  `git diff feat/milk-inventory-v3-release -- 0001…0014` vacío.
- Desviaciones aceptadas: `M1234567` válido (D-1: solo formato); `'abc'` en
  una cantidad → error 22P02 de PostgREST, sin escritura; `milk_feeding_edits`
  solo select/insert (registro inmutable); `supabase/schema.sql` no se toca
  (el repo lo dejó en 0013).

## H3 [VERIFICADO por el director]

- `lib/db.ts`: lecturas sin limit (`listContainers` con `released_at`/`lost_ml`,
  `listDiscards`, `legacySplitInputs`), N en `milkRules`/`saveMilkBottleCount`
  (sin cola), escrituras por la cola `rpc`: `logPumpingSession` (biberón
  obligatorio, `milk_bottle_needed`), `updatePumpingSession`, `discardContainer`,
  `logBottleFeed` con `p_leftover_ml`, `editBottleFeed` (`p_op_id` nuevo por
  intento, `p_expected`, `queueOnly` si algo sigue en cola), `voidBottleFeed`
  que devuelve la leche que no volvió (D-9). `milkErrorText` traduce los 7
  códigos nuevos (EN+ES).
- Verificación (16:20): `tsc` OK, `lint` OK, `format:check` OK, unitarias
  **537/537** ×4 TZ, integración **293/293**.
- **Riesgo anotado [NO VERIFICADO]:** Supabase en la nube limita por defecto
  cada lectura a 1000 filas (`max_rows`); en local no hay tope. Las lecturas
  "sin limit" (contenedores, desechos, tomas para la estimación) podrían
  cortarse en producción. Va al runbook como chequeo.

## H4 [VERIFICADO por el director]

- Componentes nuevos `BottleSlotPicker`, `LeftoverField`, `BottleEditPanel`;
  cambios en `/pumping`, `/history`, `/dashboard`, `/settings`, `SectionPage`,
  `BottleBuilder`, `AmountUnit`, `globals.css` (solo tokens), i18n (+48 / −11
  claves).
- Verificación (16:55): `tsc` OK, `lint` OK, `format:check` OK, `build` OK,
  unitarias **537/537** ×4 TZ, integración **293/293**.
- Alcance: `grep` de Similac/enfriado/combinar/receta en lo agregado a
  `app/ components/ lib/` contra v3-release: 0 líneas.
- Pendiente para QA: recorrido en navegador, barrido 390/1440, selector con
  N=30 en español a 390 px, duración del banner de "leche que no volvió".

## H5 — QA en navegador [VERIFICADO]

Build de producción en 127.0.0.1:3151, chrome-headless-shell por CDP 390×844,
familias descartables `qa-v4-*` (43, borradas: conteo 0 en todas las tablas),
reloj del teléfono sobrescrito y marcas de tiempo de la base corridas para
vencer leche. Cada aserción con contraste SQL e invariante INV en 0 filas tras
cada escenario. Scripts fuera del repo:
`/tmp/claude-1001/-home-claude-proyectos-amelia-app/95ebf723-c290-4b71-8fd4-cd01c554691d/scratchpad/qa/`
(`lib.mjs`, `e_*.mjs`, `cleanup.mjs`, `results.json`; reanudables).

| Escenario | Aserciones |
|---|---|
| E-Ana (ES) | 55/55 |
| E-Vence (EN; desechar, Ajustes e Historial también ES) | 43/43 |
| E-Luis (ES) | 28/28 |
| E-Corregir (EN) | 38/38 |
| Recorridos cortos en el otro idioma | 14/14 |
| Sin red y dos celulares (A en ES, B en EN) | 53/53 |
| Regresión Hoy/Historial (6 tipos)/Crecimiento/Médico/Ajustes | 21/21 |
| `/api/quick/*` (cambiador) con token de prueba | 7/7 |
| Barrido de layout 80 combinaciones + N=30 ES 390 px | 3/3 |
| Intentar romperlo | 15/15 |
| E-50 2000 contenedores | 6/6 |
| **Total** | **283/283, 0 FAIL** |

Defectos de v4, corregidos con prueba que falla primero:
- **QA-1 (grave):** `/feeding` → Registrar uno pasado → Biberón: `BottleBuilder`
  y `LeftoverField` con la misma `key` → el DOM crecía sin parar. Corrección:
  key distinta. Prueba `tests/unit/jsxKeys.test.ts`: el director la corrió con
  el `SectionPage.tsx` sin corregir → `1 failed` (`SectionPage.tsx:949
  key={pPlanKey} ×2`); con la corrección → pasa.
- **QA-2 (menor):** el aviso de leche que no volvió (D-9) duraba 2,5 s.
  `lib/flash.ts` (`flashMs`) lo alarga según el largo del texto (7,9 s medido).
  Prueba `tests/unit/flash.test.ts`.

Defecto que ya estaba en v0.12.1 (no se tocó): la hora por defecto de
`/pumping` es la de abrir la página o del último guardado, no la de enviar
(`0cbe798:app/pumping/page.tsx:38,92`). En v4 eso adelanta la caducidad (lado
seguro) y puede alterar el orden "más vieja primero".

Verificación del director tras QA: `tsc`/`lint`/`format:check`/`build` OK,
unitarias **542/542** ×4 TZ, integración **293/293**.

NO VERIFICADO: iPhone/WebKit, PWA instalada, red real; tope `max_rows` de la
nube.

## H5b — compatibilidad y reversa (ingeniero de release)

- **C-01** suite de integración de v0.12.1 pura (worktree desacoplado en
  `0cbe798`) sobre la base 0001–0015: **118/118**.
- **C-02** suite de v3-release (`71d4d0c`) sobre 0001–0015: **150/151**. La
  falla es deliberada (D-15, tope de 10 min al futuro): la prueba de v3 manda una
  toma 4 días en el futuro y espera `milk_container_unusable`; recibe
  `milk_future_time`. Con solo el código esperado cambiado pasa. La app v3
  cacheada mostraría ese código crudo (no lo traduce) — solo si un teléfono
  manda una toma >10 min en el futuro.
- Mezclas viejo/nuevo: 23 escrituras de la app vieja/v3 sobre lo creado por v4
  rechazadas con la base idéntica (md5 antes/después); invariante en 0 filas.
- Reversa en Postgres efímero (`--network none`): `pg_dump --schema-only`
  0001–0014 vs 0001–0015+datos+reversa → **diff 0 líneas**; idempotente;
  cadena con `rollback-leche.sql` → diff 0 contra 0001–0013; suites v3 151/151 y
  v0.12.1 118/118 sobre la base revertida.
- **Defecto R-10 (corregido, ver abajo):** reaplicar 0015 después de la reversa, con datos
  reales de v4 (número reusado tras servir, o desechado tras servir), aborta con
  `milk_invariant_broken` (falla cerrado, no aplica nada). Se corrige en la
  migración antes del cierre.

### Correcciones R-10 y tope de 1000 filas [VERIFICADO]

- **R-10:** 0015 gana la sección "VOLVER A v4 TRAS LA REVERSA": un contenedor
  anulado con porciones vivas (forma que solo produce la reversa) vuelve como
  liberado, y el sobrante de la cuenta va a `lost_ml`, nunca a "Lo que hay".
  `rollback-leche-v4.sql` solo cambió comentarios (0 líneas de SQL). Prueba
  `tests/integration/milkV4Reapply.test.ts`: el director la corrió con la 0015
  anterior → **2 failed** (`milk_invariant_broken`); con la corrección → **2
  passed**. El mismo test re-verifica en cada ciclo el diff de esquema contra
  0001–0014 y la cadena a 0001–0013.
- **Tope `max_rows` (1000):** `lib/readAll.ts` lee en páginas de 1000 con orden
  estable; lo usan las lecturas que suman (`*Since`, contenedores, porciones,
  desechos, estimación, crecimiento, turnos). Pruebas `tests/unit/readAll.test.ts`
  (4/4 fallaban antes con un cliente que corta en 1000) y
  `tests/integration/readAll.test.ts` (>1000 filas reales, página de 7).
- Verificación del director: `tsc`/`lint`/`format:check` OK, unitarias
  **550/550** ×4 TZ, integración **298/298**.

## H6 — auditorías (primera vuelta)

- **Revisor de cobertura (solo lectura):** sin bloqueantes. Las 22 reglas del
  papá trazadas; fase 1–2 todas CUBIERTAS (R7 parcial por D-3, a confirmar).
  MAYOR: plan sin Resultado en U/I; ramas de bajada de `milk_rebalance` sin
  prueba de integración. 12 menores. Alcance: nada de fases 3–4;
  `suggestPlan`/`suggestedTotalMl` idénticos a v3.
- **Auditor de seguridad y datos (solo lectura):** RLS/grants/security
  invoker/search_path/actor/locks/idempotencia OK con evidencia. **B-1
  bloqueante (solo camino de reversa):** tras `rollback-leche-v4.sql` la app v3
  podía resucitar leche desechada/servida al editar la extracción. M-1: un
  total < 0,15 ml creaba un biberón ocupado vacío. m-1: editar solo la nota de
  una toma anterior a la extracción se rechazaba. m-2: `pumped_at` sin tope
  futuro en el servidor. m-3, O-1, O-2 declarados.
- Corrector lanzado para B-1, M-1, m-1, m-2 y los MAYOR de cobertura.

### Correcciones de la primera vuelta de auditoría [VERIFICADO]

Cada una con prueba que fallaba antes (salida en el informe del corrector):
- **B-1:** la reversa ahora pasa a forma legada (lados en null, total intacto)
  las extracciones cuyo contenedor anula, así la app v3 solo les cambia hora y
  nota y no crea un contenedor con leche que ya no existe. Prueba
  `milkV4Reapply › B-1` (antes `expected '5' to be '3'`). Se pierde el reparto
  izq/der de esas extracciones (respaldo opcional en `milk_backup_v4`).
- **M-1:** un total entre 0 y 0,15 ml se rechaza (`milk_bad_input`) en servidor
  y en la pantalla (`milk.amountTooSmall`). I-14b, I-31b, U-46b.
- **m-1:** cambiar solo nota/sobró de una toma no re-valida caducidad. I-79b.
- **m-2:** `pumped_at` con tope de 10 min al futuro (`milk_future_time`).
  I-14c, I-31c. I-50 pasó a usar el cambio de horario del 8 mar 2026.
- Cobertura: I-23b/I-24b (bajadas de `milk_rebalance`), I-15b (llamada directa
  → `milk_rpc_only`), U-63 (claves de cinta borradas), U-09b (biberón liberado
  por un desecho en cola lleva "sin sincronizar"). Plan: 181 filas U/I con
  PASS desde el JSON de vitest.
- Verificación del director: `tsc`/`lint`/`format:check` OK, unitarias
  **554/554** ×4 TZ, integración **307/307**.
