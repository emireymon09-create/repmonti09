-- Fix: RLS policies existed on every public table, but the `authenticated`
-- role was never granted base table privileges (only REFERENCES/TRIGGER/
-- TRUNCATE existed by default). Without a GRANT, Postgres blocks access
-- before RLS is even evaluated, so every query from the app returned
-- nothing regardless of how correct the RLS policies/data were.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
