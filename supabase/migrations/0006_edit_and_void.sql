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
