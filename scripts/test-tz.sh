#!/usr/bin/env bash
# La misma suite unitaria bajo cuatro timezones de sistema. Ninguna aserción
# puede depender de la TZ del que mira: la casa se lee siempre en
# America/Los_Angeles. Eso es el contrato de lib/format.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

for tz in UTC America/Los_Angeles Asia/Tokyo Pacific/Kiritimati; do
  echo "--- TZ=$tz ---"
  TZ="$tz" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pnpm exec vitest run tests/unit
done
