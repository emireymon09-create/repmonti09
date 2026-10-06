-- verificar-antes-leche.sql — SOLO LECTURA. Para pegar en el SQL Editor del
-- proyecto Supabase de producción ANTES de aplicar nada (runbook, paso 2).
--
-- No escribe nada: solo SELECT sobre catálogos y conteos. Se puede correr las
-- veces que haga falta. Verifica cada migración POR SUS OBJETOS, no por
-- supabase_migrations.schema_migrations: las que se aplicaron a mano en el
-- SQL Editor pueden no haber quedado registradas ahí.
--
-- CÓMO CORRERLO: el SQL Editor de Supabase puede mostrar solo el resultado de
-- la ÚLTIMA consulta. Por eso la que decide (la 1) se corre SOLA: seleccioná
-- desde "-- 1." hasta su ";" y Run. Después, si querés, la 2, la 4 y la 5,
-- una por vez.
--
-- Resultado esperado en producción v0.12.1 ANTES del despliegue:
--   0001 … 0012 → true (salvo 0011: puede dar false si el aviso push nunca se
--        terminó de configurar en la nube; NO bloquea la leche, ver runbook)
--   0013_changer_display_scopes → true SI ya se aplicó (si da false, se aplica
--        primero: runbook paso 3a)
--   0014_milk_inventory → false en TODAS sus columnas (si alguna da true, PARÁ:
--        alguien la aplicó a medias; no sigas sin revisar)

-- 1. Una fila por migración, con la huella que la delata.
select m.migracion, m.presente, m.huella
from (values
  ('0001_init',
     to_regclass('public.feedings') is not null and to_regclass('public.family_members') is not null,
     'tablas feedings, family_members'),
  ('0002_pumping_sessions',
     to_regclass('public.pumping_sessions') is not null,
     'tabla pumping_sessions'),
  ('0003_pumping_reset',
     exists (select 1 from information_schema.columns where table_schema='public' and table_name='babies' and column_name='pumping_reset_at'),
     'babies.pumping_reset_at'),
  ('0004_fix_function_search_path',
     exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='is_family_member'
               and array_to_string(p.proconfig, ',') like '%search_path%'),
     'is_family_member con search_path fijo'),
  ('0005_grant_authenticated (informativa)',
     has_table_privilege('authenticated', 'public.feedings', 'INSERT'),
     'GRANT insert en feedings a authenticated — en Supabase suele estar por defecto: no prueba que 0005 corrió'),
  ('0006_edit_and_void',
     exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedings' and column_name='voided_at'),
     'feedings.voided_at'),
  ('0007_device_tokens',
     to_regclass('public.device_tokens') is not null
       and exists (select 1 from pg_constraint where conname='babies_id_family_id_key'),
     'tabla device_tokens + babies_id_family_id_key'),
  ('0008_growth_edit_and_void',
     exists (select 1 from information_schema.columns where table_schema='public' and table_name='growth_measurements' and column_name='voided_at'),
     'growth_measurements.voided_at'),
  ('0009_push',
     to_regclass('public.push_subscriptions') is not null
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='nursing_sessions' and column_name='long_alert_sent_at'),
     'push_subscriptions + nursing_sessions.long_alert_sent_at'),
  ('0010_push_forbidden_streak',
     exists (select 1 from information_schema.columns where table_schema='public' and table_name='push_subscriptions' and column_name='consecutive_403'),
     'push_subscriptions.consecutive_403'),
  ('0011_push_cron',
     case when to_regclass('cron.job') is null then false
          else exists (select 1 from pg_extension where extname='pg_net')
               and (xpath('/row/n/text()', query_to_xml(
                      'select count(*) as n from cron.job where jobname = ''nursing-check''', false, true, '')))[1]::text::int > 0
     end,
     'job ''nursing-check'' en cron.job + pg_net'),
  ('0012_schedule_appointments_calendar',
     to_regclass('public.family_settings') is not null and to_regclass('public.calendar_feeds') is not null
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='doctor_appointments' and column_name='reminder_sent_at'),
     'tablas family_settings, calendar_feeds + doctor_appointments.reminder_sent_at'),
  ('0013_changer_display_scopes',
     exists (select 1 from pg_constraint where conname='device_tokens_scopes_check'
             and pg_get_constraintdef(oid) like '%quick_diaper%'
             and pg_get_constraintdef(oid) like '%read_status%'),
     'CHECK de device_tokens con quick_diaper y read_status'),
  ('0014_milk_inventory (DEBE dar false)',
     to_regclass('public.milk_containers') is not null
       or to_regclass('public.milk_drawdowns') is not null
       or exists (select 1 from information_schema.columns where table_schema='public'
                  and ((table_name='pumping_sessions' and column_name in ('left_ml','right_ml'))
                    or (table_name='feedings' and column_name in ('breast_milk_ml','formula_ml'))
                    or (table_name='babies' and column_name like 'milk\_%')))
       or exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname in
                    ('log_pumping_session','update_pumping_session','void_pumping_session',
                     'log_bottle_feed','void_bottle_feed','milk_in_rpc','milk_guard_pumping',
                     'milk_guard_feedings','milk_create_container','milk_expires_at','milk_served_ml',
                     'milk_guard_containers','milk_guard_inventory')),
     'cualquier objeto del inventario de leche')
) as m(migracion, presente, huella);

-- 2. El CHECK de scopes tal cual (0009 / 0013).
select pg_get_constraintdef(oid) as device_tokens_scopes_check
from pg_constraint where conname = 'device_tokens_scopes_check';

-- 4. Qué registró el historial de migraciones, si existe la tabla (solo
--    informativo: NO es la verdad, la verdad es la consulta 1).
select to_regclass('supabase_migrations.schema_migrations') as tabla_historial;
-- Si la línea anterior no dio null, descomentá y corré:
-- select version from supabase_migrations.schema_migrations order by version;

-- 5. Volumen de datos que la migración va a "ver" (para comparar con la
--    prueba de humo y con el respaldo). Solo conteos.
select 'feedings' as tabla, count(*) as filas, count(*) filter (where voided_at is null) as vivas from feedings
union all select 'pumping_sessions', count(*), count(*) filter (where voided_at is null) from pumping_sessions
union all select 'babies', count(*), count(*) from babies
union all select 'nursing_sessions', count(*), count(*) filter (where voided_at is null) from nursing_sessions;

-- 6. ¿Hay una lactancia o un sueño abiertos ahora? (no bloquea, pero conviene
--    desplegar cuando no haya una toma en curso).
select 'nursing abierta' as que, count(*) from nursing_sessions where ended_at is null and voided_at is null
union all select 'sueño abierto', count(*) from sleep_sessions where ended_at is null and voided_at is null;
