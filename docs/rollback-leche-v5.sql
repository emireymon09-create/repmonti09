-- rollback-leche-v5.sql — deshace SOLO 0016_milk_phase3_4.sql (inventario de
-- leche v5: enfriado, combinar biberones, biberón empezado, Similac).
--
-- Deja la base con el esquema EXACTO de 0001…0015 (la de la app 0.13.0, que es
-- la que está en producción) y los datos de leche en una forma que las
-- funciones de 0015 aceptan: la invariante de 0015 (INV-1…INV-9) corre al
-- final, DENTRO de la transacción, y si no da 0 filas no se aplica nada. NO
-- toca 0015: para seguir bajando, después de este va docs/rollback-leche-v4.sql.
--
-- Cuándo hace falta: si la app v5 sale y hay que volver a la 0.13.0 por un
-- tiempo largo. Volver SOLO la app, con 0016 puesta, también funciona
-- (docs/compatibilidad-v5.md §3): esto es para quedarse atrás.
--
-- Probado el 7 oct 2026 en un Postgres efímero (misma imagen que el stack
-- local, sin red; tests/integration/milkV5Rollback.test.ts): 0001…0016 + datos
-- v5 sembrados por las RPC como un padre (combinación viva en cadena,
-- combinación deshecha, desecho de biberón empezado, Similac abierta, leche
-- enfriando, "ya está fría", un desecho de caducada) → este script →
-- invariante de 0015 = 0 filas → `pg_dump --schema-only` idéntico al de
-- 0001…0015 de cero; dos veces seguidas sin error; y 0016 vuelve a entrar
-- encima (su invariante también da 0). Evidencia: docs/compatibilidad-v5.md §4.
--
-- ================================================================ ANTES
--
-- 1. Backup completo con pg_dump (docs/seguridad-operacional.md). Este script
--    BORRA DATOS y no hay vuelta atrás sin ese backup.
-- 2. Si se puede, DESHACÉ las combinaciones vivas desde la app v5 ANTES de
--    volver ("Deshacer" en /pumping): así cada biberón recupera lo suyo y no
--    se pierde nada de "Lo que hay" (ver "COMBINACIONES" abajo). El NOTICE del
--    paso 1 las lista.
-- 3. Leé la lista de abajo y decidí si guardás lo que se pierde (paso
--    opcional, comentado, más abajo).
-- 4. Se corre entero, de una vez (SQL Editor de Supabase o psql). Es UNA
--    transacción: si algo falla, no cambia nada. Re-ejecutable sin error.
-- 5. Mejor con la app v5 ya fuera de los teléfonos (o al menos sin registrar
--    leche): una escritura v5 que llegue después recibe 404 (la función ya no
--    existe) y queda en su cola para Descartar.
--
-- ================================================================ QUÉ DATOS SE PIERDEN
--
--   · TODO el inventario de SIMILAC (tabla formula_containers): compras,
--     cuál está abierta y desde cuándo, cuáles se terminaron o vencieron. La
--     fórmula de cada toma (feedings.formula_ml) NO se toca: es de 0014.
--   · Los DESECHOS de BIBERÓN EMPEZADO (milk_discards con reason
--     'started_bottle_expired', vivos y anulados): se BORRAN. El "Sobró" de la
--     toma (feedings.leftover_ml, de 0015) queda. Los desechos de leche
--     CADUCADA ('expired') quedan intactos.
--   · El ENFRIADO: milk_containers.fridge_at y cold_at. En 0.13.0 toda leche
--     registrada es usable al instante: un biberón que en v5 decía "Enfriando"
--     aparece listo para servir (0.13.0 nunca supo de enfriado).
--   · El REGISTRO DE OPERACIONES (tabla milk_ops): idempotencia de combinar,
--     deshacer, "ya está fría" y Similac. Un reenvío tardío de esas
--     operaciones ya no tiene función a la que llegar (404).
--   · Las COMBINACIONES (tabla milk_transfers), vivas y deshechas. Ver abajo
--     qué pasa con los biberones.
--
-- ================================================================ COMBINACIONES
--
-- En 0.13.0 un biberón no puede tener más leche que la de su propia
-- extracción (CHECK remaining ≤ amount, que vuelve) ni existe "pasó a otro
-- biberón". Sin la tabla de transferencias, cada biberón tiene que cerrar con
-- la cuenta de 0015:  amount = servido + desechado + lost + remaining.
-- Para cada contenedor vivo con transferencias vivas se calcula
-- neto = entró − salió:
--
--   · neto > 0 (el que RECIBIÓ, el destino): le sobra `neto` en la cuenta. Se
--     saca, en este orden:
--       1. de lo SERVIDO: las porciones más nuevas de sus tomas pasan a
--          contar contra los biberones que le pasaron leche (primero sus
--          orígenes directos, después los de más atrás en una cadena
--          S→D→E, después cualquier otro origen del mismo bebé). La TOMA no
--          cambia: mismo total, misma leche y fórmula; solo cambia de qué
--          número salió cada parte (que es de donde vino esa leche).
--       2. de su leche perdida (lost_ml), 3. de su desecho de caducada,
--       4. de lo que le QUEDA (remaining_ml). Si quedan < 0,15 ml se libera.
--     El paso 4 es la ÚNICA pérdida en "Lo que hay": la leche que se volcó a
--     este biberón y todavía NO se sirvió desaparece del total, porque en
--     0.13.0 no hay forma honesta de decir "este biberón tiene más que su
--     extracción". Físicamente la leche sigue en el biberón: si se sirve, la
--     toma se registra igual (0.13.0 deja anotar leche sin elegir biberón, o
--     con "fórmula"/otro número) — anotalo a mano si hace falta. El NOTICE del
--     final dice, por bebé, "Lo que hay" antes y después.
--   · neto < 0 (el que DIO, el origen): a su cuenta le falta lo que pasó. Lo
--     que el paso 1 le asignó como servido cubre una parte; el resto va a
--     lost_ml (leche que no está en el biberón ni se sirvió). Sigue LIBERADO:
--     físicamente está vacío; nunca vuelve a aparecer leche en él (D5-19,
--     como D-9 de v4).
--   · La CADUCIDAD del destino queda como la dejó la combinación (la del más
--     viejo): lo prudente. Si en 0.13.0 alguien corrige la hora de esa
--     extracción, 0015 la recalcula desde su propia hora (se alarga): es lo
--     que 0.13.0 siempre hizo.
--   · Si en 0.13.0 se ANULA una toma cuyas porciones el paso 1 movió a un
--     origen, la leche "vuelve" a ese origen (re-ocupa su número si está
--     libre, si no va a lost_ml): es la regla de 0015 para toda toma anulada.
--     Igual que antes de esta reversa, no es leche física nueva: conviene no
--     anular tomas viejas de biberones combinados.
--   · Las combinaciones YA DESHECHAS no dejan rastro: sus transferencias
--     están anuladas y la cuenta de cada biberón ya cierra sin ellas.
--
-- ================================================================ QUÉ SOBREVIVE
--
--   · Todas las tomas (total, leche, fórmula, sobró, hora), todas las
--     extracciones (con su reparto izquierdo/derecho: 0016 no lo cambia y esto
--     tampoco), todos los contenedores con su número y su caducidad, los
--     desechos de caducada, N y las reglas de conservación.
--   · Lactancia, pañales, sueño, crecimiento, médico: 0016 no los tocó y esto
--     tampoco.
--
-- VOLVER A v5 DESPUÉS DE ESTO: se vuelve a aplicar 0016 tal cual. El backfill
-- pone fridge_at = stored_at (todo "frío"), y la invariante de 0016 acepta lo
-- que esta reversa dejó (probado). Lo perdido no vuelve: Similac, desechos de
-- empezado, combinaciones (los orígenes quedan liberados con su leche como
-- servida o perdida), "ya está fría".
--
-- Requiere 0015 puesta. Sobre una base sin 0016 no hace nada (salvo
-- re-verificar) y no da error: es re-ejecutable.
--
-- ================================================================ PASO OPCIONAL
--
-- Por defecto NO se guarda nada. Para conservar lo que se pierde, descomentá
-- este bloque ANTES del `begin;`. Copia a un schema `milk_backup_v5` que ni
-- PostgREST ni la app ven. Se borra con `drop schema milk_backup_v5 cascade;`.
-- Es solo para una base que TODAVÍA tiene 0016.
--
-- create schema if not exists milk_backup_v5;
-- revoke all on schema milk_backup_v5 from public, anon, authenticated;
-- create table milk_backup_v5.formula_containers as select * from public.formula_containers;
-- create table milk_backup_v5.milk_transfers as select * from public.milk_transfers;
-- create table milk_backup_v5.milk_ops as select * from public.milk_ops;
-- create table milk_backup_v5.started_discards as
--   select * from public.milk_discards where reason = 'started_bottle_expired';
-- create table milk_backup_v5.cooling as
--   select id, baby_id, label, fridge_at, cold_at from public.milk_containers;
-- create table milk_backup_v5.containers_before as
--   select id, baby_id, label, amount_ml, remaining_ml, lost_ml, released_at, expires_at
--   from public.milk_containers;
-- create table milk_backup_v5.drawdowns_before as select * from public.milk_drawdowns;

begin;

-- ---------------------------------------------------------- 1. pre-chequeo
-- Solo informa: qué se va a perder. Con 0016 ya fuera, lo dice y sigue.
do $$
declare
  r record;
begin
  if to_regclass('public.milk_transfers') is null then
    raise notice 'pre-chequeo: 0016 ya no está (sin milk_transfers): nada que revisar';
    return;
  end if;
  for r in
    select t.op_id, d.label as destino, string_agg(o.label, ', ' order by o.label) as origenes,
           sum(t.amount_ml) as ml, d.baby_id
      from milk_transfers t
      join milk_containers d on d.id = t.to_container_id
      join milk_containers o on o.id = t.from_container_id
     where t.voided_at is null
     group by t.op_id, d.label, d.baby_id
     order by d.baby_id, d.label
  loop
    raise notice 'combinación viva: % ← % (% ml, bebé %, op %)',
      r.destino, r.origenes, r.ml, r.baby_id, r.op_id;
  end loop;
  raise notice 'pre-chequeo: % combinación(es) viva(s), % Similac anotada(s) (% abierta(s)), % desecho(s) de biberón empezado, % biberón(es) todavía enfriando',
    (select count(distinct op_id) from milk_transfers where voided_at is null),
    (select count(*) from formula_containers where voided_at is null),
    (select count(*) from formula_containers
      where voided_at is null and opened_at is not null and finished_at is null),
    (select count(*) from milk_discards where reason = 'started_bottle_expired'),
    (select count(*) from milk_containers c
      where c.voided_at is null and c.released_at is null and not milk_is_cold(c, now()));
end
$$;

-- Las guardas de 0014/0015 solo dejan escribir el inventario con esta bandera.
-- Local a la transacción.
select set_config('amelia.milk_rpc', 'on', true);

-- ---------------------------------------------------------- 2. datos
-- 2a. Las combinaciones vivas, deshechas en la cuenta (ver "COMBINACIONES").
-- 2b. Los desechos de biberón empezado, borrados.
-- Solo si 0016 sigue puesta; en una segunda corrida no hay nada que hacer.
do $$
declare
  r record;
  d record;
  v_need numeric;
  v_move numeric;
  v_left numeric;
  v_x numeric;
  v_sid uuid;
  v_cap numeric;
  v_take numeric;
  v_disc numeric;
  v_c milk_containers%rowtype;
begin
  if to_regclass('public.milk_transfers') is null then
    return;
  end if;

  -- "Lo que hay" por bebé, para el NOTICE del final.
  create temp table _rb5_onhand on commit drop as
    select baby_id, sum(remaining_ml) as antes
      from milk_containers
     where voided_at is null and released_at is null and remaining_ml >= 0.15
     group by baby_id;

  -- neto = entró − salió, por contenedor con transferencias vivas.
  create temp table _rb5_need on commit drop as
    select c.id, c.baby_id,
           coalesce((select sum(t.amount_ml) from milk_transfers t
                      where t.to_container_id = c.id and t.voided_at is null), 0)
         - coalesce((select sum(t.amount_ml) from milk_transfers t
                      where t.from_container_id = c.id and t.voided_at is null), 0) as need
      from milk_containers c
     where c.voided_at is null
       and exists (select 1 from milk_transfers t
                    where t.voided_at is null
                      and (t.to_container_id = c.id or t.from_container_id = c.id));

  -- Los que RECIBIERON (neto > 0), en orden fijo.
  for r in select * from _rb5_need where need > 0 order by baby_id, id loop
    v_need := r.need;

    -- 1. Lo servido: las porciones más nuevas pasan a los que dieron.
    for d in
      -- La toma más NUEVA por su hora (fed_at), no por created_at: varias
      -- porciones guardadas en una misma transacción (o sincronizadas juntas)
      -- comparten created_at y el desempate por id sería al azar.
      select dd.* from milk_drawdowns dd join feedings f on f.id = dd.feeding_id
       where dd.container_id = r.id and dd.voided_at is null
       order by f.fed_at desc, dd.created_at desc, dd.id desc
    loop
      exit when v_need <= 0;
      v_move := least(d.amount_ml, v_need);
      v_left := d.amount_ml - v_move;
      while v_move > 0 loop
        with recursive anc(id, depth) as (
          select t.from_container_id, 0 from milk_transfers t
           where t.to_container_id = r.id and t.voided_at is null
          union
          select t.from_container_id, anc.depth + 1 from milk_transfers t
            join anc on t.to_container_id = anc.id
           where t.voided_at is null and anc.depth < 100
        )
        select s.id, -s.need into v_sid, v_cap
          from _rb5_need s
         where s.baby_id = r.baby_id and s.need < 0
         order by coalesce((select min(a.depth) from anc a where a.id = s.id), 1000), s.id
         limit 1;
        if v_sid is null then
          raise exception 'rollback_v5: no hay origen para la leche servida del contenedor %', r.id;
        end if;
        v_x := least(v_move, v_cap);
        -- Una toma saca de un contenedor una sola vez (unique de 0014): si ya
        -- tiene porción de él, crece; si estaba anulada, se reaviva (como
        -- edit_bottle_feed de 0015).
        update milk_drawdowns
           set amount_ml = case when voided_at is null then amount_ml + v_x else v_x end,
               voided_at = null
         where feeding_id = d.feeding_id and container_id = v_sid;
        if not found then
          insert into milk_drawdowns (
            family_id, baby_id, container_id, feeding_id, amount_ml, logged_by, created_at
          ) values (d.family_id, d.baby_id, v_sid, d.feeding_id, v_x, d.logged_by, d.created_at);
        end if;
        update _rb5_need set need = need + v_x where id = v_sid;
        v_move := v_move - v_x;
        v_need := v_need - v_x;
        v_sid := null;
      end loop;
      if v_left > 0 then
        update milk_drawdowns set amount_ml = v_left where id = d.id;
      else
        update milk_drawdowns set voided_at = now() where id = d.id;
      end if;
    end loop;

    select * into v_c from milk_containers where id = r.id;
    -- 2. Su leche perdida.
    v_take := least(v_c.lost_ml, v_need);
    v_c.lost_ml := v_c.lost_ml - v_take;
    v_need := v_need - v_take;
    -- 3. Su desecho de caducada (como mucho uno vivo).
    select coalesce(sum(amount_ml), 0) into v_disc
      from milk_discards where container_id = v_c.id and voided_at is null;
    if v_need > 0 and v_disc > 0 then
      if v_need >= v_disc then
        update milk_discards set voided_at = now()
         where container_id = v_c.id and voided_at is null;
        v_need := v_need - v_disc;
      else
        update milk_discards set amount_ml = amount_ml - v_need
         where container_id = v_c.id and voided_at is null;
        v_need := 0;
      end if;
    end if;
    -- 4. Lo que le queda (la única pérdida en "Lo que hay").
    v_take := least(v_c.remaining_ml, v_need);
    v_c.remaining_ml := v_c.remaining_ml - v_take;
    v_need := v_need - v_take;
    if v_need > 1e-9 then
      raise exception 'rollback_v5: la cuenta del contenedor % no cierra (faltan % ml)', v_c.id, v_need;
    end if;
    update milk_containers
       set lost_ml = v_c.lost_ml,
           remaining_ml = v_c.remaining_ml,
           released_at = case when v_c.released_at is null and v_c.remaining_ml < 0.15
                              then now() else v_c.released_at end
     where id = v_c.id;
  end loop;

  -- Los que DIERON (neto < 0): lo que no se les asignó como servido, perdido.
  update milk_containers c
     set lost_ml = c.lost_ml - s.need
    from _rb5_need s
   where s.id = c.id and s.need < 0;

  -- 2b. Desechos de biberón empezado (no tienen contenedor: 0015 no los puede
  --     representar).
  delete from milk_discards where reason = 'started_bottle_expired';

  for r in
    select coalesce(a.baby_id, b.baby_id) as baby_id, coalesce(a.antes, 0) as antes,
           coalesce(b.despues, 0) as despues
      from _rb5_onhand a
      full join (select baby_id, sum(remaining_ml) as despues
                   from milk_containers
                  where voided_at is null and released_at is null and remaining_ml >= 0.15
                  group by baby_id) b on b.baby_id = a.baby_id
     order by 1
  loop
    raise notice '"Lo que hay" del bebé %: antes % ml, después % ml', r.baby_id, r.antes, r.despues;
  end loop;
end
$$;

-- ---------------------------------------------------------- 3. funciones nuevas de 0016
drop trigger if exists milk_sync_started_discard on public.feedings;
drop function if exists public.milk_sync_started_discard();
drop function if exists public.milk_mark_cold(uuid, uuid, timestamptz);
drop function if exists public.milk_combine(uuid, uuid, uuid, uuid[], jsonb);
drop function if exists public.milk_uncombine(uuid, uuid);
drop function if exists public.discard_started_bottle(uuid, uuid, timestamptz);
drop function if exists public.formula_add(uuid, uuid, uuid[], numeric, timestamptz);
drop function if exists public.formula_open(uuid, uuid, uuid, timestamptz);
drop function if exists public.formula_finish(uuid, uuid, text, timestamptz);
drop function if exists public.formula_void(uuid, uuid);
drop function if exists public.milk_transferred_in_ml(uuid);
drop function if exists public.milk_transferred_out_ml(uuid);
drop function if exists public.milk_is_cold(public.milk_containers, timestamptz);
drop function if exists public.milk_cooling_minutes();
drop function if exists public.milk_started_bottle_minutes();
drop function if exists public.formula_open_max_hours();
drop function if exists public.formula_bottle_ml();

-- ---------------------------------------------------------- 4. las de 0015, como eran
-- log_pumping_session: 0016 la recreó con un 11º parámetro (p_fridge_at). Se
-- saca esa y se vuelve a crear la de diez con el texto EXACTO de 0015. Las
-- otras cuatro solo cambiaron el cuerpo: `create or replace` con el de 0015
-- (conservan sus permisos; igual se vuelven a dar abajo, exactos).
drop function if exists public.log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz, timestamptz
);

-- Desde acá, el texto de cada función es el de
-- supabase/migrations/0015_milk_phase1_2.sql, copiado sin cambios (así
-- pg_dump da idéntico).

-- milk_rebalance (0015:324-430)
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

-- milk_create_container (0015:436-478)
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

-- log_pumping_session (0015:489-582)
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

-- update_pumping_session (0015:593-709)
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

-- void_pumping_session (0015:714-750)
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

-- Permisos exactos de 0014/0015 (0014:884-912, 0015:1373/1383). La de
-- log_pumping_session nace de nuevo con los permisos por defecto de Supabase
-- (anon incluido): esto los deja como estaban.
revoke all on function milk_rebalance(uuid, text) from public, anon;
revoke all on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
  from public, anon;
revoke all on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) from public, anon;
revoke all on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) from public, anon;
revoke all on function void_pumping_session(uuid, timestamptz) from public, anon;

grant execute on function milk_rebalance(uuid, text) to authenticated;
grant execute on function milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz)
  to authenticated;
grant execute on function log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) to authenticated;
grant execute on function update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
) to authenticated;
grant execute on function void_pumping_session(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------- 5. tablas nuevas
-- Con cada tabla se van sus índices, policies, grants y triggers
-- (milk_guard_ops, milk_guard_transfers, milk_guard_formula).
drop table if exists public.milk_transfers;
drop table if exists public.milk_ops;
drop table if exists public.formula_containers;

-- ---------------------------------------------------------- 6. milk_discards como en 0015
-- El paso 2b ya borró las filas sin contenedor: container_id vuelve a NOT NULL.
drop index if exists public.milk_discards_one_live_feeding;
alter table public.milk_discards drop constraint if exists milk_discards_shape;
alter table public.milk_discards drop column if exists feeding_id;
alter table public.milk_discards alter column container_id set not null;
alter table public.milk_discards drop constraint if exists milk_discards_reason_check;
alter table public.milk_discards
  add constraint milk_discards_reason_check check (reason in ('expired'));
drop index if exists public.milk_discards_one_live;
create unique index milk_discards_one_live
  on milk_discards (container_id) where voided_at is null;

-- ---------------------------------------------------------- 7. milk_containers como en 0015
-- El paso 2a deja remaining ≤ amount en todos (amount = servido + desechado +
-- lost + remaining): la CHECK de 0014 vuelve.
alter table public.milk_containers
  drop column if exists fridge_at,
  drop column if exists cold_at;
alter table public.milk_containers drop constraint if exists milk_containers_remaining_le_amount;
alter table public.milk_containers
  add constraint milk_containers_remaining_le_amount check (remaining_ml <= amount_ml);

-- ---------------------------------------------------------- 8. historial
-- Si se aplicó con scripts/local-stack.sh queda anotada; sin esto, un
-- `pnpm db:up` posterior creería que 0016 sigue puesta. En la nube la tabla
-- puede no existir.
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '0016_milk_phase3_4';
  end if;
end
$$;

-- ---------------------------------------------------------- 9. verificación
-- Dentro de la transacción: si el esquema no quedó como en 0015, o si los
-- datos no cumplen la invariante de 0015 (la MISMA consulta del `do` final de
-- 0015, INV-1…INV-9), aborta y no cambia nada.
do $$
declare
  v_n int;
  v_first text;
begin
  if to_regclass('public.milk_transfers') is not null
     or to_regclass('public.milk_ops') is not null
     or to_regclass('public.formula_containers') is not null
     or to_regclass('public.milk_discards_one_live_feeding') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and ((table_name = 'milk_containers' and column_name in ('fridge_at', 'cold_at'))
                  or (table_name = 'milk_discards' and column_name = 'feeding_id')))
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and table_name = 'milk_discards' and column_name = 'container_id'
                and is_nullable = 'YES')
     or not exists (select 1 from pg_constraint where conname = 'milk_containers_remaining_le_amount')
     or exists (select 1 from pg_constraint where conname = 'milk_discards_shape')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('milk_mark_cold', 'milk_combine', 'milk_uncombine',
                                    'discard_started_bottle', 'milk_sync_started_discard',
                                    'formula_add', 'formula_open', 'formula_finish', 'formula_void',
                                    'milk_transferred_in_ml', 'milk_transferred_out_ml',
                                    'milk_is_cold', 'milk_cooling_minutes',
                                    'milk_started_bottle_minutes', 'formula_open_max_hours',
                                    'formula_bottle_ml'))
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'log_pumping_session') <> 1
     or to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)') is null
     or has_function_privilege('anon', 'public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)', 'execute')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('milk_rebalance', 'update_pumping_session',
                                    'void_pumping_session', 'milk_create_container')
                  and (p.prosrc like '%milk_transfer%' or p.prosrc like '%fridge_at%'))
  then
    raise exception 'rollback_v5_incompleto: el esquema no quedó como 0001…0015';
  end if;

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
      using detail = format('rollback_v5: %s fila(s); la primera: %s', v_n, v_first);
  end if;
end
$$;

select set_config('amelia.milk_rpc', '', true);

commit;

-- PostgREST cachea el esquema: sin esto seguiría ofreciendo milk_combine,
-- formula_* y la firma de once argumentos de log_pumping_session.
notify pgrst, 'reload schema';
