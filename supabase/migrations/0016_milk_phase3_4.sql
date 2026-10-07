-- Inventario de leche v5, fases 3 y 4 de las respuestas de papá (7 oct 2026).
--
-- Numerada en este repo por pedido explícito del dueño (CLAUDE.md §5.2), igual
-- que 0007…0015. Al escribirse está aplicada SOLO en el stack local; en la nube
-- se aplica a mano, DESPUÉS de 0015 y ANTES de que la app v5 llegue a `main`.
--
-- Fuente de verdad: docs/respuestas-papa-leche.md. Requisitos (V5-xx) y
-- decisiones (D5-x): docs/spec-feeding-v5.md. Si algo acá la contradice, el
-- bug es este archivo.
--
-- Qué agrega, en una línea cada cosa:
--   · milk_containers.fridge_at / cold_at: "Enfriando" (V5-20…V5-23). Fría a
--     la hora t ⇔ cold_at <= t o coalesce(fridge_at, stored_at) + 60 min <= t.
--     La caducidad NO cambia: sigue desde stored_at (= pumped_at, D-3).
--   · milk_ops: registro de operaciones de las RPC nuevas (idempotencia por
--     op_id del dispositivo, como milk_feeding_edits).
--   · milk_transfers: "Combinar" biberones (V5-30…V5-35). La cuenta de un
--     contenedor pasa a  amount + entra = servido + desechado + lost +
--     remaining + sale  (INV-1). amount_ml sigue siendo el de su extracción
--     (INV-8 intacta: las estadísticas izq/der no se tocan).
--   · milk_discards: el biberón empezado que pasó su hora (V5-10…V5-12):
--     reason 'started_bottle_expired', container_id nulo y feeding_id.
--   · formula_containers: inventario de Similac (V5-01…V5-07). El consumo NO
--     se escribe: se deriva de feedings.formula_ml (D5-13).
--   · Funciones: milk_mark_cold, milk_combine, milk_uncombine,
--     discard_started_bottle, formula_add/open/finish/void nuevas;
--     milk_rebalance, milk_create_container, update_pumping_session y
--     void_pumping_session cambian el cuerpo; log_pumping_session se recrea con
--     un parámetro más CON default (p_fridge_at), como 0015 hizo con
--     log_bottle_feed.
--   · Al final, la invariante INV-1…INV-12: si los datos no cierran, la
--     migración entera se aborta con `milk_invariant_broken`.
--
-- Aditiva salvo UNA relajación, a propósito: se quita la CHECK
-- milk_containers_remaining_le_amount (remaining ≤ amount). Un biberón destino
-- de una combinación tiene más leche que la de su propia extracción; la cuenta
-- que manda ahora es INV-1 con transferencias, que la invariante verifica.

begin;

-- Los UPDATE del backfill pasan por la guarda de milk_containers (0014), que
-- solo deja escribir con esta bandera. Es local a la transacción.
select set_config('amelia.milk_rpc', 'on', true);

-- ================================================================ CONSTANTES

-- Espejo de lib/milkParams.ts (U-P1 las compara con este texto). Cada una es
-- una "decisión a confirmar" (spec §4); cambiarla es una migración nueva.
create or replace function milk_cooling_minutes()
returns integer language sql immutable set search_path = public as $$ select 60 $$;

create or replace function milk_started_bottle_minutes()
returns integer language sql immutable set search_path = public as $$ select 60 $$;

create or replace function formula_open_max_hours()
returns integer language sql immutable set search_path = public as $$ select 48 $$;

-- 8 oz US (8 × 29.5735295625 ml): el tamaño de una botella de Similac.
create or replace function formula_bottle_ml()
returns numeric language sql immutable set search_path = public as $$ select 236.5882365 $$;

-- ================================================================ ENFRIADO

-- Hora en que entró al refri (la manda el teléfono al tocar "Registrar",
-- acotada por la base) y hora en que alguien confirmó "Ya está fría". Las dos
-- nulas son válidas: fridge_at nulo cae en stored_at.
alter table milk_containers
  add column fridge_at timestamptz,
  add column cold_at timestamptz;

-- Las filas que ya existen entraron al refri cuando se extrajeron (D-3): con
-- esto todas quedan "frías" (llevan más de 60 min ahí, salvo una de los
-- últimos minutos, que se enfría como cualquier otra).
update milk_containers set fridge_at = stored_at where fridge_at is null;

-- Un destino de combinación tiene más leche que su extracción (ver arriba).
alter table milk_containers drop constraint milk_containers_remaining_le_amount;

create or replace function milk_is_cold(c milk_containers, t timestamptz)
returns boolean
language sql stable set search_path = public as $$
  select (c.cold_at is not null and c.cold_at <= t)
      or coalesce(c.fridge_at, c.stored_at) + milk_cooling_minutes() * interval '1 minute' <= t;
$$;

-- ================================================================ OPERACIONES

-- Una fila por operación aplicada de las RPC nuevas. `op_id` lo genera el
-- dispositivo; `request` es la carga canónica (sin el op_id). Reenvío con la
-- misma carga → devuelve `result`; otra carga con el mismo op_id →
-- milk_idempotency_conflict. Solo se agrega y se lee, como milk_feeding_edits.
create table milk_ops (
  op_id uuid primary key,
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  kind text not null check (kind in (
    'combine', 'uncombine', 'mark_cold',
    'formula_add', 'formula_open', 'formula_finish', 'formula_void'
  )),
  request jsonb not null,
  result jsonb not null,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint milk_ops_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

create index milk_ops_baby on milk_ops (baby_id);

alter table milk_ops enable row level security;
create policy "select own milk_ops" on milk_ops
  for select using (is_family_member(family_id));
create policy "insert own milk_ops" on milk_ops
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));

revoke all on milk_ops from public, anon, authenticated;
grant select, insert on milk_ops to authenticated;

create trigger milk_guard_ops
  before insert or update on milk_ops
  for each row execute function milk_guard_inventory();

-- ================================================================ TRANSFERENCIAS

-- "Combinar": cada origen pasa todo lo que le queda al destino. Una fila por
-- origen; todas las de una combinación comparten op_id (lo que deshace
-- milk_uncombine). target_prev_expires_at es la caducidad del destino ANTES
-- de la combinación: deshacer la restaura.
create table milk_transfers (
  id uuid primary key default gen_random_uuid(),
  op_id uuid not null,
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  from_container_id uuid not null,
  to_container_id uuid not null,
  amount_ml numeric not null check (amount_ml > 0 and amount_ml < 100000),
  target_prev_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  logged_by uuid references auth.users(id),
  constraint milk_transfers_not_self check (from_container_id <> to_container_id),
  constraint milk_transfers_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade,
  constraint milk_transfers_from_in_family
    foreign key (from_container_id, family_id) references milk_containers (id, family_id)
    on delete cascade,
  constraint milk_transfers_to_in_family
    foreign key (to_container_id, family_id) references milk_containers (id, family_id)
    on delete cascade
);

create index milk_transfers_from_live
  on milk_transfers (from_container_id) where voided_at is null;
create index milk_transfers_to_live
  on milk_transfers (to_container_id) where voided_at is null;
create index milk_transfers_op on milk_transfers (op_id);

alter table milk_transfers enable row level security;
create policy "select own milk_transfers" on milk_transfers
  for select using (is_family_member(family_id));
create policy "insert own milk_transfers" on milk_transfers
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));
create policy "update own milk_transfers" on milk_transfers
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id) and is_baby_family_member(baby_id));

revoke all on milk_transfers from public, anon, authenticated;
grant select, insert, update on milk_transfers to authenticated;

create trigger milk_guard_transfers
  before insert or update on milk_transfers
  for each row execute function milk_guard_inventory();

-- Lo que entró y lo que salió de un contenedor por transferencias vivas.
create or replace function milk_transferred_in_ml(p_container_id uuid)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(amount_ml), 0)
  from milk_transfers
  where to_container_id = p_container_id and voided_at is null;
$$;

create or replace function milk_transferred_out_ml(p_container_id uuid)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(amount_ml), 0)
  from milk_transfers
  where from_container_id = p_container_id and voided_at is null;
$$;

-- ================================================================ DESECHOS

-- El CHECK de 0015 (solo 'expired') se reemplaza: entra el biberón empezado
-- que pasó su hora. Las filas 'expired' existentes cumplen todo lo nuevo
-- (tienen contenedor y no tienen toma).
alter table milk_discards drop constraint milk_discards_reason_check;
alter table milk_discards
  add constraint milk_discards_reason_check
    check (reason in ('expired', 'started_bottle_expired'));

alter table milk_discards alter column container_id drop not null;
alter table milk_discards
  add column feeding_id uuid references feedings(id) on delete cascade;

-- La forma: leche caducada ⇒ de un biberón y de ninguna toma; biberón
-- empezado ⇒ de una toma y de ningún biberón.
alter table milk_discards
  add constraint milk_discards_shape check (
    (reason = 'expired' and container_id is not null and feeding_id is null)
    or (reason = 'started_bottle_expired' and feeding_id is not null and container_id is null)
  );

-- Como mucho un desecho vivo por biberón (0015) y uno por toma (nuevo).
drop index milk_discards_one_live;
create unique index milk_discards_one_live
  on milk_discards (container_id) where voided_at is null and container_id is not null;
create unique index milk_discards_one_live_feeding
  on milk_discards (feeding_id) where voided_at is null and feeding_id is not null;

-- ================================================================ FÓRMULA

-- Una fila por botella de Similac. Cerrada = opened_at nulo; abierta =
-- opened_at sin finished_at; terminada = finished_at ('empty', 'expired' o
-- 'replaced' cuando se abrió otra). El consumo se deriva de las tomas.
create table formula_containers (
  -- Lo genera el dispositivo: anotar una compra o abrir se hace sin conexión.
  id uuid primary key,
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  size_ml numeric not null check (size_ml > 0 and size_ml < 100000),
  added_at timestamptz not null,
  opened_at timestamptz,
  finished_at timestamptz,
  finish_reason text check (finish_reason in ('empty', 'expired', 'replaced')),
  voided_at timestamptz,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint formula_containers_finished_opened
    check (finished_at is null or opened_at is not null),
  constraint formula_containers_reason_iff_finished
    check ((finish_reason is null) = (finished_at is null)),
  constraint formula_containers_finished_after_opened
    check (finished_at >= opened_at),
  constraint formula_containers_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

-- Nunca dos abiertas vivas para el mismo bebé (respaldo del lock de fórmula).
create unique index formula_containers_one_open
  on formula_containers (baby_id)
  where opened_at is not null and finished_at is null and voided_at is null;
create index formula_containers_baby_live
  on formula_containers (baby_id) where voided_at is null;

alter table formula_containers enable row level security;
create policy "select own formula_containers" on formula_containers
  for select using (is_family_member(family_id));
create policy "insert own formula_containers" on formula_containers
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));
create policy "update own formula_containers" on formula_containers
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id) and is_baby_family_member(baby_id));

revoke all on formula_containers from public, anon, authenticated;
grant select, insert, update on formula_containers to authenticated;

create trigger milk_guard_formula
  before insert or update on formula_containers
  for each row execute function milk_guard_inventory();

-- ================================================================ REPARTO

-- La única regla de reparto (0015), con transferencias. Para todo contenedor
-- no anulado:
--
--   amount + entra_vivo = servido + desechado + lost + remaining + sale_vivo
--
-- Causa nueva 'transfer' (combinar o deshacer). Lo que cambia respecto de
-- 0015, y nada más:
--   · un contenedor con transferencias de SALIDA vivas (se volcó en otro) no
--     recibe por 'amount' ni por 'return': esa leche va a lost_ml (D5-19, "la
--     leche no vuelve a un biberón que se volcó en otro");
--   · por 'transfer' (deshacer) sí recibe con la regla normal: número libre →
--     lo re-ocupa.
-- PRECONDICIÓN igual que 0015: el contenedor ya está `FOR UPDATE` y la
-- bandera prendida; la etiqueta se bloquea acá, al final del orden global.
create or replace function milk_rebalance(p_container_id uuid, p_cause text)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c milk_containers%rowtype;
  v_served numeric;
  v_disc numeric;
  v_in numeric;
  v_out numeric;
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
  if not milk_in_rpc() then
    raise exception 'milk_rpc_only';
  end if;
  if p_container_id is null or p_cause is null
     or p_cause not in ('serve', 'return', 'amount', 'transfer') then
    raise exception 'milk_bad_input';
  end if;
  select * into c from milk_containers where id = p_container_id;
  if not found then
    raise exception 'milk_container_unusable';
  end if;
  if c.voided_at is not null then
    return jsonb_build_object('label', c.label, 'returned_ml', 0, 'lost_ml', 0);
  end if;

  v_served := milk_served_ml(c.id);
  v_disc := milk_discarded_ml(c.id);
  v_in := milk_transferred_in_ml(c.id);
  v_out := milk_transferred_out_ml(c.id);
  v_rem := c.remaining_ml;
  v_lost := c.lost_ml;
  v_released := c.released_at;
  v_delta := (c.amount_ml + v_in - v_served - v_out) - (v_rem + v_disc + v_lost);

  if v_delta > 0 then
    if p_cause = 'amount' and v_disc > 0 then
      update milk_discards set amount_ml = amount_ml + v_delta
        where container_id = c.id and voided_at is null;
    else
      if v_disc > 0 then
        v_can := false;
      elsif v_out > 0 and p_cause in ('amount', 'return') then
        -- D5-19: físicamente vacío, su leche está en el destino.
        v_can := false;
      elsif v_released is null then
        v_can := true;
      else
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

-- Misma firma que 0015. Nuevo: fridge_at = stored_at al nacer (la app vieja
-- no manda la hora del refri: entra cuando se extrajo, D5-5).
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
    raise exception 'milk_label_taken:%', p_label;
  end if;
  insert into milk_containers (
    id, family_id, baby_id, source_session_id, label,
    amount_ml, remaining_ml, stored_at, fridge_at, location, expires_at, logged_by
  ) values (
    p_container_id, v_family, p_baby_id, p_session_id, p_label,
    p_amount_ml, p_amount_ml, p_stored_at, p_stored_at, 'fridge',
    milk_expires_at(p_stored_at, 'fridge', v_fridge, v_freezer), auth.uid()
  );
end;
$$;

-- ================================================================ EXTRACCIÓN

-- Se dropea y se recrea con un 11º parámetro CON default (como 0015 con
-- log_bottle_feed): la llamada de la app 0.13.0 con 10 argumentos nombrados
-- sigue resolviendo, y no hay dos versiones (PGRST203).
drop function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
);

create function log_pumping_session(
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
  p_container_expires_at timestamptz default null,
  -- Hora en que se tocó "Registrar" (V5-20). Acotada a [pumped_at, now()+10 min];
  -- nula (app vieja) → pumped_at.
  p_fridge_at timestamptz default null
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
      if not found or v_label is distinct from p_container_label then
        raise exception 'milk_idempotency_conflict';
      end if;
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  if p_pumped_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);
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

  if v_total > 0 then
    perform milk_create_container(
      p_container_id, p_container_label, p_baby_id, p_id, v_total, p_pumped_at
    );
    -- Enfriado (D5-5): lo prudente es tarde. Nunca antes de la extracción ni
    -- más allá de la tolerancia de reloj del futuro.
    update milk_containers
       set fridge_at = least(
             greatest(coalesce(p_fridge_at, p_pumped_at), p_pumped_at),
             now() + interval '10 minutes')
     where id = p_container_id;
  end if;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- Misma firma que 0015. Además de lo de 0015:
--   · nunca por debajo de servido + lo que pasó a otro biberón, contando lo
--     que recibió (milk_served_exceeds_amount:M#);
--   · la caducidad = least(la propia, la de los orígenes de sus entradas
--     vivas) — editar la hora del destino no le alarga la vida (V5-31); y si
--     el contenedor es ORIGEN, un acortamiento de su caducidad baja también la
--     de sus destinos (su leche está ahí);
--   · fridge_at nunca antes de la hora de la extracción;
--   · sacar la cantidad (total 0) de un contenedor combinado → milk_combined:M#.
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
  v_in numeric;
  v_out numeric;
  v_fridge numeric;
  v_freezer numeric;
  v_legacy boolean;
  v_expires timestamptz;
  v_src_min timestamptz;
  v_bad text;
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

  v_legacy := p_left_ml is null and p_right_ml is null
    and v_session.left_ml is null and v_session.right_ml is null
    and v_session.amount_ml is not null;
  if v_legacy then
    update pumping_sessions set notes = p_notes, pumped_at = p_pumped_at where id = p_id;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);
  if v_total >= 100000 or (v_total > 0 and v_total < 0.15) then
    raise exception 'milk_bad_input';
  end if;

  select * into v_container from milk_containers
    where source_session_id = p_id and voided_at is null
    for update;

  if found then
    v_served := milk_served_ml(v_container.id);
    v_in := milk_transferred_in_ml(v_container.id);
    v_out := milk_transferred_out_ml(v_container.id);
    if v_total > 0 then
      -- Lo que salió (servido + pasado a otro) no puede superar lo que tuvo
      -- (su extracción + lo que recibió). Para un origen (sin entradas) es
      -- "nunca por debajo de servido + lo pasado"; un destino puede bajar su
      -- extracción mientras lo recibido cubra lo servido.
      if v_total + v_in < v_served + v_out then
        raise exception 'milk_served_exceeds_amount:%', v_container.label;
      end if;
      select min(o.expires_at) into v_src_min
        from milk_transfers t join milk_containers o on o.id = t.from_container_id
       where t.to_container_id = v_container.id and t.voided_at is null;
      v_expires := milk_expires_at(p_pumped_at, v_container.location, v_fridge, v_freezer);
      if v_src_min is not null then
        v_expires := least(v_expires, v_src_min);
      end if;
      -- La CHECK expires_at > stored_at: correr la hora de un destino más allá
      -- de la caducidad de lo que recibió no tiene sentido físico.
      if v_expires <= p_pumped_at then
        raise exception 'milk_combined:%', v_container.label;
      end if;
      -- Sin el recorte de remaining de 0015: la CHECK remaining ≤ amount ya no
      -- existe (un destino tiene más que su extracción); milk_rebalance reparte.
      update milk_containers set
        amount_ml = v_total,
        stored_at = p_pumped_at,
        fridge_at = greatest(coalesce(fridge_at, stored_at), p_pumped_at),
        expires_at = v_expires
      where id = v_container.id;
      perform milk_rebalance(v_container.id, 'amount');

      -- Origen de una combinación: su leche está en los destinos. Si su
      -- caducidad se acortó, la de ellos también (nunca se alarga por acá).
      if v_out > 0 then
        select d.label into v_bad
          from milk_transfers t join milk_containers d on d.id = t.to_container_id
         where t.from_container_id = v_container.id and t.voided_at is null
           and d.voided_at is null and least(d.expires_at, v_expires) <= d.stored_at
         order by d.id limit 1;
        if v_bad is not null then
          raise exception 'milk_combined:%', v_container.label;
        end if;
        perform 1 from milk_containers d
          where d.id in (select to_container_id from milk_transfers
                          where from_container_id = v_container.id and voided_at is null)
          order by d.id for update;
        update milk_containers d set expires_at = v_expires
          where d.id in (select to_container_id from milk_transfers
                          where from_container_id = v_container.id and voided_at is null)
            and d.voided_at is null and d.expires_at > v_expires;
      end if;
    else
      if v_in > 0 or v_out > 0 then
        raise exception 'milk_combined:%', v_container.label;
      end if;
      if v_served > 0 then
        raise exception 'milk_already_served:%', v_container.label;
      end if;
      update milk_discards set voided_at = now()
        where container_id = v_container.id and voided_at is null;
      update milk_containers set voided_at = now() where id = v_container.id;
    end if;
  elsif v_total > 0 then
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

-- Misma firma que 0015. Nuevo: un contenedor con transferencias vivas (de
-- entrada o de salida) no se anula: su leche está mezclada con otra
-- (milk_combined:M#). Se deshace la combinación primero.
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
    if milk_transferred_in_ml(v_container.id) > 0
       or milk_transferred_out_ml(v_container.id) > 0 then
      raise exception 'milk_combined:%', v_container.label;
    end if;
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

-- ================================================================ YA ESTÁ FRÍA

-- "Ya está fría" (V5-21). cold_at = la hora del teléfono, acotada a
-- [fridge_at, now()]. Ya confirmada, o un biberón ya libre → no-op.
create or replace function milk_mark_cold(p_op_id uuid, p_container_id uuid, p_cold_at timestamptz)
returns jsonb -- {"label", "cold_at"}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_done milk_ops%rowtype;
  c milk_containers%rowtype;
  v_cold timestamptz;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_container_id is null then
    raise exception 'milk_bad_input';
  end if;
  v_request := jsonb_build_object(
    'container_id', p_container_id,
    'cold_at', extract(epoch from p_cold_at)
  );

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'mark_cold' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  -- RLS: uno de otra familia no se ve.
  select * into c from milk_containers where id = p_container_id for update;
  if not found or c.voided_at is not null then
    raise exception 'milk_container_unusable';
  end if;

  if c.cold_at is not null or c.released_at is not null then
    v_cold := c.cold_at;
  else
    v_cold := least(greatest(coalesce(p_cold_at, now()), coalesce(c.fridge_at, c.stored_at)), now());
    update milk_containers set cold_at = v_cold where id = c.id;
  end if;

  v_result := jsonb_build_object('label', c.label, 'cold_at', v_cold);
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, c.family_id, c.baby_id, 'mark_cold', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- ================================================================ COMBINAR

-- "Combinar" (V5-30…V5-34). Cada origen pasa TODO lo que le queda al destino y
-- queda libre; el destino vence cuando vence el más viejo. Fríos y vigentes
-- a la hora de la BASE. `p_expected` = {"<container_id>": remaining_ml} que vio
-- la pantalla, para el destino y cada origen: otra cosa → milk_combine_conflict
-- y nada cambia (regla 21: gana el primero).
--
-- Orden de bloqueos: op → contenedores FOR UPDATE en orden de id → etiqueta
-- del bebé. La etiqueta va al final, como en milk_rebalance (0015): así una
-- toma anulada que re-ocupa un número mientras se combina no se cruza en un
-- abrazo mortal con esta función.
create or replace function milk_combine(
  p_op_id uuid,
  p_baby_id uuid,
  p_target_id uuid,
  p_source_ids uuid[],
  p_expected jsonb
)
returns jsonb -- {"target": "M6", "moved_ml": n, "sources": ["M5", …]}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_ids uuid[];
  v_n int;
  v_request jsonb;
  v_done milk_ops%rowtype;
  c milk_containers%rowtype;
  t milk_containers%rowtype;
  v_locked int := 0;
  v_moved numeric := 0;
  v_labels jsonb := '[]'::jsonb;
  v_min_exp timestamptz;
  v_result jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  v_n := coalesce(cardinality(p_source_ids), 0);
  if p_op_id is null or p_baby_id is null or p_target_id is null
     or v_n < 1 or array_position(p_source_ids, null) is not null
     or (select count(distinct x) from unnest(p_source_ids) x) <> v_n
     or p_target_id = any (p_source_ids)
     or p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    raise exception 'milk_bad_input';
  end if;
  select array_agg(x order by x) into v_ids from unnest(p_source_ids) x;
  if exists (
    select 1 from unnest(array_append(v_ids, p_target_id)) x
     where jsonb_typeof(p_expected -> x::text) is distinct from 'number'
  ) then
    raise exception 'milk_bad_input';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  v_request := jsonb_build_object(
    'baby_id', p_baby_id,
    'target_id', p_target_id,
    'source_ids', to_jsonb(v_ids),
    'expected', p_expected
  );

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'combine' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  for c in
    select * from milk_containers
     where id = p_target_id or id = any (v_ids)
     order by id
     for update
  loop
    v_locked := v_locked + 1;
    if c.baby_id <> p_baby_id or c.voided_at is not null or c.released_at is not null
       or c.expires_at <= now() then
      raise exception 'milk_container_unusable:%', c.label;
    end if;
    if not milk_is_cold(c, now()) then
      raise exception 'milk_not_cold:%', c.label;
    end if;
    if abs(c.remaining_ml - (p_expected ->> c.id::text)::numeric) > 1e-9 then
      raise exception 'milk_combine_conflict';
    end if;
  end loop;
  -- RLS: uno de otra familia (o inexistente) no se ve.
  if v_locked <> v_n + 1 then
    raise exception 'milk_container_unusable';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_label:' || p_baby_id::text));

  select * into t from milk_containers where id = p_target_id;
  select min(expires_at) into v_min_exp
    from milk_containers where id = p_target_id or id = any (v_ids);
  -- CHECK expires_at > stored_at: un destino anotado "en el futuro" (tolerancia
  -- de 10 min) con un origen que vence antes no se puede combinar.
  if v_min_exp <= t.stored_at then
    raise exception 'milk_container_unusable:%', t.label;
  end if;

  foreach v_id in array v_ids loop
    select * into c from milk_containers where id = v_id;
    insert into milk_transfers (
      op_id, family_id, baby_id, from_container_id, to_container_id,
      amount_ml, target_prev_expires_at, logged_by
    ) values (
      p_op_id, v_family, p_baby_id, c.id, t.id, c.remaining_ml, t.expires_at, v_uid
    );
    v_moved := v_moved + c.remaining_ml;
    v_labels := v_labels || to_jsonb(c.label);
    perform milk_rebalance(c.id, 'transfer');
  end loop;
  perform milk_rebalance(t.id, 'transfer');
  update milk_containers set expires_at = v_min_exp
    where id = t.id and expires_at <> v_min_exp;

  v_result := jsonb_build_object('target', t.label, 'moved_ml', v_moved, 'sources', v_labels);
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, v_family, p_baby_id, 'combine', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- "Deshacer" una combinación (V5-35). Devuelve a cada origen lo suyo (vuelve a
-- ocupar su número) y restaura la caducidad del destino. Rechazos: el destino
-- ya no tiene lo que recibió → milk_combine_used:M#; el número de un origen lo
-- ocupa otra extracción → milk_label_taken:M#. Ya deshecha → no-op.
create or replace function milk_uncombine(p_op_id uuid, p_combine_op_id uuid)
returns jsonb -- {"target": "M6", "returned_ml": n, "sources": ["M5", …]}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_done milk_ops%rowtype;
  v_family uuid;
  v_baby uuid;
  v_target uuid;
  v_live numeric;
  v_ids uuid[];
  t milk_containers%rowtype;
  v_bad text;
  v_prev timestamptz;
  v_src_min timestamptz;
  v_exp timestamptz;
  v_labels jsonb;
  v_result jsonb;
  v_id uuid;
  v_fridge numeric;
  v_freezer numeric;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_combine_op_id is null or p_op_id = p_combine_op_id then
    raise exception 'milk_bad_input';
  end if;
  v_request := jsonb_build_object('combine_op_id', p_combine_op_id);

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'uncombine' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;
  -- Serializa con un reenvío en vuelo de la combinación misma.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_combine_op_id::text));

  -- RLS: una combinación de otra familia no se ve.
  select min(family_id::text)::uuid, min(baby_id::text)::uuid, min(to_container_id::text)::uuid
    into v_family, v_baby, v_target
    from milk_transfers where op_id = p_combine_op_id;
  if v_family is null then
    raise exception 'milk_bad_input';
  end if;

  select array_agg(id order by id) into v_ids from (
    select from_container_id as id from milk_transfers where op_id = p_combine_op_id
    union select v_target
  ) s;
  perform 1 from milk_containers where id = any (v_ids) order by id for update;
  perform pg_advisory_xact_lock(hashtext('amelia_milk_label:' || v_baby::text));

  select * into t from milk_containers where id = v_target;
  select coalesce(sum(amount_ml), 0), min(target_prev_expires_at)
    into v_live, v_prev
    from milk_transfers where op_id = p_combine_op_id and voided_at is null;

  if v_live = 0 then
    v_result := jsonb_build_object('target', t.label, 'returned_ml', 0, 'sources', '[]'::jsonb);
  else
    if t.voided_at is not null or t.released_at is not null
       or t.remaining_ml < v_live - 1e-9 then
      raise exception 'milk_combine_used:%', t.label;
    end if;
    select o.label into v_bad
      from milk_transfers x join milk_containers o on o.id = x.from_container_id
     where x.op_id = p_combine_op_id and x.voided_at is null
       and exists (
         select 1 from milk_containers z
          where z.baby_id = o.baby_id and z.label = o.label and z.id <> o.id
            and z.voided_at is null and z.released_at is null)
     order by o.id limit 1;
    if v_bad is not null then
      raise exception 'milk_label_taken:%', v_bad;
    end if;

    select coalesce(jsonb_agg(o.label order by o.id), '[]'::jsonb) into v_labels
      from milk_transfers x join milk_containers o on o.id = x.from_container_id
     where x.op_id = p_combine_op_id and x.voided_at is null;

    update milk_transfers set voided_at = now()
      where op_id = p_combine_op_id and voided_at is null;

    for v_id in
      select distinct from_container_id from milk_transfers
       where op_id = p_combine_op_id order by 1
    loop
      perform milk_rebalance(v_id, 'transfer');
    end loop;
    perform milk_rebalance(t.id, 'transfer');

    -- La caducidad de antes de esta combinación, sin alargarla por encima de
    -- lo que el destino todavía tenga de OTRAS combinaciones vivas.
    select min(o.expires_at) into v_src_min
      from milk_transfers x join milk_containers o on o.id = x.from_container_id
     where x.to_container_id = t.id and x.voided_at is null;
    v_exp := least(v_prev, coalesce(v_src_min, v_prev));
    if v_exp <= t.stored_at then
      -- La hora del destino se corrió después de combinar: su caducidad propia.
      select milk_fridge_days, milk_freezer_months into v_fridge, v_freezer
        from babies where id = t.baby_id;
      v_exp := least(milk_expires_at(t.stored_at, t.location, v_fridge, v_freezer),
                     coalesce(v_src_min, 'infinity'::timestamptz));
    end if;
    update milk_containers set expires_at = v_exp
      where id = t.id and expires_at is distinct from v_exp;

    v_result := jsonb_build_object('target', t.label, 'returned_ml', v_live, 'sources', v_labels);
  end if;

  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, v_family, v_baby, 'uncombine', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- ================================================================ BIBERÓN EMPEZADO

-- "Desechar" el sobró de una toma que pasó su hora (V5-11). Idempotente por
-- `p_id`; ya desechado → no-op; antes de fed_at + 60 min según la BASE →
-- milk_not_expired:started. Hora guardada acotada a [fed_at + 60 min, now()].
create or replace function discard_started_bottle(
  p_id uuid,
  p_feeding_id uuid,
  p_discarded_at timestamptz default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prev milk_discards%rowtype;
  f feedings%rowtype;
  v_family uuid;
  v_limit timestamptz;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_feeding_id is null then
    raise exception 'milk_bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));
  select * into v_prev from milk_discards where id = p_id;
  if found then
    if v_prev.feeding_id is distinct from p_feeding_id then
      raise exception 'milk_idempotency_conflict';
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  -- Serializa con void/edit de la misma toma y con otro desecho de ella.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_feeding_id::text));
  -- RLS: una toma de otra familia no se ve.
  select * into f from feedings where id = p_feeding_id for update;
  if not found or f.voided_at is not null or f.feeding_type <> 'bottle'
     or f.leftover_ml is null or f.leftover_ml <= 0 then
    raise exception 'milk_bad_input';
  end if;
  if exists (
    select 1 from milk_discards where feeding_id = f.id and voided_at is null
  ) then
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  v_limit := f.fed_at + milk_started_bottle_minutes() * interval '1 minute';
  if now() < v_limit then
    raise exception 'milk_not_expired:started';
  end if;
  select family_id into v_family from babies where id = f.baby_id;

  insert into milk_discards (
    id, family_id, baby_id, container_id, feeding_id, amount_ml, discarded_at, reason, logged_by
  ) values (
    p_id, v_family, f.baby_id, null, f.id, f.leftover_ml,
    greatest(v_limit, least(coalesce(p_discarded_at, now()), now())),
    'started_bottle_expired', v_uid
  );
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- Editar el sobró de una toma después de desecharlo sincroniza el desecho
-- (INV-10): sobró > 0 → mismo monto; nulo/0, toma anulada o que dejó de ser
-- biberón → desecho anulado. Corre también para la app vieja, que edita el
-- sobró de una toma SIN desglose por UPDATE directo (D-11b): por eso prende la
-- bandera solo para su propio UPDATE y deja la que había.
create or replace function milk_sync_started_discard()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_prev text := coalesce(current_setting('amelia.milk_rpc', true), '');
begin
  if not exists (
    select 1 from milk_discards where feeding_id = new.id and voided_at is null
  ) then
    return null;
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);
  if new.voided_at is not null or new.feeding_type <> 'bottle'
     or new.leftover_ml is null or new.leftover_ml <= 0 then
    update milk_discards set voided_at = coalesce(new.voided_at, now())
      where feeding_id = new.id and voided_at is null;
  else
    update milk_discards set amount_ml = new.leftover_ml
      where feeding_id = new.id and voided_at is null and amount_ml <> new.leftover_ml;
  end if;
  perform set_config('amelia.milk_rpc', v_prev, true);
  return null;
end;
$$;

create trigger milk_sync_started_discard
  after update of leftover_ml, voided_at, feeding_type on feedings
  for each row execute function milk_sync_started_discard();

-- ================================================================ FÓRMULA (RPC)

-- "Anotar compra" (V5-01): 1–24 botellas cerradas con ids del dispositivo.
create or replace function formula_add(
  p_op_id uuid,
  p_baby_id uuid,
  p_ids uuid[],
  p_size_ml numeric,
  p_added_at timestamptz
)
returns jsonb -- {"added": n}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_n int := coalesce(cardinality(p_ids), 0);
  v_ids uuid[];
  v_request jsonb;
  v_done milk_ops%rowtype;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_baby_id is null or p_added_at is null
     or v_n < 1 or v_n > 24 or array_position(p_ids, null) is not null
     or (select count(distinct x) from unnest(p_ids) x) <> v_n
     or p_size_ml is null or not (p_size_ml > 0 and p_size_ml < 100000) then
    raise exception 'milk_bad_input';
  end if;
  select array_agg(x order by x) into v_ids from unnest(p_ids) x;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  v_request := jsonb_build_object(
    'baby_id', p_baby_id, 'ids', to_jsonb(v_ids), 'size_ml', p_size_ml,
    'added_at', extract(epoch from p_added_at)
  );
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'formula_add' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  if p_added_at > now() + interval '10 minutes' then
    raise exception 'milk_future_time';
  end if;

  begin
    insert into formula_containers (id, family_id, baby_id, size_ml, added_at, logged_by)
      select x, v_family, p_baby_id, p_size_ml, p_added_at, v_uid from unnest(v_ids) x;
  exception when unique_violation then
    -- Un id que ya existe (de otra operación, quizá de otra familia).
    raise exception 'milk_idempotency_conflict';
  end;

  v_result := jsonb_build_object('added', v_n);
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, v_family, p_baby_id, 'formula_add', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- "Abrí una Similac" (V5-02). Abre la cerrada `p_container_id`; si no existe,
-- crea una abierta de 8 oz con ese id (nunca bloquea, V5-06). La abierta
-- anterior pasa a 'replaced'. Bajo el lock de fórmula del bebé: dos celulares
-- a la vez → una sola abierta.
create or replace function formula_open(
  p_op_id uuid,
  p_baby_id uuid,
  p_container_id uuid,
  p_opened_at timestamptz
)
returns jsonb -- {"opened": id, "created": bool, "replaced": id | null}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_request jsonb;
  v_done milk_ops%rowtype;
  v_at timestamptz;
  x formula_containers%rowtype;
  v_found boolean;
  v_prev formula_containers%rowtype;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_baby_id is null or p_container_id is null then
    raise exception 'milk_bad_input';
  end if;
  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  v_request := jsonb_build_object(
    'baby_id', p_baby_id, 'container_id', p_container_id,
    'opened_at', extract(epoch from p_opened_at)
  );
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'formula_open' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  perform pg_advisory_xact_lock(hashtext('amelia_formula:' || p_baby_id::text));
  v_at := least(coalesce(p_opened_at, now()), now() + interval '10 minutes');

  select * into x from formula_containers where id = p_container_id for update;
  v_found := found;
  if v_found and (x.baby_id <> p_baby_id or x.voided_at is not null or x.opened_at is not null) then
    raise exception 'milk_bad_input';
  end if;

  select * into v_prev from formula_containers
   where baby_id = p_baby_id and opened_at is not null and finished_at is null
     and voided_at is null
   for update;
  if found then
    update formula_containers
       set finished_at = greatest(v_at, v_prev.opened_at), finish_reason = 'replaced'
     where id = v_prev.id;
  end if;

  if v_found then
    update formula_containers set opened_at = v_at where id = x.id;
  else
    begin
      insert into formula_containers (
        id, family_id, baby_id, size_ml, added_at, opened_at, logged_by
      ) values (
        p_container_id, v_family, p_baby_id, formula_bottle_ml(), v_at, v_at, v_uid
      );
    exception when unique_violation then
      -- El id existe pero no se ve (otra familia).
      raise exception 'milk_bad_input';
    end;
  end if;

  v_result := jsonb_build_object(
    'opened', p_container_id, 'created', not v_found, 'replaced', v_prev.id
  );
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, v_family, p_baby_id, 'formula_open', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- "Se terminó" ('empty', siempre) o "Desechar" la abierta vencida ('expired',
-- solo si a la hora de la BASE pasaron 48 h; si no, milk_not_expired:formula).
-- Ya terminada → no-op.
create or replace function formula_finish(
  p_op_id uuid,
  p_container_id uuid,
  p_reason text,
  p_at timestamptz
)
returns jsonb -- {"finished": id, "reason": r, "finished_at": t}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_done milk_ops%rowtype;
  v_baby uuid;
  x formula_containers%rowtype;
  v_limit timestamptz;
  v_at timestamptz;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_container_id is null or p_reason is null
     or p_reason not in ('empty', 'expired') then
    raise exception 'milk_bad_input';
  end if;
  v_request := jsonb_build_object(
    'container_id', p_container_id, 'reason', p_reason, 'at', extract(epoch from p_at)
  );
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'formula_finish' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  select baby_id into v_baby from formula_containers where id = p_container_id;
  if v_baby is null then
    raise exception 'milk_bad_input';
  end if;
  perform pg_advisory_xact_lock(hashtext('amelia_formula:' || v_baby::text));
  select * into x from formula_containers where id = p_container_id for update;
  if x.voided_at is not null or x.opened_at is null then
    raise exception 'milk_bad_input';
  end if;

  if x.finished_at is null then
    v_limit := x.opened_at + formula_open_max_hours() * interval '1 hour';
    if p_reason = 'expired' then
      if now() < v_limit then
        raise exception 'milk_not_expired:formula';
      end if;
      v_at := greatest(v_limit, least(coalesce(p_at, now()), now()));
    else
      v_at := greatest(x.opened_at, least(coalesce(p_at, now()), now()));
    end if;
    update formula_containers set finished_at = v_at, finish_reason = p_reason
      where id = x.id;
    x.finished_at := v_at;
    x.finish_reason := p_reason;
  end if;

  v_result := jsonb_build_object(
    'finished', x.id, 'reason', x.finish_reason, 'finished_at', x.finished_at
  );
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, x.family_id, x.baby_id, 'formula_finish', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- Anula una botella mal cargada (cerrada o abierta). Ya anulada → no-op; una
-- terminada es historia y no se anula (milk_bad_input).
create or replace function formula_void(p_op_id uuid, p_container_id uuid)
returns jsonb -- {"voided": id}
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_request jsonb;
  v_done milk_ops%rowtype;
  v_baby uuid;
  x formula_containers%rowtype;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_op_id is null or p_container_id is null then
    raise exception 'milk_bad_input';
  end if;
  v_request := jsonb_build_object('container_id', p_container_id);
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_op_id::text));
  select * into v_done from milk_ops where op_id = p_op_id;
  if found then
    if v_done.kind = 'formula_void' and v_done.request = v_request then
      perform set_config('amelia.milk_rpc', '', true);
      return v_done.result;
    end if;
    raise exception 'milk_idempotency_conflict';
  end if;

  select baby_id into v_baby from formula_containers where id = p_container_id;
  if v_baby is null then
    raise exception 'milk_bad_input';
  end if;
  perform pg_advisory_xact_lock(hashtext('amelia_formula:' || v_baby::text));
  select * into x from formula_containers where id = p_container_id for update;
  if x.voided_at is null then
    if x.finished_at is not null then
      raise exception 'milk_bad_input';
    end if;
    update formula_containers set voided_at = now() where id = x.id;
  end if;

  v_result := jsonb_build_object('voided', x.id);
  insert into milk_ops (op_id, family_id, baby_id, kind, request, result, logged_by)
    values (p_op_id, x.family_id, x.baby_id, 'formula_void', v_request, v_result, v_uid);
  perform set_config('amelia.milk_rpc', '', true);
  return v_result;
end;
$$;

-- ================================================================ PERMISOS
--
-- Supabase le da EXECUTE a anon (y a PUBLIC) sobre toda función nueva de
-- public: se saca de todos lados y se da solo a authenticated. Las de
-- `create or replace` conservan sus permisos; se repiten igual (idempotente).

revoke all on function milk_cooling_minutes() from public, anon;
revoke all on function milk_started_bottle_minutes() from public, anon;
revoke all on function formula_open_max_hours() from public, anon;
revoke all on function formula_bottle_ml() from public, anon;
revoke all on function milk_is_cold(milk_containers, timestamptz) from public, anon;
revoke all on function milk_transferred_in_ml(uuid) from public, anon;
revoke all on function milk_transferred_out_ml(uuid) from public, anon;
revoke all on function milk_rebalance(uuid, text) from public, anon;
revoke all on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
  from public, anon;
revoke all on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz, timestamptz
) from public, anon;
revoke all on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) from public, anon;
revoke all on function void_pumping_session(uuid, timestamptz) from public, anon;
revoke all on function milk_mark_cold(uuid, uuid, timestamptz) from public, anon;
revoke all on function milk_combine(uuid, uuid, uuid, uuid[], jsonb) from public, anon;
revoke all on function milk_uncombine(uuid, uuid) from public, anon;
revoke all on function discard_started_bottle(uuid, uuid, timestamptz) from public, anon;
revoke all on function milk_sync_started_discard() from public, anon;
revoke all on function formula_add(uuid, uuid, uuid[], numeric, timestamptz) from public, anon;
revoke all on function formula_open(uuid, uuid, uuid, timestamptz) from public, anon;
revoke all on function formula_finish(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function formula_void(uuid, uuid) from public, anon;

grant execute on function milk_cooling_minutes() to authenticated;
grant execute on function milk_started_bottle_minutes() to authenticated;
grant execute on function formula_open_max_hours() to authenticated;
grant execute on function formula_bottle_ml() to authenticated;
grant execute on function milk_is_cold(milk_containers, timestamptz) to authenticated;
grant execute on function milk_transferred_in_ml(uuid) to authenticated;
grant execute on function milk_transferred_out_ml(uuid) to authenticated;
grant execute on function milk_rebalance(uuid, text) to authenticated;
grant execute on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
  to authenticated;
grant execute on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz, timestamptz
) to authenticated;
grant execute on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) to authenticated;
grant execute on function void_pumping_session(uuid, timestamptz) to authenticated;
grant execute on function milk_mark_cold(uuid, uuid, timestamptz) to authenticated;
grant execute on function milk_combine(uuid, uuid, uuid, uuid[], jsonb) to authenticated;
grant execute on function milk_uncombine(uuid, uuid) to authenticated;
grant execute on function discard_started_bottle(uuid, uuid, timestamptz) to authenticated;
grant execute on function formula_add(uuid, uuid, uuid[], numeric, timestamptz) to authenticated;
grant execute on function formula_open(uuid, uuid, uuid, timestamptz) to authenticated;
grant execute on function formula_finish(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function formula_void(uuid, uuid) to authenticated;
-- Como milk_guard_feedings (0015): el trigger corre como quien edita la toma.
grant execute on function milk_sync_started_discard() to authenticated;

-- ================================================================ INVARIANTE

-- La de 0015 con transferencias, el biberón empezado y la fórmula. La misma
-- que reconstruye tests/helpers/milkInvariant.ts. Si devuelve algo, la
-- migración no se aplica. INV-7 es constraint.
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
    from milk_discards
    where voided_at is null and container_id is not null group by container_id
  ), tin as (
    select to_container_id as container_id, sum(amount_ml) as ml
    from milk_transfers where voided_at is null group by to_container_id
  ), tout as (
    select from_container_id as container_id, sum(amount_ml) as ml
    from milk_transfers where voided_at is null group by from_container_id
  ), fallas as (
    select 'INV-1 cuenta' as falla, c.id
      from milk_containers c
      left join srv s on s.container_id = c.id
      left join dsc d on d.container_id = c.id
      left join tin i on i.container_id = c.id
      left join tout o on o.container_id = c.id
     where c.voided_at is null
       and abs(c.amount_ml + coalesce(i.ml,0) - coalesce(s.ml,0) - coalesce(d.ml,0)
               - c.lost_ml - c.remaining_ml - coalesce(o.ml,0)) > 1e-9
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
      left join tin i on i.container_id = c.id
      left join tout o on o.container_id = c.id
     where c.voided_at is not null
       and (s.ml is not null or d.ml is not null or i.ml is not null or o.ml is not null)
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
    union all
    select 'INV-10 empezado incoherente', x.id
      from milk_discards x left join feedings f on f.id = x.feeding_id
     where x.voided_at is null and x.reason = 'started_bottle_expired'
       and (f.id is null or f.voided_at is not null or f.feeding_type <> 'bottle'
            or f.leftover_ml is distinct from x.amount_ml)
    union all
    select 'INV-11 transferencia incoherente', t.id
      from milk_transfers t
      join milk_containers o on o.id = t.from_container_id
      join milk_containers d on d.id = t.to_container_id
     where t.voided_at is null
       and (o.baby_id <> t.baby_id or d.baby_id <> t.baby_id
            or o.voided_at is not null or o.released_at is null or o.remaining_ml >= 0.15
            or d.voided_at is not null)
    union all
    select 'INV-12 fórmula', min(x.id::text)::uuid
      from formula_containers x
     where x.voided_at is null and x.opened_at is not null and x.finished_at is null
     group by x.baby_id having count(*) > 1
    union all
    select 'INV-12 fórmula', x.id
      from formula_containers x
     where x.finished_at < x.opened_at
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
-- próximo reinicio. Se entrega al hacer commit.
notify pgrst, 'reload schema';

commit;
