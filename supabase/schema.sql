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
$$ language sql security definer stable;

-- Helper: is the current user a member of the family that owns this baby?
create or replace function is_baby_family_member(b_id uuid)
returns boolean as $$
  select exists (
    select 1 from babies
    join family_members on family_members.family_id = babies.family_id
    where babies.id = b_id and family_members.user_id = auth.uid()
  );
$$ language sql security definer stable;

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
