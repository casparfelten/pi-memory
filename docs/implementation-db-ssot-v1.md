# Implementation SSOT v1 — Database (SQLite)

Status: **Canonical DB implementation SSOT (active SQLite implementation contract)**
Date: 2026-03-10

Behavioral authority:
- `docs/intent-ssot-v1.md` (intent semantics)

Implementation-authority rule:
- This is the canonical DB implementation SSOT for v1.
- Context-loading implementation SSOT is defined separately in `docs/implementation-agentic-ssot-v1.md`.
- Both implementation docs must conform to `docs/intent-ssot-v1.md`.

---

## 0) Scope

This implementation SSOT defines the SQLite storage implementation only:
1. physical tables/indexes,
2. transactional write/read behavior,
3. storage query interface (`StoragePort`).

This doc does **not** define context assembly behavior.

---

## 1) Implementation profile (minimal core)

v1 implementation includes:
- immutable object versions,
- global monotonic `tx_seq`,
- per-object monotonic `version_no`,
- idempotent writes,
- explicit structured references,
- session tracking via versioned `session` objects,
- canonical typed envelope fields.

v1 excludes:
- `doc_nodes`,
- interval validity windows,
- field-hash pinning,
- FTS,
- GC APIs.

---

## 2) Core invariants

1. `objects.object_id` is stable identity.
2. `object_versions` rows are immutable after insert.
3. `version_no` is strictly increasing per object.
4. `tx_seq` is strictly increasing globally.
5. At most one HEAD per object (`objects.current_version_id`).
6. `path/session_id/tool_name/status/char_count` are canonical typed envelope fields; for `object_type='session'`, `session_id` is mandatory non-null/non-empty.
7. `content_struct_json` is canonical semantic payload.
8. `metadata_json` is persisted auxiliary payload.
9. `doc_references` rows are derived only from explicit structured refs in `content_struct_json`.
10. Unknown/missing targets do not reject writes; unresolved refs are stored.

---

## 3) SQLite schema

```sql
CREATE TABLE objects (
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

CREATE TABLE object_versions (
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

  -- canonical typed envelope fields (not convenience copies)
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

CREATE TABLE doc_references (
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

CREATE TABLE write_idempotency (
  request_id          TEXT PRIMARY KEY,
  object_id           TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  content_struct_hash TEXT NOT NULL,
  file_bytes_hash     TEXT,
  created_seq         INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TRIGGER trg_session_version_requires_session_id
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
```

---

## 4) Recommended indexes

```sql
CREATE INDEX idx_versions_object_seq_desc ON object_versions(object_id, version_no DESC);
CREATE INDEX idx_versions_object_txseq_desc ON object_versions(object_id, tx_seq DESC);
CREATE INDEX idx_versions_session_id ON object_versions(session_id);
CREATE INDEX idx_versions_path ON object_versions(path);
CREATE INDEX idx_versions_tool_name_status ON object_versions(tool_name, status);

CREATE INDEX idx_refs_from_version_path ON doc_references(from_version_id, from_path);
CREATE INDEX idx_refs_target_object ON doc_references(target_object_id);
CREATE INDEX idx_refs_target_version ON doc_references(target_version_id);
CREATE INDEX idx_refs_target_hash ON doc_references(target_object_hash);
CREATE INDEX idx_refs_mode ON doc_references(mode);
CREATE INDEX idx_refs_resolved ON doc_references(resolved) WHERE resolved = 0;

CREATE INDEX idx_objects_type ON objects(object_type);
CREATE INDEX idx_idempotency_object ON write_idempotency(object_id);
```

---

## 5) Write transaction contract (`putVersion`)

Validation + write flow:

0. Validate session identity requirements:
   - if `objectType='session'` and `sessionId` is null/empty/whitespace, return validation failure `invalid_session_id`.
1. Lookup `write_idempotency` by `request_id`.
   - if present and hashes match (`content_struct_hash`, `file_bytes_hash`): return prior record (`idempotentReplay=true`).
   - if present and mismatch: return conflict `idempotency_mismatch`.
2. Ensure object row exists in `objects` (insert on first write).
3. If `expectedCurrentVersionId` provided and differs from current head: return `version_conflict`.
4. Compute `nextVersionNo = coalesce(max(version_no),0)+1` for object.
5. Validate typed-envelope vs payload consistency for canonical fields when both are present.
6. Insert `object_versions` row (new immutable version).
7. Replace `objects.current_version_id` and update `updated_seq/updated_at`.
8. Extract/validate explicit refs from payload, rebuild `doc_references` rows for the new version.
9. Compute/store `refs_hash` deterministically from inserted refs.
10. Insert `write_idempotency` row.
11. Commit and return success.

Ordering rule:
- session identity validation runs before transactional write steps,
- idempotency decision happens before optimistic conflict checks.

---

## 6) Reference extraction contract

### 6.1 Canonical source

Only explicit `Ref` objects in declared ref-bearing payload fields are extracted.
No free-text parsing.

### 6.2 Minimal `Ref` runtime contract

```ts
interface Ref {
  target_object_id: string;
  mode: 'dynamic' | 'pinned';
  target_version_id?: string;
  target_object_hash?: string;
  ref_kind: string;
  ref_metadata?: Record<string, unknown>;
}
```

Pinned refs must have `target_version_id` or `target_object_hash`.

### 6.3 Stored fields per extracted ref

Each extracted ref yields one `doc_references` row with:
- `from_version_id`
- `from_path`
- target anchor fields
- `ref_kind`, `mode`, `resolved`
- optional metadata JSON

`resolved = 1` iff `target_object_id` exists at write time.

### 6.4 Deterministic `refs_hash`

`refs_hash` is computed from canonical serialization of extracted refs sorted by:
`(from_path, ref_kind, target_object_id, coalesce(target_version_id,''), coalesce(target_object_hash,''), mode)`.

---

## 7) Session realization

Sessions are represented as `object_type='session'` versions.

Required session payload shape:

```ts
interface SessionContent {
  chat_ref: Ref;
  system_prompt_ref?: Ref;
  active_set: Ref[];
  inactive_set: Ref[];
  pinned_set: Ref[];
}
```

`session_id` typed envelope column is canonical session identity anchor across versions and is required non-null/non-empty for `session` writes.

No separate mutable session-state table is canonical in this profile.

---

## 8) Hash contract realization

Per version, store:
- `content_struct_hash`
- `file_bytes_hash` (nullable)
- `metadata_hash`
- `refs_hash`
- `object_hash`

`object_hash` preimage:

```text
H("v1|object_id|version_no|content_struct_hash|file_bytes_hash|metadata_hash|refs_hash")
```

---

## 9) StoragePort boundary (minimal)

```ts
export type ObjectType = 'file' | 'toolcall' | 'chat' | 'session' | 'system_prompt';
export type WriterKind = 'client' | 'watcher' | 'system';
export type WriteReason = 'manual' | 'watcher_sync' | 'import' | 'system';
export type ReferenceMode = 'dynamic' | 'pinned';

export interface VersionWriteInput {
  requestId: string;

  objectId: string;
  objectType: ObjectType;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStruct: unknown;
  fileBytes?: Uint8Array | null;

  path?: string | null;
  // required and non-empty when objectType='session'
  sessionId?: string | null;
  toolName?: string | null;
  status?: string | null;
  charCount?: number | null;

  metadata: Record<string, unknown>;

  expectedCurrentVersionId?: string;
  txTime?: string;
}

export interface VersionRecord {
  txSeq: number;
  versionId: string;
  objectId: string;
  versionNo: number;

  txTime: string;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStructJson: string;
  fileBytesHash: string | null;

  path: string | null;
  sessionId: string | null;
  toolName: string | null;
  status: string | null;
  charCount: number | null;

  metadataJson: string;

  contentStructHash: string;
  metadataHash: string;
  refsHash: string;
  objectHash: string;
}

export interface ReferenceRecord {
  refId: string;
  fromVersionId: string;
  fromPath: string;

  targetObjectId: string;
  targetVersionId?: string;
  targetObjectHash?: string;

  refKind: string;
  mode: ReferenceMode;
  resolved: boolean;
  refMetadataJson?: string;
}

export interface StoragePort {
  putVersion(input: VersionWriteInput): Promise<
    | { ok: true; record: VersionRecord; idempotentReplay: boolean }
    | { ok: false; validation: true; reason: 'invalid_session_id' }
    | { ok: false; conflict: true; reason: 'version_conflict' | 'idempotency_mismatch' }
  >;

  getLatest(objectId: string): Promise<VersionRecord | null>;
  getHistory(objectId: string, order?: 'asc' | 'desc'): Promise<VersionRecord[]>;

  queryReferences(params: {
    fromVersionId?: string;
    fromPathPrefix?: string;
    targetObjectId?: string;
    targetVersionId?: string;
    targetObjectHash?: string;
    mode?: ReferenceMode;
    resolved?: boolean;
    limit?: number;
  }): Promise<ReferenceRecord[]>;

  getReferrersByTargetVersion(
    targetVersionId: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;

  getReferrersByTargetHash(
    targetObjectHash: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;
}
```

---

## 10) Out-of-scope for this DB implementation profile

Not part of this canonical DB v1 profile:
- `doc_nodes` and any structural tree rebuild APIs,
- temporal interval APIs (`getAsOf`, validity windows),
- `gcDryRun`/GC execution APIs,
- full-text search APIs.

---

## 11) Cross-doc references

- Intent authority: `docs/intent-ssot-v1.md`
- Agentic/context-loading implementation: `docs/implementation-agentic-ssot-v1.md`
- Historical/non-normative snapshots: `docs/archive/`
