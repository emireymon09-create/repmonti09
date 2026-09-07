-- =========================================================
-- Amelia App — Migration 0002: pumping sessions
--
-- Expressed milk, tracked separately from feedings/nursing since it's
-- about production, not what she ate. Deliberately NOT gated behind
-- birth_date being set — building a stash usually starts weeks before
-- birth, and the baby row (and its RLS scope) already exists by then.
-- =========================================================

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
