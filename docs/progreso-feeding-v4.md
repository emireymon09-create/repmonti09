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
| H3 capa de datos y cola | pendiente | |
| H4 interfaz | pendiente | |
| H5 QA | pendiente | |
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
