#!/usr/bin/env bash
# Escribe .env.test leyendo el estado REAL del stack local de Supabase.
#
# Las llaves del stack local son de desarrollo y se regeneran con
# `supabase start`, pero .env.test igual va gitignored: un archivo con una
# service_role adentro no entra al repo, sea de la base que sea.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec supabase status -o env \
  | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)=' \
  | sed -e 's/^API_URL=/SUPABASE_URL=/' \
        -e 's/^ANON_KEY=/SUPABASE_ANON_KEY=/' \
        -e 's/^SERVICE_ROLE_KEY=/SUPABASE_SERVICE_ROLE_KEY=/' \
        -e 's/^DB_URL=/SUPABASE_DB_URL=/' \
  > .env.test

echo "Escrito .env.test con $(wc -l < .env.test) variables"
