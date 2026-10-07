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
| m-2 | `log_pumping_session` / `update_pumping_session` con `pumped_at` > ahora de la base + 10 min (agregado el 6 oct 2026, auditoría H5) | `milk_future_time` (v3 no lo traduce: muestra el código). La pantalla de v3 ya no deja una hora futura **según el reloj del teléfono**, así que solo lo ve un teléfono con el reloj **adelantado** más de 10 min: su extracción "de ahora" se rechaza (o, encolada, frena la cola hasta Descartar). Un reloj **atrasado** no se ve afectado (una hora pasada vale). El reenvío de un alta ya guardada sigue siendo no-op (el tope va después de la idempotencia). La vía directa de v0.12.1 (forma legada, `pumped_at` por UPDATE/INSERT) **no** pasa por acá y queda como estaba | Sí: falla cerrado, igual que D-15 en tomas |
| M-1 | Extracción con total entre 0 y 0,15 ml (0,1 ml, `1e-30`) | `milk_bad_input` (v3 lo traduce: "milkError.badInput"); antes creaba un biberón OCUPADO casi vacío (rompía INV-5 y bloqueaba el número hasta que vencía) | Sí |
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
§10.2). **Y esa extracción pasa a forma legada** (paso 2d, B-1): se pierde su
reparto izquierdo/derecho; su total, hora, lado y nota quedan.

**B-1 (auditoría H5, 6 oct 2026) — DEFECTO corregido.** Antes del paso 2d, la
app v3 **resucitaba leche** después de la reversa: no ve contenedor vivo para la
extracción de un contenedor que la reversa anuló, así que al corregirle solo la
nota o la hora su `update_pumping_session` (0014) creaba un contenedor **nuevo
con el total entero**. Corrección de **datos** dentro de la reversa (el esquema
tiene que quedar idéntico a 0001–0014, R-01): esas extracciones quedan con
`left_ml`/`right_ml` en null, `amount_ml` igual. El cliente v3 las trata como
legadas (`isLegacyPumping`) y manda los lados en null; la función de 0014 entra
por su ramal `v_legacy` y cambia solo hora y nota.

| B-1 | Antes del paso 2d | Después |
|---|---|---|
| `run3.sql` de la auditoría (stack local, en una transacción que se deshace): M2 de 80 ml, 20 servidos, 60 desechados → reversa → v3 corrige la nota y después la hora | aparece `M3 | 80 | 80` ocupado y, con la hora de hoy, **utilizable** | la extracción queda `null/null total 80`; con los argumentos que manda v3 (lados de la fila, en null) no aparece ningún contenedor: solo `M1 100` y el `M2` anulado |
| `milkV4Reapply.test.ts` › B-1 (Postgres efímero, siembra por RPC, edición v3 armada desde la fila como su `updatePumpingSession`): M2 desechado tras servir + M3 servido entero y reusado | `expected '5' to be '3'` (dos contenedores nuevos: M9 y M8) | 0 contenedores nuevos, "Lo que hay" 40 → 40, nota y hora cambiadas, total 80; 0015 vuelve a entrar con INV 0; R-01 igual (dump = 0001–0014) |

**Riesgo que queda:** si en v3 alguien **escribe a mano** izquierdo o derecho
en una de esas extracciones legadas, v3 hace lo que hace con cualquier legada y
le crea un contenedor con esa cantidad (es lo que reproduce `run3.sql` tal cual,
que pasa `80` como si se hubiera tipeado). Es una acción explícita sobre una
fila que la pantalla muestra como "registrada antes de los lados, total X", no
una corrección de nota. Lo mismo vale en v4 después de volver a aplicar 0015, para las que siguen con el contenedor anulado (las que no tenían porciones: las otras vuelven con su contenedor liberado y una edición pasa por `milk_rebalance`).

### 5.3 Volver a v4 después de la reversa (R-10) — corregido el 6 oct 2026

Hasta el 6 oct 2026 esto era un DEFECTO: con datos reales de v4, 0015 **no
volvía a entrar** sobre la base revertida y abortaba con `milk_invariant_broken`
(4 filas: `INV-1 cuenta` de M7, el ocupado con leche perdida del NOTICE, más tres
`INV-4 anulado con vivos`). La reversa anula contenedores **servidos** —el viejo
de un número reusado, que es el uso normal de v4, y uno desechado después de
servir— y sus porciones siguen vivas porque las tomas no se tocan; y tira
`lost_ml`, así que el ocupado del NOTICE queda con `remaining < amount −
servido`.

**Corrección elegida: la arregla 0015, no la reversa.** Antes de la invariante,
0015 tiene una sección "VOLVER A v4 TRAS LA REVERSA" con dos UPDATE:

1. **Anulado con porciones vivas → liberado.** `voided_at = null`,
   `released_at` = el `voided_at` que puso la reversa (que era su hora de
   liberado), `remaining` = el polvo que tenía (< 0,15) o 0. Nunca ocupado: su
   número puede tenerlo otro y físicamente no tiene leche. Va después del
   índice nuevo (con el viejo, el M3 viejo chocaría con el que ocupa hoy M3).
2. **Residuo positivo → `lost_ml`.** `amount − servido − remaining > 0` en un
   contenedor vivo es leche que no está en el biberón ni se sirvió: la perdida
   del ocupado del NOTICE y la desechada/perdida de los del paso 1. Va a
   `lost_ml`, nunca a `remaining`: **"Lo que hay" no se mueve**. El residuo
   **negativo** (dice tener más leche de la posible) no se toca y sigue
   abortando (I-105).

Por qué ésta y no cambiar la reversa:
- Las dos formas **solo las produce la reversa**: ninguna función de 0014 anula
  un contenedor servido ni deja `remaining ≠ amount − servido`. Sobre datos v3
  comunes los dos UPDATE no tocan una fila (I-104 sigue igual).
- La reversa no tiene dónde dejarlas representables en v3: el índice
  `milk_containers_label_live` de 0014 no admite dos M3 no anulados, y el
  esquema tiene que quedar **idéntico** a 0001–0014 (R-01), así que no hay
  columna ni tabla para marcarlas. Dejar el desechado vivo haría que un
  `void_bottle_feed` de v3 le devolviera leche tirada a "Lo que hay" (R-04).
- La reversa no cambió para R-10 (solo comentarios). Después sí cambió, por
  B-1 (§5.2): el paso 2d es **solo de datos** (lados de algunas extracciones a
  null), así que el esquema que deja, R-01, R-02, R-03 y R-12 siguen igual
  (re-verificados en `milkV4Reapply.test.ts`). Las suites de v3 (151/151) y
  v0.12.1 (118/118) sobre la base revertida se midieron **antes** del paso 2d y
  no se volvieron a correr [NO VERIFICADO con 2d; no tocan esas filas: siembran
  las suyas].

Qué **no** vuelve (ya se perdía con la reversa, sigue escrito en ella): los
desechos —su leche vuelve como **perdida**, no como desechada: la reversa los
borró y ya no se distinguen—, el sobró, N (vuelve a 6), el registro de
ediciones, y la marca de liberado de los anulados **sin** porciones (siguen
anulados, que en v4 también es válido). Si una toma de v3 anulada "devolvió"
leche a un anulado, esa leche tampoco vuelve a "Lo que hay": va a `lost_ml`.

Lo que sigue abortando a propósito (residuo, no visto en ninguna prueba): si
mientras se usó v3 alguien **escribió los lados a mano** en la extracción de un
contenedor anulado por la reversa (el riesgo que deja B-1, §5.2) y v3 le creó un
contenedor nuevo, la sesión puede quedar con dos contenedores vivos y 0015 frena
por `INV-8`. Es la salida segura (no aplica nada); la consulta 3 de
`verificar-antes-v4.sql` lo anticipa. Corregir la nota o la hora ya no lo
produce (B-1).

[VERIFICADO, Postgres efímero, `tests/integration/milkV4Reapply.test.ts`, siembra
por las RPC como `authenticated`]:

| Qué | Antes de la corrección | Después |
|---|---|---|
| Caso mínimo: M3 de 30 ml servido entero, M3 nuevo de 40, reversa, 0015 | `milk_invariant_broken` — "1 fila(s); la primera: INV-4 anulado con vivos" | entra; INV 0 filas; M3 viejo liberado con su porción, M3 nuevo ocupado 40; "Lo que hay" 40 |
| Caso completo + días de v3 (toma de 0014 de M3, extracción M5) | `milk_invariant_broken` — "4 fila(s); la primera: INV-1 cuenta" | entra (en seco y de verdad); INV 0 filas; "Lo que hay" 115 → 115; M7 ocupado con `lost_ml` 25 exacto; M2 (desechado tras servir) liberado con `lost_ml` 40; 5 porciones vivas |
| R-01 tras cada reversa del ciclo (v4 → reversa → v4 → reversa) | — | `pg_dump --schema-only --schema=public` = 0001–0014 de cero |
| R-02 (reversa dos veces) | — | sin error; mismo dump |
| R-12 (`rollback-leche.sql` después, dos veces) | — | dump = 0001–0013 de cero |
| I-104 / I-105 (`milkV4Migration.test.ts`) | — | 2/2 (I-105 siembra ahora un residuo **negativo**: el positivo es justo lo que 0015 recupera) |

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
