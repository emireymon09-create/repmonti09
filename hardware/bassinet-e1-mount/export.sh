#!/usr/bin/env bash
# Re-export STLs from clamp.scad (needs openscad on PATH).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p stl
for p in top_half bottom_half tpu_liner; do
  echo "exporting $p…"
  openscad -o "stl/${p}.stl" -D "part=\"${p}\"" clamp.scad
done
echo "done → stl/"
