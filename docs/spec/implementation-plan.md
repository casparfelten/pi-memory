# Implementation Plan

> Aligns codebase with SSOT (2026-02-24). Ordered by dependency.

---

## 1) Types — `src/types.ts`

**SSOT §2.2, §2.3, §2.6, §3.1**

```typescript
// --- Source bindings ---

interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string;  // canonical
}

type Source = FilesystemSource;

// --- Envelope ---

type ObjectType = 'file' | 'toolcall' | 'chat' | 'system_prompt' | 'session';

interface ObjectEnvelope {
  'xt/id': string;
  type: ObjectType;
  source: Source | null;
  identity_hash: string;
}

// --- Hashes (on all mutable payloads) ---

interface ObjectHashes {
  file_hash: string | null;   // sourced files only
  content_hash: string | null; // null if content is null
  metadata_hash: string;       // always computable
  object_hash: string;         // composite
}

// --- Content objects ---

interface FileObject extends ObjectEnvelope, ObjectHashes {
  type: 'file';
  source: FilesystemSource;
  content: string | null;
  file_type: string;
  char_count: number;
}

interface ToolcallObject extends ObjectEnvelope, ObjectHashes {
  type: 'toolcall';
  source: null;
  content: string;
  tool: string;
  args: Record<string, unknown>;
  args_display?: string;
  status: 'ok' | 'fail';
  chat_ref: string;
  file_refs?: string[];
}

// --- Infrastructure objects ---

interface ChatObject extends ObjectEnvelope, ObjectHashes {
  type: 'chat';
  source: null;
  content: string;
  turns: Turn[];
  session_ref: string;
  turn_count: number;
  toolcall_refs: string[];
}

interface SystemPromptObject extends ObjectEnvelope, ObjectHashes {
  type: 'system_prompt';
  source: null;
  content: string;
}

interface SessionObject extends ObjectEnvelope, ObjectHashes {
  type: 'session';
  source: null;
  content: null;
  session_id: string;
  chat_ref: string;
  system_prompt_ref: string;
  session_index: string[];
  metadata_pool: string[];
  active_set: string[];
  pinned_set: string[];
}
```

**Removed:** `locked`, `provenance`, `nickname`, `id` (use `xt/id`), old hash fields.

**metadata_pool stores IDs only.** Client looks up metadata from DB or in-memory cache.

---

## 2) Hashing — `src/hashing.ts`

**SSOT §2.4**

Five functions, no overlap:

```typescript
// Immutable identity
function identityHash(type: string, source: Source | null, assignedId?: string): string {
  if (source) return sha256(stableStringify({ type, source }));
  return sha256(stableStringify({ type, 'xt/id': assignedId }));
}

// External source (raw file bytes)
function fileHash(content: string): string {
  return sha256(content);  // UTF-8 string
}

// Stored content field
function contentHash(content: string | null): string | null {
  if (content === null) return null;
  return sha256(content);
}

// Type-specific fields (explicit field list per type)
function metadataHash(typeSpecificFields: Record<string, unknown>): string {
  return sha256(stableStringify(typeSpecificFields));
}

// Composite
function objectHash(fh: string | null, ch: string | null, mh: string): string {
  return sha256(stableStringify({ file_hash: fh, content_hash: ch, metadata_hash: mh }));
}
```

**metadataHash input per type:**

| Type | Fields included |
|------|----------------|
| `file` | `file_type`, `char_count` |
| `toolcall` | `tool`, `args`, `args_display`, `status`, `chat_ref`, `file_refs` |
| `chat` | `turns`, `session_ref`, `turn_count`, `toolcall_refs` |
| `system_prompt` | *(none — metadata_hash is SHA-256 of empty object)* |
| `session` | `session_id`, `chat_ref`, `system_prompt_ref`, `session_index`, `metadata_pool`, `active_set`, `pinned_set` |

The field list is explicit per type. No dynamic exclusion — each type declares which fields are "metadata." This avoids ambiguity about what's included.

**Removed:** old `contentHash(string)`, `metadataViewHash`, `objectHash`.

---

## 3) Filesystem resolver — `src/filesystem.ts`

**SSOT §5.2, §5.3, §5.4**

```typescript
interface MountMapping {
  agentPrefix: string;      // e.g., "/workspace"
  canonicalPrefix: string;  // e.g., "/home/abaris/.openclaw/workspaces/dev"
  filesystemId: string;     // host FS ID
  writable: boolean;        // from docker inspect RW field
}

interface ResolvedPath {
  filesystemId: string;
  canonicalPath: string;
  isMounted: boolean;       // true = bind mount, false = container-internal
}

class FilesystemResolver {
  constructor(
    private defaultFsId: string,    // container overlay FS ID
    private hostFsId: string,       // host FS ID
    private mounts: MountMapping[],  // sorted by prefix length desc
  ) {}

  resolve(agentPath: string): ResolvedPath { /* longest prefix match */ }
  reverseResolve(canonicalPath: string): string { /* canonical → agent-visible */ }
  isWatchable(agentPath: string): boolean { /* true if mounted (host-accessible) */ }
}

// Build resolver from docker inspect output
async function buildResolver(containerId: string): Promise<FilesystemResolver> {
  // 1. docker inspect {containerId} → parse Mounts array
  // 2. For each bind mount: { agentPrefix: Destination, canonicalPrefix: Source, ... }
  // 3. Host FS ID from host /etc/machine-id
  // 4. Container FS ID from container /etc/machine-id or containerId hash
  // 5. Return new FilesystemResolver(containerFsId, hostFsId, mounts)
}

// Fallback: build from /proc/self/mountinfo inside sandbox
async function buildResolverFromMountinfo(execInSandbox: (cmd: string) => Promise<string>): Promise<FilesystemResolver> {
  // 1. exec 'cat /proc/self/mountinfo' → parse bind mount lines
  // 2. Identify host device from mount entries
  // 3. Build mount mappings from field 4 (host path) + field 5 (container path)
}

// No-sandbox case
function buildPassthroughResolver(): FilesystemResolver {
  // Single FS ID, no mounts, resolve() returns path unchanged
}
```

Three construction paths: docker inspect (primary), mountinfo parsing (fallback), passthrough (no sandbox). The resolver itself is the same regardless of how it was built.

---

## 4) Indexer — `src/indexer.ts`

**SSOT §5.6**

```typescript
type IndexAction = 'created' | 'updated' | 'unchanged';
interface IndexResult { objectId: string; action: IndexAction; }

// Full indexing (content available)
async function indexFile(
  xtdb: XtdbClient,
  source: FilesystemSource,
  content: string,
): Promise<IndexResult> {
  const objectId = identityHash('file', source);
  const fh = fileHash(content);
  const existing = await xtdb.get(objectId);

  if (!existing) {
    await xtdb.putAndWait(buildFileDoc(objectId, source, content, fh));
    return { objectId, action: 'created' };
  }
  if (existing.file_hash === fh) {
    return { objectId, action: 'unchanged' };
  }
  await xtdb.putAndWait(buildFileDoc(objectId, source, content, fh));
  return { objectId, action: 'updated' };
}

// Discovery (path only)
async function discoverFile(
  xtdb: XtdbClient,
  source: FilesystemSource,
): Promise<IndexResult> {
  const objectId = identityHash('file', source);
  const existing = await xtdb.get(objectId);
  if (existing) return { objectId, action: 'unchanged' };

  await xtdb.putAndWait(buildStubDoc(objectId, source));
  return { objectId, action: 'created' };
}

// Deletion
async function indexFileDeletion(
  xtdb: XtdbClient,
  source: FilesystemSource,
): Promise<IndexResult> {
  const objectId = identityHash('file', source);
  await xtdb.putAndWait(buildDeletedDoc(objectId, source));
  return { objectId, action: 'updated' };
}
```

`buildFileDoc` constructs full document with all five hashes. `buildStubDoc` uses null for file_hash, content_hash, content. `buildDeletedDoc` uses null content, null content_hash, null file_hash.

---

## 5) Extension — `src/phase3-extension.ts`

**SSOT §3, §5**

### Constructor

```typescript
constructor(
  sessionId: string,
  xtdbBaseUrl: string,
  resolver: FilesystemResolver,
  systemPrompt?: string,
)
```

### Content/infrastructure split

Chat and system_prompt are NOT in session index, metadata pool, or active set. Created and updated internally. Referenced by `chat_ref` and `system_prompt_ref` on the session document. No `locked` checks anywhere.

### Session index

`sessionIndex: Set<string>` — content object IDs only. Append-only. Persisted.

### Metadata pool

`metadataPool: Set<string>` — content object IDs only. Client maintains in-memory cache:

```typescript
interface MetadataCache {
  type: 'file' | 'toolcall';
  displayPath?: string;     // reverse-translated, files only
  file_type?: string;
  char_count?: number;
  tool?: string;
  status?: string;
  isStub?: boolean;         // file_hash is null
}
```

### Indexing integration

All file operations go through the indexer module. Session set updates depend on trigger:

- **Agent read → `indexFile`** → add to session index + metadata pool + active set.
- **Discovery (ls, grep, etc.) → `discoverFile`** → add to session index + metadata pool only.
- **Watcher event → `indexFile`** → update metadata cache only. Do NOT change session sets.
- **Resume reconciliation → `indexFile`** → sets already restored. Update cache only.

### Watcher setup

Watch canonical path via `resolver.resolve()`. Only if `resolver.isWatchable()`. Container-internal paths: no watcher.

### Activation of stubs

`activate(id)`: if object is a file with `file_hash === null` (stub), read source at canonical path, call `indexFile` to upgrade, then load content. If source inaccessible, activation fails (stays in metadata with `[unread]`).

### Session persistence

Session document: `session_index`, `metadata_pool`, `active_set`, `pinned_set` as `string[]`.

### Session resume

1. Fetch session document → restore sets.
2. Batch-fetch all objects in session index.
3. Reconcile sourced objects (file_hash comparison). Stubs for accessible files get upgraded.
4. Rebuild metadata cache.
5. Re-establish watchers.

---

## 6) Context manager — `src/context-manager.ts`

**Deferred.** Extension handles file context; context-manager handles toolcalls. Merge later.

---

## 7) Tests

### Existing (update)

All suites: new types, 5 hashes, no locked/provenance/nickname.

### New

- **Hash hierarchy:** file_hash, content_hash, metadata_hash computed correctly. object_hash is composite.
- **Content/infrastructure:** chat not in session index. Toolcalls are.
- **Identity:** same source → same ID. Different FS → different ID.
- **Indexing:** created, unchanged, updated. Stub → full upgrade.
- **Discovery:** stub created with null content/file_hash. Discovery doesn't overwrite existing.
- **Stub activation:** triggers read. Stub metadata shows `[unread]`.
- **Watcher update:** doesn't change session sets.
- **Resolver:** forward translation, reverse translation, watchability.

---

## 8) Cleanup

Remove: `locked`, `provenance`, `nickname`, `id`, `mtime_ms`, old hash functions, chat/system_prompt in active set.

---

## Dependency order

```
1. types.ts          (pure definitions)
2. hashing.ts        (depends on types)
3. filesystem.ts     (standalone utility)
4. indexer.ts         (depends on 1, 2, xtdb-client)
5. phase3-extension   (depends on all above)
6. tests              (alongside each module)
7. context-manager    (deferred)
8. cleanup
```
