# Context Manager SSOT (Single Source of Truth)

> **Authoritative document.** This is the canonical specification for the project's design, data model, and implementation status. If any other document conflicts with this one, this SSOT wins until explicitly updated.

---

## 1) Fundamentals

### 1.1 Problem

LLM agents lose continuity in long tasks because context windows are limited and tool outputs/files are repeatedly re-injected as raw text. This causes context bloat, drift, and inconsistent behaviour across turns.

### 1.2 Goals

- Provide a **context manager layer** — not just a memory bucket, but active control over what an LLM sees each turn.
- Let agents operate over **objects and references** instead of repeated full-text re-reading.
- Keep context controllable through explicit **activation and deactivation**.
- Preserve reproducibility with version-aware references and durable history.
- Support **multiple agents** sharing a database without interference, and **portable sessions** that can be paused, moved, and resumed.

### 1.3 Principles

- **Separation of concerns.** The host harness runs the agent loop, tools, and UI. This layer controls the LLM-visible context.
- **Metadata first.** Inactive objects remain visible via compact metadata summaries. The agent browses metadata broadly and activates narrowly.
- **Explicit context logistics.** Active content is a deliberate subset, not everything ever seen.
- **Store rich, render adapted.** Preserve structured internal state; adapt at the model/harness boundary.
- **Append-only history.** Objects accumulate versions. Deletions and orphaning create new versions (null content, tombstone state). History is never erased.

### 1.4 Invariants

- Objects have stable identity and version history.
- Chat history remains present as canonical conversation state.
- Tool result payloads are separate from chat inline metadata references.
- Active/inactive transitions change what content is loaded, not object identity.
- Session index is append-only. Objects are never removed from a session's index once encountered.

---

## 2) Data Model

### 2.1 Objects

An **object** is a versioned entity in the database. Every object has a stable ID, a type, and a version history. XTDB's bi-temporal store provides the versioning: every write creates a new version; the full history is queryable.

Objects come in two kinds:

**Sourced objects** are bound to an external thing — a file on a filesystem, an S3 object (future), a git blob (future). The source binding defines what the object tracks and is part of its permanent identity.

**Unsourced objects** exist only in the database. Tool call results, chat records, session state. No external source to watch. Created directly by the client (not via the indexing protocol).

### 2.2 Object document structure

Every object document stored in XTDB has two zones:

**Immutable envelope** — set at creation, never changes across versions:

| Field | Description |
|-------|-------------|
| `xt/id` | Object ID. For sourced objects, derived from identity hash. For unsourced, assigned at creation (e.g., `chat:{sessionId}`, tool call ID). |
| `type` | Object type: `file`, `toolcall`, `chat`, `system_prompt`, `session`. |
| `source` | Source binding. `null` for unsourced objects. Tagged union by source type (see §2.3). |
| `identity_hash` | SHA-256 of the immutable envelope fields (type + source). Computed once. Verifies identity consistency. |

**Mutable payload** — creates a new version when changed:

| Field | Description |
|-------|-------------|
| `content` | The payload. String or null (null for deleted/orphaned/non-text). |
| `source_hash` | SHA-256 of the raw external source (e.g., file bytes on disk). Only present for sourced objects. Used for change detection during indexing (see §5.6). |
| `content_hash` | SHA-256 of all other mutable payload fields (everything except `source_hash` and `content_hash` itself). Detects document-level changes. See below for exact scope. |
| *(type-specific fields)* | Additional mutable fields depending on object type — see §2.5 for per-type fields. |

No `locked`, `provenance`, or `nickname` fields. Locking is type-determined (§3.3). Provenance is captured by the source binding (for sourced objects) or type-specific fields (for unsourced objects). Nicknames are not stored — the path or tool name serves this purpose.

**Hashes — purposes and scope:**

| Hash | Answers | Input | When computed |
|------|---------|-------|--------------|
| `identity_hash` | Is this the same object? | Immutable envelope: `type` + `source` | Once at creation. Never changes. |
| `source_hash` | Has the external source changed? | Raw source bytes (e.g., file on disk). Not our document — the external thing itself. | Each indexing check. Compared against stored value. |
| `content_hash` | Has the document payload changed? | All mutable payload fields except `source_hash` and `content_hash`, via stable serialisation. | Each write. Covers `content`, type-specific fields, and any future mutable fields. |

`content_hash` explicitly excludes `source_hash` and itself from its input. This avoids circular dependency: `source_hash` is a property of the external source, not of the document payload. When we add new mutable fields in the future, they are automatically included in `content_hash` because the stable serialisation covers all fields not explicitly excluded.

### 2.3 Source bindings

The `source` field is a tagged union. The `type` field determines which source-specific fields are required.

**Filesystem source** (implemented):

```json
{
  "type": "filesystem",
  "filesystemId": "a1b2c3...",
  "path": "/home/abaris/project/src/main.ts"
}
```

- `filesystemId` — identifies the filesystem namespace (see §5.4).
- `path` — **canonical** absolute path within that filesystem namespace. This is the path as seen from the filesystem itself, not necessarily the path the agent uses. For bind-mounted directories, this is the host-side path, not the container-side path. See §5.3 for path translation.

**Future source types** (not yet implemented, shown for extensibility):

```json
{ "type": "s3", "bucket": "my-bucket", "key": "data/file.csv" }
{ "type": "git", "repo": "github.com/user/repo", "ref": "main", "path": "src/lib.ts" }
```

Each source type determines:
- What fields are required in the source binding.
- How the source hash is computed (file bytes for filesystem, etag for S3, blob hash for git).
- What tracking infrastructure applies (file watcher, S3 poller, webhook listener).

New source types extend the union. Existing source type schemas are stable once defined.

### 2.4 Object identity

**Sourced objects:** identity is derived from the source binding. The object ID is `SHA-256(stableStringify({type, source}))`. Two clients indexing the same source (same filesystem ID, same canonical path) produce the same identity hash and therefore resolve to the same object. This is how multi-agent access to the same file resolves to a single versioned object.

**Unsourced objects:** identity is assigned at creation. Tool calls use their call ID. Chat objects use `chat:{sessionId}`. Session objects use `session:{sessionId}`. System prompt objects use `system_prompt:{sessionId}`.

**The identity rule:** if agent A changes it and agent B inherently sees the change (same file on the same filesystem, same S3 object, etc.), it is the same object. If they are on separate filesystems such that changes don't propagate, they are different objects with different IDs, even if the path string is identical.

### 2.5 Object types

**`file`** — sourced (filesystem). Represents a file on disk.

| Mutable field | Description |
|--------------|-------------|
| `content` | File text content, or null if deleted/non-text/orphaned. |
| `file_type` | File extension (e.g., `ts`, `md`). Derived from source path. |
| `char_count` | Length of content string. 0 if content is null. |

The file's canonical path is in the immutable source binding (`source.path`), not in the mutable payload.

**`toolcall`** — unsourced. Result of a tool execution. Created once, never updated (single version).

| Mutable field | Description |
|--------------|-------------|
| `content` | Tool output text. |
| `tool` | Tool name (e.g., `bash`, `read`, `write`). |
| `args` | Tool arguments (JSON object). |
| `args_display` | Optional human-readable args summary. |
| `status` | `ok` or `fail`. |
| `chat_ref` | ID of the chat object this tool call belongs to. |
| `file_refs` | Optional list of file object IDs referenced by this tool call. |

**`chat`** — unsourced. Locked (type-determined, see §3.3). One per session. New version each turn.

| Mutable field | Description |
|--------------|-------------|
| `content` | Rendered chat text (may be empty if turns are stored in the `turns` array). |
| `turns` | Array of turn objects (user message, assistant response, tool call IDs, assistant metadata). |
| `session_ref` | ID of the parent session object. |
| `turn_count` | Number of turns. |
| `toolcall_refs` | All tool call object IDs across all turns. |

**`system_prompt`** — unsourced. Locked (type-determined). One per session.

| Mutable field | Description |
|--------------|-------------|
| `content` | The system prompt text. |

**`session`** — unsourced. Session wrapper object. See §3 for full structure. Not directly activatable by the agent — it is infrastructure, not content.

---

## 3) Sessions

A **session** is one agent's complete interaction state. It is the portable unit — everything needed to pause, move, and resume an agent's work.

### 3.1 Session structure

The session wrapper object contains:

| Field | Mutability | Description |
|-------|-----------|-------------|
| Session ID | Immutable | Stable identifier for this session. |
| Chat reference | Immutable | ID of this session's chat object. |
| System prompt reference | Immutable | ID of this session's system prompt object. |
| **Session index** | Append-only | Set of every object ID this session has ever encountered. Never shrinks. If an object is deleted or orphaned, it stays in the index — the object's latest version reflects the loss, but the index entry remains. |
| **Metadata pool** | Mutable | Subset of the session index. Object IDs currently loaded as compact metadata in the agent's context window. |
| **Active set** | Mutable | Subset of the metadata pool. Object IDs whose full content is loaded in context. |
| **Pinned set** | Mutable | Object IDs the agent has explicitly pinned. Policy-dependent (e.g., pinned objects are not auto-deactivated). |

The session document stores only object IDs in these sets, not duplicated metadata. The client caches object metadata in memory and looks it up from the database on resume.

### 3.2 Context levels

From the agent's perspective, an object can be in one of three states:

1. **Active** — full content loaded in context. Costs tokens. Object is in the active set (and therefore also in the metadata pool and session index).
2. **Inactive (metadata)** — compact metadata summary visible. Agent can browse and choose to activate. Object is in the metadata pool (and session index) but not the active set.
3. **Indexed only** — in the session index but not in the metadata pool. The agent doesn't see it in context, but the session remembers it. Can be promoted to the metadata pool.

### 3.3 Activation, deactivation, and locking

- `activate(id)` — load object content into the active set. Object must be in the metadata pool. If it's only in the session index, promote to metadata pool first, then activate.
- `deactivate(id)` — remove from active set. Object remains in the metadata pool.
- **Locking is type-determined.** `chat` and `system_prompt` objects are always locked — they cannot be deactivated. `file` and `toolcall` objects are never locked. `session` objects are infrastructure and not activatable. There is no per-object `locked` field.
- Recent tool call outputs are auto-activated; older outputs auto-collapse based on a sliding window policy (see §4.3).

### 3.4 What the agent controls

- Metadata pool membership (which indexed objects appear as metadata in context).
- Active set membership (which objects have full content loaded).
- Pinned set membership.
- Triggering new object creation (by reading files, running tools).

### 3.5 What the agent does not control

- Session index (append-only — agent cannot remove entries).
- Object version history (cannot rewrite or delete versions).
- Object identity and immutable envelope (set at creation).
- Other sessions' state.

### 3.6 Session lifecycle

**Active** — agent is running. Session state is updated each turn.

**Paused** — agent is not running. Session state is persisted in the database. All references remain valid.

**Resumed** — session is loaded from database. The client restores the session index, metadata pool, active set, and pinned set. Then it reconciles sourced objects:

1. Fetch all objects referenced in the session index from the database (batch query).
2. For each sourced object (has `source != null`): check if the client can access the source.
   - **Source accessible:** read source, compute source hash, run indexing protocol. If source changed since last version, write new version.
   - **Source unreachable** (file missing, sandbox gone, machine offline): object is orphaned. Latest version remains as-is. No new version written — we don't know the current state.
   - **Source confirmed deleted** (watcher received unlink, or explicit deletion check): write new version with null content.
3. For unsourced objects: no reconciliation needed. They exist only in the database.
4. Rebuild in-memory caches (metadata entries, object content for active set).

### 3.7 Multi-session databases

Multiple sessions can exist in the same database. Sessions are isolated by design: each has its own index, metadata pool, active set, chat, and system prompt.

Objects are shared across sessions. Two sessions activating the same file reference the same object and see the same version history. This is correct: the object represents the external thing, not any session's view of it.

Concurrent access from multiple clients is supported. The database handles concurrent HTTP requests. If two clients push an update to the same object simultaneously, both writes succeed as separate versions. In the common case both writes contain the same content (they both observed the same file change), so the duplicate version is harmless — identical content, slightly redundant history.

---

## 4) Context Assembly

### 4.1 Context rendering

Each turn, the client assembles the LLM-visible context from the session state:

1. **System prompt** (from the system prompt object).
2. **Metadata pool** rendered as compact one-line summaries per object.
3. **Chat history** (user messages, assistant messages, tool call metadata references).
4. **Active content** blocks (full content of active objects, one block per object).

**Metadata summary format per type:**

| Type | Summary format |
|------|---------------|
| `file` | `id={id} type=file path={source.path} file_type={file_type} char_count={char_count}` |
| `toolcall` | `id={id} type=toolcall tool={tool} status={status}` |

Tool call outputs in the chat history are replaced with compact metadata references (`toolcall_ref id={id} tool={tool} status={status}`). Full output is only visible if the tool call object is in the active set.

Active content blocks are rendered as:
```
ACTIVE_CONTENT id={id}
{content}
```

### 4.2 Ordering

Context assembly favours stable prefixes for cache efficiency:
1. System prompt (stable).
2. Metadata pool summary (stable across turns, changes only when objects are added/removed).
3. Chat history (append-only — new turns added at the end).
4. Active content blocks (volatile — changes as objects are activated/deactivated).

### 4.3 Auto-collapse policy

Recent tool call outputs are auto-activated. Older ones are auto-deactivated based on a sliding window: configurable per-turn limit (default: 5 most recent per turn) and turns-back window (default: 3 turns). Pinned objects are exempt from auto-collapse.

File objects are not auto-collapsed. The agent explicitly activates and deactivates them.

---

## 5) Clients, Sources, and Tracking

### 5.1 Clients

A **client** is a process that connects to the database, performs indexing, runs trackers, and assembles context. In practice, the client is the context manager layer itself — instantiated by the agent's harness, running alongside the agent loop.

**Where the client runs:** The client typically runs outside the agent's sandbox. In a Pi coding agent deployment: the harness runs on the host; the agent's tools execute inside a Docker container; tool outputs flow back to the harness; the client (part of the harness) intercepts these outputs and performs indexing against the database.

The client has:
- Network access to the XTDB database (HTTP).
- Knowledge of the execution environment: what filesystems the agent can access, how sandbox paths map to host paths, which mounts exist.
- The ability to read files the agent references — either directly (same filesystem) or via mounted volumes.

**What the client does:**
- Wraps or intercepts agent tool calls (read, write, ls, grep, etc.).
- Indexes sourced objects (files) via the indexing protocol (§5.6).
- Creates unsourced objects (tool calls) directly.
- Runs file watchers for tracked objects it can access.
- Manages the session state (session index, metadata pool, active set, pinned set).
- Assembles context each turn (§4).

**What the agent sees:** The agent does not interact with the database directly. It sees tools provided by the client: activate, deactivate, pin, unpin, and the standard file/tool operations that the client wraps. The database is invisible to the agent.

### 5.2 Client filesystem awareness

A client may need to handle multiple filesystem namespaces simultaneously. Common scenarios:

1. **No sandbox.** Client and agent on the same machine, same filesystem. One filesystem ID. All paths are canonical as-is.
2. **Sandbox with bind mounts.** Agent in Docker. Some container paths are bind-mounted from the host. The container overlay filesystem is separate. The client needs at least two filesystem IDs and must translate agent paths for bind-mounted directories.
3. **Multiple mounts.** A sandbox with several volumes from different sources. Each distinct mount gets its own filesystem ID and path translation rule.

### 5.3 Path translation and mount mappings

When the agent operates inside a sandbox, the paths it sees (e.g., `/workspace/main.ts`) may differ from the canonical paths on the host filesystem (e.g., `/home/abaris/project/main.ts`). For bind-mounted directories, these are the same underlying file, and the source binding must reflect this so that host agents and sandboxed agents resolve to the same object.

**Mount mappings** translate agent-visible paths to canonical paths and filesystem IDs:

```
Mount mapping:
  agentPrefix:  /workspace
  canonicalPrefix: /home/abaris/project
  filesystemId:   <host filesystem ID>
```

When the client processes a path from the agent:

1. **Longest-prefix match** against configured mount mappings.
2. If a mapping matches: replace `agentPrefix` with `canonicalPrefix` in the path. Use the mapping's filesystem ID. The resulting canonical path + filesystem ID form the source binding.
3. If no mapping matches: path is used as-is. Default filesystem ID applies (typically the sandbox's own filesystem).

**Example:** Agent reads `/workspace/src/main.ts`. Mount mapping matches `/workspace` → `/home/abaris/project` on host FS. Source binding becomes `{type: "filesystem", filesystemId: hostFsId, path: "/home/abaris/project/src/main.ts"}`. A host agent reading the same file at `/home/abaris/project/src/main.ts` produces the same source binding → same object.

**Where mount mappings come from:** The harness configures the client at startup with mount mappings derived from the Docker/sandbox configuration. The harness already knows the mount topology (it set up the container). This is not auto-detected — it is explicit configuration.

**Runtime device-ID detection (optional):** If the client has direct filesystem access, it can use `stat().dev` to detect filesystem boundaries automatically. The client caches device ID → filesystem ID mappings. First encounter of a new device ID generates a new filesystem ID. This detects unexpected mounts without upfront configuration. The `stat` call is already happening for the file watcher, so this adds zero extra I/O. Device-ID detection serves as a fallback; explicit mount mappings take precedence.

### 5.4 Filesystem identity

A **filesystem ID** identifies a distinct filesystem namespace. Two paths on the same filesystem ID refer to the same underlying files. Two paths on different filesystem IDs are independent even if the path strings match.

Generation: the client computes filesystem IDs programmatically. For the host machine: SHA-256 of `/etc/machine-id` (or platform equivalent). For a Docker container's overlay filesystem: SHA-256 of the container ID or the container's own `/etc/machine-id`. For bind-mounted volumes: the host's filesystem ID (since edits propagate both ways — it is the same filesystem).

The database trusts declared filesystem IDs. Clients are assumed trusted. Misconfigured filesystem IDs cause object collisions (if IDs match when filesystems don't) or spurious separation (if IDs differ when filesystems are shared). This is a configuration error, not something the database guards against.

### 5.5 Sources

A **source** is the external thing a sourced object is bound to. Defined by the source binding in the object's immutable envelope (§2.3).

The source determines identity. Two objects with the same source binding are the same object. The source binding is immutable — once an object is created with a source, that binding never changes.

### 5.6 Indexing protocol (sourced objects)

When a client encounters a file — either from an agent tool call or a watcher event:

1. **Translate path.** Apply mount mappings (§5.3) to get the canonical path and filesystem ID.
2. **Compute source binding.** `{type: "filesystem", filesystemId: X, path: Y}` where Y is the canonical path.
3. **Compute source hash.** SHA-256 of the file content. The content comes from either:
   - The tool output (the tool already read the file — no need to re-read).
   - A direct file read by the client (for watcher events or session resume reconciliation).
4. **Derive object ID.** `identityHash("file", source)` — SHA-256 of the immutable envelope.
5. **Check database.** Fetch the current version of the object by ID.
   - **Not found (new source):** create object with full envelope and payload. First version. Return `created`.
   - **Found, source hash matches stored `source_hash`:** no-op. Return `unchanged`.
   - **Found, source hash differs:** write new version with updated content, source hash, content hash, and type-specific fields. Immutable envelope is identical. Return `updated`.
6. **Update session.** Add object ID to session index (if not already present). Add to metadata pool and/or active set as appropriate (e.g., explicit `read` → activate; `ls` discovery → metadata only).

The common case (file hasn't changed) requires one hash computation and one database lookup. No write.

### 5.7 Unsourced object creation

Unsourced objects (tool calls, chat, system prompt, session) are created directly — not via the indexing protocol. The client assigns an ID at creation and writes the document to the database. No source hash, no check-then-write.

- **Tool calls:** created when the agent executes a tool. ID is the tool call ID from the harness. Written once, never updated.
- **Chat:** created when the session starts. Updated (new version) each turn with new turns appended.
- **System prompt:** created when the session starts. Updated if the system prompt changes.
- **Session:** created when the session starts. Updated whenever session state changes (active set, metadata pool, etc.).

### 5.8 Trackers

A **tracker** is a process that watches a source and pushes updates to the database when the source changes. For filesystem sources, this is a file watcher (chokidar in the current implementation). Different source types would use different tracking mechanisms.

Trackers are run by clients. Each client runs trackers for the sources it has access to. Multiple clients can track the same source — any of them can push updates, and all updates resolve to the same object because identity is source-derived.

**Watcher scope:** The client can only watch files it can directly access on its own filesystem. For bind-mounted files, the client watches the host-side canonical path. For container-internal files (overlay filesystem), the client typically cannot watch them — these objects are indexed when the agent accesses them via tools but do not have persistent watchers. This is acceptable: container-internal files are ephemeral and not externally modified.

### 5.9 Tracker lifecycle

- **Attached** — actively watching. Pushes updates on change via the indexing protocol.
- **Orphaned** — no tracker is active. The object's latest version reflects the last known state. Common causes: sandbox destroyed, machine offline, file deleted, client shut down. Orphaning is normal and expected, not an error.
- **Resumed** — a tracker (same or different client) re-attaches to an orphaned object. Runs the indexing protocol to check current source state and create a new version if the source has changed.

When a source is confirmed deleted (watcher receives an unlink event, or explicit check on resume confirms absence), the client writes a new version with null content. The object and its full history remain in the database.

---

## 6) Evaluation and Experiments

### 6.1 Prompt and behaviour policy

Fixed prompt/protocol is required for fair evaluation phases. Harness raw message logs are treated as event input; assembled context is what the model actually sees.

### 6.2 Experiment infrastructure

Experiment scripts are in `scripts/`. Some use a real LLM agent loop (GPT-4.1), some are scripted API exercises. Reports in `docs/experiments/` — see its README for the distinction.

### 6.3 Experiment database isolation

Each experiment should use a clean, isolated database. Options:
- Separate XTDB process with its own data directory per experiment.
- In-memory XTDB backend (`xtdb.mem/->kv-store`) for ephemeral experiment runs.
- Same XTDB instance with unique session IDs per experiment (weaker isolation — sourced objects from different experiments share identity if they reference the same files on the same filesystem — but no extra processes needed).

---

## 7) Implementation Status

> Last updated: 2026-02-24.

This section tracks what exists in the repo, not what the design intends. For design intent, see sections 1–6.

### 7.1 Modules

| Module | Path | Status | Notes |
|--------|------|--------|-------|
| XTDB client | `src/xtdb-client.ts` | Working | HTTP client for XTDB v1 standalone. Three endpoints: `submit-tx`, `entity`, `query`. |
| Core types | `src/types.ts` | **Needs update** | Current types predate the object model in §2. Has `locked`, `provenance`, `nickname` fields to remove. Missing: source bindings, identity hash, source hash, session index. |
| Hashing | `src/hashing.ts` | **Needs update** | Has `contentHash`, `metadataViewHash`, `objectHash` — these mix concerns. Needs three clean hashes per §2.2. |
| Context manager | `src/context-manager.ts` | Working | In-memory pools and cursor processing. Toolcall-only — no file object management. |
| Extension | `src/phase3-extension.ts` | **Needs update** | File indexing, watcher, session persist/resume. File IDs are `file:{path}` — needs source-derived identity. No filesystem ID, no path translation, no session index separate from metadata pool. Stores full metadata entries in session document (should be ID-only). |
| Exports | `src/index.ts` | Working | Re-exports public API. |

### 7.2 Test coverage

25 tests across 5 suites, all against real XTDB (no mocks for acceptance):
- `tests/phase1.test.ts` — XTDB client basics (put/get/as-of/history/query)
- `tests/phase2.test.ts` — Context manager pools and cursor
- `tests/phase3.test.ts` — Extension tools, side-effect indexing, activation/lock
- `tests/phase4.test.ts` — Watcher, session resume, cursor invalidation
- `tests/e2e-final.test.ts` — Full lifecycle continuity

### 7.3 What is not yet implemented

- Object model: types, hashing, and document structure per §2.
- Source bindings, filesystem identity, and path translation per §5.
- Client filesystem awareness (multi-filesystem, mount mappings) per §5.2–5.3.
- Session index (append-only, separate from metadata pool) per §3.1.
- Indexing protocol and database handler per §5.6.
- Unsourced object creation formalisation per §5.7.
- Not integrated into a live Pi coding agent session.
- Evaluation plan (`docs/eval-plan.md`) documented but unstarted.
- All LLM experiments used investigation/research scenarios; not yet tested on coding tasks.
- Some design decisions remain policy-level only (token budget enforcement).

### 7.4 XTDB deployment

Current: XTDB v1.24.3 standalone with RocksDB backend. Single process on host VPS. 91MB jar. Config: `xtdb/xtdb.edn`. Data in three RocksDB directories under `data/` (docs, idx, txs — ~477MB, mostly test/experiment data).

Data is portable across same-architecture machines: copy the three directories, point XTDB at them, start.

For in-memory (experiment/sandbox use): swap RocksDB for `xtdb.mem/->kv-store` in the EDN config. No persistence, no native dependencies. Suitable for ephemeral runs.

---

## 8) Glossary

| Term | Definition |
|------|-----------|
| **Object** | Versioned entity in the database with stable identity and version history. |
| **Sourced object** | Object bound to an external source (file, S3, etc.). Source binding is immutable. Created via the indexing protocol. |
| **Unsourced object** | Object that exists only in the database (tool call, chat, session). Created directly by the client. |
| **Source** | The external thing a sourced object tracks. Defined by type + type-specific locator fields. |
| **Source binding** | The immutable `source` field on a sourced object's envelope. Determines identity. |
| **Client** | The context manager process. Connects to the database, performs indexing, runs trackers, assembles context. Typically runs outside the agent's sandbox. |
| **Tracker** | A process (run by a client) watching an external source and pushing updates to the database. |
| **Orphaned** | A sourced object whose tracker is no longer active. Normal state, not an error. |
| **Canonical path** | The absolute path within a filesystem namespace. For bind mounts, this is the host-side path. Stored in the source binding. |
| **Mount mapping** | Configuration that translates agent-visible paths to canonical paths and filesystem IDs. |
| **Session** | One agent's complete interaction state: session index, metadata pool, active set, pinned set, chat, system prompt. The portable unit. |
| **Session index** | Append-only set of all object IDs a session has encountered. |
| **Metadata pool** | Mutable subset of the session index. Objects visible as compact metadata in context. |
| **Active set** | Mutable subset of the metadata pool. Objects with full content loaded in context. |
| **Pinned set** | Objects the agent has marked to exempt from auto-collapse. |
| **Activate / Deactivate** | Promote / demote object content between active and metadata-only states. |
| **Identity hash** | SHA-256 of an object's immutable envelope (type + source). Defines object ID for sourced objects. |
| **Source hash** | SHA-256 of the raw external source (e.g., file bytes). Used for efficient change detection during indexing. |
| **Content hash** | SHA-256 of all mutable payload fields (excluding source_hash and itself). Detects document-level changes. |
| **Filesystem ID** | Identifier for a distinct filesystem namespace. Programmatically generated by the client. |
| **Harness** | External agent runtime (loop, tools, UI) that the context manager integrates with. |

---

## 9) Change Policy

Update this SSOT whenever behaviour, assumptions, or architecture materially changes.

1. **Behaviour first**: implement or decide the change.
2. **Same commit window**: update this SSOT in the same change set.
3. **Mark impact** as: `Design change`, `Implementation alignment`, or `Implementation divergence`.
4. **Keep §7 honest**: never describe unshipped behaviour as shipped.
5. **Cross-link**: if detailed docs change elsewhere, adjust references here.

Default to documenting uncertainty explicitly rather than over-claiming.
