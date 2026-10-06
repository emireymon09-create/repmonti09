-- verificar-antes-v4.sql — SOLO LECTURA. Para pegar en el SQL Editor del
-- proyecto Supabase de producción ANTES de aplicar 0015_milk_phase1_2.sql
-- (inventario de leche v4). Extiende docs/verificar-antes-leche.sql (la de v3):
-- mismas huellas de 0001…0013, 0014 pasa a ser un requisito, y suma cada
-- objeto de 0015 por separado.
--
-- No escribe nada: corre dentro de `begin transaction read only` … `rollback`,
-- así que aunque alguien le agregue un UPDATE por error, la base lo rechaza.
-- Se puede correr las veces que haga falta. Verifica cada migración POR SUS
-- OBJETOS, no por supabase_migrations.schema_migrations (lo aplicado a mano en
-- el SQL Editor puede no haber quedado registrado).
--
-- CÓMO CORRERLO: el SQL Editor de Supabase puede mostrar solo el resultado de
-- la ÚLTIMA consulta. Seleccioná `begin transaction read only;` + UNA consulta
-- numerada + `rollback;` y Run; después la siguiente. En psql corre entero.
--
-- Resultado esperado ANTES de aplicar 0015:
--   0001 … 0013 → true (0011 puede dar false si el push nunca se terminó de
--        configurar en la nube; no bloquea la leche)
--   0014_milk_inventory → true. Si da false, 0014 NO está: primero va el
--        runbook de v3 (docs/runbook-despliegue-leche.md, paso 3b), o se
--        aplican 0014 y 0015 seguidas, en ese orden.
--   0015 (consulta 1) y TODOS los objetos de la consulta 2 → false. Si alguno
--        da true, PARÁ: alguien la aplicó a medias; no sigas sin revisar.
--   Consulta 3 (la cuenta que 0015 revisa al final) → 0 en todas las filas.
--        Si algo da > 0, 0015 se va a ABORTAR sola con
--        `milk_invariant_broken` (sin aplicar nada): revisá esos datos antes.
-- DESPUÉS de aplicar 0015: consulta 1 → 0015 true, y la consulta 2 → TODAS
-- true. (Probado en local el 6 oct 2026: false en 0001…0014, true en
-- 0001…0015; docs/compatibilidad-v4.md §5.)

begin transaction read only;

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
  ('0014_milk_inventory (DEBE dar true)',
     to_regclass('public.milk_containers') is not null
       and to_regclass('public.milk_drawdowns') is not null
       and to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)') is not null,
     'tablas milk_containers, milk_drawdowns + log_pumping_session'),
  ('0015_milk_phase1_2 (antes: false; después: true)',
     to_regclass('public.milk_discards') is not null,
     'tabla milk_discards (objeto por objeto: consulta 2)')
) as m(migracion, presente, huella);

-- 2. Cada objeto de 0015, uno por fila. ANTES de aplicar: todas false.
--    DESPUÉS: todas true. Una mezcla = aplicada a medias (no debería poder
--    pasar: 0015 es una sola transacción).
select o.objeto, o.presente
from (values
  ('columna milk_containers.released_at',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_containers' and column_name='released_at')),
  ('columna milk_containers.lost_ml',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_containers' and column_name='lost_ml')),
  ('columna feedings.leftover_ml',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='feedings' and column_name='leftover_ml')),
  ('columna babies.milk_bottle_count',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='babies' and column_name='milk_bottle_count')),
  ('constraint milk_containers_released_empty',
     exists (select 1 from pg_constraint where conname='milk_containers_released_empty')),
  ('constraint feedings_leftover_le_amount',
     exists (select 1 from pg_constraint where conname='feedings_leftover_le_amount')),
  ('índice milk_containers_label_occupied (y SIN milk_containers_label_live)',
     to_regclass('public.milk_containers_label_occupied') is not null
       and to_regclass('public.milk_containers_label_live') is null),
  ('tabla milk_discards con RLS',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.milk_discards')), false)),
  ('tabla milk_feeding_edits con RLS',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.milk_feeding_edits')), false)),
  ('función milk_rebalance(uuid, text)',
     to_regprocedure('public.milk_rebalance(uuid, text)') is not null),
  ('función milk_discarded_ml(uuid)',
     to_regprocedure('public.milk_discarded_ml(uuid)') is not null),
  ('función discard_container(uuid, uuid, timestamptz)',
     to_regprocedure('public.discard_container(uuid, uuid, timestamptz)') is not null),
  ('función edit_bottle_feed (8 argumentos)',
     to_regprocedure('public.edit_bottle_feed(uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb)') is not null),
  ('log_bottle_feed de 7 argumentos (y SIN la de 6)',
     to_regprocedure('public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb, numeric)') is not null
       and to_regprocedure('public.log_bottle_feed(uuid, uuid, timestamptz, text, numeric, jsonb)') is null),
  ('void_bottle_feed devuelve jsonb',
     coalesce((select pg_get_function_result(p.oid) = 'jsonb' from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='void_bottle_feed' limit 1), false)),
  ('guarda de tomas v4 (milk_guard_feedings protege leftover_ml)',
     coalesce((select prosrc like '%leftover_ml%' from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='milk_guard_feedings' limit 1), false)),
  ('milk_create_container v4 (cinta ocupada = no anulada y no liberada)',
     coalesce((select prosrc like '%released_at is null%' from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='milk_create_container' limit 1), false)),
  ('permisos: authenticated SÍ y anon NO en discard_container y edit_bottle_feed',
     to_regprocedure('public.discard_container(uuid, uuid, timestamptz)') is not null
       and to_regprocedure('public.edit_bottle_feed(uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb)') is not null
       and has_function_privilege('authenticated', 'public.discard_container(uuid, uuid, timestamptz)', 'execute')
       and not has_function_privilege('anon', 'public.discard_container(uuid, uuid, timestamptz)', 'execute')
       and has_function_privilege('authenticated', 'public.edit_bottle_feed(uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.edit_bottle_feed(uuid, uuid, timestamptz, numeric, numeric, numeric, text, jsonb)', 'execute'))
) as o(objeto, presente);

-- 3. ¿0015 va a entrar? La migración termina con la invariante contable
--    (ARQ §2.4) y aborta con `milk_invariant_broken` si los datos no cierran.
--    Esta es la MISMA cuenta con lo que hay antes de 0015 (sin desechos ni
--    leche perdida todavía): 0 en todas. Si 0014 no está, da null (no hay
--    inventario). Cada consulta va como texto (query_to_xml) para no fallar
--    por una tabla que todavía no existe.
--    OJO: si 0015 YA está aplicada, la fila INV-1 cuenta como falla todo
--    contenedor con desecho o leche perdida; ahí usá la consulta completa de
--    docs/arquitectura-v4.md §2.4.
--    Sobre una base que pasó por docs/rollback-leche-v4.sql, 0015 REPARA antes
--    de contar (R-10): los anulados con porciones vivas vuelven liberados y la
--    leche que falta en un vivo va a lost_ml. Por eso acá INV-1 cuenta solo lo
--    que sobra (remaining MAYOR que amount − servido) y lo reparable está en
--    la consulta 4, no acá. INV-8 sí mira también a los que 0015 va a
--    devolver.
select c.chequeo,
       case when to_regclass('public.milk_containers') is null then null
            else (xpath('/row/n/text()', query_to_xml(c.sql, false, true, '')))[1]::text::int
       end as filas
from (values
  ('INV-1 vivo con remaining > amount - servido (leche que no puede existir)',
   'select count(*) as n from milk_containers c where c.voided_at is null and c.amount_ml - coalesce((select sum(d.amount_ml) from milk_drawdowns d where d.container_id = c.id and d.voided_at is null), 0) - c.remaining_ml < -1e-9'),
  ('INV-2 dos vivos con leche y la misma cinta',
   'select count(*) as n from (select 1 from milk_containers where voided_at is null and remaining_ml >= 0.15 group by baby_id, label having count(*) > 1) x'),
  ('INV-6 toma con desglose que no cierra',
   'select count(*) as n from feedings f where f.voided_at is null and (f.breast_milk_ml is not null or f.formula_ml is not null) and (abs(coalesce(f.breast_milk_ml, 0) - coalesce((select sum(d.amount_ml) from milk_drawdowns d where d.feeding_id = f.id and d.voided_at is null), 0)) > 1e-9 or abs(f.amount_ml - coalesce(f.breast_milk_ml, 0) - coalesce(f.formula_ml, 0)) > 1e-9)'),
  ('INV-8 extracción viva con total distinto a su contenedor',
   'select count(*) as n from milk_containers c join pumping_sessions ps on ps.id = c.source_session_id where (c.voided_at is null or exists (select 1 from milk_drawdowns d where d.container_id = c.id and d.voided_at is null)) and ps.voided_at is null and ps.amount_ml is distinct from c.amount_ml'),
  ('INV-9 porción viva de una toma anulada',
   'select count(*) as n from milk_drawdowns d join feedings f on f.id = d.feeding_id where d.voided_at is null and f.voided_at is not null')
) as c(chequeo, sql);

-- 4. Qué va a hacer 0015 con los datos (para el dueño; null si 0014 no está).
--    Vaciados → se LIBERAN (su número vuelve al selector); vencidos con leche
--    → aparecen como Caducada con "Desechar"; cinta > M6 → siguen ocupados,
--    "fuera de M1–M6" con N = 6 por defecto (D-1, no se renumeran).
select c.que,
       case when to_regclass('public.milk_containers') is null then null
            else (xpath('/row/n/text()', query_to_xml(c.sql, false, true, '')))[1]::text::int
       end as cuantos
from (values
  ('contenedores vivos con leche (ocupados)',
   'select count(*) as n from milk_containers where voided_at is null and remaining_ml >= 0.15'),
  ('contenedores vivos vaciados (< 0,15 ml): 0015 los libera',
   'select count(*) as n from milk_containers where voided_at is null and remaining_ml < 0.15'),
  ('vencidos con leche (Caducada + Desechar en v4)',
   'select count(*) as n from milk_containers where voided_at is null and remaining_ml >= 0.15 and expires_at <= now()'),
  ('ocupados con cinta > M6',
   'select count(*) as n from milk_containers where voided_at is null and remaining_ml >= 0.15 and substring(label from 2)::numeric > 6'),
  ('contenedores anulados sin porciones vivas (no cambian)',
   'select count(*) as n from milk_containers c where c.voided_at is not null and not exists (select 1 from milk_drawdowns d where d.container_id = c.id and d.voided_at is null)'),
  ('anulados CON porciones vivas (los deja la reversa v4): 0015 los devuelve liberados',
   'select count(*) as n from milk_containers c where c.voided_at is not null and exists (select 1 from milk_drawdowns d where d.container_id = c.id and d.voided_at is null)'),
  ('vivos con remaining < amount - servido (los deja la reversa v4): la diferencia va a lost_ml',
   'select count(*) as n from milk_containers c where c.voided_at is null and c.amount_ml - coalesce((select sum(d.amount_ml) from milk_drawdowns d where d.container_id = c.id and d.voided_at is null), 0) - c.remaining_ml > 1e-9'),
  ('tomas vivas con desglose',
   'select count(*) as n from feedings where voided_at is null and (breast_milk_ml is not null or formula_ml is not null)'),
  ('biberones vivos sin desglose (legados; v4 los estima)',
   'select count(*) as n from feedings where voided_at is null and feeding_type = ''bottle'' and breast_milk_ml is null and formula_ml is null'),
  ('extracciones vivas con total y sin contenedor (legadas)',
   'select count(*) as n from pumping_sessions ps where ps.voided_at is null and ps.amount_ml is not null and not exists (select 1 from milk_containers c where c.source_session_id = ps.id and c.voided_at is null)'),
  ('tomas con desglose con hora > ahora + 10 min',
   'select count(*) as n from feedings where voided_at is null and breast_milk_ml is not null and fed_at > now() + interval ''10 minutes''')
) as c(que, sql);

-- 5. Qué registró el historial de migraciones, si existe la tabla (solo
--    informativo: NO es la verdad, la verdad son las consultas 1 y 2).
select to_regclass('supabase_migrations.schema_migrations') as tabla_historial;
-- Si la línea anterior no dio null, descomentá y corré:
-- select version from supabase_migrations.schema_migrations order by version;

-- 6. Volumen de datos (para comparar con la prueba de humo y con el respaldo).
select 'feedings' as tabla, count(*) as filas, count(*) filter (where voided_at is null) as vivas from feedings
union all select 'pumping_sessions', count(*), count(*) filter (where voided_at is null) from pumping_sessions
union all select 'babies', count(*), count(*) from babies
union all select 'nursing_sessions', count(*), count(*) filter (where voided_at is null) from nursing_sessions;

-- 7. ¿Hay una lactancia o un sueño abiertos ahora? (no bloquea, pero conviene
--    aplicar cuando no haya una toma en curso).
select 'nursing abierta' as que, count(*) from nursing_sessions where ended_at is null and voided_at is null
union all select 'sueño abierto', count(*) from sleep_sessions where ended_at is null and voided_at is null;

rollback;
