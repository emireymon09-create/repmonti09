#!/usr/bin/env bash
# Regenerate STEP (CATIA/3DX) + STL (Bambu) from clamp.py
set -euo pipefail
cd "$(dirname "$0")"
python3 clamp.py
echo "STEP → step/   STL → stl/"
