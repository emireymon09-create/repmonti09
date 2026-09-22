-- Quién llama a /api/push/nursing-check cada minuto: pg_cron + pg_net, DENTRO
-- del proyecto Supabase de la nube.
--
-- Numerada en este repo por pedido explícito de Luis (22 sep 2026), no por el
-- agente del Hub: ver CLAUDE.md §5.2.
--
-- POR QUÉ ACÁ Y NO EN OTRO LADO (CLAUDE.md §7.6)
-- ----------------------------------------------
--   · El VPS quedó descartado: es una máquina de desarrollo, no producción.
--     Poner ahí un systemd timer sería inventar una dependencia que no existe.
--   · Vercel Cron quedó descartado: en el plan Hobby corre UNA VEZ POR DÍA, con
--     hasta ~59 min de imprecisión. Para un umbral de 30 minutos no sirve.
--   · La base ya está prendida siempre y ya es la fuente de la verdad de la
--     sesión de pecho. Es el único lugar que no agrega una pieza nueva.
--
-- EL SECRETO NUNCA ESTÁ EN ESTE ARCHIVO
-- -------------------------------------
-- Ni el token ni la URL de producción se escriben acá. Los dos viven en
-- Supabase Vault y esta migración los referencia SOLO POR NOMBRE:
--
--     amelia_push_check_url    → la URL completa del endpoint en producción
--     amelia_push_check_token  → el token de device_tokens con scope push_check
--
-- Se cargan a mano, UNA SOLA VEZ, desde el SQL Editor del proyecto (así el
-- valor no pasa nunca por el repo ni por el historial de git):
--
--     select vault.create_secret(
--       'https://amelia-app.vercel.app/api/push/nursing-check',
--       'amelia_push_check_url',
--       'Amelia: endpoint del check de toma larga en produccion');
--
--     select vault.create_secret(
--       'EL-TOKEN',
--       'amelia_push_check_token',
--       'Amelia: device_token scope push_check que usa pg_cron');
--
-- Sobre esa URL: no es un secreto (es la direccion publica del sitio) y esta
-- verificada el 22 sep 2026 — 200 en /login, titulo "Amelia". Va igual por
-- Vault para que cambiar de dominio no obligue a editar y re-aplicar esta
-- migracion. OJO: tiene que ser la URL ESTABLE del proyecto; la de cada
-- deployment (amelia-<hash>-emireymon09-create.vercel.app) cambia en cada push
-- y serviria un solo deploy.
--
-- El TOKEN si es un secreto: se crea con
--   pnpm device-token create --family <uuid> --scope push_check --label "pg_cron"
-- apuntando a la base de la NUBE, y su valor no entra nunca al repo.
--
-- Para rotarlos, `vault.update_secret(id, nuevo_valor)` — el job no cambia.
--
-- UN JOB POR FAMILIA
-- ------------------
-- /api/push/nursing-check resuelve la familia DESDE el token. Así que este job
-- cubre la familia de ESE token y nada más. Hoy hay una sola familia; el día
-- que haya dos, son dos secretos y dos jobs, no un job "global".

-- ---------- EXTENSIONES ----------
-- Defensivo a propósito: el stack local de supabase/docker/ NO trae pg_cron ni
-- pg_net, y `pnpm db:up` aplica todas las migraciones. Sin esta guarda, este
-- archivo rompería el entorno de desarrollo de todos. En la nube las dos están
-- disponibles y el bloque las crea de verdad.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  else
    raise notice '0011: pg_net no disponible (stack local) — se saltea el cron';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  else
    raise notice '0011: pg_cron no disponible (stack local) — se saltea el cron';
  end if;
end
$$;

-- ---------- EL JOB ----------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice '0011: sin pg_cron/pg_net instaladas — no se agenda nada';
    return;
  end if;

  -- cron.schedule con un jobname que ya existe lo REEMPLAZA (pg_cron >= 1.4),
  -- así que volver a aplicar esta migración es idempotente.
  --
  -- El cuerpo es un SELECT con FROM sobre los dos secretos. Si alguno todavía
  -- no está cargado en Vault, el FROM no devuelve filas y el job simplemente
  -- NO HACE NADA: ni llamada, ni error cada minuto llenando el log. Es el
  -- estado en el que queda el proyecto hasta que se corren los dos
  -- vault.create_secret de arriba.
  --
  -- net.http_post es asincrónico: encola la llamada y devuelve un id. La
  -- respuesta aparece después en net._http_response — que es donde hay que
  -- mirar para saber si la app contestó 200, 401 o 503.
  perform cron.schedule(
    'nursing-check',
    '* * * * *',
    $job$
    select net.http_post(
      url := u.secret,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || t.secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000
    )
    from (
      select decrypted_secret as secret from vault.decrypted_secrets
      where name = 'amelia_push_check_url'
    ) u,
    (
      select decrypted_secret as secret from vault.decrypted_secrets
      where name = 'amelia_push_check_token'
    ) t;
    $job$
  );
  raise notice '0011: job "nursing-check" agendado (* * * * *)';
end
$$;

-- ---------- CÓMO SE VERIFICA (en la nube, no acá) ----------
--   select jobid, jobname, schedule, active from cron.job
--     where jobname = 'nursing-check';
--   select status, return_message, start_time, end_time
--     from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'nursing-check')
--     order by start_time desc limit 10;
--   select status_code, created from net._http_response order by created desc limit 10;
--
-- Para pararlo:  select cron.unschedule('nursing-check');
