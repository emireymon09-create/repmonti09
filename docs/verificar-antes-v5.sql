-- verificar-antes-v5.sql — SOLO LECTURA. Para pegar en el SQL Editor del
-- proyecto Supabase de producción ANTES de aplicar 0016_milk_phase3_4.sql
-- (inventario de leche v5: enfriado, combinar, biberón empezado, Similac).
-- Sigue el método de docs/verificar-antes-v4.sql: 0014 y 0015 pasan a ser
-- requisitos y cada objeto de 0016 se mira por separado.
--
-- No escribe nada: corre dentro de `begin transaction read only` … `rollback`,
-- así que aunque alguien le agregue un UPDATE por error, la base lo rechaza.
-- Se puede correr las veces que haga falta. Verifica cada migración POR SUS
-- OBJETOS, no por supabase_migrations.schema_migrations (lo aplicado a mano en
-- el SQL Editor puede no haber quedado registrado; la consulta 5 la muestra
-- solo como dato).
--
-- CÓMO CORRERLO: el SQL Editor de Supabase puede mostrar solo el resultado de
-- la ÚLTIMA consulta. Seleccioná `begin transaction read only;` + UNA consulta
-- numerada + `rollback;` y Run; después la siguiente. En psql corre entero.
--
-- Resultado esperado ANTES de aplicar 0016:
--   Consulta 1 → 0014 true, 0015 true, 0016 false. Si 0014 o 0015 dan false,
--        PARÁ: primero van los runbooks de v3/v4 (0016 no entra sin 0015).
--   Consulta 2 → TODOS los objetos de 0016 false. Si alguno da true, PARÁ:
--        alguien la aplicó a medias o ya está (después de aplicarla: todos true).
--   Consulta 3 (la invariante que 0015 revisa y que 0016 vuelve a revisar al
--        final, con lo que hay hoy) → 0 en todas las filas. Si algo da > 0,
--        0016 se va a ABORTAR sola con `milk_invariant_broken` (sin aplicar
--        nada): revisá esos datos antes. OJO: con 0016 YA aplicada, INV-1 y
--        INV-3 cuentan como falla todo biberón combinado (esta cuenta no
--        conoce las transferencias); ahí usá la invariante del final de 0016.
--   Consulta 4 → qué va a tocar el backfill de 0016 (para el dueño).
-- Probado el 7 oct 2026 (docs/compatibilidad-v5.md §5): en 0001…0015 da 0016
-- false y 21/21 objetos false; con 0016, true y 21/21 true; tras
-- docs/rollback-leche-v5.sql, de nuevo false y 21/21 false.

begin transaction read only;

-- 1. Las tres migraciones de leche, con la huella que las delata.
select m.migracion, m.presente, m.huella
from (values
  ('0014_milk_inventory (DEBE dar true)',
     to_regclass('public.milk_containers') is not null
       and to_regclass('public.milk_drawdowns') is not null,
     'tablas milk_containers, milk_drawdowns'),
  ('0015_milk_phase1_2 (DEBE dar true)',
     to_regclass('public.milk_discards') is not null
       and to_regclass('public.milk_feeding_edits') is not null
       and exists (select 1 from information_schema.columns where table_schema='public'
                   and table_name='milk_containers' and column_name='released_at')
       and to_regprocedure('public.milk_rebalance(uuid, text)') is not null,
     'milk_discards, milk_feeding_edits, milk_containers.released_at, milk_rebalance'),
  ('0016_milk_phase3_4 (antes: false; después: true)',
     to_regclass('public.milk_transfers') is not null,
     'tabla milk_transfers (objeto por objeto: consulta 2)')
) as m(migracion, presente, huella);

-- 2. Cada objeto de 0016, uno por fila. ANTES de aplicar: todas false.
--    DESPUÉS: todas true. Una mezcla = aplicada a medias (no debería poder
--    pasar: 0016 es una sola transacción).
select o.objeto, o.presente
from (values
  ('columna milk_containers.fridge_at',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_containers' and column_name='fridge_at')),
  ('columna milk_containers.cold_at',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_containers' and column_name='cold_at')),
  ('SIN constraint milk_containers_remaining_le_amount',
     not exists (select 1 from pg_constraint where conname='milk_containers_remaining_le_amount')),
  ('tabla milk_ops con RLS',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.milk_ops')), false)),
  ('tabla milk_transfers con RLS',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.milk_transfers')), false)),
  ('tabla formula_containers con RLS',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.formula_containers')), false)),
  ('columna milk_discards.feeding_id',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_discards' and column_name='feeding_id')),
  ('milk_discards.container_id acepta null',
     exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='milk_discards' and column_name='container_id' and is_nullable='YES')),
  ('constraint milk_discards_shape',
     exists (select 1 from pg_constraint where conname='milk_discards_shape')),
  ('milk_discards_reason_check acepta started_bottle_expired',
     coalesce((select pg_get_constraintdef(oid) like '%started_bottle_expired%'
                 from pg_constraint where conname='milk_discards_reason_check'), false)),
  ('índice milk_discards_one_live_feeding',
     to_regclass('public.milk_discards_one_live_feeding') is not null),
  ('función milk_is_cold(milk_containers, timestamptz)',
     exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='milk_is_cold')),
  ('función milk_mark_cold(uuid, uuid, timestamptz)',
     to_regprocedure('public.milk_mark_cold(uuid, uuid, timestamptz)') is not null),
  ('función milk_combine(uuid, uuid, uuid, uuid[], jsonb)',
     to_regprocedure('public.milk_combine(uuid, uuid, uuid, uuid[], jsonb)') is not null),
  ('función milk_uncombine(uuid, uuid)',
     to_regprocedure('public.milk_uncombine(uuid, uuid)') is not null),
  ('función discard_started_bottle(uuid, uuid, timestamptz)',
     to_regprocedure('public.discard_started_bottle(uuid, uuid, timestamptz)') is not null),
  ('funciones formula_add / formula_open / formula_finish / formula_void',
     to_regprocedure('public.formula_add(uuid, uuid, uuid[], numeric, timestamptz)') is not null
       and to_regprocedure('public.formula_open(uuid, uuid, uuid, timestamptz)') is not null
       and to_regprocedure('public.formula_finish(uuid, uuid, text, timestamptz)') is not null
       and to_regprocedure('public.formula_void(uuid, uuid)') is not null),
  ('trigger milk_sync_started_discard en feedings',
     exists (select 1 from pg_trigger where tgname='milk_sync_started_discard'
             and tgrelid = 'public.feedings'::regclass)),
  ('log_pumping_session de 11 argumentos (y SIN la de 10)',
     to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz, timestamptz)') is not null
       and to_regprocedure('public.log_pumping_session(uuid, uuid, text, numeric, numeric, text, timestamptz, uuid, text, timestamptz)') is null),
  ('milk_rebalance v5 (conoce las transferencias)',
     coalesce((select prosrc like '%milk_transferred_in_ml%' from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='milk_rebalance' limit 1), false)),
  ('permisos: authenticated SÍ y anon NO en milk_combine y formula_open',
     to_regprocedure('public.milk_combine(uuid, uuid, uuid, uuid[], jsonb)') is not null
       and to_regprocedure('public.formula_open(uuid, uuid, uuid, timestamptz)') is not null
       and has_function_privilege('authenticated', 'public.milk_combine(uuid, uuid, uuid, uuid[], jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.milk_combine(uuid, uuid, uuid, uuid[], jsonb)', 'execute')
       and has_function_privilege('authenticated', 'public.formula_open(uuid, uuid, uuid, timestamptz)', 'execute')
       and not has_function_privilege('anon', 'public.formula_open(uuid, uuid, uuid, timestamptz)', 'execute'))
) as o(objeto, presente);

-- 3. ¿0016 va a entrar? La invariante de 0015 (INV-1…INV-9) con lo que hay
--    hoy: 0 en todas. Cada consulta va como texto (query_to_xml) para no
--    fallar por una tabla que no exista; null = falta 0015.
select c.chequeo,
       case when to_regclass('public.milk_discards') is null then null
            else (xpath('/row/n/text()', query_to_xml(c.sql, false, true, '')))[1]::text::int
       end as filas
from (values
  ('INV-1 cuenta (amount = servido + desechado + lost + remaining)',
   'select count(*) as n from milk_containers c where c.voided_at is null and abs(c.amount_ml - coalesce((select sum(d.amount_ml) from milk_drawdowns d where d.container_id = c.id and d.voided_at is null), 0) - coalesce((select sum(x.amount_ml) from milk_discards x where x.container_id = c.id and x.voided_at is null), 0) - c.lost_ml - c.remaining_ml) > 1e-9'),
  ('INV-2 número doble',
   'select count(*) as n from (select 1 from milk_containers where voided_at is null and released_at is null group by baby_id, label having count(*) > 1) x'),
  ('INV-3 desecho incoherente',
   'select count(*) as n from milk_containers c where exists (select 1 from milk_discards x where x.container_id = c.id and x.voided_at is null) and (c.voided_at is not null or c.released_at is null or c.remaining_ml <> 0)'),
  ('INV-4 anulado con porciones o desechos vivos',
   'select count(*) as n from milk_containers c where c.voided_at is not null and (exists (select 1 from milk_drawdowns d where d.container_id = c.id and d.voided_at is null) or exists (select 1 from milk_discards x where x.container_id = c.id and x.voided_at is null))'),
  ('INV-5 ocupado vacío',
   'select count(*) as n from milk_containers where voided_at is null and released_at is null and remaining_ml < 0.15'),
  ('INV-6 toma con desglose que no cierra',
   'select count(*) as n from feedings f where f.voided_at is null and (f.breast_milk_ml is not null or f.formula_ml is not null) and (abs(coalesce(f.breast_milk_ml, 0) - coalesce((select sum(d.amount_ml) from milk_drawdowns d where d.feeding_id = f.id and d.voided_at is null), 0)) > 1e-9 or abs(f.amount_ml - coalesce(f.breast_milk_ml, 0) - coalesce(f.formula_ml, 0)) > 1e-9)'),
  ('INV-8 extracción viva con total distinto a su contenedor',
   'select count(*) as n from milk_containers c join pumping_sessions ps on ps.id = c.source_session_id where c.voided_at is null and ps.voided_at is null and ps.amount_ml is distinct from c.amount_ml'),
  ('INV-9 porción viva de una toma anulada',
   'select count(*) as n from milk_drawdowns d join feedings f on f.id = d.feeding_id where d.voided_at is null and f.voided_at is not null')
) as c(chequeo, sql);

-- 4. Qué va a hacer 0016 con los datos (para el dueño; null si falta 0015).
--    fridge_at = stored_at en TODOS (backfill): casi todo queda "frío"; solo
--    la leche extraída en la última hora aparece "Enfriando" hasta cumplirla.
--    Los desechos de caducada existentes cumplen la forma nueva sin tocarlos.
--    El "Sobró" de la última toma pasa a ser un biberón empezado: si es de la
--    última hora, Hoy dice "sirve hasta…"; si es más viejo, "Ya no sirve" +
--    "Desechar".
select c.que,
       case when to_regclass('public.milk_discards') is null then null
            else (xpath('/row/n/text()', query_to_xml(c.sql, false, true, '')))[1]::text::int
       end as cuantos
from (values
  ('contenedores que reciben fridge_at = stored_at (todos)',
   'select count(*) as n from milk_containers'),
  ('ocupados que van a aparecer "Enfriando" (extraídos hace < 60 min)',
   'select count(*) as n from milk_containers where voided_at is null and released_at is null and stored_at > now() - interval ''60 minutes'''),
  ('ocupados vigentes y fríos (la Receta los puede usar)',
   'select count(*) as n from milk_containers where voided_at is null and released_at is null and remaining_ml >= 0.15 and expires_at > now() and stored_at <= now() - interval ''60 minutes'''),
  ('desechos de caducada (deben tener contenedor: forma nueva)',
   'select count(*) as n from milk_discards'),
  ('desechos SIN contenedor (0016 los rechazaría; esperado 0)',
   'select count(*) as n from milk_discards where container_id is null'),
  ('reason distinto de expired (esperado 0)',
   'select count(*) as n from milk_discards where reason <> ''expired'''),
  ('contenedores con remaining > amount (la CHECK de 0014 lo impide; esperado 0)',
   'select count(*) as n from milk_containers where remaining_ml > amount_ml'),
  ('tomas de biberón vivas con sobró > 0 (biberones empezados posibles)',
   'select count(*) as n from feedings where voided_at is null and feeding_type = ''bottle'' and leftover_ml > 0'),
  ('ídem, de la última hora (Hoy dirá "sirve hasta…")',
   'select count(*) as n from feedings where voided_at is null and feeding_type = ''bottle'' and leftover_ml > 0 and fed_at > now() - interval ''60 minutes'''),
  ('fórmula de las últimas 72 h, en ml (el "por día" de Similac será esto / 3)',
   'select coalesce(round(sum(formula_ml)), 0) as n from feedings where voided_at is null and feeding_type = ''bottle'' and formula_ml > 0 and fed_at > now() - interval ''72 hours'''),
  ('tomas con hora > ahora + 10 min (esperado 0)',
   'select count(*) as n from feedings where voided_at is null and fed_at > now() + interval ''10 minutes''')
) as c(que, sql);

-- 5. Qué registró el historial de migraciones, si existe la tabla (solo
--    informativo: NO es la verdad, la verdad son las consultas 1 y 2).
select case when to_regclass('supabase_migrations.schema_migrations') is null then null
            else (xpath('/row/v/text()', query_to_xml(
                   'select string_agg(version, '', '' order by version) as v from supabase_migrations.schema_migrations where version >= ''0014''',
                   false, true, '')))[1]::text
       end as historial_0014_en_adelante;

-- 6. Volumen de datos (para comparar con la prueba de humo y con el respaldo).
select 'feedings' as tabla, count(*) as filas, count(*) filter (where voided_at is null) as vivas from feedings
union all select 'pumping_sessions', count(*), count(*) filter (where voided_at is null) from pumping_sessions
union all select 'milk_containers', count(*), count(*) filter (where voided_at is null) from milk_containers
union all select 'milk_drawdowns', count(*), count(*) filter (where voided_at is null) from milk_drawdowns
union all select 'babies', count(*), count(*) from babies;

-- 7. ¿Hay una lactancia o un sueño abiertos ahora? (no bloquea, pero conviene
--    aplicar cuando no haya una toma en curso).
select 'nursing abierta' as que, count(*) from nursing_sessions where ended_at is null and voided_at is null
union all select 'sueño abierto', count(*) from sleep_sessions where ended_at is null and voided_at is null;

rollback;
