export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS objects (
  object_id           TEXT PRIMARY KEY,
  object_type         TEXT NOT NULL CHECK (object_type IN ('file','toolcall','chat','session','system_prompt')),
  locked              INTEGER NOT NULL DEFAULT 0,
  nickname            TEXT,
  created_seq         INTEGER NOT NULL,
  updated_seq         INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  current_version_id  TEXT,
  FOREIGN KEY (current_version_id) REFERENCES object_versions(version_id)
);

CREATE TABLE IF NOT EXISTS object_versions (
  tx_seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id          TEXT NOT NULL UNIQUE,
  object_id           TEXT NOT NULL,
  version_no          INTEGER NOT NULL,

  tx_time             TEXT NOT NULL,

  writer_id           TEXT NOT NULL,
  writer_kind         TEXT NOT NULL CHECK (writer_kind IN ('client','watcher','system')),
  write_reason        TEXT NOT NULL CHECK (write_reason IN ('manual','watcher_sync','import','system')),

  content_struct_json TEXT NOT NULL,
  file_bytes_blob     BLOB,

  path                TEXT,
  session_id          TEXT CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
  tool_name           TEXT,
  status              TEXT,
  char_count          INTEGER,

  metadata_json       TEXT NOT NULL,

  content_struct_hash TEXT NOT NULL,
  file_bytes_hash     TEXT,
  metadata_hash       TEXT NOT NULL,
  refs_hash           TEXT NOT NULL,
  object_hash         TEXT NOT NULL,
  hash_algo           TEXT NOT NULL DEFAULT 'sha256',
  hash_schema_version INTEGER NOT NULL DEFAULT 1,

  CHECK (json_valid(content_struct_json)),
  CHECK (json_valid(metadata_json)),

  FOREIGN KEY (object_id) REFERENCES objects(object_id),
  UNIQUE (object_id, version_no)
);

CREATE TABLE IF NOT EXISTS doc_references (
  ref_id              TEXT PRIMARY KEY,

  from_version_id     TEXT NOT NULL,
  from_path           TEXT NOT NULL,

  target_object_id    TEXT NOT NULL,
  target_version_id   TEXT,
  target_object_hash  TEXT,

  ref_kind            TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('dynamic', 'pinned')),
  resolved            INTEGER NOT NULL CHECK (resolved IN (0,1)),
  ref_metadata_json   TEXT,

  CHECK (ref_metadata_json IS NULL OR json_valid(ref_metadata_json)),
  CHECK (mode != 'pinned' OR target_version_id IS NOT NULL OR target_object_hash IS NOT NULL),

  FOREIGN KEY (from_version_id) REFERENCES object_versions(version_id)
);

CREATE TABLE IF NOT EXISTS write_idempotency (
  request_id          TEXT PRIMARY KEY,
  object_id           TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  content_struct_hash TEXT NOT NULL,
  file_bytes_hash     TEXT,
  created_seq         INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_session_version_requires_session_id
BEFORE INSERT ON object_versions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM objects o
  WHERE o.object_id = NEW.object_id
    AND o.object_type = 'session'
)
AND (NEW.session_id IS NULL OR length(trim(NEW.session_id)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid_session_id');
END;
`;

export const SQLITE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_versions_object_seq_desc ON object_versions(object_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_versions_object_txseq_desc ON object_versions(object_id, tx_seq DESC);
CREATE INDEX IF NOT EXISTS idx_versions_session_id ON object_versions(session_id);
CREATE INDEX IF NOT EXISTS idx_versions_path ON object_versions(path);
CREATE INDEX IF NOT EXISTS idx_versions_tool_name_status ON object_versions(tool_name, status);

CREATE INDEX IF NOT EXISTS idx_refs_from_version_path ON doc_references(from_version_id, from_path);
CREATE INDEX IF NOT EXISTS idx_refs_target_object ON doc_references(target_object_id);
CREATE INDEX IF NOT EXISTS idx_refs_target_version ON doc_references(target_version_id);
CREATE INDEX IF NOT EXISTS idx_refs_target_hash ON doc_references(target_object_hash);
CREATE INDEX IF NOT EXISTS idx_refs_mode ON doc_references(mode);
CREATE INDEX IF NOT EXISTS idx_refs_resolved ON doc_references(resolved) WHERE resolved = 0;

CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(object_type);
CREATE INDEX IF NOT EXISTS idx_idempotency_object ON write_idempotency(object_id);
`;
