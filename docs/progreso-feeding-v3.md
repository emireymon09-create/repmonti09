# Progreso — inventario de leche y tomas v3

Memoria entre turnos. Spec: `docs/spec-feeding-v3.md`. Etiquetas:
**[VERIFICADO]** = con el comando citado; **[NO VERIFICADO]** = no se pudo
correr o comprobar.

## Estado por hito

| Hito | Estado | Verificado con |
|---|---|---|
| 0 · Lectura, exploración, plan, spec | Hecho (4 oct 2026) | — |
| 1 · Migración 0013 + `lib/milk.ts` + tests | Hecho | `vitest run tests/unit/milk.test.ts` 45/45; `tsc --noEmit` limpio; SQL en Postgres efímero (ver abajo) |
| 2 · Datos y cola + tests (+ página Leche) | Hecho | `pnpm test` 350/350; `tsc --noEmit` limpio; `pnpm test:integration` 107 pasan + 8 saltados (suite de leche: la base local no tiene 0013) |
| 3 · Interfaz + i18n | Pendiente | — |
| 4 · Documentación y documento familiar | Pendiente | — |
| Revisión independiente (3 agentes) | Pendiente | — |

## Notas

- `tests/unit/milk.test.ts`: 45/45 en verde con `pnpm exec vitest run
  tests/unit/milk.test.ts` antes de la migración [VERIFICADO].

- **0013 validada sin aplicarla en ningún entorno** [VERIFICADO]: contenedor
  efímero `public.ecr.aws/supabase/postgres:17.6.1.167` **sin puertos
  publicados**, con 0001–0013 + 41 chequeos de comportamiento dentro de una
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
  está escrita y se salta sola contra una base sin 0013 (sonda sobre
  `milk_containers`). Las otras seis suites corren y pasan contra el stack
  local sin 0013 [VERIFICADO, `pnpm test:integration`].
