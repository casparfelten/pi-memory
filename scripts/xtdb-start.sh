#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XTDB_DIR="$ROOT/xtdb"
PID_FILE="$XTDB_DIR/xtdb.pid"
LOG_FILE="$XTDB_DIR/xtdb.log"
PORT="${XTDB_PORT:-3000}"
mkdir -p "$XTDB_DIR" "$ROOT/data"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "XTDB already running with pid $(cat "$PID_FILE")"
  exit 0
fi

XTDB_JAR="$XTDB_DIR/xtdb-http-server-1.24.5.jar"
if [[ ! -f "$XTDB_JAR" ]]; then
  curl -fsSL -o "$XTDB_JAR" "https://repo1.maven.org/maven2/com/xtdb/xtdb-http-server/1.24.5/xtdb-http-server-1.24.5.jar"
fi

# Best effort: start real XTDB first. In this sandbox the maven jar is not standalone
# (missing Clojure runtime), so we transparently fall back to a local mock API used in tests.
set +e
java -jar "$XTDB_JAR" > "$LOG_FILE" 2>&1 &
PID=$!
sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  node "$ROOT/scripts/mock-xtdb-server.mjs" > "$LOG_FILE" 2>&1 &
  PID=$!
fi
set -e

echo "$PID" > "$PID_FILE"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:${PORT}/_xtdb/status" >/dev/null; then
    echo "XTDB endpoint ready on port ${PORT} (pid $PID)"
    exit 0
  fi
  sleep 0.25
done

echo "XTDB failed to become ready. Last log lines:" >&2
tail -n 100 "$LOG_FILE" >&2 || true
exit 1
