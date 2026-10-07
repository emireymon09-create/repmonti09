# Comparación: producción v0.12.1 frente al inventario de leche (6 oct 2026)

Etiquetas: **[VERIFICADO]** = comprobado con un comando cuya salida quedó en la
sesión del 6 oct 2026. **[NO VERIFICADO]** = leído, no ejercitado; se dice por qué.

## 0. Puntos de partida

| Ref | Hash | Cómo se identificó |
|---|---|---|
| Base común | `9824e26` | `main` local, y `origin/main` antes del `git fetch` |
| **Producción v0.12.1** | **`0cbe798`** | `git fetch origin --tags` (no hay tags en el repo); `origin/main` = `0cbe798`; `package.json` dice `0.12.1`; primera entrada de `CHANGELOG.md` `## [0.12.1] - 2026-10-05`; es el único commit que introduce `"version": "0.12.1"` (`git log -S`). Su padre `980063c` es 0.12.0 |
| Nuestra rama (respaldo, intacta) | `16cf390` (`feat/milk-inventory-v3`) | **13** commits sobre `9824e26`, no 12 como decía el pedido (`git log 9824e26..16cf390 --oneline`) |
| Rama de integración | `feat/milk-inventory-v3-release` | creada con `git worktree add ../amelia_app-release -b feat/milk-inventory-v3-release 0cbe798` |

`origin/main` se movió de `9824e26` a `0cbe798` **por el `git fetch`** (solo lectura
del remoto, permitido). Nada de esta sesión escribió en `main` ni en el remoto.

## 1. Qué cambió el papá (9824e26 → 0cbe798, 4 commits, 27 archivos, +1335/−201)

| Commit | Versión | Qué |
|---|---|---|
| `4a3c082` | 0.11.0 | Historial: menú ⋯ (`RowMenu`) para editar y borrar cualquier entrada, **extracciones incluidas**. `/pumping` pasa a ser un registro simple: sin Editar/Borrar en línea, una tarjeta "Sessions" con enlace a Historial |
| `e8ea50e` | — | `proposals/changer-display.md`: plan de la pantalla táctil del cambiador |
| `980063c` | 0.12.0 | Migración `0013_changer_display_scopes.sql`, `POST /api/quick/diaper` (scope `quick_diaper`), `GET /api/quick/status` (scope `read_status`), `lib/device/server.ts`, tests de integración |
| `0cbe798` | 0.12.1 | Firmware OTA de la pantalla (`public/firmware/*`) + versión |

Por área:

- **Migraciones:** `0013_changer_display_scopes.sql` — solo reescribe el CHECK
  `device_tokens_scopes_check` (agrega `quick_diaper`, `read_status`). No toca
  `pumping_sessions`, `feedings`, `babies` ni `nursing_sessions`. `supabase/schema.sql` refleja lo mismo.
- **`lib/db.ts`:** solo `buildActivity` (6.º parámetro `pumping`, entradas
  `kind: 'pumping'`). `updatePumping`/`voidPumping` ya existían; ahora los llama Historial.
- **`lib/queue.ts`:** sin cambios. **`lib/types.ts`:** `ActivityEntry.kind` + `'pumping'`.
- **`lib/deviceTokens.ts`:** `DEVICE_SCOPES` + `quick_diaper`, `read_status`.
- **i18n (EN+ES):** `activity.pumped`, `activity.pumpSide.{left,right,both}`,
  `milk.editInHistory`, `milk.sessions`, `history.kind.pumping`, `history.rowOptions`.
- **Páginas/componentes:** `app/history/page.tsx`, `app/pumping/page.tsx`,
  `components/ui.tsx` (`RowMenu`, ícono `more`), `components/SectionPage.tsx` (+2), `app/globals.css` (+93: `.row-menu`, `.kebab`…).
- **Sin cambios:** `/dashboard`, `/settings`, `/feeding`, `Nav`, `middleware.ts`,
  `lib/offlinePages.ts`, `public/sw.js` (sigue `amelia-v6`).
- **Tests:** `quick-diaper.test.ts`, `quick-status.test.ts` (nuevos);
  `activity.test.ts`, `deviceTokens.test.ts`, `i18n.test.ts`.
- **Dependencias:** ninguna (`pnpm-lock.yaml` intacto). `package.json`: solo `version` 0.10.7 → 0.12.1.
- **Docs:** `proposals/changer-display.md`, `CLAUDE.md` (+5), `CHANGELOG.md`. **No hay handoff nuevo del papá.**
  Ningún documento dice si `0013_changer_display_scopes` está aplicada en la nube → el runbook lo verifica por objeto.

## 2. Qué es nuestro (9824e26 → 16cf390, 13 commits, 30 archivos, +6880/−475)

Migración del inventario (hoy **`0014_milk_inventory.sql`**), `lib/milk.ts`
(lógica pura), `components/BottleBuilder.tsx`, `lib/db.ts` (+528: RPCs, lecturas
de contenedores/porciones, reglas de conservación), `lib/queue.ts` (operación
`rpc`, dependencias transitivas), `lib/types.ts`, i18n, `/pumping` reescrita,
`/dashboard` (panel del biberón), `/settings` ("Conservación de la leche"),
`/history`, `SectionPage`, tests unit e integración de leche, y los documentos
`spec-feeding-v3`, `progreso-feeding-v3`, `handoff-2026-10-04`,
`milk-business-logic`, `reglas-de-uso-familia`, `milk-reglas-para-aprobar`.

## 3. Solapes y cómo se resolvió cada uno

**Archivos tocados por los dos lados (10):** `app/globals.css`, `app/history/page.tsx`,
`app/pumping/page.tsx`, `components/SectionPage.tsx`, `components/ui.tsx`,
`lib/db.ts`, `lib/i18n/en.ts`, `lib/i18n/es.ts`, `lib/types.ts`, `tests/unit/i18n.test.ts`.

**Archivos solo del papá (17), [VERIFICADO] intactos en la rama de release:**
`git diff --stat 0cbe798 HEAD -- app/api/quick lib/device lib/deviceTokens.ts CHANGELOG.md package.json CLAUDE.md proposals public supabase/migrations/0013_changer_display_scopes.sql supabase/schema.sql tests/integration/quick-diaper.test.ts tests/integration/quick-status.test.ts tests/unit/activity.test.ts tests/unit/deviceTokens.test.ts middleware.ts lib/offlinePages.ts` → vacío.

### 3.1 Conflictos textuales (los marcó Git)

| # | Commit nuestro | Archivo | Qué chocaba | Resolución |
|---|---|---|---|---|
| T1 | `ab5f794` | `lib/i18n/en.ts`, `es.ts` | Los dos agregaron claves `milk.*` en el mismo lugar | Se conservan los dos bloques (los del papá primero). Sin claves duplicadas: `tsc` las rechazaría y pasa |
| T2 | `ab5f794` | `app/pumping/page.tsx` | El papá recortó `/pumping` a registro simple; nosotros la reescribimos entera (izq/der, contenedores, cronómetro) | Se tomó nuestra página (la versión simple no puede expresar izq/der ni contenedores) y **después** se le aplicó el diseño del papá a la lista — ver S2 |
| T3 | `15b89b6` | `app/history/page.tsx` | Tipo `ServerRows`, `NO_ROWS`, lectura `Promise.all`, `keepLastGood` | Llevan las dos cosas: `pumping` (papá) **y** `containers` + `drawdowns` (nuestro). Cadena de borrado: biberón con inventario → `voidBottleFeed`; luego toma, pañal, lactancia, sueño y extracción |
| T4 | `0ee8b2f` | `app/history/page.tsx` (`deleteEntry`) | Confirmación propia del papá para extracciones y la nuestra para biberones | Un ternario: biberón con inventario → `bottle.removeConfirm`; extracción → `milk.removeConfirm`; resto → `history.removeConfirm` |

Se mezclaron solos: `lib/db.ts` (`buildActivity` del papá + lo nuestro), `lib/types.ts`,
`components/ui.tsx` (`RowMenu`), `app/globals.css`, `SectionPage.tsx`, `tests/unit/i18n.test.ts`, `docs/README.md`.

### 3.2 Choques semánticos (Git no los marca)

| # | Choque | Resolución |
|---|---|---|
| S1 | El menú ⋯ de Historial del papá editaba/anulaba extracciones con `updatePumping`/`voidPumping` (UPDATE directo). Nuestra rama los había quitado (TS2305) y la guarda `milk_guard_pumping` los habría rechazado con `milk_rpc_only` | Commit de integración: Historial edita con `updatePumpingSession` y anula con `voidPumpingSession` (RPC), izquierda y derecha por separado como en `/pumping`, conserva los ml exactos de un campo no tocado y el total de una sesión legada, y rechaza (también offline) bajar de lo ya servido o anular una ya servida. `isLegacyPumping`, `servedMl`, `SERVED_EPSILON_ML` pasaron a `lib/milk.ts` |
| S2 | Dos lugares para editar extracciones: nuestra `/pumping` con Editar/Borrar en línea y el menú ⋯ de Historial del papá, cuya decisión de producto (0.11.0) es "editar y borrar desde Historial" | Se respeta la decisión del papá, que ya está en producción: `/pumping` muestra la lista con la tarjeta "Sessions" y el enlace "editar en Historial" (`milk.sessions`, `milk.editInHistory`); la edición y anulación con las reglas de leche viven en Historial. Ninguna capacidad nuestra se pierde: la misma edición y las mismas reglas están en el menú ⋯ |
| S3 | Número de migración: `0013` en los dos lados | La nuestra pasa a **`0014_milk_inventory.sql`** (no está en la nube). Referencias actualizadas en código (comentarios), tests y docs. Las `0013` del papá quedan como están |
| S4 | `0013_changer` y `0014` sobre los mismos objetos | No: `0013` solo toca `device_tokens`; `0014` no toca `device_tokens` |
| S5 | Pantalla del cambiador (`/api/quick/status`, `/api/quick/diaper`) | Lee la última toma (`feedings`, columnas explícitas) e inserta pañales: los triggers de leche no la alcanzan. Su suite (8 + 4) pasa sobre la base migrada |
| S6 | Compatibilidad durante el despliegue: la guarda de `0014` rechazaba **toda** extracción escrita fuera de las RPC, incluida la que manda la app v0.12.1 | Ver `docs/compatibilidad-leche.md`. Se corrigió en `0014`: se aceptan filas de **forma legada** (sin izq/der, sin contenedor vivo) |
| S7 | `public/sw.js`, `middleware.ts`, `lib/offlinePages.ts` | Ninguno de los dos lados los cambió. Ver el runbook (refresco de la PWA) |

## 4. Lo que existe en uno y no en el otro

- **Solo en producción (se conserva tal cual):** pantalla del cambiador (rutas,
  scopes, firmware), menú ⋯ de Historial, entradas de extracción en Historial.
- **Solo en lo nuestro (se agrega):** inventario (contenedores M#, porciones,
  caducidad, reglas en Ajustes), extracción izq/der, panel del biberón en Hoy,
  operaciones `rpc` en la cola offline.

## 5. La rama de release, commit por commit

`git log --oneline 0cbe798..HEAD` (de más viejo a más nuevo):

| Commit | Origen | Qué |
|---|---|---|
| `211d41e` … `49bad8f` | cherry-pick `-x` de `7d8fd7c` … `16cf390` (los 13 de `feat/milk-inventory-v3`, en orden, con autoría y mensaje) | El inventario tal como estaba en la rama de respaldo, con los conflictos T1–T4 resueltos |
| `9065137` | integración | S1: Historial edita y borra extracciones por las RPC de leche |
| `0b0b504` | integración | S3: `0013_milk_inventory.sql` → `0014_milk_inventory.sql` y referencias |
| `319688a` | compatibilidad | S6: la guarda acepta extracciones de forma legada (app v0.12.1 durante el despliegue) + 11 pruebas de integración |
| `db0bc8c` | integración | S2: `/pumping` vuelve al diseño del papá (lista "Sessions" + "editar en Historial") |
| `bfcda1e` | QA en navegador | Cinta sugerida sin conexión, relectura tras sobregiro, confirmación de borrado de una extracción legada (11 pruebas unitarias) |
| `0d159bb` | QA en navegador | Porción fantasma "+ M3 0 oz" por residuo de coma flotante (1 prueba unitaria) |
| `28b7202` | documentos | Comparación, compatibilidad, runbook, `verificar-antes-leche.sql`, `rollback-leche.sql` |
| `57518c9` | auditoría de cobertura | 8 pruebas de integración de ramas de 0014 sin cubrir (ningún defecto) |
| `8d0918a` | auditoría de seguridad y datos | Correcciones del runbook y del SQL de verificación; handoff del 6 oct; encabezado de 0014 (solo comentario) |

Verificado al final [VERIFICADO]: `git diff --stat 0cbe798 HEAD -- supabase/migrations/` muestra
solo `0014_milk_inventory.sql` (ninguna migración de v0.12.1 editada) y
`package.json`, `CHANGELOG.md` y `pnpm-lock.yaml` sin cambios.
