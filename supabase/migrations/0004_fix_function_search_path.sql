-- Linter flagged both RLS helper functions for a mutable search_path
-- (a hardening issue: a security definer function without a pinned
-- search_path can be tricked by a same-named object in another
-- schema). Pin both to public.
create or replace function is_family_member(fam_id uuid)
returns boolean as $$
  select exists (
    select 1 from family_members
    where family_id = fam_id and user_id = auth.uid()
  );
$$ language sql security definer stable set search_path = public;

create or replace function is_baby_family_member(b_id uuid)
returns boolean as $$
  select exists (
    select 1 from babies
    join family_members on family_members.family_id = babies.family_id
    where babies.id = b_id and family_members.user_id = auth.uid()
  );
$$ language sql security definer stable set search_path = public;
