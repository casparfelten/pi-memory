# Implementation Plan

> What needs to change in the codebase to align with the SSOT (2026-02-23 revision). Each section references the SSOT section it implements. Ordered by dependency — earlier items unblock later ones.

---

## 1) Types — `src/types.ts`

**Implements: SSOT §2.2, §2.3, §2.5, §3.1**

The current types predate the object model. Rewrite to match the document structure defined in the SSOT.

### What changes

**Source binding types** (new):

```typescript
interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string;
}

// Extensible: future source types join this union
type Source = FilesystemSource;
```

**Object envelope** (new — replaces ad-hoc fields):

```typescript
interface ObjectEnvelope {
  'xt/id': string;
  type: ObjectType;
  source: Source | null;
  identity_hash: string;
}
```

**Object types** (update existing):

- `FileObject`: gains `source: FilesystemSource`, `source_hash: string`, `identity_hash: string`. The `id` field is no longer caller-set — it is derived from the identity hash. The `path` field is removed from the mutable payload (it lives in `source.path`). Mutable fields: `content`, `file_type`, `char_count`, `content_hash`.
- `ToolcallObject`: gains `source: null`, `identity_hash: string`. Otherwise unchanged.
- `ChatObject`: gains `source: null`, `identity_hash: string`. Otherwise unchanged.
- `SessionObject`: gains `session_index: string[]` (append-only). Existing `metadata_pool` becomes `string[]` of object IDs (compact — full metadata entries are looked up from the database, not duplicated in the session document). `active_set` and `pinned_set` remain as `string[]`.

**Session wrapper** (updated shape):

```typescript
interface SessionObject {
  'xt/id': string;
  type: 'session';
  source: null;
  identity_hash: string;
  session_id: string;
  chat_ref: string;
  system_prompt_ref: string;
  session_index: string[];    // append-only: every object ID ever encountered
  metadata_pool: string[];    // mutable: object IDs currently visible as metadata
  active_set: string[];       // mutable: object IDs with full content loaded
  pinned_set: string[];       // mutable: explicitly pinned object IDs
}
```

### Decision: metadata pool storage

The current code stores full `MetadataEntry` objects (with path, char_count, file_type, etc.) inside the session document. The new design stores only object IDs in the session document — the client looks up metadata from the object documents themselves. This avoids duplicating mutable fields in two places (the object and the session) and keeps the session document lean. The client caches metadata in memory during a session.

---

## 2) Hashing — `src/hashing.ts`

**Implements: SSOT §2.2**

Currently has three hash functions that mix concerns. Replace with three clearly separated hashes.

### What changes

**`identityHash(type: string, source: Source | null): string`** — SHA-256 of the immutable envelope. For sourced objects: `sha256(stableStringify({type, source}))`. For unsourced: not used (ID is assigned, not derived). Computed once at object creation. Used as `xt/id` for sourced objects.

**`sourceHash(rawBytes: Buffer): string`** — SHA-256 of the raw external source bytes. For a file: hash the file bytes as read from disk. This is distinct from `contentHash` — it hashes the external source, not our document fields. Used for efficient change detection: compare before uploading content.

**`contentHash(mutablePayload: Record<string, unknown>): string`** — SHA-256 of all mutable payload fields via stable serialisation, excluding `source_hash` and `content_hash` itself. When we add new mutable fields, they are automatically included.

**Remove:** `metadataViewHash` (purpose absorbed by `contentHash`) and `objectHash` (purpose split between `identityHash` and `contentHash`). The existing `contentHash(content: string)` is replaced by the new `contentHash(payload)` that covers all mutable fields.

### Decision: sourceHash vs contentHash for files

For file objects, `sourceHash` and a hash of the `content` field will usually be identical (both are SHA-256 of the file's text content). They serve different purposes: `sourceHash` is compared during indexing to avoid unnecessary writes; `contentHash` covers the full document payload (content + char_count + file_type + any future fields). They may diverge if we ever store a processed/transformed version in `content` rather than the raw file, or if type-specific fields change the content hash even when file bytes haven't changed.

---

## 3) Filesystem identity — new module

**Implements: SSOT §5.2, §5.4**

### What to build

A module `src/filesystem.ts` (or similar) with:

**`getDefaultFilesystemId(): string`** — reads `/etc/machine-id` (or falls back to hostname), returns SHA-256. Called once at startup. Represents the primary filesystem namespace.

**`FilesystemResolver`** — a class or set of functions that resolves a file path to a filesystem ID.

```typescript
interface MountMapping {
  pathPrefix: string;       // e.g., "/workspace"
  filesystemId: string;     // the filesystem ID for paths under this prefix
}

class FilesystemResolver {
  constructor(
    private defaultFsId: string,
    private mounts: MountMapping[] = [],
  ) {}

  resolve(absolutePath: string): string {
    // Longest-prefix match against mounts
    // Falls back to defaultFsId
  }
}
```

Optionally, device-ID based detection: on the first `stat` of a file, check `stat().dev`. Cache a mapping from device ID to filesystem ID. If the device differs from the default filesystem's device, assign a new filesystem ID (or use a configured one). This catches bind mounts that weren't explicitly configured.

### Decision: configuration vs auto-detection

Default to auto-detection via `stat().dev` for simplicity. The `stat` call is already happening (for the file watcher). Mount configuration is available as an override for cases where auto-detection doesn't produce the right answer (e.g., bind mounts that share a device ID with the host).

Constructor accepts optional mount mappings. If none provided, all detection is automatic.

---

## 4) Database handler — new module

**Implements: SSOT §5.5**

### What to build

A module `src/indexer.ts` (or method on the extension) that implements the indexing protocol:

```typescript
interface IndexResult {
  objectId: string;
  action: 'created' | 'updated' | 'unchanged';
}

async function indexSourcedObject(
  xtdb: XtdbClient,
  source: Source,
  sourceHash: string,
  content: string | null,
  typeSpecificFields: Record<string, unknown>,
): Promise<IndexResult>
```

Logic:
1. Compute `objectId = identityHash(type, source)`.
2. Fetch current version from XTDB by ID.
3. If not found → create (full document with envelope + payload). Return `created`.
4. If found, compare `sourceHash` against stored `source_hash`.
5. If equal → return `unchanged`.
6. If different → write new version (same envelope, updated payload). Return `updated`.

### Why centralise this

The indexing logic is currently scattered across three methods in the extension (`indexFileFromDisk`, `handleWatcherUpsert`, `reconcileKnownFilesAfterResume`). All three do variations of "read file, build document, write to XTDB." Centralising makes the protocol testable in isolation and ensures all paths go through the same check-then-write logic.

---

## 5) Extension — `src/phase3-extension.ts`

**Implements: SSOT §3, §5.1, §5.5, §5.6**

The main module. Multiple changes, but the external API (activate, deactivate, pin, read, etc.) stays the same.

### What changes

**Constructor** — accept a `FilesystemResolver` (or at minimum a default filesystem ID). Accept optional mount mappings.

**File identity** — replace `file:{path}` with `identityHash('file', {type: 'filesystem', filesystemId, path})`. Use the `FilesystemResolver` to determine filesystem ID for each path.

**Session index** — add `sessionIndex: Set<string>`. Whenever an object enters the metadata pool or is otherwise encountered, add its ID to the session index. The session index is never modified except by addition. Persist as `session_index` in the session wrapper document.

**Metadata pool** — change from `MetadataEntry[]` (with inline path/char_count/etc.) to `Set<string>` of object IDs. Metadata for rendering (path, char_count, file_type) is looked up from the in-memory object cache, which is populated on index/resume.

**Indexing** — replace direct `putAndWait` calls with the database handler (§4). All file indexing goes through `indexSourcedObject`.

**Session persistence** — persist `session_index` alongside `metadata_pool`, `active_set`, `pinned_set`.

**Session resume** — load `session_index` from the persisted session document. For each tracked file in the session index, run the indexing protocol (source hash comparison). This replaces the current mtime-based reconciliation.

**Watcher paths** — the watcher needs to watch actual file paths that the client can access. If the client runs on the host and the agent is sandboxed, the watcher watches host-side paths (for bind mounts) or needs access to the container filesystem (for container-internal files). This is determined by the `FilesystemResolver` and mount configuration.

---

## 6) Context manager — `src/context-manager.ts`

**Implements: SSOT §4**

Minor changes. Can be deferred.

### What changes

- Accept file objects in addition to tool calls (currently toolcall-only in this module; files are handled separately in the extension). The extension and context manager have overlapping pool management — longer term, the context manager should be the single authority on context assembly and the extension should handle indexing and tracking only.
- No structural changes to context assembly logic. The rendering format (METADATA_POOL, ACTIVE_CONTENT blocks) is unchanged.

### Decision: defer this

The extension currently handles both indexing and context assembly for files. The context manager handles tool calls. Merging them is a cleanup, not a prerequisite. Defer until after the object model, hashing, filesystem identity, and indexing protocol are implemented and tested.

---

## 7) Tests

**Existing tests will break** when types and hashing change. Update in the same commit as the code changes.

### Updates to existing tests

- `tests/phase1.test.ts` — update document construction to include source bindings and new hash fields.
- `tests/phase2.test.ts` — minimal changes (context manager tests, mostly toolcall-focused).
- `tests/phase3.test.ts` — update file read/index tests for source-derived identity and source hashing.
- `tests/phase4.test.ts` — update watcher and resume tests. Replace mtime-based reconciliation with hash-based.
- `tests/e2e-final.test.ts` — update for new document structure.

### New tests

- **Identity hash stability:** same source → same object ID. Different filesystem ID → different object ID. Same path, different filesystem → different object.
- **Source hash comparison:** unchanged file → no new version written. Changed file → new version. Verify with XTDB history query.
- **Session index append-only:** deactivate an object → still in session index. Delete a file → still in session index (with null-content latest version).
- **Filesystem resolver:** prefix matching returns correct filesystem IDs. Default fallback works.
- **Indexer protocol:** new source → created. Unchanged → no-op. Changed → updated. Verify each case against real XTDB.

---

## 8) Cleanup

### Remove stale files

- `docs/spec/object-model-draft.md` — superseded by the SSOT. Preserved in git history.

### Update references

- `docs/spec/README.md` — add reference to `implementation-plan.md`.
- `AGENTS.md` — verify "XTDB dependency" section is still accurate after changes.
- Experiment scripts in `scripts/` — will need updates to use the new constructor API (filesystem ID). Can be done after core implementation.

---

## Summary: dependency order

```
1. types.ts          (no deps — pure type definitions)
2. hashing.ts        (depends on types)
3. filesystem.ts     (no deps — utility module)
4. indexer.ts         (depends on types, hashing, xtdb-client)
5. phase3-extension   (depends on all above)
6. tests              (updated alongside each module)
7. context-manager    (deferred — cleanup)
8. cleanup            (after everything works)
```

---

## Migration

Existing XTDB data uses the old document structure. The test/experiment database can be wiped — it's experiment data, not production. For any persistent data that matters, a migration script would read old documents and rewrite them with the new envelope + payload structure. Not needed for development.
