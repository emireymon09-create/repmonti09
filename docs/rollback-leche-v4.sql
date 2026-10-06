-- rollback-leche-v4.sql — deshace SOLO 0015_milk_phase1_2.sql (inventario de
-- leche v4: biberones que se liberan, desechos, sobró, N, ediciones de toma).
--
-- Deja la base con el esquema EXACTO de 0001…0014 (la de la app v3,
-- rama feat/milk-inventory-v3-release) y los datos de leche en una forma que
-- las funciones de 0014 entienden. NO toca 0014: para seguir bajando hasta
-- v0.12.1, después de este se corre docs/rollback-leche.sql (encadenable,
-- probado: deja 0001…0013).
--
-- Cuándo hace falta: si la app v4 sale y hay que volver a la v3 (o a la
-- v0.12.1) por un tiempo largo. Volver SOLO la app, con 0015 puesta, también
-- funciona (docs/compatibilidad-v4.md §5.1): esto es para quedarse atrás.
--
-- Probado el 6 oct 2026 en un Postgres efímero (misma imagen que el stack
-- local, sin red): 0001…0015 + datos v4 (números reusados, desechos, sobró,
-- leche perdida, ediciones) → este script → `pg_dump --schema-only` idéntico al
-- de una base con 0001…0014 de cero; correrlo dos veces seguidas no da error.
-- Y en el stack local: la suite de integración de v3 (151/151) y la de
-- v0.12.1 (118/118) pasan contra la base revertida. Detalle y evidencia:
-- docs/compatibilidad-v4.md §5 y docs/plan-pruebas-v4.md R-01…R-12.
--
-- ================================================================ ANTES
--
-- 1. Backup completo con pg_dump (docs/seguridad-operacional.md). Este script
--    BORRA DATOS y no hay vuelta atrás sin ese backup.
-- 2. Leé la lista de abajo y decidí si guardás lo que se pierde en un schema
--    aparte (paso opcional, comentado, más abajo).
-- 3. Se corre entero, de una vez (SQL Editor de Supabase o psql). Es UNA
--    transacción: si algo falla, no cambia nada. Re-ejecutable sin error.
-- 4. Mejor con la app v4 ya fuera de los teléfonos (o al menos sin registrar
--    leche): una escritura v4 que llegue después recibe 404 (la función ya no
--    existe) y queda en su cola para Descartar.
--
-- ================================================================ QUÉ DATOS SE PIERDEN
--
--   · TODOS los DESECHOS (tabla milk_discards): qué biberón caducado se tiró,
--     cuánto y cuándo. El total "Leche desechada" desaparece.
--   · TODO "SOBRÓ" (feedings.leftover_ml).
--   · N, la cantidad de biberones físicos (babies.milk_bottle_count). v3 no
--     la tiene: sugiere "la cinta más alta + 1".
--   · Las marcas de LIBERADO (milk_containers.released_at) y la LECHE PERDIDA
--     (milk_containers.lost_ml, la que volvió de una toma y no pudo entrar a
--     ningún biberón, D-9).
--   · El REGISTRO DE EDICIONES de tomas (tabla milk_feeding_edits): quién
--     cambió cada toma y qué había antes. Las tomas quedan con su valor FINAL.
--
-- Y estos CONTENEDORES se ANULAN (voided_at), porque v3 no los puede
-- representar sin mentir en "Lo que hay":
--   a. los DESECHADOS (con un desecho vivo): en v3 un contenedor vivo con
--      remaining 0 y sin porciones que lo expliquen; y un void_bottle_feed de
--      v3 de una toma suya le "devolvería" leche que se tiró;
--   b. los LIBERADOS con leche PERDIDA (lost_ml > 0): igual, v3 les
--      devolvería esa leche al próximo recálculo;
--   c. cuando hay MÁS DE UN contenedor no anulado con la misma cinta del mismo
--      bebé (v4 reusa números; v3 exige una cinta viva por bebé): queda vivo el
--      que tiene leche (el ocupado) o, si ninguno, el de `stored_at` más nuevo;
--      los demás se anulan.
--   Un anulado sigue existiendo (no se borra): sus porciones y sus tomas
--   siguen, con su desglose. Pero en v3 su extracción se ve SIN cinta ni
--   "servido", y v3 deja borrarla aunque se haya servido leche de ella
--   (riesgo aceptado, ARQ §10.2). El total de la toma y su leche/fórmula no
--   cambian.
--
-- Queda SIN TOCAR y se avisa (NOTICE al principio): un contenedor OCUPADO con
-- lost_ml > 0 (caso raro: perdió leche cuando su número estaba tomado y
-- después lo re-ocupó). En v3 remaining = amount − servido, así que la
-- próxima toma o anulación de v3 sobre él le "devolvería" esa leche perdida.
-- Si el NOTICE lista alguno, corregilo a mano en v3 (anotar la diferencia) o
-- anulalo antes.
--
-- OJO, VOLVER A v4 DESPUÉS DE ESTO: 0015 no vuelve a entrar si esta reversa
-- anuló algún contenedor del que se sirvió leche (el viejo de un número
-- reusado, o uno desechado después de servir) o si quedó un ocupado del
-- NOTICE: aborta con `milk_invariant_broken` sin aplicar nada (probado,
-- docs/compatibilidad-v4.md §5.3). La consulta 3 de
-- docs/verificar-antes-v4.sql lo anticipa. Si pensás volver a v4, guardá el
-- respaldo opcional de abajo.
--
-- Requiere 0014 puesta: sobre una base sin 0014 aborta sin cambiar nada.
--
-- ================================================================ QUÉ SOBREVIVE
--
--   · Todas las tomas (con su desglose leche/fórmula FINAL, el de la última
--     edición), todas las porciones, todas las extracciones y todos los
--     contenedores ocupados, con su cinta y lo que les queda.
--   · Lo anulado sigue anulado. Lactancia, pañales, sueño, crecimiento, etc.:
--     0015 no los tocó y esto tampoco.
--   · Las tres reglas de conservación de 0014 (babies.milk_*_hours/days/months).
--
-- ================================================================ PASO OPCIONAL
--
-- Por defecto NO se guarda nada. Para conservar lo que se pierde, descomentá
-- este bloque ANTES del `begin;`. Copia a un schema `milk_backup_v4` que ni
-- PostgREST ni la app ven (PostgREST solo expone `public`). Se borra con
-- `drop schema milk_backup_v4 cascade;` cuando ya no haga falta. Es solo para
-- una base que TODAVÍA tiene 0015 (en la segunda corrida ya no hay qué copiar).
--
-- create schema if not exists milk_backup_v4;
-- revoke all on schema milk_backup_v4 from public, anon, authenticated;
-- create table milk_backup_v4.milk_discards as select * from public.milk_discards;
-- create table milk_backup_v4.milk_feeding_edits as select * from public.milk_feeding_edits;
-- create table milk_backup_v4.container_state as
--   select id, baby_id, label, released_at, lost_ml, voided_at
--   from public.milk_containers
--   where released_at is not null or lost_ml <> 0;
-- create table milk_backup_v4.feeding_leftover as
--   select id, baby_id, fed_at, leftover_ml from public.feedings where leftover_ml is not null;
-- create table milk_backup_v4.baby_bottle_count as
--   select id, family_id, milk_bottle_count from public.babies;

begin;

-- ---------------------------------------------------------- 1. pre-chequeo
-- Solo informa (no aborta): los OCUPADOS con leche perdida, que v3 va a
-- recalcular como si esa leche siguiera ahí. Esperado: ninguno.
do $$
declare
  r record;
  n int := 0;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'milk_containers'
               and column_name = 'lost_ml') then
    for r in execute
      'select id, baby_id, label, lost_ml from public.milk_containers
        where voided_at is null and released_at is null and lost_ml > 0
        order by baby_id, label'
    loop
      n := n + 1;
      raise notice 'ocupado con leche perdida: % (bebé %, contenedor %) lost_ml=%',
        r.label, r.baby_id, r.id, r.lost_ml;
    end loop;
    raise notice 'pre-chequeo: % contenedor(es) ocupado(s) con lost_ml > 0', n;
  else
    raise notice 'pre-chequeo: 0015 ya no está (sin lost_ml): nada que revisar';
  end if;
end
$$;

-- Las guardas de 0014 (milk_guard_containers) solo dejan escribir los
-- contenedores con esta bandera. Local a la transacción.
select set_config('amelia.milk_rpc', 'on', true);

-- ---------------------------------------------------------- 2. datos
-- Lo que v3 no puede representar (ver arriba, a/b/c). Solo si 0015 sigue
-- puesta; en una segunda corrida no hay nada que hacer.
do $$
begin
  if to_regclass('public.milk_discards') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'milk_containers'
                   and column_name = 'released_at') then
    -- a. desechados (con un desecho vivo)
    execute $q$
      update public.milk_containers c
         set voided_at = coalesce(c.released_at, now())
       where c.voided_at is null
         and exists (select 1 from public.milk_discards d
                      where d.container_id = c.id and d.voided_at is null)
    $q$;
    -- b. liberados con leche perdida
    execute $q$
      update public.milk_containers c
         set voided_at = coalesce(c.released_at, now())
       where c.voided_at is null and c.released_at is not null and c.lost_ml > 0
    $q$;
    -- c. misma cinta, más de uno no anulado: se queda el ocupado o, si todos
    --    están libres, el más nuevo.
    execute $q$
      with ranked as (
        select id, released_at,
               row_number() over (
                 partition by baby_id, label
                 order by (released_at is null) desc, stored_at desc, created_at desc, id desc
               ) as rn
          from public.milk_containers
         where voided_at is null
      )
      update public.milk_containers c
         set voided_at = coalesce(r.released_at, now())
        from ranked r
       where r.id = c.id and r.rn > 1
    $q$;
  end if;
end
$$;

-- ---------------------------------------------------------- 3. funciones nuevas de 0015
drop function if exists public.edit_bottle_feed(
  uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb
);
drop function if exists public.discard_container(uuid, uuid, timestamptz);
drop function if exists public.milk_rebalance(uuid, text);
drop function if exists public.milk_discarded_ml(uuid);

-- ---------------------------------------------------------- 4. las de 0014, como eran
-- log_bottle_feed: 0015 la recreó con un séptimo parámetro (p_leftover_ml).
-- Se saca esa y se vuelve a crear la de seis, con el texto EXACTO de 0014.
drop function if exists public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb, numeric);

-- void_bottle_feed: 0015 le cambió el retorno a jsonb; `create or replace` no
-- puede cambiar un retorno, así que se dropea SOLO si es la de 0015.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'void_bottle_feed'
                and pg_get_function_result(p.oid) = 'jsonb') then
    drop function public.void_bottle_feed(uuid, timestamptz);
  end if;
end
$$;

-- Desde acá, el texto de cada función es el de
-- supabase/migrations/0014_milk_inventory.sql, copiado sin cambios (así
-- pg_dump da idéntico). Las de `create or replace` conservan sus permisos;
-- igual se vuelven a dar abajo, exactos a 0014.

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
    p_container_id, v_family, p_baby_id, p_session_id, p_label,
    p_amount_ml, p_amount_ml, p_stored_at, 'fridge',
    milk_expires_at(p_stored_at, 'fridge', v_fridge, v_freezer), auth.uid()
  );
end;
$$;

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

  -- `not (x >= 0 and x < tope)` y no `x < 0`: así también rechaza NaN.
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

  -- Un reintento que llega mientras la primera llamada todavía no terminó (la
  -- cola corta el pedido a los 15 s, el servidor no) espera acá a que termine,
  -- y después ve lo que esa hizo: un no-op, no un sobregiro falso ni un error
  -- de clave duplicada.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));

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
  if v_total >= 100000 then
    raise exception 'milk_bad_input';
  end if;

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
      p_container_id, p_container_label, p_baby_id, p_id, v_total, p_pumped_at
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

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));
  -- RLS: una sesión de otra familia no se ve, y se trata como inexistente.
  select * into v_session from pumping_sessions where id = p_id for update;
  if not found or v_session.voided_at is not null then
    raise exception 'milk_session_gone';
  end if;
  select family_id, milk_fridge_days, milk_freezer_months
    into v_family, v_fridge, v_freezer
    from babies where id = v_session.baby_id;

  -- Una sesión de antes de 0014 solo tiene un total, sin izquierda ni derecha
  -- y sin contenedor. Corregirle la hora o la nota sin escribir los lados NO
  -- puede borrarle el total (ni inventarle un reparto 50/50): se le cambian
  -- esas dos cosas y nada más.
  v_legacy := p_left_ml is null and p_right_ml is null
    and v_session.left_ml is null and v_session.right_ml is null
    and v_session.amount_ml is not null;
  if v_legacy then
    -- `p_side` también se ignora: el lado viejo va con el total viejo.
    update pumping_sessions set notes = p_notes, pumped_at = p_pumped_at where id = p_id;
    perform set_config('amelia.milk_rpc', '', true);
    return;
  end if;

  v_total := coalesce(p_left_ml, 0) + coalesce(p_right_ml, 0);
  if v_total >= 100000 then
    raise exception 'milk_bad_input';
  end if;

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
     or not (v_formula >= 0 and v_formula < 100000)
     or jsonb_typeof(v_portions) <> 'array' then
    raise exception 'milk_bad_input';
  end if;

  -- La forma de cada porción, ANTES de cualquier cast: un texto que no es un
  -- número o un uuid daría un error crudo de Postgres en vez de un código.
  if exists (
    select 1 from jsonb_array_elements(v_portions) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e->'amount_ml') is distinct from 'number'
       or coalesce(e->>'container_id', '')
          !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
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
       or not ((e->>'amount_ml')::numeric > 0 and (e->>'amount_ml')::numeric < 100000)
  ) or v_count <> (
    select count(distinct e->>'container_id') from jsonb_array_elements(v_portions) e
  ) then
    raise exception 'milk_bad_input';
  end if;
  -- Solo fórmula vale; solo leche vale; nada de nada, no es una toma.
  if not (v_breast + v_formula > 0 and v_breast + v_formula < 100000) then
    raise exception 'milk_bad_input';
  end if;

  select family_id into v_family from babies where id = p_baby_id;
  if v_family is null or not is_family_member(v_family) then
    raise exception 'milk_baby_not_found';
  end if;

  -- Un reintento que llega mientras la primera llamada todavía no terminó (la
  -- cola corta el pedido a los 15 s, el servidor no) espera acá a que termine,
  -- y después ve lo que esa hizo: un no-op, no un sobregiro falso ni un error
  -- de clave duplicada.
  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_id::text));

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

  perform pg_advisory_xact_lock(hashtext('amelia_milk_op:' || p_feeding_id::text));
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

-- Permisos exactos de 0014 (0014:877-915). Las recreadas (log_bottle_feed,
-- void_bottle_feed) nacen con los permisos por defecto de Supabase (anon
-- incluido): esto los deja como en 0014.
revoke all on function milk_in_rpc() from public, anon;
revoke all on function milk_guard_feedings() from public, anon;
revoke all on function milk_guard_pumping() from public, anon;
revoke all on function milk_guard_inventory() from public, anon;
revoke all on function milk_guard_containers() from public, anon;
revoke all on function milk_expires_at(timestamptz, text, numeric, numeric) from public, anon;
revoke all on function milk_served_ml(uuid) from public, anon;
revoke all on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
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
grant execute on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
  to authenticated;
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

-- ---------------------------------------------------------- 5. tablas nuevas
-- Con cada tabla se van sus índices, policies, grants y triggers
-- (milk_guard_discards, milk_guard_feeding_edits).
drop table if exists public.milk_feeding_edits;
drop table if exists public.milk_discards;

-- ---------------------------------------------------------- 6. índice de cintas
-- Vuelve la unicidad de 0014: una cinta NO ANULADA por bebé. El paso 2c deja
-- los datos en condiciones de cumplirla.
drop index if exists public.milk_containers_label_occupied;
create unique index if not exists milk_containers_label_live
  on milk_containers (baby_id, label) where voided_at is null;

-- ---------------------------------------------------------- 7. constraints y columnas
-- Con cada columna se va su CHECK de rango (milk_containers_lost_ml_check,
-- feedings_leftover_ml_check, babies_milk_bottle_count_check).
alter table public.milk_containers drop constraint if exists milk_containers_released_empty;
alter table public.feedings drop constraint if exists feedings_leftover_le_amount;
alter table public.milk_containers
  drop column if exists released_at,
  drop column if exists lost_ml;
alter table public.feedings drop column if exists leftover_ml;
alter table public.babies drop column if exists milk_bottle_count;

-- ---------------------------------------------------------- 8. historial
-- Si se aplicó con scripts/local-stack.sh queda anotada; sin esto, un
-- `pnpm db:up` posterior creería que 0015 sigue puesta. En la nube la tabla
-- puede no existir.
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '0015_milk_phase1_2';
  end if;
end
$$;

select set_config('amelia.milk_rpc', '', true);

-- ---------------------------------------------------------- 9. verificación
-- Dentro de la transacción: si algo no quedó como en 0014, aborta y no
-- cambia nada.
do $$
declare
  v_bad int;
begin
  if to_regclass('public.milk_discards') is not null
     or to_regclass('public.milk_feeding_edits') is not null
     or to_regclass('public.milk_containers_label_occupied') is not null
     or to_regclass('public.milk_containers_label_live') is null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and ((table_name = 'milk_containers' and column_name in ('released_at', 'lost_ml'))
                  or (table_name = 'feedings' and column_name = 'leftover_ml')
                  or (table_name = 'babies' and column_name = 'milk_bottle_count')))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('edit_bottle_feed', 'discard_container',
                                    'milk_rebalance', 'milk_discarded_ml'))
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'log_bottle_feed'
            and p.pronargs = 6) <> 1
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('log_bottle_feed', 'void_bottle_feed')) <> 2
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'void_bottle_feed'
                  and pg_get_function_result(p.oid) <> 'void')
     or has_function_privilege('anon', 'public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.void_bottle_feed(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.void_bottle_feed(uuid, timestamptz)', 'execute')
  then
    raise exception 'rollback_v4_incompleto: el esquema no quedó como 0001…0014';
  end if;
  -- La cuenta de v3: para todo contenedor no anulado, remaining = amount −
  -- servido. Informativo (los del pre-chequeo no cierran, a propósito).
  select count(*) into v_bad
    from milk_containers c
   where c.voided_at is null
     and abs(c.remaining_ml - (c.amount_ml - milk_served_ml(c.id))) > 1e-9;
  raise notice 'contenedores vivos con remaining <> amount - servido (esperado = los del pre-chequeo): %', v_bad;
end
$$;

commit;

-- PostgREST cachea el esquema: sin esto seguiría ofreciendo discard_container
-- y edit_bottle_feed (y la firma de siete argumentos de log_bottle_feed).
notify pgrst, 'reload schema';
