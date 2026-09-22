-- Aviso push cuando una toma de pecho lleva demasiado tiempo abierta
-- (docs/superpowers/specs/2026-09-22-dashboard-secciones-push-design.md,
-- "Parte B").
--
-- Numerada en este repo por pedido explícito de Emilio (22 sep 2026), no por
-- el agente del Hub: ver CLAUDE.md §5.2. Igual que 0007 y 0008, entra al Hub
-- como historia.

-- ---------- PUSH SUBSCRIPTIONS ----------
-- Una fila por (usuario, dispositivo/navegador): lo que el navegador devuelve
-- de pushManager.subscribe(). No es un secreto de la cuenta, pero sí es lo que
-- permite mandarle notificaciones a ese teléfono: nadie más que su dueño la ve.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Scope directo por familia (no por join vía baby_id): fase 2 lo pide así.
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- La URL del servicio de push (FCM, Mozilla, Apple…). Siempre https. Qué
  -- hosts se aceptan lo decide lib/push/endpoint.ts, al guardar Y al mandar:
  -- el servidor hace un POST a esta URL, y una fila escrita a mano por
  -- PostgREST no pasa por la ruta de la app.
  endpoint text not null check (endpoint ~ '^https://' and char_length(endpoint) <= 2048),
  -- Claves del navegador para cifrar el contenido (RFC 8291), base64url.
  p256dh text not null check (char_length(p256dh) between 80 and 100),
  auth text not null check (char_length(auth) between 16 and 32),
  -- Idioma en el que se le escribe la notificación a este dispositivo.
  lang text not null default 'en' check (lang in ('en', 'es')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index push_subscriptions_family_id_idx on push_subscriptions (family_id);

alter table push_subscriptions enable row level security;

-- Cada padre ve, crea, cambia y borra SOLO sus suscripciones, y solo con la
-- familia de la que es miembro. El otro padre de la misma familia no ve el
-- endpoint de este teléfono: no lo necesita para nada.
create policy "select own push_subscriptions" on push_subscriptions
  for select using (user_id = auth.uid() and is_family_member(family_id));
create policy "insert own push_subscriptions" on push_subscriptions
  for insert with check (user_id = auth.uid() and is_family_member(family_id));
create policy "update own push_subscriptions" on push_subscriptions
  for update
  using (user_id = auth.uid() and is_family_member(family_id))
  with check (user_id = auth.uid() and is_family_member(family_id));
create policy "delete own push_subscriptions" on push_subscriptions
  for delete using (user_id = auth.uid() and is_family_member(family_id));

-- Grants explícitos. RLS correcta no alcanza sin GRANT (el bug de 0005), y el
-- default de este stack le da TODO a anon: se le saca todo. A authenticated,
-- solo las cuatro operaciones (no truncate/references/trigger).
revoke all on push_subscriptions from anon, authenticated;
grant select, insert, update, delete on push_subscriptions to authenticated;

-- ---------- NURSING: "YA SE AVISÓ" ----------
-- La marca que hace que el aviso salga UNA sola vez por sesión: el check la
-- pone con un solo `update … where long_alert_sent_at is null returning`, así
-- dos checks a la vez no mandan dos veces.
alter table nursing_sessions add column if not exists long_alert_sent_at timestamptz;

-- ---------- DEVICE TOKENS: SCOPE push_check ----------
-- El que llama a /api/push/nursing-check cada minuto (quién es, está abierto:
-- ver el encabezado de app/api/push/nursing-check/route.ts).
alter table device_tokens drop constraint device_tokens_scopes_check;
alter table device_tokens add constraint device_tokens_scopes_check
  check (
    cardinality(scopes) > 0
    and scopes <@ array['ingest', 'quick_nurse', 'push_check']::text[]
  );
