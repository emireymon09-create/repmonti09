# Compatibilidad y reversa: inventario de leche v5 (0016) con las apps 0.13.0 y v0.12.1 (7 oct 2026)

Durante el despliegue de v5 corren a la vez, contra la misma base, hasta **tres**
apps: la **0.13.0** (`66462fa`, producción hoy, con 0014 y 0015 en la nube), la
**v0.12.1** (`0cbe798`, si algún aparato quedó muy atrás) y la **v5**
(`feat/milk-inventory-v5`). Este documento dice qué pasa en cada mezcla con la
base en 0016, cómo se vuelve atrás y qué se pierde, con evidencia. Sigue el
método de `docs/compatibilidad-v4.md`.

Etiquetas: **[VERIFICADO]** = prueba ejecutada el 7 oct 2026 en este VPS contra
el stack local (127.0.0.1) o un Postgres efímero sin red, con la salida pegada.
**[NO VERIFICADO]** = con motivo.

## 0. Montaje

- Stack local `amelia-local`, puertos solo en `127.0.0.1:54321/54322`;
  `.env.local` y `.env.test` del worktree v5 apuntan a `127.0.0.1`
  (`grep -c supabase.co` = 0 y 0). Base migrada 0001–0016
  (`supabase_migrations.schema_migrations`: última `0016_milk_phase3_4`).
- Worktrees de comprobación desacoplados, **borrados al terminar**:
  `../amelia_app-c1` en `0cbe798` y `../amelia_app-c2` en `66462fa`, con
  `.env.local` y `.env.test` copiados del worktree v5 (sin imprimirlos) y
  `pnpm install --frozen-lockfile` (exit 0 en los dos).
- Postgres efímero: imagen `public.ecr.aws/supabase/postgres:17.6.1.167`,
  `--network none`, `--pull never`, borrado al terminar. Reproducible en
  `tests/integration/milkV5Rollback.test.ts` (nuevo, C-4 y C-5).

## 1. Suites de las apps viejas sobre la base con 0016 [VERIFICADO]

Comando en cada worktree: `pnpm exec vitest run tests/integration --maxWorkers=2`.

| Qué | Base | Resultado |
|---|---|---|
| **C-1** · suite de integración de **v0.12.1** (`0cbe798`) | local 0001–0016 | **118/118** (8 archivos) |
| **C-2** · suite de integración de **0.13.0** (`66462fa`) | local 0001–0016 | **309/310** (19 archivos; 1 falla, abajo) |
| C-2 · `milkV4Schema` "INV-1 por SQL" con **una combinación viva** sembrada en la base | local 0001–0016 | **falla** (`expected '2' to be '0'`) — QA-4, abajo |
| ídem, con la combinación borrada | local 0001–0016 | 1/1 |
| C-1 sobre la base **revertida** con `rollback-leche-v5.sql` | local 0001–0015 | **118/118** |
| C-2 sobre la base **revertida** | local 0001–0015 | **310/310** |

```
# C-1 (0cbe798)
 Test Files  8 passed (8)
      Tests  118 passed (118)

# C-2 (66462fa)
 FAIL  tests/integration/milkV4Schema.test.ts > v4 · esquema por SQL (I-101…I-103, I-106) > I-101 19 tablas en public, las 19 con RLS; grants de las dos nuevas sin anon ni DELETE
AssertionError: expected '22|22' to be '19|19' // Object.is equality
 Test Files  1 failed | 18 passed (19)
      Tests  1 failed | 309 passed (310)
```

**La falla de C-2 no es una regresión.** `milkV4Schema` I-101 cuenta las tablas
de `public` y espera 19 (las de 0015); 0016 agrega tres (`milk_ops`,
`milk_transfers`, `formula_containers`), **las tres con RLS**: 22/22. Es un test
que afirma el esquema viejo; la misma prueba de la rama v5 ya dice 22 (cambio
hecho a propósito en H2, `progreso-feeding-v5.md`).

**QA-4 — en qué condición falla además "INV-1 por SQL".** El test de 0.13.0
corre la cuenta de 0015 (`amount = servido + desechado + lost + remaining`) sobre
**toda la base**. Esa cuenta no conoce las transferencias: con una combinación
viva, el destino tiene más que su extracción y el origen quedó vacío sin
porciones que lo expliquen, y los dos cuentan como falla. Pasa en la corrida
completa porque las suites limpian lo suyo y la base local queda sin
combinaciones. Comprobado sembrando una (M2 de 50 → M1 de 60, por
`milk_combine` como un padre, en el stack local), corriendo el test y borrando la
siembra (0 restos):

```
M1 60 110 false
M2 50 0 true
   × … INV-1 por SQL (la cuenta de ARQ §2.4) y la invariante completa: 0 fallas en toda la base
     → expected '2' to be '0' // Object.is equality
      Tests  1 failed | 15 skipped (16)
# después de borrar la familia sembrada (contenedores|transferencias|ops|extracciones|familia|usuario):
0|0|0|0|0|0
      Tests  1 passed | 15 skipped (16)
```

O sea: **falla en una base con combinaciones vivas** (como será la de
producción en cuanto alguien combine), y es una consulta de test vieja, no un
defecto de 0016. La invariante que vale desde 0016 es la del final de la
migración (INV-1 con `entra`/`sale`, INV-10…INV-13), y la de la rama v5 ya la
usa (`tests/helpers/milkInvariant.ts`).

## 2. C-3 — la llamada de la app 0.13.0 a `log_pumping_session` [VERIFICADO]

Ya cubierto por la suite v5: `tests/integration/milkV5Cooling.test.ts`, caso
**"I-C1 app vieja (10 argumentos, sin p_fridge_at): fridge_at = pumped_at"**
— arma los 10 argumentos nombrados que manda 0.13.0, comprueba que son 10, y que
el contenedor queda con `fridge_at = stored_at = pumped_at` y `cold_at` nulo. La
firma vieja resuelve porque 0016 recrea la función con un 11º parámetro **con
default** (sin dos versiones: sin PGRST203). Pasa en la corrida completa de la
rama (§6).

## 3. La app 0.13.0 sobre datos v5 (leído en el código de `66462fa`)

[VERIFICADO por lectura de código con `git show 66462fa:<archivo>`, NO en
navegador.] **Ninguna pantalla de 0.13.0 se cae** con datos v5: no hay
`select('*')` sobre `milk_containers` (lee una lista fija de columnas,
`lib/db.ts:1044`), no hay barras ni porcentajes `remaining/amount`, y toda
comparación con `container_id` es por igualdad (un `null` simplemente no
coincide). Lo que **se ve raro**:

| Dato v5 | Qué muestra 0.13.0 | Dónde |
|---|---|---|
| Destino combinado (extracción 60, tiene 110) | "Lo que hay" y la lista de Leche: **bien** (110). "Ya se sirvieron" del destino: no aparece (`max(0, 60 − 110) = 0`) | `lib/milk.ts:202`, `app/pumping/page.tsx:708`, `lib/milkBottles.ts:295-300` |
| Origen combinado (extracción 50, libre, sin porciones) | En la lista de extracciones de Leche: **"Ya se sirvieron 1.69 oz de acá"** — falso: se pasó a otro biberón (`served = amount − desechado − lost − remaining`) | `app/pumping/page.tsx:708` |
| Borrar o dejar en 0 la extracción de un origen o destino combinado (Historial) | El cliente lo deja intentar; la base contesta `milk_combined:M#`, que 0.13.0 **no traduce**: el banner dice "milk_combined:M2" crudo. No se escribe nada | `0016:674/696/760`; `milkErrorText` de 0.13.0 no conoce el código |
| Bajar la extracción de un **destino** por debajo de lo servido de sus porciones | 0.13.0 lo bloquea en el cliente aunque la base lo aceptaría (lo recibido lo cubre): falso bloqueo, sin daño | `app/history/page.tsx:576-579` |
| Vista **sin conexión** de 0.13.0 con una edición o anulación encolada sobre un destino | Repinta el destino como si tuviera solo su extracción (pierde lo recibido en la vista local) hasta sincronizar; la base decide bien | `lib/milk.ts:515-523, 643` |
| Desecho `started_bottle_expired` (sin contenedor, 10 ml) | **"Leche desechada" de Leche lo suma** (0.13.0 suma todo desecho vivo; v5 suma solo `expired`, D5-11). En Historial: "Leche desechada · ? · 0.34 oz" (`label ?? '?'`). Sin crash | `lib/milkBottles.ts:132` (0.13.0), `lib/db.ts:1962-1984` |
| `fridge_at` / `cold_at` | Invisibles: no se leen. Leche "enfriando" se ofrece como cualquier otra (0.13.0 no conoce el enfriado) | `lib/db.ts:1044` |
| `formula_containers` (Similac) | No la ve: ningún archivo de 0.13.0 la nombra | `git grep formula_containers 66462fa` → 0 |
| Cola offline de 0.13.0 | Solo RPC con nombre y altas/ediciones de sus propias tablas; lo que choque con una combinación se rechaza al sincronizar con `milk_combined` crudo y queda para Descartar | `lib/db.ts` `sendOpWith` |

Todo esto es **riesgo de ventana** (runbook §9): dura lo que tarde cada aparato
en cargar v5. La base nunca queda inconsistente por una escritura de 0.13.0:
toda escritura vieja pasa por las funciones de 0016, que respetan las
transferencias (la suite C-2 lo ejercita entera contra 0016).

La **v0.12.1** escribe leche fuera del inventario (como con 0015,
`compatibilidad-v4.md` §2.1) y no lee ninguna tabla de leche: C-1 118/118.

## 4. C-4 — `docs/rollback-leche-v5.sql` [VERIFICADO]

Postgres efímero (`tests/integration/milkV5Rollback.test.ts`), siembra **por las
RPC como un padre `authenticated`**: combinación viva en cadena M3→M2→M1 con una
toma de 150 ml servida de M1 (más que su extracción de 120), combinación viva sin
servir M6→M5, combinación deshecha M8→M7, toma con sobró 10 ml y su desecho de
biberón empezado, 6 Similac compradas y 1 abierta, M4 enfriando, M9 marcada
"ya está fría", M10 vencida y desechada.

```
 ✓ … C-5 en 0001–0015: 0016 false y sus 21 objetos false; es solo lectura
 ✓ … 0016 + datos v5 por las RPC: invariante de 0016 = 0; C-5 da 21/21  1090ms
 ✓ … C-4 la reversa: invariante de 0015 = 0, esquema = 0001–0015, qué pierde  668ms
 ✓ … C-4 re-ejecutable: la segunda corrida no da error y deja lo mismo  440ms
 ✓ … después de la reversa, las RPC de 0015 (app 0.13.0) andan y la invariante sigue en 0
 ✓ … 0016 vuelve a entrar sobre lo que dejó la reversa: esquema = el de 0016, invariante 0  404ms
      Tests  6 passed (6)
```

NOTICE de la reversa (primera corrida):

```
NOTICE:  combinación viva: M1 ← M2 (110 ml, bebé …, op …)
NOTICE:  combinación viva: M2 ← M3 (50 ml, bebé …, op …)
NOTICE:  combinación viva: M5 ← M6 (30 ml, bebé …, op …)
NOTICE:  pre-chequeo: 3 combinación(es) viva(s), 6 Similac anotada(s) (1 abierta(s)), 1 desecho(s) de biberón empezado, 1 biberón(es) todavía enfriando
NOTICE:  "Lo que hay" del bebé …: antes 250 ml, después 220 ml
```

| Qué | Resultado |
|---|---|
| Invariante de **0015** (la consulta del `do` final de 0015, INV-1…INV-9) después | **0 filas** (y la reversa la corre adentro: si no diera 0, aborta) |
| `pg_dump --schema-only --schema=public --no-owner` contra 0001–0015 de cero (sin las líneas `\restrict` al azar de pg_dump 17.6) | **idéntico** |
| Segunda corrida | sin error ("0016 ya no está"), mismo dump, mismos contenedores |
| Contenedores (amount\|remaining\|lost\|liberado\|servido) antes → después | M1 `120\|50\|0\|f\|180` → `120\|50\|0\|f\|70`; M2 `60\|0\|0\|t\|0` → `60\|0\|0\|t\|60`; M3 `50\|0\|0\|t\|0` → `50\|0\|0\|t\|50`; M5 `40\|70\|0\|f\|0` → `40\|40\|0\|f\|0`; M6 `30\|0\|0\|t\|0` → `30\|0\|30\|t\|0`; M4, M7, M8, M9, M10 sin cambio |
| La toma F2 | `170\|150\|20` igual; porciones `M1=40, M2=60, M3=50` (antes M1=150) |
| Desechos | el de caducada (M10) vivo e intacto; el del empezado, borrado; el "Sobró" (10) queda |
| C-5 después | 0016 `f`, 0/21 objetos |
| RPC de 0015 después (biberón de M5, anular F2, extracción M11) | entran; invariante de 0015 = 0 |
| **0016 de nuevo** | entra; dump = el de 0016 de la primera vez; invariante de 0016 = 0; C-5 21/21 |

Y en el **stack local** (vacío de datos de leche al momento): reversa → C-1
118/118 y C-2 **310/310** sobre 0001–0015 → 0016 re-aplicada como lo hace
`scripts/local-stack.sh` (`begin; 0016; insert schema_migrations; commit;`, 0
`ERROR`) → historial `0014_milk_inventory,0015_milk_phase1_2,0016_milk_phase3_4`.

**Qué se pierde** (está en el encabezado del script): el inventario de Similac,
los desechos de biberón empezado (el "Sobró" queda), el enfriado
(`fridge_at`/`cold_at`), el registro de operaciones y las combinaciones. Cada
combinación viva se deshace **en la cuenta**: lo servido del destino por encima
de su extracción pasa a contar contra sus orígenes (la toma no cambia), el resto
del origen queda como **leche perdida**, y la leche recibida que **todavía no se
sirvió** sale de "Lo que hay" del destino (en la prueba, 250 → 220 ml: los 30 que
M6 le pasó a M5). Es la única pérdida en "Lo que hay", y se evita deshaciendo las
combinaciones desde la app v5 **antes** de la reversa.

## 5. C-5 — `docs/verificar-antes-v5.sql` [VERIFICADO]

Solo lectura: todo entre `begin transaction read only;` y `rollback;`. Probado
que la base rechaza una escritura en ese modo
(`cannot execute UPDATE in a read-only transaction`, en el test).

| Base | Consulta 1 (0014/0015/0016) | Consulta 2 (21 objetos de 0016) |
|---|---|---|
| Efímera 0001–0015 | t / t / **f** | **0/21** true |
| Efímera 0001–0016 + datos v5 | t / t / **t** | **21/21** |
| Efímera tras la reversa | t / t / **f** | **0/21** |
| Efímera con 0016 de nuevo | t / t / **t** | **21/21** |
| **Stack local** (0001–0016) | t / t / **t** — detecta que ya está | **21/21** |

Salida en el stack local (resumida; la consulta 3 da 0 en las 8 filas y la 4,
0 en todo porque las suites dejan la base sin filas de leche):

```
 0014_milk_inventory (DEBE dar true)              | t
 0015_milk_phase1_2 (DEBE dar true)               | t
 0016_milk_phase3_4 (antes: false; después: true) | t
 … (21 filas de objetos, todas t)
 INV-1 cuenta (amount = servido + desechado + lost + remaining) |     0
 … INV-2, INV-3, INV-4, INV-5, INV-6, INV-8, INV-9                |     0
 historial_0014_en_adelante: 0014_milk_inventory, 0015_milk_phase1_2, 0016_milk_phase3_4
ROLLBACK
```

## 6. Suite de la rama v5 después de todo esto [VERIFICADO]

`pnpm test:integration` en el worktree v5 contra el stack local con 0016 de
nuevo: ver `progreso-feeding-v5.md` §H5b (28 archivos con
`milkV5Rollback.test.ts`).

## 7. NO VERIFICADO

- **La nube:** que 0016 y la reversa corran en el SQL Editor de Supabase igual
  que en psql (0016 trae su propio `begin`/`commit`; la reversa también), los
  permisos por defecto del proyecto y que el rol `postgres` del SQL Editor pueda
  borrar filas de `milk_discards` (en local es superusuario). Sin credenciales
  en este VPS.
- **Pantallas de 0.13.0** sobre datos v5 en un navegador: §3 es lectura de
  código.
- PWA instalada en iOS / WebKit.
