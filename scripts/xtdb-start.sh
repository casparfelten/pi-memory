#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XTDB_DIR="$ROOT/xtdb"
DATA_DIR="$ROOT/data"
PID_FILE="$XTDB_DIR/xtdb.pid"
LOG_FILE="$XTDB_DIR/xtdb.log"
PORT="${XTDB_PORT:-3000}"
mkdir -p "$XTDB_DIR" "$DATA_DIR"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "XTDB already running with pid $(cat "$PID_FILE")"
  exit 0
fi

# Pre-built standalone JARs from GitHub releases
XTDB_VERSION="1.24.3"
XTDB_ROCKSDB_JAR="$XTDB_DIR/xtdb-standalone-rocksdb.jar"
XTDB_INMEM_JAR="$XTDB_DIR/xtdb-in-memory.jar"

# Try RocksDB first (persistent), fall back to in-memory
XTDB_JAR=""
XTDB_MODE=""

if [[ -f "$XTDB_ROCKSDB_JAR" ]] || [[ "${XTDB_PREFER_INMEM:-}" != "1" ]]; then
  if [[ ! -f "$XTDB_ROCKSDB_JAR" ]]; then
    echo "Downloading XTDB standalone (RocksDB) v${XTDB_VERSION}..."
    curl -fsSL -o "$XTDB_ROCKSDB_JAR" \
      "https://github.com/xtdb/xtdb/releases/download/${XTDB_VERSION}/xtdb-standalone-rocksdb.jar" || true
  fi
  if [[ -f "$XTDB_ROCKSDB_JAR" ]]; then
    XTDB_JAR="$XTDB_ROCKSDB_JAR"
    XTDB_MODE="rocksdb"
  fi
fi

# In-memory fallback (or explicit preference)
if [[ -z "$XTDB_JAR" ]] || [[ "${XTDB_PREFER_INMEM:-}" == "1" ]]; then
  if [[ ! -f "$XTDB_INMEM_JAR" ]]; then
    echo "Downloading XTDB standalone (in-memory) v${XTDB_VERSION}..."
    curl -fsSL -o "$XTDB_INMEM_JAR" \
      "https://github.com/xtdb/xtdb/releases/download/${XTDB_VERSION}/xtdb-in-memory.jar"
  fi
  XTDB_JAR="$XTDB_INMEM_JAR"
  XTDB_MODE="in-memory"
fi

echo "Starting XTDB ($XTDB_MODE) on port $PORT..."

if [[ "$XTDB_MODE" == "rocksdb" ]]; then
  XTDB_EDN="$XTDB_DIR/xtdb.edn"
  cat > "$XTDB_EDN" <<EOF
{:xtdb.http-server/server {:port ${PORT}}
 :xtdb/index-store {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                                :db-dir "${DATA_DIR}/idx"}}
 :xtdb/document-store {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                                   :db-dir "${DATA_DIR}/docs"}}
 :xtdb/tx-log {:kv-store {:xtdb/module xtdb.rocksdb/->kv-store
                           :db-dir "${DATA_DIR}/txs"}}}
EOF
  java -jar "$XTDB_JAR" -f "$XTDB_EDN" > "$LOG_FILE" 2>&1 &
else
  java -jar "$XTDB_JAR" > "$LOG_FILE" 2>&1 &
fi
PID=$!
echo "$PID" > "$PID_FILE"

# Wait for XTDB to become ready
for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:${PORT}/_xtdb/status" >/dev/null 2>&1; then
    echo "XTDB ready on port ${PORT} (pid $PID)"
    exit 0
  fi
  sleep 0.5
done

echo "XTDB failed to become ready within 30s. Last log lines:" >&2
tail -n 50 "$LOG_FILE" >&2 || true
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1
