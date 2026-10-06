-- Inventario de leche v4, fases 1 y 2 de las respuestas de papá (6 oct 2026).
--
-- Numerada en este repo por pedido explícito del dueño (CLAUDE.md §5.2), igual
-- que 0007…0014. Al escribirse está aplicada SOLO en el stack local; en la nube
-- se aplica a mano, DESPUÉS de 0014 y ANTES de que la app v4 llegue a `main`.
--
-- Fuente de verdad: docs/respuestas-papa-leche.md. Requisitos y decisiones
-- (D-x): docs/spec-feeding-v4.md. Diseño (nombres, firmas, códigos de error,
-- orden de bloqueos, invariante): docs/arquitectura-v4.md (ARQ §n). Lo que
-- sigue es esa arquitectura escrita en SQL; si algo acá la contradice, el bug
-- es este archivo.
--
-- Qué agrega, en una línea cada cosa:
--   · milk_containers.released_at: el biberón físico (M1…MN) se LIBERA cuando
--     se vacía o se desecha, y su número se puede volver a elegir (reglas 3–5).
--   · milk_containers.lost_ml: leche que volvió de una toma y no pudo entrar a
--     ningún biberón porque ese número ya tiene otra extracción (D-9). Sin esta
--     columna la cuenta del contenedor no cierra.
--   · milk_discards: "Desechar" leche caducada (regla 8). Un hecho histórico,
--     no un estado del contenedor.
--   · milk_feeding_edits: el registro de cada edición completa de una toma
--     (regla 17), por id de operación — es lo que la hace idempotente aunque
--     otro teléfono la vuelva a cambiar en el medio (ARQ AJ-3).
--   · feedings.leftover_ml: "sobró X oz" (regla 13). Solo estadística: no
--     toca el inventario (D-10).
--   · babies.milk_bottle_count: cuántos biberones físicos hay, N (D-23).
--   · Funciones: milk_rebalance (la ÚNICA que reparte el residuo de un
--     contenedor), discard_container y edit_bottle_feed nuevas;
--     log_bottle_feed y void_bottle_feed recreadas (cambian de firma); las
--     otras de 0014 cambian solo el cuerpo.
--   · Al final, la invariante contable (ARQ §2.4): si los datos no cierran, la
--     migración entera se aborta con `milk_invariant_broken`.
--
-- Aditiva: nada se renumera, nada se anula, ninguna fila v3 cambia salvo la
-- marca `released_at` de los contenedores ya vacíos (ARQ §6). Sobre una base
-- que pasó por docs/rollback-leche-v4.sql, además deshace lo que esa reversa
-- tuvo que hacer para v3 (sección VOLVER A v4 TRAS LA REVERSA, R-10).

-- Los UPDATE del backfill de abajo pasan por la guarda de milk_containers
-- (0014), que solo deja escribir con esta bandera. Es local a la transacción.
select set_config('amelia.milk_rpc', 'on', true);

-- ================================================================ COLUMNAS

-- Mismos topes finitos que 0014 (`x < 100000` rechaza NaN e Infinity, que en
-- Postgres son "mayores que todo").
alter table milk_containers
  add column released_at timestamptz,
  add column lost_ml numeric not null default 0
    check (lost_ml >= 0 and lost_ml < 100000);

-- Sin chequeo de `feeding_type`, a propósito (ARQ §3.11): la app v0.12.1 puede
-- pasar a `nursing` una toma vieja con sobró, y no debe recibir un error por
-- un campo que no conoce. Los lectores ignoran `leftover_ml` fuera de `bottle`.
alter table feedings
  add column leftover_ml numeric check (leftover_ml >= 0 and leftover_ml < 100000),
  add constraint feedings_leftover_le_amount
    check (leftover_ml is null or amount_ml is null or leftover_ml <= amount_ml);

-- N vive al lado de las reglas de conservación (ARQ §3.11): misma policy
-- "update own babies" (0006), mismo guardado sin cola. Entero: 2.5 o NaN no
-- entran por tipo. El default cubre las altas de v0.12.1, que solo escribe
-- {birth_date}.
alter table babies
  add column milk_bottle_count integer not null default 6
    check (milk_bottle_count between 1 and 30);

-- ================================================================ BACKFILL

-- Un contenedor v3 vaciado por tomas (le queda polvo de redondeo, < 0.15 ml =
-- EMPTY_ML de lib/milk) ya no tiene leche: su número queda libre (V4-14 CA3).
-- `lost_ml` nace en 0, que es exacto: en v3 remaining = amount − servido.
update milk_containers
   set released_at = now()
 where voided_at is null and remaining_ml < 0.15;

-- Un liberado nunca tiene leche que cuente. El polvo puede quedar en
-- `remaining_ml` (no se inventa una cuarta categoría para 0,1 ml, AJ-11), pero
-- un liberado no es utilizable, así que nunca suma. Va DESPUÉS del backfill.
alter table milk_containers
  add constraint milk_containers_released_empty
    check (released_at is null or remaining_ml < 0.15);

-- La unicidad pasa de "no anulado" a "ocupado": dos M3 pueden existir, uno
-- vaciado y uno con leche, pero nunca dos con leche. No puede fallar: el índice
-- viejo era más estricto. Es el respaldo; quien decide es la función, bajo el
-- advisory lock de etiqueta, para que el segundo vea `milk_label_taken:M3` y
-- nunca un 23505 crudo.
drop index milk_containers_label_live;
create unique index milk_containers_label_occupied
  on milk_containers (baby_id, label)
  where voided_at is null and released_at is null;

-- ================================================================ VOLVER A v4 TRAS LA REVERSA

-- docs/rollback-leche-v4.sql (la reversa de esta migración) deja dos formas que
-- v3 tolera y la invariante de abajo no (R-10, docs/compatibilidad-v4.md
-- §5.3). Las dos SOLO las produce esa reversa: ninguna función de 0014 las
-- escribe (v3 nunca anula un contenedor servido y siempre deja remaining =
-- amount − servido). Sobre datos v3 comunes los dos UPDATE no tocan una fila.
--
-- 1. Anulado con porciones vivas: el contenedor viejo de un número reusado, o
--    uno desechado después de servir, que la reversa anuló porque v3 exige una
--    cinta viva por bebé o le devolvería leche tirada. Vuelve como LIBERADO
--    (nunca ocupado: su número puede tenerlo otro, y físicamente ya no tiene
--    leche), con la hora de liberado que la reversa guardó en voided_at.
--    Conserva el polvo (< 0,15 ml) si lo tenía; si una toma de v3 anulada le
--    "devolvió" leche mientras estaba anulado, esa leche no está en ningún
--    biberón: remaining 0, y el resto lo pone el paso 2 en lost_ml.
--    Va DESPUÉS del índice nuevo: con el viejo (una cinta no anulada por bebé)
--    el M3 viejo chocaría con el M3 que la ocupa hoy.
update milk_containers c
   set voided_at = null,
       released_at = c.voided_at,
       remaining_ml = case when c.remaining_ml < 0.15
                           then least(c.remaining_ml, greatest(c.amount_ml - s.ml, 0))
                           else 0 end
  from (select container_id, sum(amount_ml) as ml
          from milk_drawdowns where voided_at is null group by container_id) s
 where s.container_id = c.id and c.voided_at is not null;

-- 2. Leche que no está en el biberón ni se sirvió: amount − servido −
--    remaining > 0 en un contenedor vivo. La reversa tira `lost_ml` y los
--    desechos, así que eso es: la leche perdida de un ocupado (el NOTICE de la
--    reversa) y la desechada o perdida de los que devolvió el paso 1. Va a
--    lost_ml, que es lo que es: nunca a remaining, así que "Lo que hay" no se
--    mueve ni un ml. El residuo NEGATIVO (dice tener más de lo que le entró
--    menos lo servido) no se toca: no lo produce nada nuestro, y la invariante
--    de abajo aborta la migración (I-105).
--    El desecho NO se reconstruye: la reversa lo borró (está escrito en ella) y
--    ya no se distingue de la leche perdida; vuelve como perdida.
update milk_containers c
   set lost_ml = r.residual
  from (select c2.id,
               c2.amount_ml - c2.remaining_ml - coalesce((
                 select sum(d.amount_ml) from milk_drawdowns d
                  where d.container_id = c2.id and d.voided_at is null), 0) as residual
          from milk_containers c2
         where c2.voided_at is null) r
 where r.id = c.id and r.residual > 1e-9 and r.residual < 100000;

-- ================================================================ DESECHOS

create table milk_discards (
  -- Lo genera el dispositivo: desechar también se hace sin conexión y se
  -- reenvía, y el id es lo que lo vuelve idempotente.
  id uuid primary key,
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  container_id uuid not null,
  amount_ml numeric not null check (amount_ml > 0 and amount_ml < 100000),
  discarded_at timestamptz not null,
  -- Hoy solo leche caducada (D-6). Fase 4 suma 'started_1h' y 'manual'.
  reason text not null default 'expired' check (reason in ('expired')),
  voided_at timestamptz,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint milk_discards_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade,
  constraint milk_discards_container_in_family
    foreign key (container_id, family_id) references milk_containers (id, family_id)
    on delete cascade
);

-- Desechar es total (D-5): como mucho un desecho vivo por contenedor. Fase 4
-- (desechos parciales) dropea este índice; las sumas ya están escritas en
-- plural.
create unique index milk_discards_one_live
  on milk_discards (container_id) where voided_at is null;
create index milk_discards_baby_live
  on milk_discards (baby_id) where voided_at is null;

alter table milk_discards enable row level security;
create policy "select own milk_discards" on milk_discards
  for select using (is_family_member(family_id));
create policy "insert own milk_discards" on milk_discards
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));
create policy "update own milk_discards" on milk_discards
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id) and is_baby_family_member(baby_id));

-- Sin DELETE: el borrado es lógico. INSERT/UPDATE hacen falta porque las
-- funciones son `security invoker`; la guarda impide usarlos por fuera.
revoke all on milk_discards from public, anon, authenticated;
grant select, insert, update on milk_discards to authenticated;

create trigger milk_guard_discards
  before insert or update on milk_discards
  for each row execute function milk_guard_inventory();

-- ================================================================ EDICIONES

-- Una fila por edición completa de una toma aplicada (o reconocida como ya
-- aplicada). `op_id` lo genera el dispositivo. Por qué hace falta (AJ-3): con
-- valores absolutos y "lo que vio la pantalla" no alcanza — A→B (este
-- teléfono), B→A (el otro), y el reenvío tardío de A→B encuentra A = esperado y
-- pisaría al otro. Con el op registrado, el reenvío es un no-op.
-- Sirve además de auditoría: quién cambió la toma y qué había antes.
create table milk_feeding_edits (
  op_id uuid primary key,
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  feeding_id uuid not null references feedings(id) on delete cascade,
  request jsonb not null,
  before jsonb not null,
  result jsonb not null,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint milk_feeding_edits_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

create index milk_feeding_edits_feeding on milk_feeding_edits (feeding_id);

-- Solo se agrega y se lee: un registro de lo que pasó no se corrige
-- (ARQ §3.10). Por eso no hay policy ni grant de UPDATE, y tampoco DELETE.
alter table milk_feeding_edits enable row level security;
create policy "select own milk_feeding_edits" on milk_feeding_edits
  for select using (is_family_member(family_id));
create policy "insert own milk_feeding_edits" on milk_feeding_edits
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));

revoke all on milk_feeding_edits from public, anon, authenticated;
grant select, insert on milk_feeding_edits to authenticated;

create trigger milk_guard_feeding_edits
  before insert or update on milk_feeding_edits
  for each row execute function milk_guard_inventory();

-- ================================================================ GUARDA DE TOMAS

-- Mismo nombre y mismo trigger que 0014; cambia el cuerpo (ARQ §3.9):
--   · `leftover_ml` de una toma CON desglose solo cambia por RPC (AJ-13): así
--     toda corrección de esas tomas queda en milk_feeding_edits.
--   · Cambiar la hora de una toma con desglose por fuera (lo hacen v0.12.1 y
--     v3; v4 nunca) re-valida lo mismo que edit_bottle_feed (AJ-14): no futura
--     según la base (+10 min de tolerancia) y cada porción viva de un
--     contenedor que a esa hora existía y no había vencido (D-7, V4-58).
--   · Una toma sin desglose sigue siendo editable entera, `leftover_ml`
--     incluido (D-11b), y nunca gana desglose por fuera.
create or replace function milk_guard_feedings()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_label text;
begin
  if milk_in_rpc() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.breast_milk_ml is not null or new.formula_ml is not null then
      raise exception 'milk_rpc_only';
    end if;
    return new;
  end if;
  if old.breast_milk_ml is not null or old.formula_ml is not null
     or new.breast_milk_ml is not null or new.formula_ml is not null then
    if new.baby_id is distinct from old.baby_id
       or new.feeding_type is distinct from old.feeding_type
       or new.amount_ml is distinct from old.amount_ml
       or new.breast_milk_ml is distinct from old.breast_milk_ml
       or new.formula_ml is distinct from old.formula_ml
       or new.leftover_ml is distinct from old.leftover_ml
       or new.voided_at is distinct from old.voided_at then
      raise exception 'milk_rpc_only';
    end if;
    if new.fed_at is distinct from old.fed_at then
      if new.fed_at > now() + interval '10 minutes' then
        raise exception 'milk_future_time';
      end if;
      select c.label into v_label
        from milk_drawdowns d join milk_containers c on c.id = d.container_id
       where d.feeding_id = new.id and d.voided_at is null
         and (c.expires_at <= new.fed_at or c.stored_at > new.fed_at + interval '10 minutes')
       order by c.id
       limit 1;
      if v_label is not null then
        raise exception 'milk_container_unusable:%', v_label;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ================================================================ AYUDANTES

-- Lo desechado de un contenedor: la suma de sus desechos vivos. En v4 hay como
-- mucho uno; la suma deja lugar al desecho parcial de fase 4.
create or replace function milk_discarded_ml(p_container_id uuid)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(amount_ml), 0)
  from milk_discards
  where container_id = p_container_id and voided_at is null;
$$;

-- La única regla de reparto (ARQ §2.3). Para todo contenedor no anulado:
--
--   amount_ml = servido_vivo + desechado_vivo + lost_ml + remaining_ml
--
-- Ninguna función escribe remaining_ml ni lost_ml con aritmética propia:
-- cambian lo que les toca (amount_ml, porciones, desecho) y llaman acá, que
-- recalcula cómo se reparte el residuo `amount − servido`. Así la igualdad
-- cierra siempre, por construcción.
--
-- PRECONDICIÓN: quien llama ya tiene el contenedor `FOR UPDATE` y la bandera
-- prendida. La etiqueta se bloquea acá, al final del orden global, y solo si
-- hay que re-ocupar un número.
--
--   delta > 0 (entra leche):
--     · por 'amount' sobre un desechado: crece el desecho (D-8, AJ-10);
--     · si no, si el contenedor PUEDE recibir (no desechado, y ocupado o con su
--       número todavía libre): va a remaining y lo re-ocupa (D-9, CL-9);
--     · si no: va a lost_ml — nunca aparece leche en un biberón que
--       físicamente ya tiene otra cosa (D-9, CL-10).
--   delta < 0 (sale leche no servida): remaining → lost → desecho; un desecho
--     que llega a 0 se anula (su amount_ml queda: la CHECK `> 0` lo exige).
--   Después: ocupado con menos de 0.15 ml (EMPTY_ML) → se libera.
--
-- Devuelve {"label", "returned_ml", "lost_ml"}: lo que en ESTA llamada entró a
-- remaining y lo que fue a lost.
create or replace function milk_rebalance(p_container_id uuid, p_cause text)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c milk_containers%rowtype;
  v_served numeric;
  v_disc numeric;
  v_delta numeric;
  v_need numeric;
  v_take numeric;
  v_rem numeric;
  v_lost numeric;
  v_released timestamptz;
  v_returned numeric := 0;
  v_to_lost numeric := 0;
  v_can boolean;
begin
  -- Defensa en profundidad: es ejecutable por `authenticated` (las funciones
  -- son security invoker y la necesitan), pero llamada sola no hace nada.
  if not milk_in_rpc() then
    raise exception 'milk_rpc_only';
  end if;
  if p_container_id is null or p_cause is null or p_cause not in ('serve', 'return', 'amount') then
    raise exception 'milk_bad_input';
  end if;
  select * into c from milk_containers where id = p_container_id;
  if not found then
    raise exception 'milk_container_unusable';
  end if;
  -- Un anulado no tiene porciones ni desechos vivos (INV-4): no hay nada que
  -- repartir.
  if c.voided_at is not null then
    return jsonb_build_object('label', c.label, 'returned_ml', 0, 'lost_ml', 0);
  end if;

  v_served := milk_served_ml(c.id);
  v_disc := milk_discarded_ml(c.id);
  v_rem := c.remaining_ml;
  v_lost := c.lost_ml;
  v_released := c.released_at;
  v_delta := (c.amount_ml - v_served) - (v_rem + v_disc + v_lost);

  if v_delta > 0 then
    if p_cause = 'amount' and v_disc > 0 then
      update milk_discards set amount_ml = amount_ml + v_delta
        where container_id = c.id and voided_at is null;
    else
      if v_disc > 0 then
        v_can := false;
      elsif v_released is null then
        v_can := true;
      else
        -- Re-ocupar un número: bajo el lock de etiqueta (el mismo de
        -- milk_create_container), así una extracción nueva con ese número y
        -- esta vuelta no se cruzan.
        perform pg_advisory_xact_lock(hashtext('amelia_milk_label:' || c.baby_id::text));
        v_can := not exists (
          select 1 from milk_containers o
          where o.baby_id = c.baby_id and o.label = c.label and o.id <> c.id
            and o.voided_at is null and o.released_at is null
        );
      end if;
      if v_can then
        v_rem := v_rem + v_delta;
        v_released := null;
        v_returned := v_delta;
      else
        v_lost := v_lost + v_delta;
        v_to_lost := v_delta;
      end if;
    end if;
  elsif v_delta < 0 then
    v_need := -v_delta;
    v_take := least(v_rem, v_need);
    v_rem := v_rem - v_take;
    v_need := v_need - v_take;
    v_take := least(v_lost, v_need);
    v_lost := v_lost - v_take;
    v_need := v_need - v_take;
    if v_need > 0 then
      -- Lo que falta sale del desecho. Si lo cubre entero, el desecho
      -- desaparece (anulado) y el contenedor queda libre sin desecho.
      if v_need >= v_disc then
        update milk_discards set voided_at = now()
          where container_id = c.id and voided_at is null;
      else
        update milk_discards set amount_ml = amount_ml - v_need
          where container_id = c.id and voided_at is null;
      end if;
    end if;
  end if;

  if v_released is null and v_rem < 0.15 then
    v_released := now();
  end if;

  if v_rem is distinct from c.remaining_ml
     or v_lost is distinct from c.lost_ml
     or v_released is distinct from c.released_at then
    update milk_containers
       set remaining_ml = v_rem, lost_ml = v_lost, released_at = v_released
     where id = c.id;
  end if;

  return jsonb_build_object('label', c.label, 'returned_ml', v_returned, 'lost_ml', v_to_lost);
end;
$$;

-- Crea el contenedor de una extracción (0014, misma firma). Cambia solo qué es
-- "número ocupado": ahora uno no anulado Y no liberado. Un biberón vaciado o
-- desechado se puede volver a elegir (reglas 4–5). No valida número ≤ N: N es
-- de la pantalla (D-1, D-2).
create or replace function milk_create_container(
  p_container_id uuid,
  p_label text,
  p_baby_id uuid,
  p_session_id uuid,
  p_amount_ml numeric,
  p_stored_at timestamptz
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_fridge numeric;
  v_freezer numeric;
  v_family uuid;
begin
  if p_container_id is null or p_label is null or p_label !~ '^M[1-9][0-9]*$' then
    raise exception 'milk_bad_input';
  end if;
  select family_id, milk_fridge_days, milk_freezer_months into v_family, v_fridge, v_freezer
    from babies where id = p_baby_id;
  if v_family is null then
    raise exception 'milk_baby_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('amelia_milk_label:' || p_baby_id::text));
  if exists (
    select 1 from milk_containers
    where baby_id = p_baby_id and label = p_label
      and voided_at is null and released_at is null
  ) then
    -- El código de cable sigue siendo el de 0014 (AJ-1): la app v3 cacheada lo
    -- traduce. Cambia solo el texto que muestra v4 ("biberón", no "cinta").
    raise exception 'milk_label_taken:%', p_label;
  end if;
  insert into milk_containers (
    id, family_id, baby_id, source_session_id, label,
    amount_ml, remaining_ml, stored_at, location, expires_at, logged_by
  ) values (
    p_container_id, v_family, p_baby_id, p_session_id, p_label,
    p_amount_ml, p_amount_ml, p_stored_at, 'fridge',
    milk_expires_at(p_stored_at, 'fridge', v_fridge, v_freezer), auth.uid()
  );
end;
$$;

-- ================================================================ EXTRACCIÓN

-- Misma firma que 0014 (ARQ §3.2). Cambia la idempotencia: el mismo id con
-- OTRO biberón es un conflicto, no un no-op. El biberón de una extracción no
-- se cambia nunca (regla 18), así que comparar el que creó esta llamada es
-- estricto sin romper ediciones. Se compara contra el contenedor que nombra
-- `p_container_id` (el que creó el alta original), no contra "el vivo de la
-- sesión": una sesión creada sin cantidad que después ganó biberón por
-- edición no debe convertir el reenvío de su alta en un conflicto falso.
create or replace function log_pumping_session(
  p_id uuid,
  p_baby_id uuid,
  p_side text,
  p_left_ml numeric,
  p_right_ml numeric,
  p_notes text,
  p_pumped_at timestamptz,
  p_container_id uuid default null,
  p_container_label text default null,
  -- Se acepta y se IGNORA (0014, S-15): la caducidad la calcula el servidor.
  p_container_expires_at timestamptz default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_total numeric;
  v_existing pumping_sessions%rowtype;
  v_label text;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_baby_id is null or p_pumped_at is null
     or p_side is null or p_side not in ('left', 'right', 'both')
     or (p_left_ml is not null and not (p_left_ml >= 0 and p_left_ml < 100000))
     or (p_right_ml is not null and not (p_right_ml >= 0 and p_right_ml < 100000)) then
    raise exception 'milk_bad_input';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));

  select * into v_existing from pumping_sessions where id = p_id;
  if found then
    if v_existing.baby_id <> p_baby_id then
      raise exception 'milk_idempotency_conflict';
    end if;
    if p_container_id is not null then
      select label into v_label from milk_containers
        where id = p_container_id and source_session_id = p_id;
      -- Otro contenedor (de otra sesión, o uno que esta sesión nunca creó), u
      -- otro número para el mismo: no es un reenvío.
      if not found or v_label is distinct from p_container_label then
        raise exception 'milk_idempotency_conflict';
      end if;
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  -- La hora la pone el teléfono (la extracción offline vale), pero no puede
  -- ser del futuro según la base (m-2, mismo tope de 10 min que D-15). Va
  -- DESPUÉS de la idempotencia: el reenvío de un alta ya guardada no se
  -- re-valida. La app v0.12.1 escribe `pumped_at` directo en forma legada y
  -- esa vía no pasa por acá (queda como estaba).
  if p_pumped_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);
  -- Polvo (M-1): un total entre 0 y 0,15 ml (EMPTY_ML) no es "sin cantidad"
  -- ni un biberón: crearía un OCUPADO con menos de 0,15 ml (rompe INV-5 y
  -- bloquea el número hasta que vence). Se rechaza en vez de redondear a 0 en
  -- silencio; la pantalla tampoco lo deja mandar (readPumpingSides).
  if v_total >= 100000 or (v_total > 0 and v_total < 0.15) then
    raise exception 'milk_bad_input';
  end if;

  insert into pumping_sessions (
    id, baby_id, pumped_at, side, amount_ml, left_ml, right_ml, notes, logged_by
  ) values (
    p_id, p_baby_id, p_pumped_at, p_side,
    case when v_total > 0 then v_total end,
    p_left_ml, p_right_ml, p_notes, v_uid
  );

  -- Hora de entrada al refri = hora de la extracción (D-3).
  if v_total > 0 then
    perform milk_create_container(
      p_container_id, p_container_label, p_baby_id, p_id, v_total, p_pumped_at
    );
  end if;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- Misma firma que 0014 (ARQ §3.3). El contenedor sigue a la extracción; el
-- reparto del cambio lo hace milk_rebalance('amount'):
--   · subir sobre un desechado → crece el desecho (D-8);
--   · subir sobre un libre con su número reusado → lost_ml (D-9);
--   · subir sobre un libre con su número libre → lo re-ocupa;
--   · bajar → sale de remaining, después de lost, después del desecho.
-- Nunca por debajo de lo servido (regla 19). No re-valida las tomas ya
-- servidas al mover la hora (D-7, riesgo escrito en la spec). Idempotente por
-- estado final, como 0014.
create or replace function update_pumping_session(
  p_id uuid,
  p_side text,
  p_left_ml numeric,
  p_right_ml numeric,
  p_notes text,
  p_pumped_at timestamptz,
  p_container_id uuid default null,
  p_container_label text default null,
  p_container_expires_at timestamptz default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_session pumping_sessions%rowtype;
  v_family uuid;
  v_total numeric;
  v_container milk_containers%rowtype;
  v_served numeric;
  v_fridge numeric;
  v_freezer numeric;
  v_legacy boolean;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_pumped_at is null
     or p_side is null or p_side not in ('left', 'right', 'both')
     or (p_left_ml is not null and not (p_left_ml >= 0 and p_left_ml < 100000))
     or (p_right_ml is not null and not (p_right_ml >= 0 and p_right_ml < 100000)) then
    raise exception 'milk_bad_input';
  end if;

  -- Mismo tope que el alta (m-2), también para una legada.
  if p_pumped_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));
  select * into v_session from pumping_sessions where id = p_id for update;
  if not found or v_session.voided_at is not null then
    raise exception 'milk_session_gone';
  end if;
  select family_id, milk_fridge_days, milk_freezer_months
    into v_family, v_fridge, v_freezer
    from babies where id = v_session.baby_id;

  -- Sesión de antes de 0014 sin lados: solo hora y nota (0014, S-22).
  v_legacy := p_left_ml is null and p_right_ml is null
    and v_session.left_ml is null and v_session.right_ml is null
    and v_session.amount_ml is not null;
  if v_legacy then
    update pumping_sessions set notes = p_notes, pumped_at = p_pumped_at where id = p_id;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);
  -- Polvo (M-1): mismo rechazo que el alta.
  if v_total >= 100000 or (v_total > 0 and v_total < 0.15) then
    raise exception 'milk_bad_input';
  end if;

  select * into v_container from milk_containers
    where source_session_id = p_id and voided_at is null
    for update;

  if found then
    v_served := milk_served_ml(v_container.id);
    if v_total > 0 then
      if v_total < v_served then
        raise exception 'milk_served_exceeds_amount:%', v_container.label;
      end if;
      -- `least(remaining, total)` no es aritmética de reparto: la CHECK
      -- remaining ≤ amount no se puede diferir, y bajar amount por debajo del
      -- remaining viejo la violaría antes de llegar a milk_rebalance. Recortar
      -- remaining al total es neutro para el orden remaining → lost → desecho
      -- (lo recortado es justo lo primero que milk_rebalance sacaría de
      -- remaining), así que el resultado es el mismo que sin recorte.
      update milk_containers set
        amount_ml = v_total,
        remaining_ml = least(remaining_ml, v_total),
        stored_at = p_pumped_at,
        expires_at = milk_expires_at(p_pumped_at, v_container.location, v_fridge, v_freezer)
      where id = v_container.id;
      perform milk_rebalance(v_container.id, 'amount');
    else
      if v_served > 0 then
        raise exception 'milk_already_served:%', v_container.label;
      end if;
      -- Sin leche y sin servir: el contenedor y su desecho se anulan juntos
      -- (CL-17: el total de "Leche desechada" baja).
      update milk_discards set voided_at = now()
        where container_id = v_container.id and voided_at is null;
      update milk_containers set voided_at = now() where id = v_container.id;
    end if;
  elsif v_total > 0 then
    -- No tenía cantidad y ahora sí: nace con el biberón ELEGIDO (AJ-5).
    perform milk_create_container(
      p_container_id, p_container_label, v_session.baby_id, p_id, v_total, p_pumped_at
    );
  end if;

  update pumping_sessions set
    side = p_side,
    left_ml = p_left_ml,
    right_ml = p_right_ml,
    amount_ml = case when v_total > 0 then v_total end,
    notes = p_notes,
    pumped_at = p_pumped_at
  where id = p_id;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- Misma firma que 0014 (ARQ §3.4). Servida → no (aunque esté libre o
-- desechada, CL-18). Si no, se anulan sesión, contenedor y su desecho vivo
-- (CL-17).
create or replace function void_pumping_session(p_id uuid, p_voided_at timestamptz default null)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_session pumping_sessions%rowtype;
  v_container milk_containers%rowtype;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));
  select * into v_session from pumping_sessions where id = p_id for update;
  if not found or v_session.voided_at is not null then
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  select * into v_container from milk_containers
    where source_session_id = p_id and voided_at is null
    for update;
  if found then
    if milk_served_ml(v_container.id) > 0 then
      raise exception 'milk_already_served:%', v_container.label;
    end if;
    update milk_discards set voided_at = coalesce(p_voided_at, now())
      where container_id = v_container.id and voided_at is null;
    update milk_containers set voided_at = coalesce(p_voided_at, now())
      where id = v_container.id;
  end if;

  update pumping_sessions set voided_at = coalesce(p_voided_at, now()) where id = p_id;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- ================================================================ DESECHAR

-- "Desechar" leche caducada (regla 8, ARQ §3.5). Todo lo que le queda (D-5);
-- el biberón queda libre.
--
-- Quién decide que venció: `now()` de la BASE (D-15). Un teléfono con el reloj
-- adelantado no tira leche que sirve: recibe `milk_not_expired:M3`. La hora que
-- se guarda es la del teléfono (puede llegar tarde, sin conexión), acotada a
-- [expires_at, now()].
--
-- Idempotente por `p_id`. Ya desechado, libre o anulado → no-op (V4-34, AJ-15):
-- el segundo teléfono que desecha el mismo biberón no ve un rechazo.
create or replace function discard_container(
  p_id uuid,
  p_container_id uuid,
  p_discarded_at timestamptz default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prev uuid;
  c milk_containers%rowtype;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_container_id is null then
    raise exception 'milk_bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));
  select container_id into v_prev from milk_discards where id = p_id;
  if found then
    if v_prev <> p_container_id then
      raise exception 'milk_idempotency_conflict';
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  -- RLS: un contenedor de otra familia no se ve y se trata como inexistente.
  select * into c from milk_containers where id = p_container_id for update;
  if not found then
    raise exception 'milk_container_unusable';
  end if;
  if c.voided_at is not null or c.released_at is not null
     or milk_discarded_ml(c.id) > 0 then
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;
  if now() < c.expires_at then
    raise exception 'milk_not_expired:%', c.label;
  end if;

  -- Un ocupado siempre tiene ≥ 0.15 ml (INV-5). Si no (dato roto), no hay
  -- nada que tirar: solo se libera, en milk_rebalance.
  if c.remaining_ml >= 0.15 then
    insert into milk_discards (
      id, family_id, baby_id, container_id, amount_ml, discarded_at, reason, logged_by
    ) values (
      p_id, c.family_id, c.baby_id, c.id, c.remaining_ml,
      greatest(c.expires_at, least(coalesce(p_discarded_at, now()), now())),
      'expired', v_uid
    );
  end if;
  perform milk_rebalance(c.id, 'amount');
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- ================================================================ TOMA

-- Se dropea y se recrea con un séptimo parámetro CON default (ARQ §3.6, A7).
-- No es una sobrecarga a propósito: PostgREST elige por nombres de argumentos,
-- y con una de seis y otra de siete la llamada de seis de la app v3 matchearía
-- las dos (PGRST203). Con una sola, la de seis nombres resuelve a ésta.
drop function log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb);

create function log_bottle_feed(
  p_id uuid,
  p_baby_id uuid,
  p_fed_at timestamptz,
  p_notes text,
  p_formula_ml numeric,
  -- [{ "container_id": uuid, "amount_ml": number }, …]
  p_portions jsonb,
  -- "Sobró X" (regla 13): solo estadística, no toca el inventario (D-10).
  p_leftover_ml numeric default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_formula numeric := coalesce(p_formula_ml, 0);
  v_portions jsonb := coalesce(p_portions, '[]'::jsonb);
  v_count int;
  v_breast numeric;
  v_existing feedings%rowtype;
  v_container milk_containers%rowtype;
  v_want numeric;
  v_available numeric;
  v_locked int := 0;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_baby_id is null or p_fed_at is null
     or not (v_formula >= 0 and v_formula < 100000)
     or jsonb_typeof(v_portions) <> 'array' then
    raise exception 'milk_bad_input';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_portions) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e->'amount_ml') is distinct from 'number'
       or coalesce(e->>'container_id', '')
          !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    raise exception 'milk_bad_input';
  end if;

  select count(*), coalesce(sum((e->>'amount_ml')::numeric), 0)
    into v_count, v_breast
    from jsonb_array_elements(v_portions) e;
  if exists (
    select 1 from jsonb_array_elements(v_portions) e
    where (e->>'container_id') is null
       or (e->>'amount_ml') is null
       or not ((e->>'amount_ml')::numeric > 0 and (e->>'amount_ml')::numeric < 100000)
  ) or v_count <> (
    select count(distinct e->>'container_id') from jsonb_array_elements(v_portions) e
  ) then
    raise exception 'milk_bad_input';
  end if;
  if not (v_breast + v_formula > 0 and v_breast + v_formula < 100000) then
    raise exception 'milk_bad_input';
  end if;
  -- Sobró: nada, o entre 0 y lo servido (D-10, V4-43).
  if p_leftover_ml is not null
     and not (p_leftover_ml >= 0 and p_leftover_ml < 100000
              and p_leftover_ml <= v_breast + v_formula) then
    raise exception 'milk_bad_input';
  end if;
  -- La hora de la toma la pone el teléfono (la toma offline de las 2 a.m. que
  -- llega a las 9 vale), pero no puede ser del futuro según la base (D-15). La
  -- tolerancia de 10 min es FUTURE_TOLERANCE_MS de lib/milkBottles.ts.
  if p_fed_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));

  select * into v_existing from feedings where id = p_id;
  if found then
    -- AJ-8: si la toma ya se editó con edit_bottle_feed, el reenvío tardío de
    -- su alta es un no-op: el alta se aplicó y una edición posterior la
    -- reemplazó; compararla con el estado editado daría un conflicto falso.
    if exists (select 1 from milk_feeding_edits where feeding_id = p_id) then
      perform set_config('amelia.milk_rpc', '', true);
      return;
    end if;
    -- Idempotencia estricta (S-16) + el sobró: misma carga = reenvío.
    if v_existing.baby_id <> p_baby_id
       or v_existing.feeding_type <> 'bottle'
       or coalesce(v_existing.formula_ml, -1) <> v_formula
       or v_existing.leftover_ml is distinct from p_leftover_ml
       or exists (
         (select (e->>'container_id')::uuid, (e->>'amount_ml')::numeric
            from jsonb_array_elements(v_portions) e)
         except
         (select container_id, amount_ml from milk_drawdowns where feeding_id = p_id)
       )
       or exists (
         (select container_id, amount_ml from milk_drawdowns where feeding_id = p_id)
         except
         (select (e->>'container_id')::uuid, (e->>'amount_ml')::numeric
            from jsonb_array_elements(v_portions) e)
       ) then
      raise exception 'milk_idempotency_conflict';
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  for v_container in
    select * from milk_containers
    where id in (select (e->>'container_id')::uuid from jsonb_array_elements(v_portions) e)
    order by id
    for update
  loop
    v_locked := v_locked + 1;
    if v_container.baby_id <> p_baby_id
       or v_container.voided_at is not null
       or v_container.expires_at <= p_fed_at then
      raise exception 'milk_container_unusable:%', v_container.label;
    end if;
    select (e->>'amount_ml')::numeric into v_want
      from jsonb_array_elements(v_portions) e
      where (e->>'container_id')::uuid = v_container.id;
    -- Disponible = lo que le queda (en v4, amount − servido ignoraría desecho y
    -- pérdida). Un liberado (vaciado o desechado) no tiene leche que cuente:
    -- quien sirvió de él sin conexión mientras otro lo desechaba ve el
    -- sobregiro (D-22, AJ-6).
    v_available := case when v_container.released_at is null
                        then v_container.remaining_ml else 0 end;
    if v_want > v_available then
      raise exception 'milk_overdraw:%', v_container.label;
    end if;
  end loop;
  if v_locked <> v_count then
    raise exception 'milk_container_unusable';
  end if;

  insert into feedings (
    id, baby_id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml,
    leftover_ml, notes, logged_by
  ) values (
    p_id, p_baby_id, p_fed_at, 'bottle', v_breast + v_formula, v_breast, v_formula,
    p_leftover_ml, p_notes, v_uid
  );

  insert into milk_drawdowns (family_id, baby_id, container_id, feeding_id, amount_ml, logged_by)
    select v_family, p_baby_id, (e->>'container_id')::uuid, p_id, (e->>'amount_ml')::numeric, v_uid
    from jsonb_array_elements(v_portions) e;

  -- Libera los que quedan con menos de 0.15 ml (V4-14), en orden de id.
  for v_id in
    select (e->>'container_id')::uuid from jsonb_array_elements(v_portions) e order by 1
  loop
    perform milk_rebalance(v_id, 'serve');
  end loop;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- Se dropea y se recrea porque cambia el retorno, void → jsonb (ARQ §3.7, AJ-7):
-- "la pantalla lo dice" cuando la leche no puede volver (D-9). La app v3
-- ignora el cuerpo de la respuesta (lib/db.ts sendOpWith solo lee `error`).
drop function void_bottle_feed(uuid, timestamptz);

create function void_bottle_feed(p_feeding_id uuid, p_voided_at timestamptz default null)
returns jsonb -- {"returned_ml": n, "lost": [{"label": "M3", "ml": n}, …]}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_feeding feedings%rowtype;
  v_ids uuid[];
  v_id uuid;
  v_rb jsonb;
  v_returned numeric := 0;
  v_lost jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_feeding_id::text));
  select * into v_feeding from feedings where id = p_feeding_id for update;
  if not found or v_feeding.voided_at is not null then
    perform set_config('amelia.milk_rpc', '', true);
    return jsonb_build_object('returned_ml', 0, 'lost', '[]'::jsonb);
  end if;

  select array_agg(container_id order by container_id) into v_ids
    from milk_drawdowns
    where feeding_id = p_feeding_id and voided_at is null;
  perform 1 from milk_containers where id = any (v_ids) order by id for update;

  update milk_drawdowns set voided_at = coalesce(p_voided_at, now())
    where feeding_id = p_feeding_id and voided_at is null;

  -- Cada porción vuelve por la regla única: al biberón si todavía la puede
  -- recibir, a lost_ml si no (D-9).
  if v_ids is not null then
    foreach v_id in array v_ids loop
      v_rb := milk_rebalance(v_id, 'return');
      v_returned := v_returned + (v_rb->>'returned_ml')::numeric;
      if (v_rb->>'lost_ml')::numeric > 0 then
        v_lost := v_lost || jsonb_build_array(
          jsonb_build_object('label', v_rb->>'label', 'ml', (v_rb->>'lost_ml')::numeric)
        );
      end if;
    end loop;
  end if;

  update feedings set voided_at = coalesce(p_voided_at, now()) where id = p_feeding_id;
  perform set_config('amelia.milk_rpc', '', true);
  return jsonb_build_object('returned_ml', v_returned, 'lost', v_lost);
end;
$$;

-- Edición completa de una toma con desglose (regla 17, ARQ §3.8): hora, leche,
-- fórmula, sobró y nota. Los valores son ABSOLUTOS (el estado final pedido).
--
--   · Idempotencia por `p_op_id` (AJ-3): ya registrado con la misma carga →
--     devuelve el resultado guardado; con otra → milk_idempotency_conflict.
--   · Concurrencia por `p_expected` (regla 21): si la toma no está ni como la
--     vio la pantalla ni como se pide → milk_edit_conflict.
--   · Baja la leche (D-17): vuelve primero a la porción del contenedor más
--     NUEVO; cada porción baja hasta 0 (y se anula) antes de pasar a la otra.
--   · Sube la leche (D-18): de la leche más VIEJA que a la hora de la toma
--     existía y no había vencido; si no alcanza → milk_not_enough:<ml
--     disponibles> y nada se guarda (V4-54). La fórmula no tiene inventario y
--     nunca bloquea.
--   · La hora nueva re-valida cada porción que queda viva (D-7, V4-55).
create function edit_bottle_feed(
  p_op_id uuid,
  p_feeding_id uuid,
  p_fed_at timestamptz,
  p_breast_ml numeric,
  p_formula_ml numeric,
  p_leftover_ml numeric,
  p_notes text,
  -- {"fed_at", "breast_milk_ml", "formula_ml", "leftover_ml"} que vio la pantalla
  p_expected jsonb
)
returns jsonb -- {"returned_ml", "lost": [{label, ml}], "taken": [{label, ml}]}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_exp_fed timestamptz;
  v_exp_breast numeric;
  v_exp_formula numeric;
  v_exp_leftover numeric;
  v_request jsonb;
  v_done milk_feeding_edits%rowtype;
  v_f feedings%rowtype;
  v_family uuid;
  v_before jsonb;
  v_result jsonb;
  v_delta numeric;
  v_need numeric;
  v_take numeric;
  v_avail numeric;
  v_ids uuid[];
  v_return_ids uuid[] := '{}';
  v_serve_ids uuid[] := '{}';
  v_id uuid;
  v_bad text;
  v_rb jsonb;
  v_returned numeric := 0;
  v_lost jsonb := '[]'::jsonb;
  v_taken jsonb := '[]'::jsonb;
  r record;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_feeding_id is null or p_fed_at is null
     or p_breast_ml is null or not (p_breast_ml >= 0 and p_breast_ml < 100000)
     or p_formula_ml is null or not (p_formula_ml >= 0 and p_formula_ml < 100000)
     or not (p_breast_ml + p_formula_ml > 0 and p_breast_ml + p_formula_ml < 100000)
     or (p_leftover_ml is not null
         and not (p_leftover_ml >= 0 and p_leftover_ml < 100000
                  and p_leftover_ml <= p_breast_ml + p_formula_ml))
     or p_expected is null or jsonb_typeof(p_expected) <> 'object'
     or not (p_expected ?& array['fed_at', 'breast_milk_ml', 'formula_ml', 'leftover_ml'])
     or jsonb_typeof(p_expected->'fed_at') <> 'string'
     or jsonb_typeof(p_expected->'breast_milk_ml') <> 'number'
     or jsonb_typeof(p_expected->'formula_ml') <> 'number'
     or jsonb_typeof(p_expected->'leftover_ml') not in ('number', 'null') then
    raise exception 'milk_bad_input';
  end if;
  begin
    v_exp_fed := (p_expected->>'fed_at')::timestamptz;
  exception when others then
    raise exception 'milk_bad_input';
  end;
  v_exp_breast := (p_expected->>'breast_milk_ml')::numeric;
  v_exp_formula := (p_expected->>'formula_ml')::numeric;
  v_exp_leftover := (p_expected->>'leftover_ml')::numeric;

  -- La carga canónica: todo menos el op_id, con las horas en epoch para que la
  -- comparación no dependa del formato ni de la zona de la sesión.
  v_request := jsonb_build_object(
    'feeding_id', p_feeding_id,
    'fed_at', extract(epoch from p_fed_at),
    'breast_ml', p_breast_ml,
    'formula_ml', p_formula_ml,
    'leftover_ml', p_leftover_ml,
    'notes', p_notes,
    'expected', jsonb_build_object(
      'fed_at', extract(epoch from v_exp_fed),
      'breast_milk_ml', v_exp_breast,
      'formula_ml', v_exp_formula,
      'leftover_ml', v_exp_leftover
    )
  );

  -- 1. La operación: un reenvío espera a que termine la primera y ve lo que hizo.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_feeding_edits where op_id = p_op_id;
  if found then
    if v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  -- 2. La toma: serializa con void_bottle_feed y con otras ediciones.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_feeding_id::text));
  -- RLS: una toma de otra familia no se ve.
  select * into v_f from feedings where id = p_feeding_id for update;
  if not found or v_f.voided_at is not null then
    raise exception 'milk_feeding_gone';
  end if;
  -- Una toma sin desglose (vieja o de v0.12.1) se estima y no se edita por acá
  -- (D-14b): fijarle leche exigiría porciones de leche que no existe.
  if v_f.breast_milk_ml is null and v_f.formula_ml is null then
    raise exception 'milk_not_inventory';
  end if;
  select family_id into v_family from babies where id = v_f.baby_id;

  v_before := jsonb_build_object(
    'fed_at', v_f.fed_at,
    'breast_milk_ml', v_f.breast_milk_ml,
    'formula_ml', v_f.formula_ml,
    'leftover_ml', v_f.leftover_ml,
    'notes', v_f.notes,
    'portions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'container_id', d.container_id, 'label', c.label, 'amount_ml', d.amount_ml)
               order by c.id), '[]'::jsonb)
        from milk_drawdowns d join milk_containers c on c.id = d.container_id
       where d.feeding_id = p_feeding_id and d.voided_at is null
    )
  );

  -- 3. Ya está como se pide (otra edición llegó a lo mismo): se registra el op
  --    como no-op, así su reenvío también lo es.
  if v_f.fed_at = p_fed_at
     and coalesce(v_f.breast_milk_ml, 0) = p_breast_ml
     and coalesce(v_f.formula_ml, 0) = p_formula_ml
     and v_f.leftover_ml is not distinct from p_leftover_ml
     and v_f.notes is not distinct from p_notes then
    v_result := jsonb_build_object('returned_ml', 0, 'lost', '[]'::jsonb, 'taken', '[]'::jsonb);
    insert into milk_feeding_edits (
      op_id, family_id, baby_id, feeding_id, request, before, result, logged_by
    ) values (
      p_op_id, v_family, v_f.baby_id, p_feeding_id, v_request, v_before, v_result, v_uid
    );
    perform set_config('amelia.milk_rpc', '', true);
    return v_result;
  end if;

  -- 4. Otro teléfono la cambió desde que esta pantalla la leyó (regla 21: gana
  --    el primero). La hora se compara al milisegundo: es lo que conserva un
  --    Date de JavaScript.
  if date_trunc('milliseconds', v_f.fed_at) <> date_trunc('milliseconds', v_exp_fed)
     or coalesce(v_f.breast_milk_ml, 0) <> v_exp_breast
     or coalesce(v_f.formula_ml, 0) <> v_exp_formula
     or v_f.leftover_ml is distinct from v_exp_leftover then
    raise exception 'milk_edit_conflict';
  end if;

  if p_fed_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  v_delta := p_breast_ml - coalesce(v_f.breast_milk_ml, 0);

  -- 5. Bloqueo de contenedores, en un solo SELECT ordenado por id: los de las
  --    porciones de esta toma (vivas o no: una anulada puede reavivarse) y, si
  --    sube, los candidatos a esa hora. Con los locks tomados el plan se
  --    calcula con lo que hay AHORA (otro pudo servir mientras se esperaba), y
  --    solo entre los bloqueados.
  select array_agg(id order by id) into v_ids from (
    select container_id as id from milk_drawdowns where feeding_id = p_feeding_id
    union
    select c.id from milk_containers c
     where v_delta > 0 and c.baby_id = v_f.baby_id
       and c.voided_at is null and c.released_at is null
       and c.stored_at <= p_fed_at and c.expires_at > p_fed_at
  ) s;
  perform 1 from milk_containers where id = any (v_ids) order by id for update;

  -- 6. El plan.
  if v_delta < 0 then
    v_need := -v_delta;
    for r in
      select d.id, d.container_id, d.amount_ml
        from milk_drawdowns d join milk_containers c on c.id = d.container_id
       where d.feeding_id = p_feeding_id and d.voided_at is null
       order by c.stored_at desc, substring(c.label from 2)::numeric desc, c.id desc
    loop
      exit when v_need <= 0;
      v_take := least(r.amount_ml, v_need);
      if v_take >= r.amount_ml then
        update milk_drawdowns set voided_at = now() where id = r.id;
      else
        update milk_drawdowns set amount_ml = amount_ml - v_take where id = r.id;
      end if;
      v_need := v_need - v_take;
      v_return_ids := array_append(v_return_ids, r.container_id);
    end loop;
  elsif v_delta > 0 then
    select coalesce(sum(c.remaining_ml), 0) into v_avail
      from milk_containers c
     where c.id = any (v_ids) and c.baby_id = v_f.baby_id
       and c.voided_at is null and c.released_at is null
       and c.stored_at <= p_fed_at and c.expires_at > p_fed_at
       and c.remaining_ml >= 0.15;
    if v_avail < v_delta then
      raise exception 'milk_not_enough:%', trim_scale(round(v_avail, 4));
    end if;
    v_need := v_delta;
    for r in
      select c.id, c.label, c.remaining_ml
        from milk_containers c
       where c.id = any (v_ids) and c.baby_id = v_f.baby_id
         and c.voided_at is null and c.released_at is null
         and c.stored_at <= p_fed_at and c.expires_at > p_fed_at
         and c.remaining_ml >= 0.15
       order by c.stored_at, substring(c.label from 2)::numeric, c.id
    loop
      exit when v_need <= 0;
      v_take := least(r.remaining_ml, v_need);
      -- Una toma saca de un contenedor una sola vez (unique de 0014): si ya
      -- tiene porción de él, crece; si una edición anterior la anuló, se
      -- reaviva con el monto nuevo.
      update milk_drawdowns
         set amount_ml = case when voided_at is null then amount_ml + v_take else v_take end,
             voided_at = null
       where feeding_id = p_feeding_id and container_id = r.id;
      if not found then
        insert into milk_drawdowns (
          family_id, baby_id, container_id, feeding_id, amount_ml, logged_by
        ) values (v_family, v_f.baby_id, r.id, p_feeding_id, v_take, v_uid);
      end if;
      v_need := v_need - v_take;
      v_serve_ids := array_append(v_serve_ids, r.id);
      v_taken := v_taken || jsonb_build_array(jsonb_build_object('label', r.label, 'ml', v_take));
    end loop;
  end if;

  -- 7. Cada porción que queda viva, válida a la hora (nueva) de la toma.
  --    Solo si la edición mueve la hora o la leche (m-1): corregir la nota,
  --    el sobró o la fórmula de una toma que log_bottle_feed aceptó (p. ej.
  --    anterior a la extracción, S-17, o una extracción cuya hora se corrió
  --    después, D-7) no puede quedar bloqueado por porciones que nadie toca.
  if p_fed_at is distinct from v_f.fed_at or v_delta <> 0 then
    select c.label into v_bad
      from milk_drawdowns d join milk_containers c on c.id = d.container_id
     where d.feeding_id = p_feeding_id and d.voided_at is null
       and (c.expires_at <= p_fed_at or c.stored_at > p_fed_at + interval '10 minutes')
     order by c.id
     limit 1;
  end if;
  if v_bad is not null then
    raise exception 'milk_container_unusable:%', v_bad;
  end if;

  -- 8. El reparto, por la regla única.
  for v_id in select distinct u from unnest(v_return_ids) u order by 1 loop
    v_rb := milk_rebalance(v_id, 'return');
    v_returned := v_returned + (v_rb->>'returned_ml')::numeric;
    if (v_rb->>'lost_ml')::numeric > 0 then
      v_lost := v_lost || jsonb_build_array(
        jsonb_build_object('label', v_rb->>'label', 'ml', (v_rb->>'lost_ml')::numeric)
      );
    end if;
  end loop;
  for v_id in select distinct u from unnest(v_serve_ids) u order by 1 loop
    perform milk_rebalance(v_id, 'serve');
  end loop;

  update feedings set
    fed_at = p_fed_at,
    breast_milk_ml = p_breast_ml,
    formula_ml = p_formula_ml,
    amount_ml = p_breast_ml + p_formula_ml,
    leftover_ml = p_leftover_ml,
    notes = p_notes
  where id = p_feeding_id;

  v_result := jsonb_build_object('returned_ml', v_returned, 'lost', v_lost, 'taken', v_taken);
  insert into milk_feeding_edits (
    op_id, family_id, baby_id, feeding_id, request, before, result, logged_by
  ) values (
    p_op_id, v_family, v_f.baby_id, p_feeding_id, v_request, v_before, v_result, v_uid
  );
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- ================================================================ PERMISOS
--
-- Supabase le da EXECUTE a anon sobre toda función nueva de public: se saca de
-- todos lados y se da solo a authenticated. Las de 0014 que solo cambiaron el
-- cuerpo (`create or replace`) conservan sus permisos; las recreadas no.

revoke all on function milk_discarded_ml(uuid) from public, anon;
revoke all on function milk_rebalance(uuid, text) from public, anon;
revoke all on function discard_container(uuid, uuid, timestamptz) from public, anon;
revoke all on function log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb, numeric)
  from public, anon;
revoke all on function void_bottle_feed(uuid, timestamptz) from public, anon;
revoke all on function edit_bottle_feed(
  uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb
) from public, anon;

grant execute on function milk_discarded_ml(uuid) to authenticated;
grant execute on function milk_rebalance(uuid, text) to authenticated;
grant execute on function discard_container(uuid, uuid, timestamptz) to authenticated;
grant execute on function log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb, numeric)
  to authenticated;
grant execute on function void_bottle_feed(uuid, timestamptz) to authenticated;
grant execute on function edit_bottle_feed(
  uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb
) to authenticated;

-- ================================================================ INVARIANTE

-- La consulta de ARQ §2.4, tal cual (la misma que corren QA y la auditoría con
-- `pnpm db:psql`, y la que reconstruye tests/helpers/milkInvariant.ts). Si
-- devuelve algo, los datos no cierran y la migración no se aplica: mejor un
-- deploy frenado que un inventario que miente. INV-7 es constraint.
do $$
declare
  v_n int;
  v_first text;
begin
  with srv as (
    select container_id, sum(amount_ml) as ml
    from milk_drawdowns where voided_at is null group by container_id
  ), dsc as (
    select container_id, sum(amount_ml) as ml, count(*) as n
    from milk_discards where voided_at is null group by container_id
  ), fallas as (
    select 'INV-1 cuenta' as falla, c.id
      from milk_containers c
      left join srv s on s.container_id = c.id
      left join dsc d on d.container_id = c.id
     where c.voided_at is null
       and abs(c.amount_ml - coalesce(s.ml,0) - coalesce(d.ml,0) - c.lost_ml - c.remaining_ml) > 1e-9
    union all
    select 'INV-2 número doble', min(c.id::text)::uuid
      from milk_containers c
     where c.voided_at is null and c.released_at is null
     group by c.baby_id, c.label having count(*) > 1
    union all
    select 'INV-3 desecho incoherente', c.id
      from milk_containers c join dsc d on d.container_id = c.id
     where c.voided_at is not null or c.released_at is null or c.remaining_ml <> 0
    union all
    select 'INV-4 anulado con vivos', c.id
      from milk_containers c
      left join srv s on s.container_id = c.id
      left join dsc d on d.container_id = c.id
     where c.voided_at is not null and (s.ml is not null or d.ml is not null)
    union all
    select 'INV-5 ocupado vacío', c.id
      from milk_containers c
     where c.voided_at is null and c.released_at is null and c.remaining_ml < 0.15
    union all
    select 'INV-6 desglose', f.id
      from feedings f
      left join (select feeding_id, sum(amount_ml) ml from milk_drawdowns
                  where voided_at is null group by feeding_id) p on p.feeding_id = f.id
     where f.voided_at is null and (f.breast_milk_ml is not null or f.formula_ml is not null)
       and (abs(coalesce(f.breast_milk_ml,0) - coalesce(p.ml,0)) > 1e-9
            or abs(f.amount_ml - coalesce(f.breast_milk_ml,0) - coalesce(f.formula_ml,0)) > 1e-9)
    union all
    select 'INV-8 sesión≠contenedor', c.id
      from milk_containers c join pumping_sessions ps on ps.id = c.source_session_id
     where c.voided_at is null and ps.voided_at is null and ps.amount_ml is distinct from c.amount_ml
    union all
    select 'INV-9 porción huérfana', d.feeding_id
      from milk_drawdowns d join feedings f on f.id = d.feeding_id
     where d.voided_at is null and f.voided_at is not null
  )
  select count(*), min(falla || ' ' || id::text) into v_n, v_first from fallas;
  if v_n > 0 then
    raise exception 'milk_invariant_broken'
      using detail = format('%s fila(s); la primera: %s', v_n, v_first);
  end if;
end;
$$;

select set_config('amelia.milk_rpc', '', true);

-- PostgREST cachea el esquema: sin esto las funciones nuevas dan 404 hasta el
-- próximo reinicio (C-24). Se entrega al hacer commit.
notify pgrst, 'reload schema';
