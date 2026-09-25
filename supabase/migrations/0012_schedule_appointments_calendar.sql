-- Countdown configurable, recordatorio de cita y feed de calendario.
--
-- Numerada en este repo por pedido explícito de Emilio (24 sep 2026), no por
-- el agente del Hub: ver CLAUDE.md §5.2. Igual que 0007, 0008, 0009, 0010 y
-- 0011, entra al Hub como historia.
--
-- Las tres partes comparten una regla: scope por `family_id` DIRECTO, nunca
-- por un join a través de `baby_id`. Es la forma que pide la fase 2
-- (PROJECT.md, "What changes when the shared backend lands") y la misma que ya
-- usan `device_tokens` (0007) y `push_subscriptions` (0009).

-- ============================================================ FAMILY SETTINGS
-- Los dos umbrales del countdown de /dashboard, y las marcas de "ya avisé".
--
-- POR QUÉ NO ES localStorage, como Theme / Language / Nursing alerts:
--   · Los dos padres tienen que ver el MISMO número. Un umbral que vale
--     distinto en cada teléfono no es un umbral de la bebé, es una preferencia
--     de pantalla, y "le toca comer a las 3" no puede depender de quién mira.
--   · El SERVIDOR lo necesita. El check de push (lib/push/server.ts) decide si
--     manda el aviso, y ahí no hay localStorage.
--
-- Una fila por familia. La app la crea con un upsert la primera vez que se
-- guarda un umbral; hasta entonces valen los defaults de lib/schedule.ts, que
-- son los mismos números que la columna.
create table family_settings (
  family_id uuid primary key references families(id) on delete cascade,

  -- Cuánto puede pasar desde que TERMINÓ la última siesta antes de que la
  -- próxima se dé por vencida. Default 2 h, pedido por Emilio.
  nap_threshold_minutes integer not null default 120
    check (nap_threshold_minutes between 15 and 1440),

  -- Lo mismo para la comida, desde el fin del último evento de comida de
  -- cualquier tipo (biberón, sólido o toma de pecho terminada). Default 3 h.
  feed_threshold_minutes integer not null default 180
    check (feed_threshold_minutes between 15 and 1440),

  -- "Ya avisé". No hay fila que marcar como en la toma larga (0009): "no
  -- comió" no es una fila, así que la marca vive acá. El aviso se repite cada
  -- ~30 min mientras siga vencido; la regla exacta es pura y está en
  -- lib/push/schedule.ts (shouldAlert), para poder probarla sin base ni red.
  feed_alert_sent_at timestamptz,
  nap_alert_sent_at timestamptz,

  updated_at timestamptz not null default now()
);

alter table family_settings enable row level security;

-- Cualquier miembro de la familia lee y cambia los umbrales: son de la familia,
-- no de un padre. (Contraste deliberado con push_subscriptions, donde la fila
-- es de UN dispositivo y el otro padre no tiene por qué verla.)
create policy "select own family_settings" on family_settings
  for select using (is_family_member(family_id));
create policy "insert own family_settings" on family_settings
  for insert with check (is_family_member(family_id));
create policy "update own family_settings" on family_settings
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id));

-- Grants explícitos. RLS correcta no alcanza sin GRANT: el bug de 0005, donde
-- las policies estaban perfectas y Postgres bloqueaba antes de evaluarlas.
-- No se da `delete`: borrar la fila de ajustes de la familia no es una acción
-- que la app ofrezca, y sin GRANT no hay forma de hacerlo por PostgREST.
revoke all on family_settings from anon, authenticated;
grant select, insert, update on family_settings to authenticated;

-- ===================================================== APPOINTMENT REMINDERS
-- La marca que hace que el recordatorio de 24 h salga UNA sola vez por cita,
-- con el mismo patrón que `nursing_sessions.long_alert_sent_at` (0009): un
-- solo `update … where reminder_sent_at is null returning`, así dos checks a
-- la vez no mandan dos veces.
alter table doctor_appointments add column if not exists reminder_sent_at timestamptz;

-- ============================================================ CALENDAR FEEDS
-- El token opaco del feed .ics de una familia.
--
-- POR QUÉ UNA TABLA Y NO UNA COLUMNA EN `families`:
--   · `families` tiene UNA sola policy en todo el repo — "select own family"
--     (0001_init.sql:157). Sin policy de update, un padre no podría generar ni
--     rotar su propio token por PostgREST.
--   · La fase 2 reemplaza `families` por `core.households`. Colgarle cuatro
--     columnas a una tabla que va a desaparecer es deuda; una tabla propia con
--     `family_id` directo se muda tal cual.
--
-- POR QUÉ EL HASH Y NO EL TOKEN:
--   Mismo espíritu que device_tokens (0007). La base guarda solo el sha-256
--   hex; el valor en claro se muestra UNA vez, al generarlo. Si alguien lee la
--   base, no se lleva un link funcionando.
--
-- ROTAR: generar uno nuevo pisa la fila (family_id es PK) y el link viejo deja
-- de funcionar en el acto. Es lo que hace falta si alguien comparte el link sin
-- querer, y por eso no hay historial de tokens: un token viejo que todavía
-- sirva no sería una rotación.
--
-- SIN LOGIN, A PROPÓSITO: un cliente de calendario suscrito a un feed no manda
-- credenciales. La URL es el único control de acceso. Qué expone quien la
-- tenga: título, tipo, hora, doctor y notas de los TURNOS MÉDICOS de esa
-- familia — nada de tomas, pañales, sueño, peso ni los nombres de los padres.
-- Decisión de producto, escrita en CLAUDE.md §5.8 y en PROJECT.md.
create table calendar_feeds (
  family_id uuid primary key references families(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  -- Para que la pantalla pueda decir "se leyó por última vez el …": es la única
  -- señal de que el link está vivo en algún calendario. La escribe el handler
  -- público con service_role.
  last_fetched_at timestamptz
);

alter table calendar_feeds enable row level security;

-- Un miembro de la familia puede ver que el feed existe y desde cuándo, y
-- generarlo o rotarlo. El HASH no le sirve de nada (no se puede revertir), así
-- que verlo no filtra el link.
create policy "select own calendar_feeds" on calendar_feeds
  for select using (is_family_member(family_id));
create policy "insert own calendar_feeds" on calendar_feeds
  for insert with check (is_family_member(family_id));
create policy "update own calendar_feeds" on calendar_feeds
  for update
  using (is_family_member(family_id))
  with check (is_family_member(family_id));
create policy "delete own calendar_feeds" on calendar_feeds
  for delete using (is_family_member(family_id));

revoke all on calendar_feeds from anon, authenticated;
grant select, insert, update, delete on calendar_feeds to authenticated;
