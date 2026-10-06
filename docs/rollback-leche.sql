-- rollback-leche.sql — deshace 0014_milk_inventory.sql (inventario de leche).
--
-- Para qué existe: si la app de 0014 sale a producción y hay que volver a la
-- v0.12.1, la base tiene que quedar con el schema EXACTO de 0001…0013. Con las
-- guardas de 0014 puestas, la app vieja sigue cargando filas de la forma vieja,
-- pero NO puede corregir ni borrar una extracción o una toma cargada con la app
-- nueva (`milk_guard_*` lo rechaza con `milk_rpc_only`), y la leche que carga
-- queda como fila "legada", fuera del inventario (no lo desfasa: no cuenta).
-- Ver docs/compatibilidad-leche.md. Si se vuelve el código para quedarse en la
-- v0.12.1 por un tiempo largo, conviene volver también la base.
--
-- Probado en un Postgres efímero (misma imagen que el stack local) el
-- 6 oct 2026: después de esto, `pg_dump --schema-only --schema=public` da
-- idéntico al de una base con 0001…0013 aplicadas de cero, y correrlo dos
-- veces seguidas no da error.
--
-- ================================================================ ANTES
--
-- 1. Backup completo de la base con pg_dump, como dice
--    docs/seguridad-operacional.md. Este script BORRA DATOS y no hay vuelta
--    atrás sin ese backup.
-- 2. Leé la lista de abajo y decidí si querés guardar lo que se pierde en un
--    schema aparte (el paso opcional, comentado, más abajo).
-- 3. Se corre de una vez, entero (SQL Editor de Supabase o psql). Es una sola
--    transacción: si algo falla, no cambia nada.
--
-- ================================================================ QUÉ DATOS SE PIERDEN
--
--   · TODOS los contenedores de leche (tabla milk_containers): la cinta de
--     cada biberón (M1, M2, M3…), cuánto tenía, cuánto le queda, cuándo se
--     guardó, dónde (heladera/freezer) y cuándo caduca.
--   · TODAS las porciones (tabla milk_drawdowns): qué leche de qué contenedor
--     fue a cada toma de biberón.
--   · El reparto izquierda/derecha de cada extracción (pumping_sessions.left_ml
--     y right_ml). El TOTAL de la extracción (amount_ml) se queda.
--   · El desglose leche materna / fórmula de cada toma de biberón
--     (feedings.breast_milk_ml y formula_ml). El TOTAL de la toma (amount_ml)
--     se queda.
--   · Las tres reglas de conservación de cada bebé (babies.milk_room_hours,
--     milk_fridge_days, milk_freezer_months).
--
-- ================================================================ QUÉ SOBREVIVE
--
--   · Todas las filas de feedings, pumping_sessions, nursing, pañales, sueño,
--     crecimiento, turnos, etc. — las cargadas con la app vieja Y las cargadas
--     con la nueva. Las extracciones y tomas de biberón de la app nueva quedan
--     como filas comunes, con su total, su hora, su lado y su nota.
--   · Lo que la app nueva anuló por las funciones (void_bottle_feed,
--     void_pumping_session) SIGUE ANULADO: `voided_at` es una columna de antes
--     (0006), no se toca, y la app vieja la respeta igual.
--   · El UNIQUE (id, family_id) de babies (`babies_id_family_id_key`) se queda:
--     NO es de 0014, lo agregó 0007 para device_tokens.
--
-- ================================================================ PASO OPCIONAL
--
-- Por defecto NO se guarda nada. Si querés conservar lo que se pierde (para
-- reconstruirlo más adelante o solo para tenerlo), descomentá este bloque
-- ANTES del `begin;`. Copia los datos a un schema `milk_backup` que ni
-- PostgREST ni la app ven (PostgREST solo expone `public`). Se borra con
-- `drop schema milk_backup cascade;` cuando ya no haga falta.
--
-- create schema if not exists milk_backup;
-- revoke all on schema milk_backup from public, anon, authenticated;
-- create table milk_backup.milk_containers as select * from public.milk_containers;
-- create table milk_backup.milk_drawdowns as select * from public.milk_drawdowns;
-- create table milk_backup.pumping_split as
--   select id, baby_id, pumped_at, amount_ml, left_ml, right_ml
--   from public.pumping_sessions
--   where left_ml is not null or right_ml is not null;
-- create table milk_backup.feeding_split as
--   select id, baby_id, fed_at, amount_ml, breast_milk_ml, formula_ml
--   from public.feedings
--   where breast_milk_ml is not null or formula_ml is not null;
-- create table milk_backup.baby_milk_rules as
--   select id, family_id, milk_room_hours, milk_fridge_days, milk_freezer_months
--   from public.babies;

begin;

-- ---------------------------------------------------------- 1. triggers
-- Primero, para que nada de lo que sigue (ni una escritura concurrente) pase
-- por las guardas mientras se desarma.
drop trigger if exists milk_guard_feedings on public.feedings;
drop trigger if exists milk_guard_pumping on public.pumping_sessions;
-- `drop trigger if exists … on tabla` falla igual si la TABLA no existe, y en
-- una segunda corrida milk_containers/milk_drawdowns ya no están: por eso van
-- dentro de un to_regclass. (Igual se irían solos con el drop table de abajo.)
do $$
begin
  if to_regclass('public.milk_containers') is not null then
    drop trigger if exists milk_guard_containers on public.milk_containers;
  end if;
  if to_regclass('public.milk_drawdowns') is not null then
    drop trigger if exists milk_guard_drawdowns on public.milk_drawdowns;
  end if;
end
$$;

-- ---------------------------------------------------------- 2. funciones
-- Con la firma exacta de 0014. Sin CASCADE: si algo inesperado dependiera de
-- alguna, mejor que falle a la vista (y la transacción no cambie nada).
drop function if exists public.log_pumping_session(
  uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
);
drop function if exists public.update_pumping_session(
  uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz
);
drop function if exists public.void_pumping_session(uuid, timestamptz);
drop function if exists public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb);
drop function if exists public.void_bottle_feed(uuid, timestamptz);
drop function if exists public.milk_create_container(uuid, text, uuid, uuid, numeric, timestamptz);
drop function if exists public.milk_served_ml(uuid);
drop function if exists public.milk_expires_at(timestamptz, text, numeric, numeric);
drop function if exists public.milk_guard_feedings();
drop function if exists public.milk_guard_pumping();
drop function if exists public.milk_guard_containers();
drop function if exists public.milk_guard_inventory();
drop function if exists public.milk_in_rpc();

-- ---------------------------------------------------------- 3. tablas
-- Las porciones primero: tienen una FK a los contenedores. Con las tablas se
-- van sus índices, policies, grants y constraints.
drop table if exists public.milk_drawdowns;
drop table if exists public.milk_containers;

-- ---------------------------------------------------------- 4. columnas
-- Con cada columna se va su CHECK. 0014 no agregó nada más sobre tablas
-- existentes: ni índices, ni grants, ni policies, ni constraints aparte.
alter table public.pumping_sessions
  drop column if exists left_ml,
  drop column if exists right_ml;

alter table public.feedings
  drop column if exists breast_milk_ml,
  drop column if exists formula_ml;

alter table public.babies
  drop column if exists milk_room_hours,
  drop column if exists milk_fridge_days,
  drop column if exists milk_freezer_months;

-- ---------------------------------------------------------- 5. historial
-- Si se aplicó con scripts/local-stack.sh, queda anotada; sin esto, un
-- `pnpm db:up` posterior creería que 0014 sigue puesta. En la nube la tabla
-- puede no existir: por eso el to_regclass.
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '0014_milk_inventory';
  end if;
end
$$;

commit;

-- PostgREST cachea el schema: sin esto seguiría ofreciendo las funciones y
-- tablas que ya no existen.
notify pgrst, 'reload schema';
