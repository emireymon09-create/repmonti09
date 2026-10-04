-- Inventario de leche materna y registro de tomas v3 (4 oct 2026).
--
-- Numerada en este repo por pedido explícito del dueño (CLAUDE.md §5.2), igual
-- que 0007…0012. NO ESTÁ APLICADA EN NINGÚN ENTORNO: ni en el stack local ni
-- en la nube. Hay que aplicarla a mano en el proyecto de la nube ANTES de que
-- la app que la usa llegue a `main` (docs/handoff-2026-10-04.md).
--
-- Qué agrega, en una línea cada cosa (las reglas: docs/spec-feeding-v3.md §1):
--   · pumping_sessions: izquierda y derecha por separado. `amount_ml` sigue
--     siendo el total y lo escribe el servidor (= izquierda + derecha).
--   · milk_containers: el biberón físico que llena una extracción, con su
--     cinta M1, M2, M3…, lo que le queda y cuándo caduca.
--   · milk_drawdowns: cuánto de qué contenedor fue a qué toma.
--   · feedings: el desglose de una toma de biberón — leche materna y fórmula.
--     La fórmula NO tiene inventario: vive solo como número en la toma.
--   · babies: las tres reglas de conservación del pediatra (por familia).
--   · cinco funciones que hacen cada escritura en UNA transacción, y triggers
--     que impiden armar o desarmar el inventario por fuera de ellas.
--
-- Scope: las tablas nuevas llevan `family_id` DIRECTO (la forma de la fase 2,
-- CLAUDE.md §5.3) y además `baby_id` (lo pide el pedido), atados con una FK
-- compuesta a `babies (id, family_id)` — la misma que usa device_tokens (0007)
-- — para que nunca puedan discrepar.

-- ================================================================ COLUMNAS

alter table pumping_sessions
  add column if not exists left_ml numeric check (left_ml >= 0),
  add column if not exists right_ml numeric check (right_ml >= 0);

-- Nulos en las tomas de antes de esta migración: son las "tomas viejas sin
-- desglose", que siguen siendo editables como siempre.
alter table feedings
  add column if not exists breast_milk_ml numeric check (breast_milk_ml >= 0),
  add column if not exists formula_ml numeric check (formula_ml >= 0);

-- Las reglas del pediatra. Son de la familia (los dos padres ven las mismas),
-- se cambian en Ajustes y se guardan directo, sin cola offline. Viven en
-- `babies` y las cambia la policy "update own babies" que ya existe (0006);
-- no se crea otra. Los topes son los mismos que valida lib/milk.ts.
alter table babies
  add column if not exists milk_room_hours numeric not null default 4
    check (milk_room_hours > 0 and milk_room_hours <= 24),
  add column if not exists milk_fridge_days numeric not null default 4
    check (milk_fridge_days > 0 and milk_fridge_days <= 30),
  add column if not exists milk_freezer_months numeric not null default 6
    check (
      milk_freezer_months > 0
      and milk_freezer_months <= 24
      and milk_freezer_months = trunc(milk_freezer_months)
    );

-- ================================================================ CONTENEDORES

create table milk_containers (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  -- La extracción que lo llenó. Si alguna vez se borrara de verdad la sesión
  -- (no pasa: el borrado es lógico), el contenedor queda.
  source_session_id uuid references pumping_sessions(id) on delete set null,
  -- La cinta del biberón: M1, M2, M3…
  label text not null check (label ~ '^M[1-9][0-9]*$'),
  amount_ml numeric not null check (amount_ml > 0),
  remaining_ml numeric not null check (remaining_ml >= 0),
  stored_at timestamptz not null,
  -- Hoy todo va al refrigerador. "Pasar al congelador" no se construye; la
  -- columna y la regla quedan listas.
  location text not null default 'fridge' check (location in ('fridge', 'freezer')),
  expires_at timestamptz not null,
  voided_at timestamptz,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint milk_containers_remaining_le_amount check (remaining_ml <= amount_ml),
  constraint milk_containers_expires_after_stored check (expires_at > stored_at),
  constraint milk_containers_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

-- Dos biberones vivos con la misma cinta serían peor que un número salteado.
-- Respaldo de la verificación que hacen las funciones bajo un advisory lock.
create unique index milk_containers_label_live
  on milk_containers (baby_id, label) where voided_at is null;
-- Una extracción llena un solo contenedor.
create unique index milk_containers_one_per_session
  on milk_containers (source_session_id)
  where voided_at is null and source_session_id is not null;
create index milk_containers_family_live
  on milk_containers (family_id) where voided_at is null;

-- ================================================================ PORCIONES

create table milk_drawdowns (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  baby_id uuid not null,
  container_id uuid not null references milk_containers(id) on delete cascade,
  feeding_id uuid not null references feedings(id) on delete cascade,
  amount_ml numeric not null check (amount_ml > 0),
  voided_at timestamptz,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- Una toma saca de un mismo contenedor una sola vez: dos filas del mismo
  -- contenedor en una toma serían una sola porción escrita dos veces.
  unique (feeding_id, container_id),
  constraint milk_drawdowns_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

create index milk_drawdowns_container_live
  on milk_drawdowns (container_id) where voided_at is null;
create index milk_drawdowns_family_live
  on milk_drawdowns (family_id) where voided_at is null;

-- ================================================================ RLS

alter table milk_containers enable row level security;
alter table milk_drawdowns enable row level security;

-- Cualquier miembro de la familia lee y escribe: el inventario es de la casa,
-- no de un padre. WITH CHECK explícito en las de escritura: impide mudar una
-- fila a otra familia o a un bebé ajeno (la FK compuesta ya ata los dos).
create policy "select own milk_containers" on milk_containers
  for select using (is_family_member(family_id));
create policy "insert own milk_containers" on milk_containers
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));
create policy "update own milk_containers" on milk_containers
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id) and is_baby_family_member(baby_id));

create policy "select own milk_drawdowns" on milk_drawdowns
  for select using (is_family_member(family_id));
create policy "insert own milk_drawdowns" on milk_drawdowns
  for insert with check (is_family_member(family_id) and is_baby_family_member(baby_id));
create policy "update own milk_drawdowns" on milk_drawdowns
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id) and is_baby_family_member(baby_id));

-- Grants explícitos: RLS correcta sin GRANT bloquea igual (el bug de 0005), y
-- el default de este stack le da TODO a anon. Sin `delete`: el borrado es
-- lógico (`voided_at`), nunca un DELETE. INSERT y UPDATE hacen falta porque las
-- funciones son `security invoker` (corren como el padre); los triggers de
-- abajo impiden usarlos por fuera de ellas.
revoke all on milk_containers from anon, authenticated;
grant select, insert, update on milk_containers to authenticated;
revoke all on milk_drawdowns from anon, authenticated;
grant select, insert, update on milk_drawdowns to authenticated;

-- ================================================================ GUARDAS
--
-- El inventario se escribe SOLO por las cinco funciones de abajo, que lo
-- hacen en una transacción y con las cuentas hechas en el servidor. Cada una
-- prende una bandera local a su transacción (`amelia.milk_rpc`); los triggers
-- rechazan lo que llegue sin ella. Es defensa en profundidad, no una frontera
-- de seguridad: lo que cuida es que una versión vieja de la app cacheada en un
-- teléfono (o un PATCH a mano por PostgREST) no pueda anular una toma sin
-- devolver la leche, ni registrar una extracción con cantidad sin contenedor.
-- Quien la recibe ve un error, nunca un inventario que no cierra.

create or replace function milk_in_rpc()
returns boolean
language sql stable set search_path = public as $$
  select coalesce(current_setting('amelia.milk_rpc', true), '') = 'on';
$$;

create or replace function milk_guard_feedings()
returns trigger
language plpgsql set search_path = public as $$
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
  -- Una toma con desglose solo cambia la hora (y la nota). Una toma vieja sin
  -- desglose sigue siendo editable entera, y nunca puede ganar un desglose
  -- por esta vía.
  if old.breast_milk_ml is not null or old.formula_ml is not null
     or new.breast_milk_ml is not null or new.formula_ml is not null then
    if new.baby_id is distinct from old.baby_id
       or new.feeding_type is distinct from old.feeding_type
       or new.amount_ml is distinct from old.amount_ml
       or new.breast_milk_ml is distinct from old.breast_milk_ml
       or new.formula_ml is distinct from old.formula_ml
       or new.voided_at is distinct from old.voided_at then
      raise exception 'milk_rpc_only';
    end if;
  end if;
  return new;
end;
$$;

create trigger milk_guard_feedings
  before insert or update on feedings
  for each row execute function milk_guard_feedings();

create or replace function milk_guard_pumping()
returns trigger
language plpgsql set search_path = public as $$
begin
  if milk_in_rpc() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- Una extracción con cantidad sin su contenedor no sumaría a lo que hay y
    -- nadie se daría cuenta: que falle a la vista.
    if new.amount_ml is not null or new.left_ml is not null or new.right_ml is not null then
      raise exception 'milk_rpc_only';
    end if;
    return new;
  end if;
  -- Por fuera de las funciones solo se cambia la nota.
  if new.baby_id is distinct from old.baby_id
     or new.amount_ml is distinct from old.amount_ml
     or new.left_ml is distinct from old.left_ml
     or new.right_ml is distinct from old.right_ml
     or new.pumped_at is distinct from old.pumped_at
     or new.side is distinct from old.side
     or new.voided_at is distinct from old.voided_at then
    raise exception 'milk_rpc_only';
  end if;
  return new;
end;
$$;

create trigger milk_guard_pumping
  before insert or update on pumping_sessions
  for each row execute function milk_guard_pumping();

create or replace function milk_guard_inventory()
returns trigger
language plpgsql set search_path = public as $$
begin
  if not milk_in_rpc() then
    raise exception 'milk_rpc_only';
  end if;
  return new;
end;
$$;

create trigger milk_guard_containers
  before insert or update on milk_containers
  for each row execute function milk_guard_inventory();
create trigger milk_guard_drawdowns
  before insert or update on milk_drawdowns
  for each row execute function milk_guard_inventory();

-- ================================================================ CADUCIDAD

-- Refrigerador: N × 24 h exactas (`interval '24 hours'`, no `days`: un día de
-- calendario se estira o se acorta con el cambio de horario de la sesión).
-- Congelador: N meses de calendario sumados en UTC; Postgres recorta al último
-- día del mes cuando el día no existe (31 ago + 6 meses = 28 feb), que es el
-- lado seguro y lo mismo que hace containerExpiresAt en lib/milk.ts.
create or replace function milk_expires_at(
  p_stored_at timestamptz,
  p_location text,
  p_fridge_days numeric,
  p_freezer_months numeric
)
returns timestamptz
language sql immutable set search_path = public as $$
  select case
    when p_location = 'freezer' then
      ((p_stored_at at time zone 'UTC') + make_interval(months => p_freezer_months::int))
        at time zone 'UTC'
    else p_stored_at + p_fridge_days * interval '24 hours'
  end;
$$;

-- ================================================================ FUNCIONES
--
-- Las cinco: `security invoker` (corren como el padre que llama, así que RLS
-- sigue aplicando), `search_path = public`, el actor es SIEMPRE auth.uid()
-- — nunca un parámetro —, una transacción cada una, e idempotentes por el id
-- que generó el dispositivo: la cola offline las reenvía (lib/queue.ts).
--
-- La bandera de las guardas se apaga antes de cada salida: no sobrevive a la
-- llamada ni siquiera dentro de la misma transacción.
--
-- Errores: el mensaje es un código estable, a veces con la etiqueta después
-- de ':' (`milk_overdraw:M3`). lib/db.ts (milkErrorText) lo traduce; nunca
-- llega a la pantalla un error de Postgres crudo por estos casos.

-- Crea el contenedor de una extracción. Interna: la usan las dos de abajo.
create or replace function milk_create_container(
  p_container_id uuid,
  p_label text,
  p_family_id uuid,
  p_baby_id uuid,
  p_session_id uuid,
  p_amount_ml numeric,
  p_stored_at timestamptz,
  p_uid uuid
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_fridge numeric;
  v_freezer numeric;
begin
  if p_container_id is null or p_label is null or p_label !~ '^M[1-9][0-9]*$' then
    raise exception 'milk_bad_input';
  end if;
  select milk_fridge_days, milk_freezer_months into v_fridge, v_freezer
    from babies where id = p_baby_id;
  -- Una cinta por bebé, a la vez: dos extracciones simultáneas esperan acá en
  -- fila, y la segunda ve la primera.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_label:' || p_baby_id::text));
  if exists (
    select 1 from milk_containers
    where baby_id = p_baby_id and label = p_label and voided_at is null
  ) then
    -- Otro dispositivo ya usó esa cinta (dos extracciones sin conexión a la
    -- vez). No se renumera en silencio: la cinta ya puede estar escrita.
    raise exception 'milk_label_taken:%', p_label;
  end if;
  insert into milk_containers (
    id, family_id, baby_id, source_session_id, label,
    amount_ml, remaining_ml, stored_at, location, expires_at, logged_by
  ) values (
    p_container_id, p_family_id, p_baby_id, p_session_id, p_label,
    p_amount_ml, p_amount_ml, p_stored_at, 'fridge',
    milk_expires_at(p_stored_at, 'fridge', v_fridge, v_freezer), p_uid
  );
end;
$$;

-- Lo servido de un contenedor: la suma de sus porciones vivas. Se recalcula
-- en vez de confiar en sumas y restas acumuladas.
create or replace function milk_served_ml(p_container_id uuid)
returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(amount_ml), 0)
  from milk_drawdowns
  where container_id = p_container_id and voided_at is null;
$$;

-- ---------------------------------------------------------- 1. extracción

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
  -- Se acepta y se IGNORA: la caducidad la calcula el servidor con las reglas
  -- vigentes de la familia (docs/spec-feeding-v3.md S-15). El dispositivo la
  -- calcula igual solo para mostrarla sin conexión.
  p_container_expires_at timestamptz default null
)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_total numeric;
  v_existing pumping_sessions%rowtype;
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_baby_id is null or p_pumped_at is null
     or p_side is null or p_side not in ('left', 'right', 'both')
     or p_left_ml < 0 or p_right_ml < 0 then
    raise exception 'milk_bad_input';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  -- Idempotencia estricta sobre lo que una edición no cambia (S-16): el bebé y
  -- el contenedor que creó. Lo demás (cantidades, hora, nota) se edita.
  select * into v_existing from pumping_sessions where id = p_id;
  if found then
    if v_existing.baby_id <> p_baby_id
       or (p_container_id is not null and exists (
         select 1 from milk_containers
         where id = p_container_id and source_session_id is distinct from p_id
       )) then
      raise exception 'milk_idempotency_conflict';
    end if;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);

  insert into pumping_sessions (
    id, baby_id, pumped_at, side, amount_ml, left_ml, right_ml, notes, logged_by
  ) values (
    p_id, p_baby_id, p_pumped_at, p_side,
    case when v_total > 0 then v_total end,
    p_left_ml, p_right_ml, p_notes, v_uid
  );

  -- Sin cantidad, sin contenedor.
  if v_total > 0 then
    perform milk_create_container(
      p_container_id, p_container_label, v_family, p_baby_id, p_id, v_total, p_pumped_at, v_uid
    );
  end if;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

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
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_pumped_at is null
     or p_side is null or p_side not in ('left', 'right', 'both')
     or p_left_ml < 0 or p_right_ml < 0 then
    raise exception 'milk_bad_input';
  end if;

  -- RLS: una sesión de otra familia no se ve, y se trata como inexistente.
  select * into v_session from pumping_sessions where id = p_id for update;
  if not found or v_session.voided_at is not null then
    raise exception 'milk_session_gone';
  end if;
  select family_id, milk_fridge_days, milk_freezer_months
    into v_family, v_fridge, v_freezer
    from babies where id = v_session.baby_id;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);

  select * into v_container from milk_containers
    where source_session_id = p_id and voided_at is null
    for update;

  if found then
    v_served := milk_served_ml(v_container.id);
    if v_total > 0 then
      -- El contenedor sigue a la extracción, nunca por debajo de lo servido.
      if v_total < v_served then
        raise exception 'milk_served_exceeds_amount:%', v_container.label;
      end if;
      update milk_containers set
        amount_ml = v_total,
        remaining_ml = v_total - v_served,
        stored_at = p_pumped_at,
        expires_at = milk_expires_at(p_pumped_at, v_container.location, v_fridge, v_freezer)
      where id = v_container.id;
    else
      -- Sacarle la cantidad a una extracción ya servida dejaría tomas
      -- apuntando a leche que no existe.
      if v_served > 0 then
        raise exception 'milk_already_served:%', v_container.label;
      end if;
      update milk_containers set voided_at = now() where id = v_container.id;
    end if;
  elsif v_total > 0 then
    -- No tenía cantidad y ahora sí: el contenedor nace ahora.
    perform milk_create_container(
      p_container_id, p_container_label, v_family, v_session.baby_id, p_id,
      v_total, p_pumped_at, v_uid
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

  select * into v_session from pumping_sessions where id = p_id for update;
  -- Nunca llegó, o ya está anulada: no hay nada que hacer.
  if not found or v_session.voided_at is not null then
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  select * into v_container from milk_containers
    where source_session_id = p_id and voided_at is null
    for update;
  if found then
    -- No se anula una extracción de la que ya se sirvió leche: primero se
    -- borran esas tomas (que devuelven la leche).
    if milk_served_ml(v_container.id) > 0 then
      raise exception 'milk_already_served:%', v_container.label;
    end if;
    update milk_containers set voided_at = coalesce(p_voided_at, now())
      where id = v_container.id;
  end if;

  update pumping_sessions set voided_at = coalesce(p_voided_at, now()) where id = p_id;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- ---------------------------------------------------------- 2. toma

create or replace function log_bottle_feed(
  p_id uuid,
  p_baby_id uuid,
  p_fed_at timestamptz,
  p_notes text,
  p_formula_ml numeric,
  -- [{ "container_id": uuid, "amount_ml": number }, …]
  p_portions jsonb
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
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  if p_id is null or p_baby_id is null or p_fed_at is null
     or v_formula < 0 or jsonb_typeof(v_portions) <> 'array' then
    raise exception 'milk_bad_input';
  end if;

  -- Cada porción: un contenedor, una cantidad positiva, sin repetir contenedor.
  select count(*), coalesce(sum((e->>'amount_ml')::numeric), 0)
    into v_count, v_breast
    from jsonb_array_elements(v_portions) e;
  if exists (
    select 1 from jsonb_array_elements(v_portions) e
    where (e->>'container_id') is null
       or (e->>'amount_ml') is null
       or (e->>'amount_ml')::numeric <= 0
  ) or v_count <> (
    select count(distinct e->>'container_id') from jsonb_array_elements(v_portions) e
  ) then
    raise exception 'milk_bad_input';
  end if;
  -- Solo fórmula vale; solo leche vale; nada de nada, no es una toma.
  if v_breast + v_formula <= 0 then
    raise exception 'milk_bad_input';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  -- Idempotencia estricta (S-16): el mismo id con el mismo bebé, la misma
  -- fórmula y las mismas porciones es un reenvío y no hace nada. La hora y la
  -- nota no se comparan: se pueden editar después.
  select * into v_existing from feedings where id = p_id;
  if found then
    if v_existing.baby_id <> p_baby_id
       or v_existing.feeding_type <> 'bottle'
       or coalesce(v_existing.formula_ml, -1) <> v_formula
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

  -- Bloquear los contenedores, siempre en el mismo orden (por id): dos tomas
  -- que comparten contenedores no se esperan una a la otra en cruz. La segunda
  -- de dos que sirven del mismo contenedor espera acá a que la primera
  -- termine, y después ve lo que la primera ya sacó.
  for v_container in
    select * from milk_containers
    where id in (select (e->>'container_id')::uuid from jsonb_array_elements(v_portions) e)
    order by id
    for update
  loop
    v_locked := v_locked + 1;
    -- Del bebé de esta toma, no anulado, y no caducado A LA HORA DE LA TOMA
    -- (S-6): una toma de las 2 a.m. que se sincroniza a las 9 no se rechaza
    -- porque la leche caducó a las 8.
    if v_container.baby_id <> p_baby_id
       or v_container.voided_at is not null
       or v_container.expires_at <= p_fed_at then
      raise exception 'milk_container_unusable:%', v_container.label;
    end if;
    select (e->>'amount_ml')::numeric into v_want
      from jsonb_array_elements(v_portions) e
      where (e->>'container_id')::uuid = v_container.id;
    v_available := v_container.amount_ml - milk_served_ml(v_container.id);
    -- Nunca más de lo que tiene, y sin recortar en silencio: quien llegó
    -- segundo vuelve a elegir.
    if v_want > v_available then
      raise exception 'milk_overdraw:%', v_container.label;
    end if;
  end loop;
  -- Un contenedor que no existe, o que RLS no deja ver (otra familia).
  if v_locked <> v_count then
    raise exception 'milk_container_unusable';
  end if;

  -- Los totales los calcula el servidor: no se confía en lo que mande nadie.
  insert into feedings (
    id, baby_id, fed_at, feeding_type, amount_ml, breast_milk_ml, formula_ml, notes, logged_by
  ) values (
    p_id, p_baby_id, p_fed_at, 'bottle', v_breast + v_formula, v_breast, v_formula, p_notes, v_uid
  );

  insert into milk_drawdowns (family_id, baby_id, container_id, feeding_id, amount_ml, logged_by)
    select v_family, p_baby_id, (e->>'container_id')::uuid, p_id, (e->>'amount_ml')::numeric, v_uid
    from jsonb_array_elements(v_portions) e;

  update milk_containers c set remaining_ml = c.amount_ml - milk_served_ml(c.id)
    where c.id in (select (e->>'container_id')::uuid from jsonb_array_elements(v_portions) e);
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

create or replace function void_bottle_feed(p_feeding_id uuid, p_voided_at timestamptz default null)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_feeding feedings%rowtype;
  v_ids uuid[];
begin
  if v_uid is null then
    raise exception 'milk_not_signed_in';
  end if;
  perform set_config('amelia.milk_rpc', 'on', true);

  select * into v_feeding from feedings where id = p_feeding_id for update;
  -- Nunca llegó, o ya está anulada: no-op.
  if not found or v_feeding.voided_at is not null then
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  -- Mismo orden de bloqueo que log_bottle_feed.
  select array_agg(container_id order by container_id) into v_ids
    from milk_drawdowns
    where feeding_id = p_feeding_id and voided_at is null;
  perform 1 from milk_containers where id = any (v_ids) order by id for update;

  update milk_drawdowns set voided_at = coalesce(p_voided_at, now())
    where feeding_id = p_feeding_id and voided_at is null;

  -- Cada porción vuelve a su contenedor, en una sola operación. Nada que
  -- revertir de fórmula: no tiene inventario.
  if v_ids is not null then
    update milk_containers c
      set remaining_ml = least(c.amount_ml, c.amount_ml - milk_served_ml(c.id))
      where c.id = any (v_ids);
  end if;

  update feedings set voided_at = coalesce(p_voided_at, now()) where id = p_feeding_id;
  perform set_config('amelia.milk_rpc', '', true);
end;
$$;

-- ================================================================ PERMISOS
--
-- Supabase le da EXECUTE a anon sobre toda función nueva de public: se saca
-- de todos lados y se da solo a authenticated.

revoke all on function milk_in_rpc() from public, anon;
revoke all on function milk_guard_feedings() from public, anon;
revoke all on function milk_guard_pumping() from public, anon;
revoke all on function milk_guard_inventory() from public, anon;
revoke all on function milk_expires_at(timestamptz, text, numeric, numeric) from public, anon;
revoke all on function milk_served_ml(uuid) from public, anon;
revoke all on function milk_create_container(uuid, text, uuid, uuid, uuid, numeric, timestamptz, uuid)
  from public, anon;
revoke all on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) from public, anon;
revoke all on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) from public, anon;
revoke all on function void_pumping_session(uuid, timestamptz) from public, anon;
revoke all on function log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb)
  from public, anon;
revoke all on function void_bottle_feed(uuid, timestamptz) from public, anon;

-- milk_in_rpc la llaman los triggers de `feedings` y `pumping_sessions`, que
-- también disparan cuando escribe el servidor con service_role (los seeds de
-- los tests de integración, por ejemplo): sin EXECUTE, cualquier insert en
-- `feedings` de service_role fallaría.
grant execute on function milk_in_rpc() to authenticated, service_role;
grant execute on function milk_expires_at(timestamptz, text, numeric, numeric) to authenticated;
grant execute on function milk_served_ml(uuid) to authenticated;
grant execute on function milk_create_container(
  uuid, text, uuid, uuid, uuid, numeric, timestamptz, uuid
) to authenticated;
grant execute on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) to authenticated;
grant execute on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) to authenticated;
grant execute on function void_pumping_session(uuid, timestamptz) to authenticated;
grant execute on function log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb)
  to authenticated;
grant execute on function void_bottle_feed(uuid, timestamptz) to authenticated;
