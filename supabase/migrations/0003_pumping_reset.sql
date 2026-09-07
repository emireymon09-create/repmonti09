-- Lets a parent zero out the "in the stash" running total without
-- touching any logged session — history stays intact, only the sum
-- shown on the Milk page changes. Nullable: no reset yet = count
-- everything, same as before this migration existed.
alter table babies add column if not exists pumping_reset_at timestamptz;
