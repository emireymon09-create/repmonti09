-- Corre una sola vez, cuando el volumen de datos está vacío. La imagen de
-- supabase/postgres crea los roles; acá solo les ponemos la contraseña de ESTA
-- máquina (sale de supabase/docker/.env, nunca del repo).
\set pgpass `echo "$POSTGRES_PASSWORD"`
alter user authenticator with password :'pgpass';
alter user supabase_auth_admin with password :'pgpass';
