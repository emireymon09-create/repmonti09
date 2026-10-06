# Compatibilidad y reversa: inventario de leche v4 (0015) con las apps v0.12.1 y v3 (6 oct 2026)

Durante el despliegue de v4 corren a la vez, contra la misma base, hasta **tres**
apps: la **v0.12.1** (`0cbe798`, producción hoy, escribe las tablas directo), la
**v3** (`71d4d0c`, rama `feat/milk-inventory-v3-release`, llama a las RPC de 0014
con sus nombres de argumentos; si se desplegó antes, queda cacheada en los
teléfonos) y la **v4** (`feat/milk-inventory-v4`). Este documento dice qué pasa
en cada mezcla con la base en 0015, cómo se vuelve atrás y qué se pierde, con
evidencia. Sigue el método de `docs/compatibilidad-leche.md` (la de v3).

Etiquetas: **[VERIFICADO]** = prueba ejecutada el 6 oct 2026 en este VPS contra
el stack local (127.0.0.1) o un Postgres efímero sin red, contrastada con SQL.
**[NO VERIFICADO]** = con motivo.

## 0. Montaje y destino

- Stack local `amelia-local` (compose del worktree v4), puertos solo en
  `127.0.0.1:54321/54322`; `.env.local` y `.env.test` apuntan a
  `http://127.0.0.1`, `grep -c supabase.co` = 0 en los dos. Base migrada
  0001–0015 (`supabase_migrations.schema_migrations`: 15 filas, última
  `0015_milk_phase1_2`).
- Worktrees de comprobación desacoplados (borrados al terminar):
  `../amelia_app-v0121-check` en `0cbe798` y `../amelia_app-v3check` en
  `71d4d0c`, con `.env.test` y `supabase/docker/.env` copiados del v4 (`cmp`
  idéntico) y `pnpm install --frozen-lockfile`. El worktree `../amelia_app-release`
  no se tocó.
- Postgres efímeros: imagen `public.ecr.aws/supabase/postgres:17.6.1.167` (la del
  stack), `--network none` (ningún puerto, ni en 127.0.0.1), `--pull never`,
  borrados al terminar; migraciones aplicadas como `scripts/local-stack.sh` (una
  transacción por archivo + fila en `schema_migrations`).
- Scripts y salidas: en el scratchpad de la sesión (no en el repo); lo
  reproducible está en `tests/integration/milkV4Compat.test.ts`,
  `milkV4Schema.test.ts` y `milkV4Migration.test.ts`, y en este documento.

## 1. Suites [VERIFICADO]

| Qué | Base | Resultado |
|---|---|---|
| C-01 · suite de integración de **v0.12.1 pura** (`vitest run tests/integration --maxWorkers=2`) | local 0001–0015 | **118/118** |
| C-02 · suite de integración de **v3-release** | local 0001–0015 | **150/151** — la única falla es una decisión de v4 (abajo) |
| C-02 · el mismo caso con el código esperado de v4 (`milk_future_time`) | local 0001–0015 | 1/1 (el resto del caso —base sin cambios, contenedor de otro bebé, mezcla con porción buena— pasa) |
| `tests/integration/milkV4Compat.test.ts` (C-03…C-20 por PostgREST) | local 0001–0015 | 15/15 |
| `milkV4Schema.test.ts` -t `C-22\|C-23\|I-96` | local 0001–0015 | 3/3 |
| R-07 · suite de **v3-release** | local con `rollback-leche-v4.sql` aplicado (0001–0014) | **151/151** |
| R-08 · suite de **v0.12.1** | ídem | **118/118** |
| Cadena · suite de **v0.12.1** | local tras `rollback-leche-v4.sql` + `rollback-leche.sql` (0001–0013) | **118/118** |

**La falla de C-02 no es una regresión.** `tests/integration/milk.test.ts` de v3,
caso "log_bottle_feed rechaza un contenedor anulado, uno vencido y uno de otro
bebé de la familia": registra una toma con `p_fed_at = expires_at + 1 s` (cuatro
días en el **futuro**) y espera `milk_container_unusable:M7`; 0015 contesta
`milk_future_time` porque la base ya no acepta una toma más de 10 min en el
futuro (ARQ A9, D-15). Las dos respuestas rechazan y no escriben nada. Corregido
**solo** el código esperado (en el worktree de comprobación, revertido después),
el caso entero pasa. **ARQ §9.2 decía que la única diferencia posible era el
reuso de la cinta de un vaciado; faltaba esta.** Efecto visible para un teléfono
v3: con el reloj adelantado más de 10 min, su toma de biberón recibe
`milk_future_time`, que v3 **no traduce** (su `milkErrorText` no conoce el
código y lo pasa crudo al banner).

## 2. Mezclas sobre lo creado por v4 [VERIFICADO]

Escenario (SQL como `authenticated`, con `request.jwt.claims`, en el stack
local): v4 crea, por sus RPC, M1 elegido (90 ml); M2 vencido y **desechado**; M3
servido entero con **sobró** (queda **libre**) y M3 **reusado** (40 ml); la toma
de M3 viejo anulada con el número tomado (**leche perdida**, `lost_ml` 30); M4 y
M5 vaciados (libres, toma viva); M6 vencido y desechado; una toma de M1 con
fórmula y sobró, después **editada** con `edit_bottle_feed`. Después, cada
escritura de la app vieja y de la app v3, con una foto (md5 de contenedores,
porciones, desechos, tomas y extracciones de la familia) antes y después.

**Invariante INV (ARQ §2.4, toda la base): 0 filas antes de crear, 0 después de
crear, 0 después de las mezclas.** De **23** pasos rechazados, **23** dejaron la
foto idéntica; 0 cambiaron algo. Familia y usuario borrados al final (0 restos).

### 2.1 App vieja v0.12.1 × objeto de 0015

| # | Caso | Base | ¿Aceptable? |
|---|---|---|---|
| B1 / C-05 / C-07 | Borrar una toma con desglose, con sobró y **editada** (`{voided_at}`) | `milk_rpc_only`, foto igual | Sí |
| B2a/b | Cambiar cantidad / pasar a `nursing` | `milk_rpc_only`, igual | Sí |
| C-07 | Tocar `leftover_ml` de esa toma | `milk_rpc_only`, igual | Sí (v0.12.1 nunca lo manda) |
| B2c / C-06 | Cambiar **solo la hora**, mismo `amount_ml`, a una hora válida | entra (`UPDATE 1`) | Sí (como en v3) |
| C-06 | Solo la hora, a antes de que existiera M1 | `milk_container_unusable:M1`, igual | Sí (crudo: v0.12.1 no traduce) |
| C-06 / D-15 | Solo la hora, +1 h en el futuro | `milk_future_time`, igual | Sí (crudo) |
| B3 / C-08 | Borrar / cambiar total de la extracción **elegida con selector** | `milk_rpc_only`, igual | Sí |
| B3d | Solo la nota, reenviando el total redondeado a oz | `milk_rpc_only`, igual | Sí (igual que en v3: la vieja no edita extracciones nuevas) |
| C-09 | Borrar / cambiar total de la extracción **desechada** (M2), **libre** (M4) y **libre con leche perdida** (M3 viejo) | `milk_rpc_only`, igual; desecho intacto | Sí |
| B4 / B5 / C-03 / C-04 / C-12 | Alta legada de extracción + biberón + pañal, cada alta dos veces (`on conflict do nothing`) | 1 fila cada una, **0 contenedores** para la extracción | Sí, con la condición de v3 (no entra al inventario, §5 de compatibilidad-leche) |
| C-03 | Editar y borrar esa extracción legada | entra | Sí |
| C-10 | Bajar el total de una toma legada por debajo del sobró que le puso v4 | `23514 feedings_leftover_le_amount`, igual | Sí (D-11b, visible y crudo) |
| C-11 | Pasar esa toma legada a `nursing` | entra | Sí |
| C-13 | Cola v4 inyectada en v0.12.1: su `sendOpWith` trata `kind:'rpc'` como alta → `POST /milk_discards` con `row` (por PostgREST) | **400 P0001 `milk_rpc_only`** | Sí: falla cerrado |
| C-13 | ídem `edit_bottle_feed` (la entrada no tiene `row`: `POST /feedings` sin cuerpo) | **400 PGRST102** "Empty or invalid json" | Sí: falla cerrado |
| — | `milk_feeding_edits` directo; `milk_containers` "resucitar" (`released_at = null`) directo | `milk_rpc_only` | Sí |

Foto antes/después por PostgREST en C-13: idéntica.

### 2.2 App v3 (RPC de 0014, sus argumentos) × objeto de 0015

| # | Caso | Base | ¿Aceptable? |
|---|---|---|---|
| C-15 | `log_pumping_session` con la cinta de un ocupado (M3 reusado) | `milk_label_taken:M3`, igual (v3 lo traduce) | Sí |
| C-14 | Cinta M15 con N = 6 | entra | Sí (D-1) |
| — | Cinta de un **libre** (M4) | entra: v4 reusa números libres; el **cliente** v3 nunca la sugiere (los cree tomados) | Sí |
| — | `log_bottle_feed` de **seis** argumentos de M4 **libre** | `milk_overdraw:M4`, igual | Sí |
| — | ídem de M2 **desechado** | `milk_container_unusable:M2` (un desechado siempre está vencido y ese chequeo va antes), igual. **ARQ §9.2 decía `milk_overdraw`**; las dos son rechazos que v3 traduce | Sí |
| — | ídem de M1, 10 ml; y el reenvío de la cola con la misma carga | entra; reenvío no-op | Sí |
| AJ-8 | Reenvío tardío, con seis argumentos, del alta de una toma ya **editada** por v4 | no-op (foto igual) | Sí |
| D-15 | Toma +1 h en el futuro | `milk_future_time`, igual (v3 no lo traduce) | Sí |
| C-16 | `void_bottle_feed` de una toma de M5 libre con el número libre | la leche vuelve y **re-ocupa** M5 | Sí |
| C-16 | `void_bottle_feed` de la toma de M4 viejo con M4 reusado | la leche va a `lost_ml` (20); v3 ignora el cuerpo `jsonb` | Sí |
| — | `void_pumping_session` de una extracción servida (M1) | `milk_already_served:M1`, igual | Sí |
| C-19 | `update_pumping_session` cambiando la división de un **desechado** (mismo total) | entra; desecho intacto | Sí |
| D-8 | ídem subiendo el total 50 → 70 | el desecho crece a 70 | Sí |
| — | `void_pumping_session` de un desechado sin servir | anula contenedor **y** desecho | Sí |
| C-17 | `{fed_at}` directo sobre la toma editada, a una hora válida | entra (re-valida) | Sí |
| — | `void_bottle_feed` de la toma editada | la leche vuelve a M1 | Sí |
| C-18 | Historial v3 con una extracción desechada | [VERIFICADO por lectura de código, NO en navegador] `listContainers` de v3 no lee `released_at`; `servedMl = amount − remaining` cuenta lo desechado como "servido", y `app/history/page.tsx:497` bloquea borrar con `milk_already_served:M#` **en el cliente**, sin escribir. El servidor sí lo dejaría (fila anterior) | Sí: falla cerrado |
| C-20 | Cola v4 (desechar, editar) en v3 con la base en 0015 | se aplican (`milkV4Compat.test.ts`) | Sí |
| C-21 | Cola v4 con la base **revertida** (por PostgREST, stack local) | `discard_container`, `edit_bottle_feed` **y** `log_bottle_feed` con `p_leftover_ml` → **404 PGRST202** | Sí: falla cerrado (rechazo con Descartar) |

## 3. La base: caché de PostgREST (C-24)

[VERIFICADO en local] Tras correr `rollback-leche-v4.sql` en el stack local, la
primera llamada (≈0,5 s después del `COMMIT`/`NOTIFY`) ya daba 404 PGRST202; tras
`pnpm db:reset` (0015 de nuevo) las mismas llamadas llegaron a la función (400
P0001 con el código de negocio, no 404). **En la nube [NO VERIFICADO]:** sin
credenciales; por eso 0015 y la reversa terminan en `notify pgrst, 'reload
schema'`.

## 4. La ventana de cambio y cómo acortarla

La ventana es el tramo con 0015 aplicada y teléfonos que todavía corren v0.12.1
o v3. Lo de §2 dice que **ninguna** escritura vieja desfasa el inventario; lo que
sí pasa:

- **v0.12.1:** igual que con 0014 (`compatibilidad-leche.md` §5): su leche entra
  legada, fuera del inventario, y un biberón suyo no descuenta. Bloqueos
  visibles y crudos al tocar lo creado por v3/v4.
- **v3:** escribe bien sobre 0015, pero (a) su cliente no conoce "libre" ni
  "desechado": muestra lo desechado como servido y no deja borrar esa
  extracción; (b) sugiere cintas por "máx + 1" y nunca un número liberado;
  (c) `milk_future_time` le llega crudo.
- **v4 sobre la base sin 0015** (si se pushea antes de aplicar): toda RPC nueva
  y `log_bottle_feed` con `p_leftover_ml` dan 404 → rechazo. **Orden: 0015
  primero, push después.**

Cómo acortarla (mismo método que v3):

1. `verificar-antes-v4.sql` → aplicar 0015 → `notify` → push, **seguidos**.
2. Cerrar del todo y reabrir la PWA en cada aparato y recargar la pared.
3. No registrar leche desde un aparato que no se actualizó. Pañales, sueño y
   lactancia no tienen ventana (0015 no los toca; C-25).

## 5. Reversa

### 5.1 Volver solo la app (0015 se queda)

Funciona, en las dos direcciones, con lo de §2: v3 sobre 0015 pasa su suite
salvo la decisión de los 10 min; v0.12.1 pasa la suya entera. Lo que un
teléfono tenía encolado con v4:

- vuelto a **v3**: `discard_container` y `edit_bottle_feed` **se aplican** (las
  funciones existen) — C-20;
- vuelto a **v0.12.1**: cada entrada rechaza (`milk_rpc_only` o `PGRST102`) y
  detiene la cola hasta Descartar; nada se escribe — C-13.

### 5.2 Volver también la base: `docs/rollback-leche-v4.sql`

**Primero la app**, después la base: con la base revertida, la app v4 no puede
registrar ni un biberón (`log_bottle_feed` de siete argumentos → 404).

Probado en Postgres efímero [VERIFICADO]:

| Qué | Resultado |
|---|---|
| R-01 · `pg_dump --schema-only --schema=public --no-owner` de 0001–0014 de cero contra 0001–0015 + datos v4 + rollback (sin las líneas `\restrict`, que pg_dump 17.6 genera al azar en cada volcado) | `diff` **0 líneas** |
| R-02 · segunda corrida | sin error; `diff` 0 líneas |
| R-03 · dos M3 y dos M5 no anulados | se recrea `milk_containers_label_live`; 0 cintas dobles |
| R-04 · `void_bottle_feed` de v3 de tomas de M2 desechado, M3/M5 viejos | "Lo que hay" 155 → 155 en los tres |
| R-05 · M7 ocupado con `lost_ml` 30 | `NOTICE` con cinta, bebé, id y monto; sigue |
| R-06 · `remaining <> amount − servido` en vivos | 1 (= M7, el del pre-chequeo) |
| R-09 · respaldo opcional | 2 desechos, 1 edición, 2 sobró, 8 contenedores, 1 bebé = lo sembrado; `anon` y `authenticated` sin `usage` del schema |
| R-11 · tomas con desglose | 6 vivas, 6 porciones vivas, 0 que no cierren |
| R-12 · `rollback-leche.sql` después | sin error; `diff` contra 0001–0013 de cero **0 líneas**; segunda corrida sin error |
| `verificar-antes-v4.sql` | en 0001–0014: 0014 `t`, 0015 `f`, 18/18 objetos `f`; en 0001–0015: 0015 `t`, 18/18 `t`; en la revertida: 0014 `t`, 0015 `f`, 18/18 `f`; en 0001–0013: 0014 `f`, 0015 `f` |
| Reversa sobre una base **sin** 0014 | aborta (`relation "milk_containers" does not exist`), sin cambiar nada (diff 0). Requiere 0014 puesta |

Y en el stack local (después de comprobar que es local): reversa → suites v3
**151/151** y v0.12.1 **118/118** → `rollback-leche.sql` → v0.12.1 **118/118** →
`pnpm db:reset` desde el worktree v4 (0001–0015).

**Qué se pierde** (está en el encabezado del script): todos los desechos, todo
"sobró", N, las marcas de liberado y de leche perdida, el registro de ediciones;
y se **anulan** los contenedores desechados, los liberados con leche perdida y,
cuando una cinta quedó repetida, los que no tienen leche. Las tomas conservan su
desglose final. En v3 la extracción de un contenedor anulado se ve sin cinta ni
"servido" y v3 dejaría borrarla aunque se sirvió leche de ella (riesgo de ARQ
§10.2).

### 5.3 DEFECTO: volver a aplicar 0015 después de la reversa (R-10)

[VERIFICADO, Postgres efímero] Con datos reales de v4, **0015 no vuelve a
entrar** sobre la base revertida: aborta con `milk_invariant_broken` (4 filas: la
primera `INV-1 cuenta` de M7, más tres `INV-4 anulado con vivos`). Es seguro (la
migración es una transacción y no aplica nada), pero ARQ §10.3 paso 6 esperaba
"entra; INV 0 filas" y eso solo vale si la reversa no anuló ningún contenedor con
porciones vivas.

- **Por qué:** la reversa (ARQ §10.1 paso 3) anula contenedores **servidos** —un
  desechado después de servir (caso 16) y, sobre todo, el contenedor viejo de un
  **número reusado** que se vació sirviendo, que es el uso normal de v4—; sus
  porciones siguen vivas porque las tomas no se tocan. 0015 exige INV-4 (anulado
  ⇒ 0 porciones vivas). Y un contenedor del pre-chequeo (ocupado con
  `lost_ml > 0`) queda con `remaining ≠ amount − servido` → INV-1.
- **Reproducción:** 0001–0015 → sembrar (por las RPC, como `authenticated`): M3
  de 30 ml servido entero en una toma; M3 nuevo de 40 ml → `rollback-leche-v4.sql`
  → `begin; <0015>; rollback;` → `milk_invariant_broken … INV-4`. La consulta 3
  de `verificar-antes-v4.sql` lo **anticipa** (en la base revertida dio
  `INV-1 = 1`, `INV-4 = 3`).
- **Con datos sin esos casos** (ocupado editado con sobró, desechado sin servir,
  libre con polvo, reusado cuyo viejo no tiene porciones vivas): 0015 vuelve a
  entrar e INV da 0 filas.
- **No se corrigió** (fuera del alcance de este rol). Decisión para arquitectura:
  aceptar que volver a v4 tras revertir pide una corrección manual guiada por la
  consulta 3, o guardar el respaldo opcional (`milk_backup_v4`) para poder
  reconstruir, o relajar INV-4 para contenedores anulados por la reversa.

## 6. NO VERIFICADO

- La nube: event triggers de recarga de PostgREST, que la reversa corra en el SQL
  Editor de Supabase igual que en psql, y los permisos por defecto del proyecto
  (sin credenciales en este VPS).
- Pantallas: la UI de v0.12.1 y de v3 sobre datos v4 en navegador (C-18 se
  verificó leyendo el código de v3, no en pantalla); el banner con Descartar de
  C-13/C-21 en un perfil real de teléfono (se probó la respuesta del servidor
  a la petición exacta que arma cada app).
- PWA instalada en iOS / WebKit (no hay WebKit acá).
- Un teléfono v3 con el reloj adelantado más de 10 min (se probó la respuesta de
  la base, no el teléfono).
