# Arquitectura — Inventario de leche v4 (fases 1 y 2)

Rama `feat/milk-inventory-v4`, worktree `../amelia_app-v4`, escrito el
6 oct 2026 **antes** del código (hito H1, `docs/progreso-feeding-v4.md`).

Entradas: `docs/respuestas-papa-leche.md` (fuente de verdad),
`docs/spec-feeding-v4.md` (requisitos V4-xx, decisiones D-1…D-23),
`supabase/migrations/0014_milk_inventory.sql`, `lib/milk.ts`, `lib/db.ts`,
`lib/queue.ts`, `lib/types.ts`, `docs/compatibilidad-leche.md`,
`docs/milk-business-logic.md`, las pruebas de leche y las pantallas.
Todo lo que cito como "0014:n" es una línea de esa migración tal como está en
`5439173`.

Lo que este documento fija y la implementación no puede cambiar sin volver
acá: **nombres de columnas y tablas, firmas de funciones, códigos de error,
orden de bloqueos, la invariante contable y la reversa**. Lo que deja libre:
nombres internos de variables, el texto exacto de los mensajes (que va por
`lib/i18n`) y el reparto de componentes de React mientras se respete §8.

El plan de pruebas que acompaña a este documento es `docs/plan-pruebas-v4.md`.

---

## 0. Resumen de decisiones de arquitectura

| # | Decisión | Por qué, en una línea |
|---|---|---|
| A1 | Estados del biberón **derivados de columnas**, sin enum: `voided_at`, `released_at`, fila viva en `milk_discards`, `expires_at` | Fase 3 suma estados (Enfriando) con una columna, sin migrar datos |
| A2 | `milk_containers.released_at` + índice único parcial `milk_containers_label_occupied (baby_id, label) where voided_at is null and released_at is null` | Un vaciado libera su número (reglas 4–5) |
| A3 | `milk_containers.lost_ml` = leche que volvió de una toma y **no pudo entrar** a ningún biberón (D-9) | Sin ella la cuenta no cierra; con ella la invariante es una igualdad exacta |
| A4 | **Una** función interna `milk_rebalance(container, cause)` reparte toda variación del residuo (`amount − servido`) entre `remaining`, `lost` y el desecho | Una sola regla, en un solo lugar, para las siete RPC |
| A5 | Tabla `milk_discards` (desechos) y tabla `milk_feeding_edits` (registro de ediciones aplicadas, por `p_op_id`) | Desechar es un hecho histórico; editar necesita idempotencia que sobreviva al ABA |
| A6 | `babies.milk_bottle_count integer not null default 6 check (between 1 and 30)` | Mismo lugar, misma policy y mismo guardado que las reglas de conservación |
| A7 | `log_bottle_feed` y `void_bottle_feed` se **dropean y recrean** (parámetro con default / retorno `jsonb`); las otras cinco de 0014 son `create or replace` con la misma firma | PostgREST elige por nombres de argumentos: una sobrecarga daría `PGRST203` |
| A8 | Código de cable para "biberón ocupado": **`milk_label_taken:M#`** (el de 0014), no uno nuevo | La app v3 cacheada ya lo traduce (ver Ajuste AJ-1) |
| A9 | Caducidad: registrar/editar una toma valida contra la hora **de la toma** + tope de 10 min al futuro según la **base**; desechar se decide con `now()` de la **base** | D-15 |
| A10 | Estimación hacia atrás: función pura `estimateLegacySplit`, **no persistida** | D-14 |
| A11 | Reversa en `docs/rollback-leche-v4.sql`, una transacción, deja `pg_dump --schema-only` idéntico a 0001–0014; anula los contenedores que v3 no puede representar | §10 |

---

## 1. Estado del biberón

### 1.1 Columnas nuevas de `milk_containers` (0015)

| Columna | Tipo | Regla |
|---|---|---|
| `released_at` | `timestamptz null` | Se fija en el **servidor** (`now()`) cuando el contenedor deja de ocupar su número: se vació por tomas, se desechó. `null` = ocupa su número (si no está anulado) |
| `lost_ml` | `numeric not null default 0`, `check (lost_ml >= 0 and lost_ml < 100000)` | Leche de este contenedor que volvió de una toma (anulada o bajada) o de un aumento de la extracción, y que **no pudo** volver a entrar (D-9) |

Constraint nueva, estructural: `milk_containers_released_empty check
(released_at is null or remaining_ml < 0.15)`. Un liberado nunca tiene leche
que cuente: el polvo de redondeo (< `EMPTY_ML`) puede quedar en
`remaining_ml`, pero nunca suma porque un liberado no es utilizable.

`0.15` es `EMPTY_ML` de `lib/milk.ts:99`. En SQL aparece como literal en la
constraint y en `milk_rebalance`; un test unitario compara los dos valores
leyendo el texto de la migración (U-41).

### 1.2 Estados (derivados, en este orden de precedencia)

| Estado | Condición | Ocupa número | Suma a "Lo que hay" | Se puede servir | Acciones en pantalla |
|---|---|---|---|---|---|
| **anulado** | `voided_at is not null` | no | no | no | ninguna (no se lista) |
| **desechado** | no anulado, hay fila viva en `milk_discards` | no | no | no | Historial muestra el desecho, sin editar (D-11) |
| **libre** (vaciado) | no anulado, `released_at is not null`, sin desecho vivo | no | no | no | ninguna; el número aparece libre en el selector |
| **caducada** | no anulado, `released_at is null`, `expires_at <= ahora` | **sí** | no | no | "Caducada" + "Desechar" |
| **ocupado** | no anulado, `released_at is null`, `expires_at > ahora` | **sí** | sí (si `remaining ≥ EMPTY_ML`) | sí | — |

"ahora" es el reloj del dispositivo **solo para pintar**; quien decide un
desecho es `now()` de la base (§4).

Función pura (cliente): `containerState(c, discards, atMs): 'voided' |
'discarded' | 'free' | 'expired' | 'occupied'` en `lib/milkBottles.ts` (§7.1).

### 1.3 Índice de ocupación

0015 hace, en este orden (después del backfill de §6):

```
drop index milk_containers_label_live;
create unique index milk_containers_label_occupied
  on milk_containers (baby_id, label)
  where voided_at is null and released_at is null;
```

Es el respaldo; la decisión la toman las funciones bajo el advisory lock
`amelia_milk_label:<baby_id>` (el de 0014:408), así el que llega segundo ve un
`milk_label_taken:M#` y nunca un `23505` crudo.

### 1.4 Transiciones

| De → a | Quién | Cómo |
|---|---|---|
| (nada) → ocupado | `log_pumping_session`, `update_pumping_session` (sesión que gana cantidad) | `milk_create_container` bajo lock de etiqueta; si el número está ocupado → `milk_label_taken:M#` |
| ocupado → libre | `milk_rebalance` tras servir o bajar la extracción | `remaining_ml < 0.15` ⇒ `released_at = now()` |
| ocupado/caducada → desechado | `discard_container` | fila en `milk_discards` por **todo** `remaining_ml`; `remaining_ml = 0`, `released_at = now()` |
| libre → ocupado (**re-ocupar**) | `milk_rebalance` con leche que vuelve (`void_bottle_feed`, `edit_bottle_feed` a la baja, `update_pumping_session` al alza) | solo si el número **sigue libre** (consulta bajo lock de etiqueta) y el contenedor **no** está desechado: `released_at = null`, `remaining_ml += vuelta` |
| libre con número reusado → (sigue libre) | ídem | la vuelta va a `lost_ml` (D-9), la respuesta lo informa |
| desechado → (sigue desechado) | ídem con leche que vuelve de una toma | a `lost_ml` (D-9) |
| desechado ↔ desechado con otro total | `update_pumping_session` (D-8) | ver §2.3 |
| cualquiera no servido → anulado | `void_pumping_session` | anula contenedor **y** su desecho vivo (caso límite 17) |

Un contenedor vencido **sí** recibe leche que vuelve (D-9): queda como caducada.

---

## 2. Invariante contable

### 2.1 La igualdad

Para todo contenedor **no anulado**:

```
amount_ml = servido_vivo + desechado_vivo + lost_ml + remaining_ml
```

- `servido_vivo` = `sum(milk_drawdowns.amount_ml)` vivas del contenedor
  (`milk_served_ml`, 0014:430).
- `desechado_vivo` = `sum(milk_discards.amount_ml)` vivas del contenedor
  (`milk_discarded_ml`, nueva). En v4 hay como mucho una (índice único
  parcial); la suma deja lugar al desecho parcial de fase 4.
- `lost_ml` y `remaining_ml` = columnas.

Por qué cierra siempre: **ninguna** RPC escribe `remaining_ml` ni `lost_ml`
con aritmética propia; todas cambian lo que les toca (`amount_ml`, porciones,
desecho) y llaman a `milk_rebalance`, que recalcula el reparto del residuo
`amount − servido` (§2.3). "Lo que hay" suma solo `remaining_ml` de
utilizables, así que la leche que va a `lost_ml` **nunca** lo hace subir.

### 2.2 Invariantes de estado (complementan la igualdad)

| ID | Invariante |
|---|---|
| INV-1 | La igualdad de §2.1 con tolerancia `1e-9` ml |
| INV-2 | Nunca dos contenedores ocupados (`voided_at is null and released_at is null`) con el mismo `(baby_id, label)` |
| INV-3 | Desecho vivo ⇒ contenedor no anulado, `released_at is not null`, `remaining_ml = 0` |
| INV-4 | Contenedor anulado ⇒ 0 porciones vivas y 0 desechos vivos |
| INV-5 | Ocupado ⇒ `remaining_ml >= 0.15`; liberado ⇒ `remaining_ml < 0.15` (lo segundo es constraint) |
| INV-6 | Toma viva con desglose ⇒ `breast_milk_ml = sum(porciones vivas)` y `amount_ml = breast_milk_ml + formula_ml` |
| INV-7 | `leftover_ml is null or amount_ml is null or leftover_ml <= amount_ml` (constraint) |
| INV-8 | Sesión viva con contenedor vivo ⇒ `pumping_sessions.amount_ml = milk_containers.amount_ml` |
| INV-9 | Porción viva ⇒ su toma está viva (no hay porciones colgando de una toma anulada) |

### 2.3 `milk_rebalance(p_container_id uuid, p_cause text) returns jsonb`

Interna, `security invoker`, `search_path = public`, sin `execute` para
`anon`/`public`, ejecutable por `authenticated` (como `milk_create_container`).
**Precondición:** el que llama ya tiene `FOR UPDATE` sobre el contenedor y ya
cambió `amount_ml` o las porciones. `p_cause in ('serve', 'return', 'amount')`.

```
residuo_nuevo = amount_ml − servido_vivo
partes        = remaining_ml + desechado_vivo + lost_ml        (estado anterior)
delta         = residuo_nuevo − partes
```

- `delta > 0` (entra leche):
  - `cause = 'amount'` y hay desecho vivo → el desecho crece `delta` (D-8:
    "desechado = total − servido", descontando lo perdido).
  - si no, ¿puede recibir? = no está desechado **y** (`released_at is null`
    **o** el número no lo ocupa otro contenedor, consultado bajo
    `pg_advisory_xact_lock(hashtext('amelia_milk_label:'||baby_id))`):
    - sí → `remaining_ml += delta`, `released_at = null` (re-ocupa);
    - no → `lost_ml += delta`.
- `delta < 0` (sale leche que no está servida — solo por `cause = 'amount'`,
  porque servir lo valida antes contra `remaining_ml`): se descuenta de
  `remaining_ml`, después de `lost_ml`, después del desecho. Si el desecho
  llega a 0 o menos, su fila se **anula** (`voided_at = now()`, su
  `amount_ml` queda como estaba: la CHECK `> 0` lo exige) y el contenedor
  queda **libre** sin desecho.
- Después: si `released_at is null` y `remaining_ml < 0.15` →
  `released_at = now()`.
- Devuelve `{"label": "M3", "returned_ml": x, "lost_ml": y}` (lo que entró a
  `remaining` y lo que fue a `lost` en esta llamada; 0 y 0 si no hubo entrada).

`servido_vivo > amount_ml` nunca llega acá: lo impiden
`milk_served_exceeds_amount` (extracción) y `milk_overdraw` (toma).

### 2.4 Consulta de invariante (QA y auditor; tiene que devolver 0 filas)

```sql
-- Invariante contable y de estado del inventario de leche (0015).
-- Correr como postgres (salta RLS). 0 filas = cierra.
with srv as (
  select container_id, sum(amount_ml) as ml
  from milk_drawdowns where voided_at is null group by container_id
), dsc as (
  select container_id, sum(amount_ml) as ml, count(*) as n
  from milk_discards where voided_at is null group by container_id
)
select 'INV-1 cuenta' as falla, c.id, c.label,
       c.amount_ml, coalesce(s.ml,0) as servido, coalesce(d.ml,0) as desechado,
       c.lost_ml, c.remaining_ml
  from milk_containers c
  left join srv s on s.container_id = c.id
  left join dsc d on d.container_id = c.id
 where c.voided_at is null
   and abs(c.amount_ml - coalesce(s.ml,0) - coalesce(d.ml,0) - c.lost_ml - c.remaining_ml) > 1e-9
union all
select 'INV-2 número doble', min(c.id::text)::uuid, c.label, null,null,null,null,null
  from milk_containers c
 where c.voided_at is null and c.released_at is null
 group by c.baby_id, c.label having count(*) > 1
union all
select 'INV-3 desecho incoherente', c.id, c.label, null,null,d.ml,null,c.remaining_ml
  from milk_containers c join dsc d on d.container_id = c.id
 where c.voided_at is not null or c.released_at is null or c.remaining_ml <> 0
union all
select 'INV-4 anulado con vivos', c.id, c.label, null, s.ml, d.ml, null, null
  from milk_containers c
  left join srv s on s.container_id = c.id
  left join dsc d on d.container_id = c.id
 where c.voided_at is not null and (s.ml is not null or d.ml is not null)
union all
select 'INV-5 ocupado vacío', c.id, c.label, null,null,null,null,c.remaining_ml
  from milk_containers c
 where c.voided_at is null and c.released_at is null and c.remaining_ml < 0.15
union all
select 'INV-6 desglose', f.id, null, f.amount_ml, coalesce(p.ml,0), null, null, f.breast_milk_ml
  from feedings f
  left join (select feeding_id, sum(amount_ml) ml from milk_drawdowns
              where voided_at is null group by feeding_id) p on p.feeding_id = f.id
 where f.voided_at is null and (f.breast_milk_ml is not null or f.formula_ml is not null)
   and (abs(coalesce(f.breast_milk_ml,0) - coalesce(p.ml,0)) > 1e-9
        or abs(f.amount_ml - coalesce(f.breast_milk_ml,0) - coalesce(f.formula_ml,0)) > 1e-9)
union all
select 'INV-8 sesión≠contenedor', c.id, c.label, c.amount_ml, null,null,null, ps.amount_ml
  from milk_containers c join pumping_sessions ps on ps.id = c.source_session_id
 where c.voided_at is null and ps.voided_at is null and ps.amount_ml is distinct from c.amount_ml
union all
select 'INV-9 porción huérfana', d.feeding_id, null, d.amount_ml, null,null,null,null
  from milk_drawdowns d join feedings f on f.id = d.feeding_id
 where d.voided_at is null and f.voided_at is not null;
```

INV-7 es constraint. La misma consulta se corre **al final de 0015** dentro de
un `do $$ … $$` que hace `raise exception 'milk_invariant_broken'` si
devuelve algo (la migración no se aplica sobre datos que no cierran) y al
final de cada prueba de integración de leche (helper `assertMilkInvariant` en
`tests/helpers/milkInvariant.ts`, ver la nota).

> Nota de implementación: PostgREST no corre SQL libre. Para las pruebas de
> integración, el helper reconstruye la invariante en TypeScript con tres
> lecturas de `adminClient()` (`milk_containers`, `milk_drawdowns`,
> `milk_discards`, `feedings`) y la misma aritmética; la consulta SQL de arriba
> es la que se corre con `pnpm db:psql` en QA/E-xx y en la auditoría. Las dos
> tienen que estar escritas con los mismos nueve chequeos (U-42 compara la
> lista de IDs).

---

## 3. Funciones (RPC)

### 3.0 Reglas comunes (las de 0014, sin excepción)

- `language plpgsql security invoker set search_path = public`.
- Actor = `auth.uid()`; `null` → `milk_not_signed_in`. **Nunca** un parámetro
  de actor ni de familia: la familia sale del bebé/contenedor/toma, que RLS
  solo deja ver si es de quien llama.
- Bandera `amelia.milk_rpc` prendida al entrar (`set_config(..., true)`) y
  apagada antes de **cada** salida.
- Topes: toda cantidad se valida con `not (x >= 0 and x < 100000)` (o `> 0`
  donde corresponda), que rechaza `NaN` e `Infinity`.
- `revoke all … from public, anon; grant execute … to authenticated` para
  cada función nueva o recreada.
- **Orden de bloqueo global** (igual en todas, para no cruzarse):
  1. `pg_advisory_xact_lock(hashtext('amelia_milk_op:' || <id de la operación>))`
  2. si hay toma o sesión objetivo: `pg_advisory_xact_lock` sobre su id (si
     difiere del de 1) y `SELECT … FOR UPDATE` de esa fila;
  3. contenedores `FOR UPDATE` en **un solo** `select … where id = any($set)
     order by id`;
  4. `amelia_milk_label:<baby_id>` (advisory), **siempre al final**, solo si
     hay que ocupar o re-ocupar un número.
- Errores: `raise exception '<código>[:<sufijo>]'`. Códigos estables:

| Código | Sufijo | Quién | Nuevo |
|---|---|---|---|
| `milk_not_signed_in` | — | todas | |
| `milk_bad_input` | — | todas | |
| `milk_baby_not_found` | — | log_* | |
| `milk_idempotency_conflict` | — | log_*, discard, edit | |
| `milk_label_taken` | etiqueta | log_pumping, update_pumping | (texto nuevo: "biberón") |
| `milk_overdraw` | etiqueta | log_bottle_feed | |
| `milk_container_unusable` | etiqueta o nada | log_bottle_feed, edit, discard, trigger | |
| `milk_already_served` | etiqueta | update/void_pumping | |
| `milk_served_exceeds_amount` | etiqueta | update_pumping | |
| `milk_session_gone` | — | update_pumping | |
| `milk_rpc_only` | — | triggers | |
| `milk_not_expired` | etiqueta | discard_container | **sí** |
| `milk_not_enough` | ml disponibles (número, `round(x, 4)`) | edit_bottle_feed | **sí** |
| `milk_edit_conflict` | — | edit_bottle_feed | **sí** |
| `milk_future_time` | — | log_bottle_feed, edit, trigger de feedings | **sí** |
| `milk_feeding_gone` | — | edit_bottle_feed | **sí** |
| `milk_not_inventory` | — | edit_bottle_feed (toma sin desglose) | **sí** |
| `milk_invariant_broken` | — | solo la migración | **sí** |

### 3.1 Funciones de 0014 que cambian **solo el cuerpo** (`create or replace`, misma firma)

| Función | Firma (sin cambios) | Cambio de cuerpo |
|---|---|---|
| `milk_create_container` | `(uuid, text, uuid, uuid, numeric, timestamptz) returns void` | El chequeo de número ocupado pasa a `voided_at is null and released_at is null`. Sin validar `≤ N` (D-1/D-2). |
| `log_pumping_session` | `(p_id uuid, p_baby_id uuid, p_side text, p_left_ml numeric, p_right_ml numeric, p_notes text, p_pumped_at timestamptz, p_container_id uuid default null, p_container_label text default null, p_container_expires_at timestamptz default null) returns void` | Idempotencia: además de bebé y `container_id`, si existe la sesión y su contenedor tiene **otra etiqueta** que `p_container_label` → `milk_idempotency_conflict` (la etiqueta no se edita nunca, así que compararla es estricto sin romper ediciones). Con cantidad y sin etiqueta → `milk_bad_input` (como hoy, vía `milk_create_container`). |
| `update_pumping_session` | `(p_id uuid, p_side text, p_left_ml numeric, p_right_ml numeric, p_notes text, p_pumped_at timestamptz, p_container_id uuid default null, p_container_label text default null, p_container_expires_at timestamptz default null) returns void` | Ver §3.3. |
| `void_pumping_session` | `(p_id uuid, p_voided_at timestamptz default null) returns void` | Ver §3.4. |
| `milk_guard_feedings` | trigger | Ver §3.9. |

`milk_expires_at`, `milk_served_ml`, `milk_in_rpc`, `milk_guard_pumping`,
`milk_guard_inventory`, `milk_guard_containers` **no se tocan**.

### 3.2 `log_pumping_session` v4 — flujo

1. `auth.uid()`; bandera; topes (`p_left_ml`, `p_right_ml` finitos ≥ 0 y < 100000; `p_side` válido).
2. Bebé visible (RLS) → si no, `milk_baby_not_found`.
3. Lock `amelia_milk_op:p_id`.
4. Si existe la sesión `p_id`: mismo bebé, y (`p_container_id` nulo o es el
   contenedor de esta sesión) y (sin contenedor vivo o su `label =
   p_container_label`) → **no-op**; si no → `milk_idempotency_conflict`.
5. `p_pumped_at > now() + 10 min` → `milk_future_time` (m-2, auditoría H5:
   mismo tope que D-15; va después del paso 4, así el reenvío de un alta ya
   guardada no se re-valida). Total con `0 < T < 0,15` ml (polvo, EMPTY_ML) →
   `milk_bad_input` (M-1: si no, nacía un ocupado casi vacío, contra INV-5).
   Inserta la sesión (total = izq + der, nulo si 0).
6. Total > 0 → `milk_create_container` (lock de etiqueta al final; ocupado →
   `milk_label_taken:M#`). `stored_at = p_pumped_at` (D-3).

Sin cambio de semántica para la app v3: misma firma, mismas respuestas, salvo
que **ahora un número liberado se puede reusar** (antes `milk_label_taken`).

### 3.3 `update_pumping_session` v4

Bloqueos: op(`p_id`) → sesión `FOR UPDATE` → contenedor vivo de la sesión
`FOR UPDATE` → (etiqueta, dentro de `milk_rebalance` o `milk_create_container`).

| Caso | Regla |
|---|---|
| `p_pumped_at > now() + 10 min` (cualquier sesión, legada incluida) | `milk_future_time` (m-2) |
| Sesión legada sin lados (0014:575) | Igual que 0014: solo hora y nota |
| Total nuevo `0 < T < 0,15` ml | `milk_bad_input` (M-1) |
| Total nuevo `T = 0` y contenedor con `servido > 0` | `milk_already_served:M#` |
| `T = 0`, contenedor sin servir | anula contenedor **y** su desecho vivo; sesión sin total |
| `T > 0` y `T < servido_vivo` | `milk_served_exceeds_amount:M#` (V4-19) |
| `T > 0`, contenedor vivo | `amount_ml = T`, `stored_at = p_pumped_at`, `expires_at` recalculada (como 0014:601-605); `milk_rebalance(c, 'amount')`. **No** re-valida tomas ya servidas (D-7). Subir sobre desechado → crece el desecho (D-8); subir sobre libre con número reusado → `lost_ml` (D-9); subir sobre libre con número libre → re-ocupa; bajar → sale de remaining → lost → desecho |
| `T > 0`, sin contenedor | nace con `p_container_label` (que v4 manda **elegido**, AJ-5); ocupado → `milk_label_taken` |
| Cambia solo la división izq/der con el mismo total | `delta = 0`: `remaining_ml` no se mueve (V4-03 CA) |

Idempotencia: como 0014, por **estado final** (valores absolutos). Una edición
reenviada que ya se aplicó es no-op. No se agrega `p_op_id` acá (AJ-3 explica
por qué alcanza para extracciones y no para tomas).

### 3.4 `void_pumping_session` v4

Op(`p_id`) → sesión `FOR UPDATE` → contenedor vivo `FOR UPDATE`.
Servido > 0 → `milk_already_served:M#` (aunque esté desechado o libre: caso
18). Si no: anula el contenedor, **anula su desecho vivo** (caso 17: el total
de desechada baja) y la sesión. Ya anulada o inexistente → no-op (0014).

### 3.5 `discard_container` (nueva)

```
discard_container(
  p_id uuid,                     -- id de la fila de milk_discards, hecho en el dispositivo
  p_container_id uuid,
  p_discarded_at timestamptz default null
) returns void
```

1. Auth, bandera; `p_id`/`p_container_id` no nulos → si no, `milk_bad_input`.
2. Lock op(`p_id`).
3. Existe `milk_discards.id = p_id`: mismo contenedor → **no-op**; otro →
   `milk_idempotency_conflict`.
4. Contenedor `FOR UPDATE`; no visible (RLS) o inexistente →
   `milk_container_unusable`.
5. Anulado, ya desechado, o libre → **no-op** (V4-34: el segundo teléfono no
   ve rechazo; CA3 una sola fila).
6. `now() < expires_at` → `milk_not_expired:M#` (D-6, D-15; la base decide).
7. Inserta `milk_discards (id = p_id, family_id, baby_id, container_id,
   amount_ml = remaining_ml, discarded_at = greatest(expires_at,
   least(coalesce(p_discarded_at, now()), now())), reason = 'expired',
   logged_by = auth.uid())`. Si `remaining_ml < 0.15` (no hay nada que tirar)
   no inserta y libera (caso degenerado; no debería existir por INV-5).
8. `remaining_ml = 0`, `released_at = now()`.

Desechar un contenedor del que ya se sirvió leche está permitido (caso 16):
solo se tira lo que queda. **No** se deshace en v4 (D-11): no hay
`void_discard`.

### 3.6 `log_bottle_feed` v4 (drop + create)

```
log_bottle_feed(
  p_id uuid, p_baby_id uuid, p_fed_at timestamptz, p_notes text,
  p_formula_ml numeric, p_portions jsonb,
  p_leftover_ml numeric default null
) returns void
```

Se hace `drop function log_bottle_feed(uuid, uuid, timestamptz, text, numeric,
jsonb)` y `create function` con el séptimo parámetro **con default**, en la
misma transacción. La app v3 llama con seis nombres y PostgREST resuelve a esta
(con una sobrecarga de seis y otra de siete los dos matchearían → `PGRST203`).

Cambios respecto de 0014:

- `p_fed_at > now() + interval '10 minutes'` → `milk_future_time` (D-15).
- `p_leftover_ml`: nulo, o `0 <= x < 100000` y `x <= breast + formula`; si no
  → `milk_bad_input` (V4-43). Se guarda en `feedings.leftover_ml`. **No toca
  el inventario** (D-10).
- Disponible por contenedor = `remaining_ml` (no `amount − servido`, que en v4
  ignoraría desecho y pérdida). Contenedor **liberado** → disponible 0 →
  `milk_overdraw:M#` (D-22: desechado mientras otro servía offline).
  Anulado / de otro bebé / vencido a `p_fed_at` → `milk_container_unusable:M#`
  (0014).
- Después de insertar porciones: `milk_rebalance(c, 'serve')` por contenedor
  (en orden de id): libera los que quedan `< 0.15`.
- Idempotencia: como 0014 (bebé, tipo, fórmula, conjunto de porciones) **más**
  `leftover_ml`. **Excepción (AJ-8):** si la toma existe y tiene al menos una
  fila en `milk_feeding_edits`, el reenvío del alta es **no-op** (el alta ya
  se aplicó y una edición posterior la reemplazó; compararla con el estado
  editado daría un conflicto falso).

### 3.7 `void_bottle_feed` v4 (drop + create, cambia el retorno)

```
void_bottle_feed(p_feeding_id uuid, p_voided_at timestamptz default null)
returns jsonb   -- {"returned_ml": n, "lost": [{"label": "M3", "ml": n}, …]}
```

Op(`p_feeding_id`) → toma `FOR UPDATE` → contenedores de sus porciones vivas
(orden id) → anula porciones → `milk_rebalance(c, 'return')` por contenedor →
anula la toma. No-op (devuelve `{"returned_ml":0,"lost":[]}`) si no existe o
ya está anulada. La app v3 ignora el cuerpo de la respuesta (verificado:
`sendOpWith` solo lee `error`, `lib/db.ts:136-138`).

### 3.8 `edit_bottle_feed` (nueva)

```
edit_bottle_feed(
  p_op_id uuid,             -- id de ESTA edición, hecho en el dispositivo
  p_feeding_id uuid,
  p_fed_at timestamptz,
  p_breast_ml numeric,      -- absolutos: el estado final pedido
  p_formula_ml numeric,
  p_leftover_ml numeric,    -- null = "no se sabe"
  p_notes text,
  p_expected jsonb          -- {"fed_at","breast_milk_ml","formula_ml","leftover_ml"} que vio la pantalla
) returns jsonb             -- {"returned_ml", "lost":[{label,ml}], "taken":[{label,ml}]}
```

**Cómo es idempotente una edición reenviada (decisión AJ-3).** Valores
absolutos + `p_expected` no alcanzan: con A→B (esta edición) y después B→A
(otro teléfono), un reenvío tardío de A→B encuentra el estado A = esperado y lo
vuelve a aplicar, pisando al otro (ABA). Por eso:

- Tabla `milk_feeding_edits` (§3.10) con `op_id` como PK y el `request`
  canónico (`jsonb` de todos los argumentos salvo `p_op_id`).
- `op_id` ya registrado con el mismo `request` → **no-op**, devuelve el
  `result` guardado. Mismo `op_id` con otro `request` →
  `milk_idempotency_conflict`.
- `p_expected` sigue sirviendo para la **concurrencia** (regla 21): si el
  estado actual no es ni el pedido ni el esperado → `milk_edit_conflict`; si
  ya es el pedido (otra edición llegó a lo mismo) → registra el op como no-op.

Flujo:

1. Auth, bandera, topes: `p_breast_ml >= 0`, `p_formula_ml >= 0`, ambos
   `< 100000`, `0 < breast + formula < 100000`, `leftover` nulo o
   `0 <= x <= breast + formula`, `p_fed_at` no nulo, `p_op_id` y
   `p_feeding_id` no nulos, `p_expected` objeto con las cuatro claves.
2. Lock op(`p_op_id`); si está en `milk_feeding_edits` → paso de idempotencia.
3. Lock op(`p_feeding_id`) (serializa con `void_bottle_feed` y otras
   ediciones); toma `FOR UPDATE`. Inexistente o anulada →
   `milk_feeding_gone`. Sin desglose → `milk_not_inventory` (D-14b).
4. Igual al pedido (fecha, leche, fórmula, sobró, nota) → registrar op, no-op.
5. Distinto del esperado → `milk_edit_conflict`.
6. `p_fed_at > now() + 10 min` → `milk_future_time`.
7. **Plan** (`Δ = p_breast_ml − breast_milk_ml`):
   - `Δ < 0` (D-17): se recorren las porciones vivas de la más **nueva** a la
     más vieja (`stored_at desc, label desc`); cada una baja hasta 0 (y se
     **anula** si llega a 0) antes de pasar a la siguiente.
   - `Δ > 0` (D-18): candidatos = contenedores del bebé no anulados, **no
     liberados**, con `stored_at <= p_fed_at`, `expires_at > p_fed_at` y
     `remaining_ml >= 0.15`, en orden `stored_at, número`. FIFO puro: se toma
     `min(remaining, falta)`. Si el contenedor ya tiene porción en esta toma,
     esa porción **crece** (el `unique (feeding_id, container_id)` de 0014
     impide otra fila; si la porción estaba anulada por una edición anterior,
     se **reaviva** con el monto nuevo).
   - No alcanza → `milk_not_enough:<ml disponibles>` y nada se escribe
     (V4-54). La fórmula no tiene inventario y nunca bloquea **por sí misma**.
8. Bloqueo: el conjunto = contenedores de porciones actuales ∪ candidatos, en
   un `select … order by id for update`; con los locks tomados se **recalcula**
   el plan (otro pudo servir mientras se esperaba).
9. **Re-validación por hora** (D-7, V4-55): **solo si la edición mueve la
   hora (`p_fed_at` distinto) o la leche (`Δ ≠ 0`)** (m-1, auditoría H5), cada
   porción que queda viva tiene que ser de un contenedor con `expires_at >
   p_fed_at` y `stored_at <= p_fed_at + 10 min`; si no →
   `milk_container_unusable:M#`. Cambiar solo nota, sobró o fórmula no
   re-valida: una toma que `log_bottle_feed` aceptó (anterior a la extracción,
   S-17; o cuya extracción se movió después, D-7) no queda bloqueada para
   corregirle la nota.
10. Escribe porciones; `milk_rebalance(c, 'return')` para las que bajaron y
    `('serve')` para las que subieron; actualiza la toma (`fed_at`,
    `breast_milk_ml`, `formula_ml`, `amount_ml = breast + formula`,
    `leftover_ml`, `notes`); inserta `milk_feeding_edits` con `before`,
    `request` y `result`.

### 3.9 Trigger `milk_guard_feedings` v4 (mismo nombre, cuerpo nuevo)

Fuera de las RPC:

- **INSERT** con desglose → `milk_rpc_only` (igual). Con `leftover_ml` y sin
  desglose → **pasa** (estadística; ningún cliente lo hace hoy).
- **UPDATE de toma sin desglose** (legada/estimada): libre como en 0014
  (v0.12.1 y la app v4 la editan entera, D-11b), y nunca gana desglose. Bajar
  `amount_ml` por debajo de `leftover_ml` falla por la constraint (`23514`,
  visible; aceptado en D-11b).
- **UPDATE de toma con desglose**: solo `fed_at` y `notes` (igual que 0014);
  `leftover_ml` pasa a la lista de columnas protegidas (AJ-13). Si cambia
  `fed_at`: `new.fed_at > now() + 10 min` → `milk_future_time`; y por cada
  porción viva, contenedor con `expires_at <= new.fed_at` o `stored_at >
  new.fed_at + 10 min` → `milk_container_unusable:M#` (V4-58). La app v4
  **nunca** usa este camino; queda para v0.12.1 y v3.

### 3.10 Tablas nuevas

**`milk_discards`**

| Columna | Tipo |
|---|---|
| `id` | `uuid primary key` (lo genera el dispositivo; sin default útil) |
| `family_id` | `uuid not null references families(id) on delete cascade` |
| `baby_id` | `uuid not null` |
| `container_id` | `uuid not null` |
| `amount_ml` | `numeric not null check (amount_ml > 0 and amount_ml < 100000)` |
| `discarded_at` | `timestamptz not null` |
| `reason` | `text not null default 'expired' check (reason in ('expired'))` |
| `voided_at` | `timestamptz` |
| `logged_by` | `uuid references auth.users(id)` |
| `created_at` | `timestamptz not null default now()` |

Constraints: FK `(baby_id, family_id) → babies (id, family_id)`, FK
`(container_id, family_id) → milk_containers (id, family_id)` (mismas que
`milk_drawdowns`, 0014:121-127). Índices: `milk_discards_one_live (container_id)
unique where voided_at is null`; `milk_discards_baby_live (baby_id) where
voided_at is null`. RLS en la misma migración: select/insert/update con
`is_family_member(family_id)` y `with check (is_family_member(family_id) and
is_baby_family_member(baby_id))`. `revoke all … from anon, authenticated;
grant select, insert, update … to authenticated` (sin delete). Trigger
`milk_guard_discards before insert or update … execute function
milk_guard_inventory()`.

**`milk_feeding_edits`**

| Columna | Tipo |
|---|---|
| `op_id` | `uuid primary key` |
| `family_id` | `uuid not null references families(id) on delete cascade` |
| `baby_id` | `uuid not null` |
| `feeding_id` | `uuid not null references feedings(id) on delete cascade` |
| `request` | `jsonb not null` |
| `before` | `jsonb not null` (fed_at, breast, formula, leftover, notes, porciones) |
| `result` | `jsonb not null` |
| `logged_by` | `uuid references auth.users(id)` |
| `created_at` | `timestamptz not null default now()` |

FK `(baby_id, family_id) → babies`. Índice `(feeding_id)`. RLS
select/insert por familia con WITH CHECK; `revoke all … from anon,
authenticated; grant select, insert … to authenticated` (ni update ni delete);
trigger `milk_guard_feeding_edits` → `milk_guard_inventory`. Sirve además de
auditoría ("quién cambió esta toma y qué había antes").

Tablas nuevas con `family_id` directo (CLAUDE.md §5.3) y RLS en la misma
migración (§5.2): **19 tablas creadas, 19 con RLS** después de 0015 (17
`create table` en 0001–0014, contados con `grep` el 6 oct 2026, + estas 2).

### 3.11 Columnas nuevas fuera del inventario

- `feedings.leftover_ml numeric check (leftover_ml >= 0 and leftover_ml <
  100000)` + `constraint feedings_leftover_le_amount check (leftover_ml is
  null or amount_ml is null or leftover_ml <= amount_ml)`. **Sin** chequeo de
  `feeding_type`: v0.12.1 puede pasar a `nursing` una toma legada con sobró y
  no debe recibir un error por un campo que no conoce; los lectores ignoran
  `leftover_ml` si el tipo no es `bottle`, y la app v4 lo limpia al cambiar el
  tipo.
- `babies.milk_bottle_count integer not null default 6 check
  (milk_bottle_count between 1 and 30)` (D-23).

**Dónde vive N — justificación (`babies`, no `family_settings`):**

1. Las etiquetas son únicas **por bebé** (índice de 0014 y el de 0015): N es
   el tamaño del espacio de etiquetas de ese bebé, así que va al lado.
2. Es el mismo lugar que `milk_room_hours`/`milk_fridge_days`/
   `milk_freezer_months` (S-21): misma policy `update own babies` (0006), mismo
   `saveMilkRules` directo sin cola, misma tarjeta de Ajustes. Uno solo de los
   dos lugares, no medio y medio.
3. `family_settings` (0012) se crea **perezosamente** por upsert y sus lectores
   asumen defaults si no hay fila; `babies` siempre existe y el `default 6`
   cubre altas de v0.12.1 (que solo escribe `{birth_date}`).
4. La reversa es un `drop column`.

Enganche: si algún día hay mellizos que comparten biberones físicos, N y la
unicidad pasan juntos a `family_id` (otra migración, no esta).

---

## 4. Caducidad: hora de la base vs. hora del teléfono (D-15)

| Operación | Contra qué se valida | Por qué |
|---|---|---|
| Crear contenedor | `expires_at = stored_at + milk_fridge_days × 24 h`, calculado por el servidor (0014:350) | S-15 |
| Registrar toma | `expires_at > p_fed_at` (S-6) **y** `p_fed_at <= now() + 10 min` | La toma offline de las 2 a.m. que llega a las 9 no se rechaza; un reloj adelantado no inventa una hora futura |
| Editar toma (RPC o trigger) | igual, con la hora nueva, más `stored_at <= fed_at + 10 min` — en la RPC, solo si la edición mueve hora o leche (m-1) | V4-55, V4-58 |
| Registrar / editar extracción | `p_pumped_at <= now() + 10 min` de la base (m-2). La vía directa de v0.12.1 (forma legada) no pasa por acá | Mismo motivo que la toma: un reloj adelantado no inventa una extracción futura (que además alargaría su caducidad) |
| Desechar | permiso: `now() >= expires_at` **de la base**; hora guardada: la del teléfono acotada a `[expires_at, now()]` | Un teléfono adelantado no desecha leche vigente |
| Pintar "Caducada" / ofrecer en el selector y en la sugerencia | reloj del teléfono | Solo pantalla; el servidor tiene la última palabra |

**Riesgos que quedan, escritos:**

1. Un teléfono con el reloj **atrasado** puede servir leche vencida en una toma
   "de ahora": su `p_fed_at` es anterior a `expires_at`. Cerrarlo exigiría
   `now()` al registrar, que rompe la toma offline de la madrugada. Tamaño del
   riesgo: el atraso del reloj. Los teléfonos con hora automática no lo tienen.
2. Un teléfono adelantado **pinta** "Caducada" y ofrece Desechar antes de
   tiempo; el servidor responde `milk_not_expired:M3` y la pantalla lo dice
   ("Todavía no venció según el servidor"). Offline, el desecho queda en cola y
   ese rechazo llega al sincronizar (banner con Descartar).
3. D-7: mover la hora de una **extracción** ya servida más tarde alarga su
   caducidad sin re-validar las tomas que ya salieron de ella.
4. El tope de 10 min es arbitrario y es el mismo en los tres lugares (una
   constante en SQL: `interval '10 minutes'`, y una en TS:
   `FUTURE_TOLERANCE_MS = 600_000` en `lib/milkBottles.ts`; U-40 verifica que
   coinciden).
5. "4 días" son 96 h exactas, no días de calendario: cruza el cambio de horario
   sin moverse (ya verificado en v3, se repite en U-05/I-xx).

---

## 5. Estimación hacia atrás (2B, D-14)

Módulo nuevo `lib/milkEstimate.ts`, puro, sin reloj (todas las horas salen de
los datos).

```ts
export type LegacySplit = { breastMl: number; formulaMl: number; estimated: true }

export function estimateLegacySplit(input: {
  /** Todas las tomas vivas del bebé de tipo bottle (con y sin desglose). */
  feedings: Pick<Feeding, 'id' | 'fed_at' | 'feeding_type' | 'amount_ml' | 'breast_milk_ml' | 'formula_ml'>[]
  /** Todas las extracciones vivas con amount_ml > 0. */
  pumping: Pick<PumpingSession, 'id' | 'pumped_at' | 'amount_ml'>[]
  /** Ids de sesiones que llenaron un contenedor (vivo, libre o desechado). */
  sessionsWithContainer: ReadonlySet<string>
  /** Regla vigente del refri, en días (milk_fridge_days). */
  fridgeDays: number
}): Map<string, LegacySplit>
```

- **Pozo** = extracciones **sin** contenedor (forma legada), cada una con
  `vence = pumped_at + fridgeDays × 24 h` y su `amount_ml`.
- Se recorre una línea de tiempo con extracciones del pozo y tomas **sin
  desglose** con `amount_ml > 0`, ordenada por hora y desempatando por `id`
  (determinista). En empate de hora, la extracción entra antes que la toma.
- Cada toma toma del pozo, de la extracción más vieja **no vencida a la hora de
  la toma** (`vence > fed_at`), hasta su total. `breastMl` = lo tomado,
  `formulaMl = amount_ml − breastMl`.
- Las tomas **con** desglose no participan (ya descuentan contenedores).
- Salida: un mapa solo con las tomas sin desglose. Nada se escribe.
- No toca `stashMl`, ni contenedores, ni la cola.

Lectura que la alimenta (sin `limit`: un pozo recortado daría otro reparto):
`legacySplitInputs(babyId)` en `lib/db.ts` (§7.2). Se usa en Historial y en
`/feeding` (detalle y panel de edición de una toma legada: "≈ 1.5 oz leche +
1.5 oz fórmula (estimado)", solo lectura, D-14b).

Sesgo único, escrito (D-14): si la leche registrada se tiró sin anotarlo, la
estimación queda por arriba de la real, acotada por lo extraído.

---

## 6. Migración de datos v3 → v4 (dentro de 0015)

Orden dentro de la transacción:

1. `select set_config('amelia.milk_rpc', 'on', true)` — los UPDATE del backfill
   pasan por `milk_guard_containers`.
2. Columnas nuevas (`released_at`, `lost_ml default 0`, `leftover_ml` y su
   constraint, `milk_bottle_count default 6`). `lost_ml` nace en 0 para todo
   contenedor v3, que es exacto: en v3 `remaining = amount − servido`.
3. **Backfill:** `update milk_containers set released_at = now() where
   voided_at is null and remaining_ml < 0.15` (V4-14 CA3; caso 38). Nada se
   renumera ni se anula (D-1).
4. Constraint `milk_containers_released_empty` (se agrega **después** del
   backfill; con él ya cumple).
5. `drop index milk_containers_label_live; create unique index
   milk_containers_label_occupied …`. No puede fallar: el índice viejo era más
   estricto (todos los no anulados), así que entre los ocupados no hay dobles.
5b. **Volver a v4 tras la reversa (R-10, agregado el 6 oct 2026).** Dos UPDATE
   que sobre datos v3 comunes no tocan una fila, porque solo
   `docs/rollback-leche-v4.sql` produce lo que corrigen: (1) contenedor
   **anulado con porciones vivas** → `voided_at = null`, `released_at` = su
   `voided_at`, `remaining` = su polvo (< 0,15) o 0 — liberado, nunca ocupado;
   va después del paso 5 porque con el índice viejo chocaría con el que ocupa
   su número; (2) contenedor vivo con `amount − servido − remaining > 0` →
   ese residuo a `lost_ml` (nunca a `remaining`: "Lo que hay" no cambia). El
   residuo negativo no se toca y la invariante (paso 8) aborta. Detalle:
   `docs/compatibilidad-v4.md` §5.3.
6. Tablas nuevas, RLS, grants, triggers.
7. Funciones (create or replace / drop + create), revoke/grant.
8. Chequeo de la invariante (§2.4) en un `do` que aborta con
   `milk_invariant_broken`.
9. `set_config('amelia.milk_rpc', '', true)`; `notify pgrst, 'reload schema'`.

Qué queda de cada tipo de contenedor v3:

| v3 | v4 |
|---|---|
| Con leche, vigente, número ≤ N | ocupado |
| Con leche, número > N (M9 con N=6, M12, M999999) | ocupado, "fuera de M1–MN" en la lista (D-1); al vaciarse sale del selector |
| Con leche, vencido | caducada (Desechar disponible) |
| Vaciado (`remaining < 0.15`) | libre; su número vuelve al selector |
| Anulado | anulado (sin cambio) |
| Anulado **con porciones vivas** (solo lo deja la reversa v4) | libre, con su polvo o 0 (paso 5b) |
| Vivo con `remaining < amount − servido` (solo lo deja la reversa v4) | igual, con la diferencia en `lost_ml` (paso 5b) |
| Extracción legada sin contenedor | sigue sin contenedor; alimenta el pozo de 2B (D-21) |

---

## 7. Capa de datos y lógica pura

### 7.1 Lógica pura (reloj inyectable, sin `Date.now()` adentro)

**`lib/milkBottles.ts`** (nuevo; **no** importa `lib/milk.ts` para no tener un
ciclo: `EMPTY_ML` se **mueve** acá y `lib/milk.ts` lo re-exporta).

| Función | Firma | Qué hace |
|---|---|---|
| `EMPTY_ML` | `0.15` | (movido) |
| `FUTURE_TOLERANCE_MS` | `600_000` | tope de hora futura (§4) |
| `MAX_BOTTLE_COUNT` / `DEFAULT_BOTTLE_COUNT` | `30` / `6` | D-23 |
| `containerState` | `(c, discards, atMs) => 'voided'\|'discarded'\|'free'\|'expired'\|'occupied'` | §1.2 |
| `isOccupied` | `(c) => boolean` | no anulado y `released_at` nulo |
| `bottleSlots` | `(n, containers, discards, atMs) => { slots: Slot[]; outOfRange: Slot[] }` con `Slot = { label; state: 'free'\|'occupied'\|'expired'; container?; pending? }` | M1…MN en orden numérico + ocupados con número > N (D-1/D-2). Un número **libre** que liberó algo todavía en la cola (un desecho, una toma que lo vació) lleva `pending: true` ("Todavía sin sincronizar", V4-39, E-16) |
| `canDiscard` | `(c, discards, atMs) => boolean` | ocupado y `expires_at <= atMs` (pantalla) |
| `discardedTotalMl` | `(discards) => number` | suma de vivos (D-13) |
| `containerBalance` | `(c, drawdowns, discards) => { served; discarded; lost; remaining }` | reemplaza `servedMl = amount − remaining`, que en v4 contaría el desecho como servido |
| `rebalance` | `(c, cause, newResidueMl, containers, discards, atIso) => { container; discards; returnedMl; lostMl }` | espejo exacto de `milk_rebalance` (§2.3), incluido "número ocupado por otro" |
| `planBottleEdit` | `(feeding, drawdowns, containers, discards, request, atMs) => { ok: true; portions; returned; taken } \| { ok: false; problem: 'not_enough'; availableMl } \| { ok: false; problem: 'unusable'; label } \| { ok: false; problem: 'future' }` | espejo de los pasos 7–9 de §3.8, D-17/D-18 |
| `validateBottleCount` | `(text) => { n } \| { problem: 'empty'\|'number'\|'whole'\|'range' }` | V4-10 CA1 |
| `validateLeftover` | `(leftoverMl, totalMl) => problem \| null` | V4-43 |

**`lib/milkEstimate.ts`** (nuevo): `estimateLegacySplit` (§5).

**`lib/milk.ts`** (cambia):

- `isUsable` agrega `!c.released_at`; `stashMl`, `usableContainers`,
  `suggestPlan` lo heredan (V4-36).
- `activeContainers` pasa a devolver solo **ocupados** (lo que lista `/pumping`).
- `applyPendingInventory(containers, drawdowns, discards, pending)` devuelve
  `{ containers, drawdowns, discards }` (§7.3).
- `convertAmountText(text, from, to)` — extraído de `BottleBuilder.switchUnit`
  (D-19: convertir, **reusando**, sin copia); lo usan `BottleBuilder`,
  `/pumping` (izq/der) y el campo "Sobró".
- `servedMl(c)` se **borra** (lo reemplaza `containerBalance`).
- `nextContainerLabel`, `suggestContainerLabel`, `normalizeTapeLabel`,
  `tapeInUse`, `takenTapes`, `suggestTape` (X-1): se **borran**, con sus
  tests y las claves `milk.tape*`. `newestSavedContainers` queda (lo usa el
  selector offline, V4-11 CA3). `describeBottle` suma "· sobró X".
- `PumpingArgs`, `BottleFeedArgs` (agrega `p_leftover_ml?`), nuevos
  `DiscardArgs`, `EditBottleArgs`.

### 7.2 `lib/db.ts`

**"Sin limit" quiere decir también "más allá de `max_rows`"** (MAXROWS, 6 oct
2026). Supabase en la nube corta cada respuesta de PostgREST en 1000 filas, sin
error; el stack local no tiene tope. Toda lectura de abajo marcada "sin limit"
—y las `*Since`, `listDrawdowns`, `listGrowth` y `listAppointments`— pasa por
`readAll` (`lib/readAll.ts`): `.range()` en páginas de 1000 hasta que una venga
corta, con `.order('id')` de desempate (sin orden único el paginado repite y
pierde filas) y sin repetir un `id`. Si el `max_rows` del proyecto se bajara de
1000, hay que bajar `PAGE_SIZE` con él.

| Función | Cambio |
|---|---|
| `sendOpWith` | devuelve también `data` en `kind: 'rpc'`; `write` pasa a `Result<unknown>` y expone `data` (el `jsonb` de `void_bottle_feed`/`edit_bottle_feed`) |
| `listContainers(babyId, db)` | agrega `released_at, lost_ml` al select. **Sin limit** (sigue siendo la base de totales); sigue filtrando `voided_at is null` |
| `listDiscards(babyId, db)` **nueva** | `id, container_id, amount_ml, discarded_at, reason, milk_containers(label)`, vivas, **sin limit** |
| `legacySplitInputs(babyId)` **nueva** | todas las tomas vivas `bottle` (`id, fed_at, amount_ml, breast_milk_ml, formula_ml`) y todas las extracciones vivas con cantidad (`id, pumped_at, amount_ml`), **sin limit** |
| `FEEDING_COLUMNS` | agrega `leftover_ml` |
| `logPumpingSession(babyId, userId, input, ctx, label)` | `label` **obligatorio** si hay cantidad (sin sugerencia); `newContainer` deja de inventar etiqueta |
| `updatePumpingSession(id, input, ctx, opts & { label?: string })` | `label` cuando la sesión gana su primer contenedor (AJ-5) |
| `discardContainer(babyId, userId, container, opts?: { pending?: boolean })` **nueva** | op abajo |
| `logBottleFeed(…, input & { leftover_ml: number \| null })` | agrega `p_leftover_ml` |
| `editBottleFeed(feeding, input, expected, ctx, opts?: { pending?: boolean })` **nueva** | op abajo |
| `voidBottleFeed` | devuelve el `jsonb` (lo perdido) cuando fue en línea |
| `updateFeeding` | agrega `leftover_ml` al patch (solo para tomas **sin** desglose) |
| `milkRules` / `saveMilkRules` | leen y escriben también `milk_bottle_count` (tipo `MilkSettings = MilkRules & { milk_bottle_count: number }`) |
| `milkErrorText` | claves nuevas (§8.4); `milk_not_enough` pone el sufijo en `{amount}` (oz), no en `{label}` |
| `buildActivity` | recibe `discards` y emite entradas `kind: 'discard'` (no editables); `ActivityEntry.kind` suma `'discard'` |
| `describeWrite` / `THING` | `milk_discards: 'sync.thing.milk_discards'` |

**Forma de las ops de cola nuevas** (todas `kind: 'rpc'`):

| fn | `args` | `table` | `id` | `effect` | `row` / `patch` | `creates` | `refs` |
|---|---|---|---|---|---|---|---|
| `log_pumping_session` | como hoy, `p_container_label` = elegido | `pumping_sessions` | sesión | `insert` | `row` de la sesión | `[container_id]` | — |
| `update_pumping_session` | como hoy | `pumping_sessions` | sesión | `update` | `patch` | `[container_id]` si nace | — |
| `void_pumping_session` | como hoy | `pumping_sessions` | sesión | `delete` | `{voided_at}` | — | — |
| `discard_container` | `{p_id, p_container_id, p_discarded_at}` | `milk_discards` | `p_id` | `insert` | `row: {id, container_id, amount_ml: remaining visto, discarded_at, reason:'expired'}` | — | `[container_id]` |
| `log_bottle_feed` | + `p_leftover_ml` | `feedings` | toma | `insert` | `row` + `leftover_ml` | — | contenedores de las porciones |
| `edit_bottle_feed` | los 8 parámetros | `feedings` | **toma** (no el op) | `update` | `patch: {fed_at, breast_milk_ml, formula_ml, amount_ml, leftover_ml, notes}` | — | contenedores de porciones actuales ∪ los que el plan toma |
| `void_bottle_feed` | como hoy | `feedings` | toma | `delete` | `{voided_at}` | — | — |

`queueOnly` (encolar detrás): `discard_container` si el contenedor es
`pending`; `edit_bottle_feed` si la toma o algún contenedor de `refs` es
`pending`. `dependentsOf` ya sigue `refs` y el `id` objetivo: descartar una
extracción rechazada se lleva el desecho y las ediciones que la usan.

### 7.3 `applyPendingInventory` con cada `fn`

Aplica la cola en orden de `queuedAt`; todo lo tocado queda `pending: true`.

| fn | Efecto en pantalla | "Ya lo tiene el servidor" (no aplicar dos veces) |
|---|---|---|
| `log_pumping_session` | como hoy; el contenedor nace **ocupado** (`released_at: null`) y ocupa su número en `bottleSlots` (V4-12 CA2) | contenedor con ese id ya listado |
| `update_pumping_session` | `amount_ml`, `stored_at`, `expires_at` y `rebalance(c, 'amount', …)` | por estado final (idempotente) |
| `void_pumping_session` | anula contenedor y su desecho | ya anulado |
| `discard_container` | si el contenedor está ocupado y `expires_at <= p_discarded_at`: agrega desecho con `remaining_ml`, `remaining_ml = 0`, `released_at = queuedAt` | desecho con `id = p_id` ya listado, o contenedor ya desechado/libre/anulado |
| `log_bottle_feed` | descuenta y `rebalance(c, 'serve')` (libera si queda < 0.15) | porciones de esa toma ya listadas |
| `edit_bottle_feed` | `planBottleEdit` sobre lo conocido; si `ok`, aplica porciones y `rebalance`; si no, **no** aplica nada y marca la toma `pending` (el servidor decide) | si la toma ya está en el estado pedido, Δ = 0 |
| `void_bottle_feed` | devuelve cada porción con `rebalance(c, 'return')` (D-9 incluido) | porciones ya anuladas |

### 7.4 Tipos (`lib/types.ts`)

- `MilkContainer` + `released_at?: string | null`, `lost_ml?: number`.
- `MilkDiscard = { id; container_id; amount_ml; discarded_at; reason: 'expired'; label?: string | null; voided_at?: string | null }`.
- `Feeding` + `leftover_ml?: number | null`.
- `MilkSettings = MilkRules & { milk_bottle_count: number }`.
- `ActivityEntry.kind` + `'discard'`.

---

## 8. Interfaz

### 8.1 Archivos

| Archivo | Cambio |
|---|---|
| `components/AmountUnit.tsx` | prop opcional `label?: string` para el `aria-label` (V4-01 CA5); sin estado propio, como hoy |
| `components/BottleSlotPicker.tsx` **nuevo** | `<select className="input">` con opción vacía "Elegí un biberón…" (D-4, sin preselección), `M1…MN` en orden numérico; ocupado = `disabled` con "M3 · 2.5 oz · 14:20" (fecha si no es de hoy), caducado = "M3 · Caducada"; `pending` suma "· sin sincronizar"; aviso "lista desconocida" (V4-11 CA3) y "copia de hace X". Mismo componente en `/pumping` (alta) y en la edición de Historial cuando la sesión gana su primer contenedor (AJ-5) |
| `components/LeftoverField.tsx` **nuevo** | campo "Sobró" + `AmountUnit` propio (vuelve a oz al montar y tras guardar), validado con `validateLeftover` |
| `components/BottleEditPanel.tsx` **nuevo** | edición completa 2A: hora, leche (oz), fórmula (oz), total (solo lectura), sobró, nota; muestra el plan (`planBottleEdit`: "vuelve 1 oz a M4", "sale 1 oz de M5", "a M3 no vuelve: ya tiene otra extracción") antes de guardar; envía `editBottleFeed`. Usado por Historial **y** `/feeding` (D-16). Para tomas **sin** desglose, el panel de siempre + `LeftoverField` + la línea "≈ … (estimado)" solo lectura |
| `app/pumping/page.tsx` | dos `AmountUnit` (uno por lado, estados `unitLeft`/`unitRight`, convierten con `convertAmountText`); el campo "Cinta" → `BottleSlotPicker`; "Sesión registrada en M3."; la lista "Lo que hay" muestra ocupados (orden por `stored_at`, sin insinuar número) con "fuera de M1–MN" si aplica; caducados con "Caducada" + botón **Desechar** (`window.confirm` con número y cantidad); tarjeta/valor **"Leche desechada: X oz"** (`discardedTotalMl`, D-13); "servido" sale de `containerBalance` |
| `app/history/page.tsx` | lee `listDiscards` y `legacySplitInputs`; filas `discard` (solo lectura); desglose con "· sobró X"; tomas legadas con "≈ … (estimado)"; ⋯ Editar de toma con desglose → `BottleEditPanel` (se va `bottle.timeOnly`); borrar toma muestra lo perdido si `void_bottle_feed` lo informa; edición de extracción **sigue en oz sin toggle** (D-20/V4-05) y suma `BottleSlotPicker` solo si la sesión no tiene contenedor y gana cantidad |
| `components/SectionPage.tsx` | `/feeding`: `BottleEditPanel` en vez de "solo la hora"; "Registrar uno pasado" suma `LeftoverField` y ofrece solo contenedores **no liberados** utilizables a esa hora |
| `app/dashboard/page.tsx` | `LeftoverField` en el panel del biberón (aplica a "Registrar tal cual" y "con cambios"); usa `isUsable` nuevo |
| `components/BottleBuilder.tsx` | usa `convertAmountText` (extraído) en vez de su `convert` interno |
| `app/settings/page.tsx` | `MilkStorageSettings`: campo **"Cantidad de biberones"** (1–30) validado con las reglas y guardado con el mismo botón; "A temperatura ambiente" y "En el congelador" con la marca **"Todavía no se usa"** (D-12), editables; nota "hoy toda la leche se cuenta en el refrigerador"; al bajar N con ocupados por encima, aviso D-2 |
| `lib/db.ts`, `lib/milk.ts`, `lib/milkBottles.ts`, `lib/milkEstimate.ts`, `lib/types.ts`, `lib/i18n/en.ts`, `lib/i18n/es.ts` | §7, §8.4 |

Ninguna pantalla nueva: `/statistics` no se toca. `public/sw.js` no cambia de
lista de páginas (sí de build, como siempre).

### 8.2 Textos de "leche que no volvió" (D-9)

En línea, la respuesta `jsonb` dice qué etiquetas perdieron cuánto. Offline,
la pantalla usa `rebalance`/`planBottleEdit` sobre lo conocido y lo dice con
"según lo que sabe este teléfono".

### 8.3 Lo que no cambia en la UI

La sugerencia v3 (última toma, 3 oz, más vieja primero, faltante a fórmula), la
lactancia en curso sin biberón (caso 40), el cronómetro por dispositivo,
`/pumping` sin edición en línea.

### 8.4 Claves i18n nuevas (en `en.ts` y `es.ts`)

Se borran: `milk.tape`, `milk.tapeEmpty`, `milk.tapeFormat`, `milk.tapeInUse`,
`milk.tapeUnknown`, `milk.tapeFromSaved`, `milk.tapeNeeded`,
`milk.loggedLabel`, `milk.queuedLabel`, `bottle.timeOnly`, `milk.expired`
(reemplazada).

Nuevas:

| Clave | Variables |
|---|---|
| `milk.leftUnit` / `milk.rightUnit` (aria del AmountUnit por lado) | — |
| `milk.bottle` ("Biberón") | — |
| `milk.bottlePick` ("Elegí un biberón…") | — |
| `milk.amountTooSmall` ("Es demasiado poco para guardarlo en un biberón…"; M-1, total de extracción entre 0 y 0,15 ml) | — |
| `milk.bottleNeeded` ("Elegí en qué biberón quedó.") | — |
| `milk.bottleOptionFree` | `{label}` |
| `milk.bottleOptionTaken` ("M3 · 2.5 oz · 14:20") | `{label}`, `{amount}`, `{when}` |
| `milk.bottleOptionExpired` | `{label}` |
| `milk.bottleOptionPending` | `{label}` |
| `milk.bottlesUnknown` (V4-11 CA3) | — |
| `milk.bottlesFromSaved` | `{when}` |
| `milk.loggedIn` ("Sesión registrada en M3.") | `{label}` |
| `milk.queuedIn` | `{label}` |
| `milk.bottleInUse` ("M3 ya lo ocupó otra extracción recién. Elegí otro biberón.") | `{label}` |
| `milk.outOfRange` ("fuera de M1–M{n}") | `{n}` |
| `milk.expiredShort` ("Caducada") | — |
| `milk.discard` ("Desechar") | — |
| `milk.discardConfirm` | `{label}`, `{amount}` |
| `milk.discarded` ("Desechada") | — |
| `milk.discardedTotal` ("Leche desechada") | — |
| `milk.discardedLine` ("Leche desechada · M3 · 1.5 oz") | `{label}`, `{amount}` |
| `milk.notReturned` ("La leche no volvió a M3: ese biberón ya tiene otra extracción.") | `{label}`, `{amount}` |
| `milk.notReturnedDiscarded` | `{label}`, `{amount}` |
| `milk.notReturnedGuess` (offline) | `{label}`, `{amount}` |
| `activity.discard` | — |
| `bottle.leftover` ("Sobró") | — |
| `bottle.leftoverAria` | `{unit}` |
| `bottle.leftoverPart` ("sobró {amount}") | `{amount}` |
| `bottle.leftoverTooMuch` ("Sobró más de lo que se sirvió.") | — |
| `bottle.leftoverNotNumber` | — |
| `bottle.editTitle` | — |
| `bottle.editMilk` / `bottle.editFormula` / `bottle.editTotal` | `{amount}` en total |
| `bottle.editReturns` ("Vuelve {amount} a {label}") | `{label}`, `{amount}` |
| `bottle.editTakes` ("Sale {amount} de {label}") | `{label}`, `{amount}` |
| `bottle.estimated` ("≈ {milk} leche + {formula} fórmula (estimado)") | `{milk}`, `{formula}` |
| `bottle.estimatedHint` | — |
| `milkRules.bottles` ("Cantidad de biberones") | — |
| `milkRules.bottlesHint` | — |
| `milkRules.notUsedYet` ("Todavía no se usa") | — |
| `milkRules.fridgeOnlyNote` | — |
| `milkRules.problem.bottles` (rango 1–30, entero) | `{max}` |
| `milkRules.bottlesAbove` (D-2: "M7 y M8 todavía tienen leche…") | `{labels}` |
| `milkError.notExpired` | `{label}` |
| `milkError.notEnough` | `{amount}` |
| `milkError.editConflict` | — |
| `milkError.futureTime` | — |
| `milkError.feedingGone` | — |
| `milkError.notInventory` | — |
| `milkError.bottleTaken` (reemplaza el texto de `labelTaken`: biberón) | `{label}` |
| `milkError.bottleTakenQueued` (V4-84) | `{label}` |
| `sync.thing.milk_discards` | — |

(`milkError.labelTaken`/`labelTakenQueued` se **renombran** a
`bottleTaken`/`bottleTakenQueued`; el código de cable sigue siendo
`milk_label_taken`, AJ-1.)

---

## 9. Compatibilidad

### 9.1 App vieja v0.12.1 (producción hoy) × objetos de 0015

| Objeto nuevo | Qué hace v0.12.1 | Resultado | ¿Aceptable? |
|---|---|---|---|
| `milk_containers.released_at`, `lost_ml` | nunca las lee ni escribe | nada | sí |
| `milk_containers_label_occupied` | no crea contenedores | nada | sí |
| `milk_discards`, `milk_feeding_edits` | no las conoce; un POST a mano → 403 por grants/guard | nada | sí |
| `feedings.leftover_ml` | no la manda; select explícito | nada | sí |
| `feedings_leftover_le_amount` | edita el total de una toma **legada** con sobró por debajo del sobró | `23514` crudo, sin cambios | sí (D-11b, visible) |
| idem | pasa a `nursing` una toma legada con sobró | pasa (`amount_ml` null) | sí |
| `babies.milk_bottle_count` | solo escribe `{birth_date}` | default 6 | sí |
| `milk_guard_feedings` v4 | cambia solo la hora de una toma con desglose a una hora en que su leche vencía | `milk_container_unusable:M#` crudo, sin cambios (caso 34) | sí |
| idem | cambia `leftover_ml` | nunca lo manda | sí |
| idem | borra/edita toma **editada** por `edit_bottle_feed` | `milk_rpc_only` (como B1/B2) | sí |
| `milk_guard_pumping` (sin cambio) | edita/borra extracción **elegida con selector**, desechada o libre | `milk_rpc_only` (como B3) | sí |
| idem | alta/edición/borrado de extracción legada | pasa (sin contenedor, pozo de 2B) | sí |
| Funciones nuevas o recreadas | no las llama | nada | sí |
| Cola v4 inyectada en v0.12.1 (vuelta atrás de la app) | trata `rpc` como alta: `POST /milk_discards` o `/feedings` con `row` | 403/400 o `milk_rpc_only`; cola detenida con Descartar | sí, falla cerrado (igual que §4 de compatibilidad-leche) |

Suite de v0.12.1 pura sobre 0001–0015: **118/118** (C-01).

### 9.2 App v3 (`feat/milk-inventory-v3-release`, cacheada) × objetos de 0015

| Objeto | Qué hace v3 | Resultado | ¿Aceptable? |
|---|---|---|---|
| `log_pumping_session` (misma firma) | manda la cinta sugerida (máx+1) o tipeada | entra; un número > N es D-1; si el número está ocupado `milk_label_taken:M#`, que v3 traduce | sí |
| idem, cinta de un liberado | el **cliente** v3 la cree tomada (lista no anulados) y sugiere otra | más estricto que el servidor | sí |
| `update_pumping_session` (misma firma) | edita; semántica de "servido" ahora excluye desecho | correcto en la base | sí |
| `void_pumping_session` (misma firma) | borra extracción desechada no servida | anula también el desecho | sí |
| `log_bottle_feed` (drop+create con default) | llama con 6 nombres | resuelve a la nueva; `leftover_ml = null`; tope de 10 min al futuro | sí |
| idem, de un liberado/desechado | v3 no lo ofrece (remaining < EMPTY) | si lo manda, `milk_overdraw:M#` (v3 lo traduce) | sí |
| `void_bottle_feed` (retorno `jsonb`) | ignora el cuerpo | devuelve la leche con D-9 | sí |
| `discard_container`, `edit_bottle_feed` | no las conoce | nada | sí |
| `milk_guard_feedings` v4 | `updateFeeding(id, {fed_at})` de una toma con desglose | re-valida caducidad; error `milk_container_unusable:M#` traducido | sí |
| `listContainers` de v3 (sin `released_at`) | ve liberados y desechados como contenedores vivos con `remaining` 0 | no los muestra (filtra `< EMPTY_ML`); su `servedMl = amount − remaining` cuenta lo desechado como "servido" y **bloquea en el cliente** borrar esa extracción | sí: falla cerrado (no escribe nada) |
| Cola v3 reenviada sobre 0015 | las cinco formas `rpc` | mismas respuestas que en 0014 | sí |
| Cola v4 inyectada en v3 (vuelta atrás de la app a v3 con la base en 0015) | v3 manda `rpc` tal cual | `discard_container`/`edit_bottle_feed` **funcionan** (existen en la base); el resto igual | sí |
| Cola v4 en v3 con la base **revertida** a 0014 | `discard_container`/`edit_bottle_feed` | `PGRST202` 404 → rechazo con Descartar | sí, falla cerrado |

Suite de v3-release sobre 0001–0015: **151/151** esperado (C-02); cualquier
diferencia tiene que estar en la lista de cambios de semántica de arriba (la
única candidata: un test que reuse la cinta de un contenedor **vaciado** y
espere `milk_label_taken`; en v4 entra. Revisado: la suite v3 no tiene ese
test — "la cinta de una extracción anulada se puede volver a usar" es con
anulado).

---

## 10. Reversa: `docs/rollback-leche-v4.sql`

Objetivo: base con 0001–0015 → esquema **idéntico** a 0001–0014
(`feat/milk-inventory-v3-release`), datos coherentes para v3.

### 10.1 Orden (una transacción, re-ejecutable sin error)

0. **Antes, fuera de la transacción:** backup con `pg_dump` (como
   `docs/rollback-leche.sql`). Bloque opcional comentado que copia a un schema
   `milk_backup_v4` (revocado a `public, anon, authenticated`): `milk_discards`,
   `milk_feeding_edits`, `(id, released_at, lost_ml)` de contenedores,
   `(id, leftover_ml)` de tomas, `(id, milk_bottle_count)` de bebés.
1. **Pre-chequeo informativo** (`raise notice`, no aborta): contenedores
   **ocupados** con `lost_ml > 0` (v3 recalcula `remaining = amount − servido`
   al editar o al anular una toma, y les "devolvería" esa leche). Esperado: 0.
2. `set_config('amelia.milk_rpc', 'on', true)`.
3. **Datos que v3 no puede representar** (solo si existe la columna
   `released_at`; si no, se saltea — re-ejecutable):
   a. contenedores con desecho vivo → `voided_at = coalesce(released_at, now())`;
   b. liberados con `lost_ml > 0` → ídem;
   c. por cada `(baby_id, label)` con más de un contenedor no anulado: se
      queda vivo el **ocupado** (o, si todos están libres, el de `stored_at`
      más nuevo) y los demás libres → `voided_at = released_at`.
   Así el índice viejo se puede recrear y `void_bottle_feed` de 0014 no
   resucita leche desechada ni perdida (actualiza `remaining` de un anulado,
   que no cuenta en ningún lado).
   d. (B-1, auditoría H5) cada **extracción viva** que tiene contenedor pero
      ninguno vivo (o sea, la de un anulado en a/b/c) pasa a **forma legada**:
      `left_ml = right_ml = null`, `amount_ml` igual. Sin esto el cliente v3
      no ve contenedor vivo y su `update_pumping_session` (0014), al
      corregir solo nota u hora, crea uno nuevo con el total entero (leche
      servida o desechada de vuelta en "Lo que hay"). Legada, v3 manda los
      lados en null y la función entra por su ramal `v_legacy`. Es solo de
      datos: el esquema no cambia (R-01).
4. Funciones: `drop function if exists edit_bottle_feed(...)`,
   `discard_container(...)`, `milk_rebalance(...)`, `milk_discarded_ml(...)`;
   `drop function if exists log_bottle_feed(uuid, uuid, timestamptz, text,
   numeric, jsonb, numeric)` y `create` de la de 0014 (6 parámetros);
   `drop function if exists void_bottle_feed(uuid, timestamptz)` y `create` de
   la de 0014 (`returns void`); `create or replace` con el **texto de 0014** de
   `milk_create_container`, `log_pumping_session`, `update_pumping_session`,
   `void_pumping_session`, `milk_guard_feedings`. Revokes/grants exactos de
   0014:877-915.
5. Tablas: `drop table if exists milk_feeding_edits, milk_discards` (con sus
   policies, índices y triggers).
6. Índices: `drop index if exists milk_containers_label_occupied; create
   unique index if not exists milk_containers_label_live … where voided_at is
   null`.
7. Constraints y columnas: `milk_containers_released_empty`,
   `feedings_leftover_le_amount`; `drop column if exists` de `released_at`,
   `lost_ml`, `leftover_ml`, `milk_bottle_count`.
8. `set_config('amelia.milk_rpc', '', true)`; `commit`;
   `notify pgrst, 'reload schema'`.

### 10.2 Qué se pierde

Todos los **desechos** (filas y su total "Leche desechada"); todo **sobró**;
**N**; las marcas de **liberado** y **perdido**; el registro de **ediciones**;
y los contenedores del paso 3 quedan **anulados** (en v3: sus extracciones se
ven sin cinta ni "servido", y v3 dejaría borrarlas aunque se haya servido leche
de ellas — se anota como riesgo); y esas extracciones pierden su reparto
**izquierdo/derecho** (paso 3d: quedan legadas con su total). Riesgo que deja
3d: si en v3 alguien escribe a mano los lados de una de esas legadas, v3 le
crea un contenedor con esa cantidad, como a cualquier legada. Sobreviven: todas las tomas con su desglose
final, todas las porciones, todas las extracciones, contenedores ocupados.

### 10.3 Cómo se comprueba (R-xx)

En un Postgres efímero con la misma imagen del stack local:

1. Base A: 0001–0014 de cero → `pg_dump --schema-only --schema=public
   --no-owner` → `a.sql`.
2. Base B: 0001–0015 de cero + datos de leche de los escenarios E-xx (con
   números reusados, desechos, sobró, ediciones, pérdida) → rollback →
   `pg_dump` igual → `b.sql`. **`diff a.sql b.sql` vacío.**
3. Rollback dos veces seguidas: sin error.
4. En B: invariante v3 (`remaining = amount − servido` para no anulados, salvo
   los del pre-chequeo) y el índice viejo sin conflicto.
5. Suite de v3-release (151/151) y de v0.12.1 (118/118) contra B.
6. Volver a aplicar 0015 sobre B: entra y la invariante v4 da 0 filas (lo
   hace posible el paso 5b de §6; `tests/integration/milkV4Reapply.test.ts`).

---

## 11. Enganches fases 3–4 (no se construyen)

- **Enfriado:** columna `milk_containers.cold_at timestamptz` (null =
  enfriando; estimada por cantidad o confirmada). `containerState` suma
  `'cooling'` antes de `'occupied'`; `isUsable` exige `cold_at <= at`. Si hace
  falta separar la entrada al refri de la extracción (D-3), `fridge_at`.
- **Combinar:** tabla `milk_transfers (id, from_container_id, to_container_id,
  amount_ml, …)`; en la igualdad de §2.1 suma `+ transferido_entrante −
  transferido_saliente` (la invariante se extiende con dos términos; ningún
  dato v4 cambia). El origen queda libre por `milk_rebalance`; el destino toma
  `expires_at = min(...)`.
- **Desechos por otros motivos / parciales:** reemplazar el CHECK de
  `milk_discards.reason` (`'started_1h'`, `'manual'`) y dropear
  `milk_discards_one_live`. `discard_container` gana `p_amount_ml default null`
  (drop+create, como §3.6). `milk_rebalance` ya resta desecho en general.
- **Inventario de fórmula (Similac):** tablas `formula_packs`,
  `formula_bottles (opened_at, expires_at 48 h)` y porciones de fórmula; se
  enganchan **dentro** de `log_bottle_feed`/`edit_bottle_feed`, que ya reciben
  `formula_ml` absoluto. Nunca bloquea (regla 14).
- **Receta en Hoy:** función pura nueva que reemplaza `suggestPlan`, leyendo
  `lastFeedingEvent`, objetivo y "completar con 1 oz" (columnas de `babies`,
  junto a `milk_bottle_count`) y solo leche fría (`cold_at`).
- **Biberón empezado 1 h:** `feedings.prepared_at`; lo sobrante como
  `milk_discards.reason = 'started_1h'` (por eso "sobró" y "desechada" siguen
  separados, D-10).
- **Estadísticas:** `leftover_ml`, `milk_discards`, `lost_ml` y
  `estimateLegacySplit` son las fuentes.

---

## 12. Ajustes a la spec (con motivo)

| ID | Spec dice | Ajuste | Motivo |
|---|---|---|---|
| AJ-1 | (pedido del arquitecto) ocupado → `milk_bottle_taken:M#` | El código de cable sigue siendo **`milk_label_taken:M#`**; cambia el texto (clave `milkError.bottleTaken`) | La app v3 cacheada traduce `milk_label_taken` (y su variante de cola); un código nuevo le llegaría crudo. El test de integración v3 lo afirma |
| AJ-2 | `milk_bottle_count numeric … = trunc` | `integer … between 1 and 30` | Un entero no admite 2.5 ni NaN por tipo; menos lógica |
| AJ-3 | `edit_bottle_feed` idempotente por valores absolutos + `p_expected` | + `p_op_id` y tabla `milk_feeding_edits` | Valores absolutos no protegen del ABA (reenvío tardío que pisa una edición posterior del otro teléfono). En extracciones se deja como 0014 porque no hay "esperado" en la spec y el riesgo es el mismo que ya tenía v3 (anotado) |
| AJ-4 | D-9 "no vuelve y no cuenta como desechada", sin dónde | `milk_containers.lost_ml` | Sin un lugar, la igualdad contable no cierra |
| AJ-5 | V4-17: la edición de una extracción no tiene selector | Excepción: si la sesión **no tiene contenedor** y la edición le da cantidad (legada o sin cantidad), aparece `BottleSlotPicker` | El contenedor necesita número y no hay sugerencia; no es "cambiar el número", es elegirlo por primera vez |
| AJ-6 | D-22: desechado mientras otro servía → `milk_overdraw` | Se generaliza: servir de cualquier **liberado** → `milk_overdraw:M#` | Un liberado no tiene leche que cuente (constraint) |
| AJ-7 | `void_bottle_feed` sin cambio de firma | Retorno `void → jsonb` (drop + create) | "La pantalla lo dice" (D-9) en línea; v3 ignora el cuerpo |
| AJ-8 | S-16 idempotencia estricta del alta | Reenvío de `log_bottle_feed` de una toma ya **editada** = no-op | Si no, conflicto falso cuando la respuesta del alta se perdió y otro teléfono la editó |
| AJ-9 | `p_expected = {fed_at, breast, formula}` | + `leftover_ml` | Dos teléfonos corrigiendo "sobró" también es regla 21 |
| AJ-10 | D-8 "desechado = total − servido" | `= total − servido − lost`; al bajar se descuenta remaining → lost → desecho y un desecho que llega a 0 se anula | Que la igualdad cierre con pérdida |
| AJ-11 | V4-14 "libera al dejar < 0,15" | El polvo queda en `remaining_ml` del liberado (constraint `< 0.15`), no cuenta | No inventar una cuarta categoría para 0,1 ml |
| AJ-12 | `milk_not_enough` con la cantidad | El sufijo es **ml disponibles** (número), no una etiqueta | `milkErrorText` lo pone en `{amount}` |
| AJ-13 | D-11b sobró en legadas por UPDATE | Y en tomas **con** desglose, `leftover_ml` solo por RPC (trigger) | Toda corrección de una toma con desglose queda en `milk_feeding_edits` |
| AJ-14 | V4-58: el trigger re-valida caducidad | Re-valida lo mismo que la RPC: caducidad, `stored_at <= fed_at + 10 min` y hora futura | Una sola regla para los dos caminos |
| AJ-15 | V4-34 no-op "ya desechado o anulado" | También no-op si está **libre** (vaciado) | No hay nada que tirar ni número que liberar |
| AJ-16 | V4-02/D-19 convertir "si se puede sin copia" | Se puede: `convertAmountText` se extrae de `BottleBuilder` a `lib/milk.ts` | Se elige **convertir** en los tres lugares |
| AJ-17 | V4-10 tarjeta "Conservación" o hermana | Mismo card y mismo botón que las reglas | Una validación conjunta, un solo `saveMilkRules` |
| AJ-18 | (implícito) `listContainers` sin limit | Crece con cada extracción (los liberados no se anulan) | Aceptado: ~1–3 filas/día; se mide en E-xx (tiempo de lectura con 2 000 contenedores). Paginado en 1000 por el `max_rows` de la nube (§7.2) |
| AJ-19 | V4-60 estimación "al leer" | Necesita una lectura **sin limit** nueva (`legacySplitInputs`) | Historial lee 20–100 filas; el pozo depende de todo lo anterior |
