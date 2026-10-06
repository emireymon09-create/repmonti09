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
