-- =========================================================
-- Amelia App — Supabase Schema
-- Run this in Supabase: Dashboard > SQL Editor > New query
-- =========================================================

-- ---------- FAMILIES & MEMBERSHIP ----------
-- Supports you + your wife sharing the same baby's data, each with
-- their own login (Supabase Auth user), instead of a shared password.

create table families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'parent',
  created_at timestamptz not null default now(),
  unique (family_id, user_id)
);

-- ---------- BABIES ----------
create table babies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  birth_date date,
  created_at timestamptz not null default now()
);

-- ---------- FEEDINGS ----------
create table feedings (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  fed_at timestamptz not null default now(),
  feeding_type text not null check (feeding_type in ('bottle','nursing','solid')),
  amount_ml numeric,
  notes text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- DIAPER CHANGES ----------
create table diaper_changes (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  changed_at timestamptz not null default now(),
  diaper_type text not null check (diaper_type in ('wet','dirty','both')),
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- SLEEP SESSIONS ----------
-- source = 'manual' (logged via app toggle) or 'nuc_derived'
-- (pushed from HA/Frigate motion data later) — same table either way.
create table sleep_sessions (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null default 'manual' check (source in ('manual','nuc_derived')),
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- GROWTH MEASUREMENTS ----------
create table growth_measurements (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  measured_at date not null default current_date,
  weight_kg numeric,
  height_cm numeric,
  notes text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- BREASTFEEDING SESSIONS ----------
-- Separate from `feedings` (bottle/solid) since nursing tracks side +
-- duration rather than a single point-in-time event.
create table nursing_sessions (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  side text not null check (side in ('left','right')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- DOCTOR APPOINTMENTS ----------
create table doctor_appointments (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  title text not null,                 -- e.g. "2-month checkup"
  appointment_type text check (appointment_type in ('checkup','vaccine','sick_visit','other')),
  scheduled_at timestamptz not null,
  doctor_name text,
  notes text,
  completed boolean not null default false,
  caldav_uid text,  -- populated once this appointment is synced out to the shared calendar (handled by the Hub app, not here)
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- MONITOR EVENTS (from NUC — sound alerts, motion, etc.) ----------
-- NEVER stores video/images. Only event metadata pushed from HA/Frigate.
create table monitor_events (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  event_type text not null,       -- e.g. 'sound_alert', 'motion_start', 'motion_end'
  occurred_at timestamptz not null default now(),
  meta jsonb,                     -- small structured extra info, no media
  created_at timestamptz not null default now()
);

-- =========================================================
-- ROW LEVEL SECURITY — enabled on every table, day one.
-- Rule: a user can only read/write rows for babies belonging to a
-- family they're a member of.
-- =========================================================

alter table families enable row level security;
alter table family_members enable row level security;
alter table babies enable row level security;
alter table feedings enable row level security;
alter table diaper_changes enable row level security;
alter table sleep_sessions enable row level security;
alter table growth_measurements enable row level security;
alter table monitor_events enable row level security;
alter table nursing_sessions enable row level security;
alter table doctor_appointments enable row level security;

-- Helper: is the current user a member of this family?
create or replace function is_family_member(fam_id uuid)
returns boolean as $$
  select exists (
    select 1 from family_members
    where family_id = fam_id and user_id = auth.uid()
  );
$$ language sql security definer stable set search_path = public;

-- Helper: is the current user a member of the family that owns this baby?
create or replace function is_baby_family_member(b_id uuid)
returns boolean as $$
  select exists (
    select 1 from babies
    join family_members on family_members.family_id = babies.family_id
    where babies.id = b_id and family_members.user_id = auth.uid()
  );
$$ language sql security definer stable set search_path = public;

-- families: members can see their own family
create policy "select own family" on families
  for select using (is_family_member(id));

-- family_members: members can see other members of their own family
create policy "select own family members" on family_members
  for select using (is_family_member(family_id));

-- babies: members can see/manage babies in their family
create policy "select own babies" on babies
  for select using (is_family_member(family_id));
create policy "insert own babies" on babies
  for insert with check (is_family_member(family_id));

-- feedings / diaper_changes / sleep_sessions / growth_measurements:
-- same pattern for all four — scoped through the baby's family
create policy "select feedings" on feedings
  for select using (is_baby_family_member(baby_id));
create policy "insert feedings" on feedings
  for insert with check (is_baby_family_member(baby_id));

create policy "select diaper_changes" on diaper_changes
  for select using (is_baby_family_member(baby_id));
create policy "insert diaper_changes" on diaper_changes
  for insert with check (is_baby_family_member(baby_id));

create policy "select sleep_sessions" on sleep_sessions
  for select using (is_baby_family_member(baby_id));
create policy "insert sleep_sessions" on sleep_sessions
  for insert with check (is_baby_family_member(baby_id));
create policy "update sleep_sessions" on sleep_sessions
  for update using (is_baby_family_member(baby_id));

create policy "select growth_measurements" on growth_measurements
  for select using (is_baby_family_member(baby_id));
create policy "insert growth_measurements" on growth_measurements
  for insert with check (is_baby_family_member(baby_id));

create policy "select nursing_sessions" on nursing_sessions
  for select using (is_baby_family_member(baby_id));
create policy "insert nursing_sessions" on nursing_sessions
  for insert with check (is_baby_family_member(baby_id));
create policy "update nursing_sessions" on nursing_sessions
  for update using (is_baby_family_member(baby_id));

create policy "select doctor_appointments" on doctor_appointments
  for select using (is_baby_family_member(baby_id));
create policy "insert doctor_appointments" on doctor_appointments
  for insert with check (is_baby_family_member(baby_id));
create policy "update doctor_appointments" on doctor_appointments
  for update using (is_baby_family_member(baby_id));

create policy "select monitor_events" on monitor_events
  for select using (is_baby_family_member(baby_id));
-- NOTE: no insert policy for monitor_events for regular users —
-- only the server-side API route (using the service_role key, which
-- bypasses RLS) is allowed to write these. This is intentional: the
-- NUC never gets a user login, it authenticates against your own
-- /api/ingest route with a separate device secret (see README).

-- ---------- PUMPING SESSIONS (migration 0002) ----------
-- Expressed milk, tracked separately from feedings/nursing since it's
-- about production, not what she ate. Deliberately NOT gated behind
-- birth_date being set — building a stash usually starts weeks before
-- birth, and the baby row (and its RLS scope) already exists by then.
create table pumping_sessions (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references babies(id) on delete cascade,
  pumped_at timestamptz not null default now(),
  side text not null default 'both' check (side in ('left', 'right', 'both')),
  amount_ml numeric,
  notes text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table pumping_sessions enable row level security;

create policy "select pumping_sessions" on pumping_sessions
  for select using (is_baby_family_member(baby_id));
create policy "insert pumping_sessions" on pumping_sessions
  for insert with check (is_baby_family_member(baby_id));

-- Lets a parent zero out the "in the stash" running total without
-- touching any logged session — history stays intact, only the sum
-- shown on the Milk page changes. Nullable: no reset yet = count
-- everything, same as before this migration existed.
alter table babies add column if not exists pumping_reset_at timestamptz;

-- 0005_grant_authenticated.sql
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;

-- 0006_edit_and_void.sql
-- Editing: these tables could only ever be inserted into before.
create policy "update own babies" on babies
  for update using (is_family_member(family_id));

create policy "update feedings" on feedings
  for update using (is_baby_family_member(baby_id));

create policy "update diaper_changes" on diaper_changes
  for update using (is_baby_family_member(baby_id));

create policy "update pumping_sessions" on pumping_sessions
  for update using (is_baby_family_member(baby_id));

-- Deleting: soft-delete via voided_at instead of a real DELETE, so a
-- baby's care history is marked retracted rather than destroyed.
-- Every read filters these out; nothing needs a DELETE policy.
alter table feedings add column if not exists voided_at timestamptz;
alter table diaper_changes add column if not exists voided_at timestamptz;
alter table nursing_sessions add column if not exists voided_at timestamptz;
alter table sleep_sessions add column if not exists voided_at timestamptz;
alter table pumping_sessions add column if not exists voided_at timestamptz;

-- ---------- DEVICE TOKENS (0007) ----------
-- Tokens por dispositivo. Reemplazan al secreto compartido de /api/ingest y
-- /api/quick/nurse, que no decía de qué familia era nadie (hallazgos C1 y C2,
-- docs/auditorias/2026-09-20-auditoria-inicial.md).
--
-- Numerada en este repo por pedido explícito de Emilio (21 sep 2026), no por
-- el agente del Hub: ver CLAUDE.md §5.2.

-- La FK compuesta de abajo necesita que (id, family_id) sea única en babies.
-- id ya es PK, así que esto no restringe nada nuevo: solo lo hace referenciable.
alter table babies add constraint babies_id_family_id_key unique (id, family_id);

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  -- Scope directo por familia (no por join vía baby_id): fase 2 lo pide así.
  family_id uuid not null references families(id) on delete cascade,
  -- Nulo = vale para toda la familia (el NUC). No nulo = clavado a un bebé.
  baby_id uuid,
  label text not null check (length(btrim(label)) > 0),
  -- NUNCA el token en claro: sha-256 hex.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null
    check (cardinality(scopes) > 0 and scopes <@ array['ingest', 'quick_nurse']::text[]),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Lo que la propuesta intentó con un CHECK que siempre daba verdadero: el bebé
  -- tiene que ser DE ESA familia. Con baby_id nulo la FK no se evalúa.
  constraint device_tokens_baby_in_family
    foreign key (baby_id, family_id) references babies (id, family_id) on delete cascade
);

alter table device_tokens enable row level security;

-- Sin policies, a propósito: nadie la lee desde la app. Solo el servidor
-- (service_role) y `pnpm device-token`.
--
-- Y el revoke hace falta aunque no haya policies: 0005 dejó
-- `alter default privileges ... grant ... to authenticated`, así que esta tabla
-- nació con grants. RLS sin policy ya bloquea las filas; el revoke cierra
-- también la tabla, para que un error de policy futuro no alcance.
revoke all on device_tokens from anon, authenticated;

-- ---------- GROWTH EDIT/VOID (0008) ----------
-- Una medición de crecimiento mal cargada ya no es permanente (hallazgo M3,
-- docs/auditorias/2026-09-20-auditoria-inicial.md). Lo que 0006 hizo para las
-- otras cinco tablas, y dejó afuera a esta.

-- Retractar: borrado lógico, nunca DELETE (CLAUDE.md §5.4).
alter table growth_measurements add column if not exists voided_at timestamptz;

-- Corregir. El WITH CHECK explícito impide mudar la fila a un bebé ajeno
-- (Postgres ya usaría el USING, pero así no depende de acordarse).
create policy "update growth_measurements" on growth_measurements
  for update
  using (is_baby_family_member(baby_id))
  with check (is_baby_family_member(baby_id));

-- Sin GRANT nuevo: 0005 ya otorgó update sobre todas las tablas de public a
-- authenticated. Verificado por el test de integración, no supuesto.
