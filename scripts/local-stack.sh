#!/usr/bin/env bash
# Opera el stack local de Supabase (supabase/docker/). Reemplaza al CLI de
# Supabase, que publica sus puertos en 0.0.0.0 sin forma de evitarlo.
#
#   up      genera las claves la primera vez, levanta y aplica migraciones pendientes
#   down    baja los contenedores (los datos quedan en el volumen)
#   reset   baja, BORRA el volumen y levanta de cero con todas las migraciones
#   env     escribe .env.test y actualiza las 3 claves de Supabase en .env.local
#   psql    abre psql como postgres
#   status  contenedores y puertos (tienen que decir 127.0.0.1)
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=supabase/docker
ENVF=$DIR/.env
dc() { docker compose -f "$DIR/docker-compose.yml" --env-file "$ENVF" "$@"; }
psql_db() { dc exec -T db psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

ensure_keys() {
  if [ ! -f "$ENVF" ]; then
    node scripts/local-stack-keys.mjs > "$ENVF.tmp"
    chmod 600 "$ENVF.tmp"
    mv "$ENVF.tmp" "$ENVF"
    echo "Claves nuevas en $ENVF (gitignored)."
  fi
}

apply_migrations() {
  psql_db -c "create schema if not exists supabase_migrations;
              create table if not exists supabase_migrations.schema_migrations (
                version text primary key, applied_at timestamptz not null default now());"
  for f in supabase/migrations/*.sql; do
    v=$(basename "$f" .sql)
    done_already=$(psql_db -tAc "select 1 from supabase_migrations.schema_migrations where version = '$v'")
    [ "$done_already" = "1" ] && continue
    echo "aplicando $v"
    { echo 'begin;'; cat "$f"; echo;
      echo "insert into supabase_migrations.schema_migrations (version) values ('$v');";
      echo 'commit;'; } | psql_db
  done
  # PostgREST cachea el schema: sin esto no ve las tablas nuevas.
  psql_db -c "notify pgrst, 'reload schema'"
}

get() { grep -E "^$1=" "$ENVF" | cut -d= -f2-; }

write_env() {
  local url=http://127.0.0.1:54321
  {
    echo "SUPABASE_URL=$url"
    echo "SUPABASE_ANON_KEY=$(get ANON_KEY)"
    echo "SUPABASE_SERVICE_ROLE_KEY=$(get SERVICE_ROLE_KEY)"
    echo "SUPABASE_DB_URL=postgresql://postgres:$(get POSTGRES_PASSWORD)@127.0.0.1:54322/postgres"
  } > .env.test
  chmod 600 .env.test
  [ -f .env.local ] || cp .env.local.example .env.local
  sed -i -e "s|^NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$url|" \
         -e "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$(get ANON_KEY)|" \
         -e "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$(get SERVICE_ROLE_KEY)|" .env.local
  chmod 600 .env.local
  echo "Escritos .env.test y las 3 claves de Supabase en .env.local"
}

case "${1:-}" in
  up)     ensure_keys; dc up -d --wait; apply_migrations ;;
  down)   dc down ;;
  reset)  ensure_keys; dc down -v; dc up -d --wait; apply_migrations ;;
  env)    ensure_keys; write_env ;;
  psql)   dc exec db psql -U postgres -d postgres ;;
  status) dc ps --format '{{.Name}}\t{{.Status}}\t{{.Ports}}' ;;
  *) echo "uso: $0 up|down|reset|env|psql|status" >&2; exit 2 ;;
esac
