# Compatibilidad: app v0.12.1 sobre la base con el inventario de leche (6 oct 2026)

Durante el despliegue la app **vieja** (v0.12.1, `0cbe798`) corre contra la base
**nueva** (0001–0014): entre aplicar la migración y el push, y después en todo
teléfono o pantalla de pared con la PWA vieja abierta o en caché. Este documento
dice qué pasa en ese tramo, con evidencia.

Etiquetas: **[VERIFICADO]** = con prueba ejecutada el 6 oct 2026 en local
(127.0.0.1) y contrastada con SQL. **[NO VERIFICADO]** = con motivo.

Montaje de la prueba: base local migrada desde cero 0001–0014 (`pnpm db:reset`
desde la rama de release); build de producción de **v0.12.1 pura** (worktree
desacoplado en `0cbe798`) en `127.0.0.1:3132` y de la **rama de release** en
`127.0.0.1:3131`, contra la misma base; chrome-headless-shell 390×844; familias
descartables, borradas al terminar (conteo 0 en las 17 tablas y en `auth.users`).

## 1. Superficie de 0014 que la app vieja puede tocar

| Elemento de 0014 | Qué hace | Qué petición de v0.12.1 lo activa |
|---|---|---|
| `pumping_sessions.left_ml`, `right_ml` (nullable, CHECK `>=0 and <100000`) | Reparto izq/der | Ninguna: v0.12.1 nunca los manda y lee columnas explícitas (no hay `select('*')` en el repo) |
| `feedings.breast_milk_ml`, `formula_ml` (nullable, mismo CHECK) | Desglose de la toma | Ninguna (ídem) |
| `babies.milk_room_hours`, `milk_fridge_days`, `milk_freezer_months` (NOT NULL con default) | Reglas de conservación | Ninguna: la única escritura vieja sobre `babies` es `{birth_date}`; los defaults cubren cualquier alta |
| Trigger `milk_guard_feedings` (BEFORE INSERT/UPDATE) | Rechaza (`milk_rpc_only`, SQLSTATE P0001) un alta con desglose y, en una toma **con** desglose, cambiar `baby_id`, `feeding_type`, `amount_ml`, desglose o `voided_at` | `logFeeding` (pasa: sin desglose); `updateFeeding` y `voidFeeding` sobre una toma con desglose (bloquea, salvo que reenvíe los mismos valores) |
| Trigger `milk_guard_pumping` (BEFORE INSERT/UPDATE) | Alta: rechaza si trae izq o der. Update: libre si la fila es de **forma legada** (sin izq/der antes y después, sin contenedor vivo, mismo `baby_id`); si no, rechaza cambiar total, izq/der, hora, lado, bebé o `voided_at` | `logPumping` (pasa: forma legada); `updatePumping`/`voidPumping` del menú ⋯ de Historial (pasa sobre legadas; bloquea sobre las de la app nueva) |
| Triggers `milk_guard_containers`, `milk_guard_drawdowns` | Toda escritura fuera de las RPC rechazada | Ninguna: v0.12.1 no conoce esas tablas |
| Tablas `milk_containers`, `milk_drawdowns` (RLS por `family_id`, sin DELETE, grants solo a `authenticated`) | Inventario | Ninguna |
| Índices únicos parciales `milk_containers_label_live`, `milk_containers_one_per_session` | Una cinta viva por bebé; un contenedor vivo por extracción | Ninguna |
| Funciones `log_pumping_session`, `update_pumping_session`, `void_pumping_session`, `log_bottle_feed`, `void_bottle_feed` (+ ayudantes), `security invoker`, `search_path = public`, sin `anon` | RPC del inventario | Ninguna (salvo el caso de rollback, §4) |
| Rutas de dispositivo (`/api/quick/*`, `/api/ingest`) con `service_role` | Saltan RLS, **no** los triggers | No escriben `feedings` ni `pumping_sessions` |

**Corrección hecha en esta integración (S6 de la comparación) [VERIFICADO]:** en
la versión original de la migración la guarda rechazaba **toda** extracción
escrita fuera de las RPC. Medido con psql como `authenticated`: el alta de
v0.12.1 (`{side, amount_ml, …}`), su borrado y su edición de una extracción
**vieja** daban `ERROR: milk_rpc_only`. Consecuencia: ningún teléfono viejo podía
registrar leche, y una extracción encolada offline atascaba su cola hasta
descartarla, **perdiendo el dato**. Se aceptan ahora las filas de forma legada;
11 pruebas de regresión en `tests/integration/milk.test.ts` ("app vieja v0.12.1
durante el deploy") — 6 fallaban antes del arreglo, 25/25 después.

## 2. Suites [VERIFICADO]

| Qué | Base | Resultado |
|---|---|---|
| Suite de integración de v0.12.1 pura | solo v0.12.1 (0001–0013) — línea base | 118/118 |
| Suite de integración de v0.12.1 pura | migrada 0001–0014 (antes y después del arreglo de la guarda) | 118/118 |
| Suite de integración de la rama de release | 0001–0014 | 151/151 (corrida final) |
| Suite de v0.12.1 pura en pila efímera | 0001–0014 + datos de leche → `rollback-leche.sql` | 118/118 antes y 118/118 después |

## 3. Matriz: app vieja × dato × resultado [VERIFICADO salvo donde se dice]

### 3.1 La app vieja sola sobre la base nueva

Hoy (pecho izq/der y terminar, pañal, sueño y despertar, biberón 3 oz),
`/pumping` (izq 2 oz → `left, 59.1`, 0 contenedores), Historial ⋯ editar y borrar
los cinco tipos, Crecimiento, Médico, Ajustes (umbrales 150/95), los dos padres,
`/api/quick/diaper` y `/api/quick/status`: **todo pasa**, cada paso contra SQL.

### 3.2 Mezclas

| # | Caso | Base | Lo que ve el usuario | ¿Aceptable en la ventana? |
|---|---|---|---|---|
| B1 | Vieja borra una toma **con desglose** | `PATCH {voided_at}` → 400 `milk_rpc_only`; `remaining_ml` y porciones idénticos antes/después | Banner rojo "Couldn't delete — milk_rpc_only" | **Sí**: no hay desfase. El texto es un código crudo (v0.12.1 no lo traduce) |
| B2a/b | Vieja cambia cantidad o tipo de esa toma | 400, sin cambios | "Couldn't save — milk_rpc_only" | Sí |
| B2c | Vieja cambia **solo la hora** | Pasa si el `amount_ml` reenviado coincide (88,7205 → 204); falla si el redondeo a oz lo altera (50 ml → reenvía 50,27495 → 400) | "Saved" o el banner | Sí: el dato queda a salvo; la edición de hora puede fallar |
| B3 | Vieja borra o edita una extracción **con contenedor** | 400, contenedor intacto | Banner `milk_rpc_only` | Sí |
| B3d/e | Vieja edita **solo la nota** de esa extracción | 400: reenvía `amount_ml` redondeado (59,1 ≠ 59,147) | Banner | Sí (siempre falla: la app vieja no puede editar extracciones nuevas) |
| B4 | Vieja registra extracción y biberón | Entran en forma legada, 0 contenedores, 0 porciones | Normal | **Sí, con una condición**: la extracción no entra al inventario, y un biberón de leche materna **no descuenta** de él, así que "Lo que hay" queda **más alto que la leche real** hasta corregirlo (§5). La contabilidad no se desfasa; la heladera sí |
| B4' | La app nueva lee eso | "Lo que hay" 3,82 oz antes y después; Historial las muestra con ⋯ y el aviso de sesión legada | Normal | Sí |
| B4'' | **`/pumping` vieja** muestra su total | Suma `amount_ml` de todas las extracciones: 9,5 oz contra 3,82 reales | Número **inflado** (no descuenta lo servido) | **Solo de pantalla**, no toca datos. Se acorta con §6 |
| B5a | Cola vieja offline: extracción + biberón + pañal | 3 POST `on_conflict=id` → 201, sin duplicados, extracción legada | "Offline · 3 entries saved…" y luego nada | Sí |
| B5b/c | Respuesta perdida / misma alta encolada dos veces | 1 fila | Nada | Sí |
| B5d | Vieja borra offline una toma con desglose | Al reconectar 400; cola detenida | "Couldn't sync — milk_rpc_only … [Discard this entry]"; Descartar la vacía y la toma sigue viva | Sí (nada se pierde: la toma sigue) |
| B6 | La nueva edita/borra filas de la vieja | Biberón legado 2→2,5 oz; nota de la extracción legada vía RPC (rama legada); borrar ambos | "Saved"/"Deleted"; inventario sin cambios | Sí |

### 3.3 La base

- **PostgREST y el esquema [VERIFICADO en local]:** el stack local tiene los
  event triggers `pgrst_ddl_watch` y `pgrst_drop_watch` habilitados, que recargan
  el caché solos (medido: una función nueva da 404 `PGRST202` a los 118 ms y 200
  al segundo). Con esa recarga suprimida (`session_replication_role=replica`) la
  función siguió en 404 hasta `notify pgrst, 'reload schema'`. Además
  `scripts/local-stack.sh:43` manda ese `notify` tras migrar. **En la nube
  [NO VERIFICADO]:** no hay credenciales acá para ver si existen esos event
  triggers; por eso el runbook manda el `notify` explícito (es inocuo).
  Mientras el caché esté viejo, una RPC de leche da 404 y la app nueva lo trata
  como **rechazo** (no lo encola): banner de error; reintentar segundos después
  funciona.

## 4. Volver atrás solo la app (rollback del despliegue con 0014 aplicada)

Lo que pasa es lo de §3 de forma permanente: la app vieja funciona entera salvo
editar/borrar tomas con desglose y extracciones con contenedor (bloqueo visible,
sin desfase), y su "En reserva" de `/pumping` suma de más.

**Entradas `rpc` que un teléfono ya había encolado con la app nueva [VERIFICADO
por inyección]:** se exportaron de la IndexedDB de la app nueva
(`amelia-pending`/`writes`, v1) las cuatro formas —`log_pumping_session`,
`log_bottle_feed`, `void_pumping_session`, `void_bottle_feed`— y se inyectaron en
la de la vieja (los orígenes difieren por puerto, así que no se compartían solas;
**no se probó en un mismo perfil real** de teléfono). El código viejo trata
`kind:'rpc'` como un alta: `POST /<tabla>?on_conflict=id` con `row`. Resultado:

| Entrada | Lo que manda la vieja | Respuesta |
|---|---|---|
| `log_pumping_session` | `row` con izq/der | 400 `milk_rpc_only` |
| `log_bottle_feed` | `row` con desglose | 400 `milk_rpc_only` |
| `void_pumping_session`, `void_bottle_feed` | sin cuerpo | 400 `PGRST102 Empty or invalid json` |

La cola se detiene en **cada una**: hacen falta 4 "Descartar", y las cuatro
escrituras **se pierden**; los banners las rotulan "(edit)". Después la cola
sigue (un pañal normal entró, 201). **Nada se escribió ni se corrompió.** Falla
cerrado. Salida: Descartar cada entrada y volver a registrar a mano.

## 5. La leche registrada por teléfonos viejos durante la ventana

Entra como fila **legada**: total sin izq/der, **sin contenedor**. No suma a
"Lo que hay" ni puede servirse en un biberón con desglose. Y un biberón de leche
materna registrado por la vieja **no descuenta** de ningún contenedor: "Lo que
hay" muestra leche que ya se tomó. Para que entre al
inventario, después de actualizar: borrarla desde Historial (⋯ → Borrar) y
volver a registrarla en Leche con izquierda/derecha y su cinta. Un biberón
registrado por la vieja queda como toma sin desglose: cuenta en los totales de
comida y no descuenta leche de ningún contenedor.

## 6. Cómo acortar la ventana

1. Aplicar 0014 y pushear **seguidos** (runbook pasos 4–7): la ventana con la
   base nueva y sin app nueva publicada dura lo que tarde Vercel (~1 min medido
   en el pasado, §2.1 de `CLAUDE.md`).
2. Cerrar del todo y reabrir la PWA en cada teléfono y recargar la pantalla de
   pared (runbook paso 8): una pestaña abierta conserva el JS viejo en memoria
   aunque el service worker ya tenga lo nuevo.
3. No registrar leche hasta haber hecho el paso 2 en ese aparato.

## 7. Aceptable y no aceptable

**Aceptable en la ventana:** bloqueos visibles sin cambios en la base (B1–B3,
B5d); leche registrada por la vieja fuera del inventario (B4, §5); el total
inflado de la `/pumping` vieja (solo pantalla); códigos de error crudos.

**No aceptable (y corregido):** que la app vieja no pudiera registrar ni borrar
ninguna extracción y que una extracción encolada offline se perdiera (S6).

**No encontrado:** ningún caso en que una escritura de la app vieja altere
`remaining_ml` o las porciones. Se verificó con SQL antes/después en B1–B6.

**Pero ojo (auditoría de seguridad y datos):** que la base quede coherente no
quiere decir que "Lo que hay" coincida con la heladera. Un biberón de leche
materna dado con la app vieja no descuenta nada, así que el número queda **por
encima** de la leche real. Es aceptable **solo** con la regla de la ventana
(runbook paso 0: no registrar leche desde un aparato sin actualizar) y la
consulta de control del runbook paso 9, que lista lo que entró por la vía vieja.

## 8. NO VERIFICADO

- Event triggers de recarga de PostgREST en el proyecto de la nube (sin credenciales).
- PWA instalada en iOS / WebKit (no hay WebKit en este VPS); el service worker se
  ejercitó en Chromium.
- B7 en un perfil real de teléfono (se hizo por inyección de IndexedDB).
- La UI en español de la app **vieja** sobre la base nueva (se recorrió en inglés;
  la nueva sí se recorrió en los dos idiomas).
