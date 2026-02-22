#!/usr/bin/env bash
set -euo pipefail

# Phase 1 policy: real XTDB only (external)
XTDB_URL="${XTDB_URL:-http://172.17.0.1:3000}"

curl -fsS "${XTDB_URL}/_xtdb/status" >/dev/null

echo "XTDB reachable at ${XTDB_URL}"
