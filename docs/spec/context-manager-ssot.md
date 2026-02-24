# Context Manager SSOT (Single Source of Truth)

> **Authoritative document.** If any other document conflicts with this one, this SSOT wins until explicitly updated.

---

## 1) Fundamentals

### 1.1 Problem

LLM agents lose continuity in long tasks because context windows are limited and tool outputs/files are repeatedly re-injected as raw text. This causes context bloat, drift, and inconsistent behaviour across turns.

### 1.2 Goals

- **Context manager layer** — active control over what an LLM sees each turn, not just a memory bucket.
- **Objects and references** instead of repeated full-text re-reading.
- **Explicit activation/deactivation** — context is a deliberate subset, not everything ever seen.
- **Version-aware references** and durable history for reproducibility.
- **Multi-agent support** — multiple agents sharing a database without interference, portable sessions.

### 1.3 Principles

- **Separation of concerns.** The harness runs the agent loop/tools/UI. This layer controls the LLM-visible context.
- **Metadata first.** Inactive objects visible via compact summaries. Browse broadly, activate narrowly.
- **Store rich, render adapted.** Structured internal state; adapted at the model/harness boundary.
- **Append-only history.** Deletions and orphaning create new versions (null content). History is never erased.

### 1.4 Invariants

- Objects have stable identity and version history.
- Chat history is always present as canonical conversation state.
- Tool result payloads are separate from inline metadata references.
- Active/inactive transitions change loaded content, not object identity.
- Session index is append-only — content objects are never removed once encountered.

---

## 2) Data Model

### 2.1 Objects

An **object** is a versioned entity in the database. Every object has a stable ID, a type, and a version history maintained by XTDB's bi-temporal store.

**Two axes classify objects:**

| | Content | Infrastructure |
|---|---------|---------------|
| **Sourced** | `file` | *(future)* |
| **Unsourced** | `toolcall` | `chat`, `system_prompt`, `session` |

**Content objects** (`file`, `toolcall`) — the things the agent works with. Participate in the context management system: session index, metadata pool, active set. The agent activates, deactivates, and pins them.

**Infrastructure objects** (`chat`, `system_prompt`, `session`) — session scaffolding. Stored in XTDB for persistence/versioning. Referenced by the session wrapper and rendered in fixed positions. The agent does not activate or deactivate them.

**Sourced objects** — bound to an external thing (file on disk, S3 object, etc.). Source binding is immutable. Identity derived from the source.

**Unsourced objects** — exist only in the database. Identity assigned at creation.

### 2.2 Document structure

Every object in XTDB is a flat document. Conceptually it has two zones, but in storage all fields are top-level keys.

#### Immutable envelope

Set at creation, identical across all versions of the same object:

| Field | Description |
|-------|-------------|
| `xt/id` | Object ID. Sourced: derived from `identity_hash`. Unsourced: assigned (e.g., `chat:{sessionId}`, tool call ID). |
| `type` | `file` \| `toolcall` \| `chat` \| `system_prompt` \| `session` |
| `source` | Source binding (§2.3). `null` for unsourced objects. |
| `identity_hash` | Identity verification hash (§2.4). |

#### Mutable payload

New version created when any mutable field changes:

| Field | Present on | Description |
|-------|-----------|-------------|
| `content` | All | The payload. String or null. |
| *(type-specific fields)* | Varies | See §2.6 for per-type fields. |
| `file_hash` | Sourced files only | SHA-256 of raw file bytes on disk. `null` for discovery stubs. |
| `content_hash` | All | SHA-256 of the `content` field. `null` if content is null. |
| `metadata_hash` | All | SHA-256 of type-specific fields (excludes content and all hash fields). |
| `object_hash` | All | SHA-256 of `{file_hash, content_hash, metadata_hash}`. Full version fingerprint. |

No `locked`, `provenance`, or `nickname` fields.

### 2.3 Source bindings

The `source` field is a tagged union. The `type` field determines required sub-fields.

**Filesystem source** (implemented):

```json
{
  "type": "filesystem",
  "filesystemId": "a1b2c3...",
  "path": "/home/abaris/project/src/main.ts"
}
```

- `filesystemId` — identifies the filesystem namespace (§5.4).
- `path` — **canonical** absolute path. For bind mounts, the host-side path. See §5.3 for translation.

**Future source types** (extensibility):

```json
{ "type": "s3", "bucket": "...", "key": "..." }
{ "type": "git", "repo": "...", "ref": "...", "path": "..." }
```

Each source type defines its required fields, how `file_hash` is computed (file bytes, etag, blob hash), and what tracker applies. Existing schemas are stable once defined.

### 2.4 Hashes

Five hashes, each with a distinct purpose:

```
identity_hash (immutable — per object, never changes)
│
├── file_hash      (per version — external source)
│
└── object_hash    (per version — full document fingerprint)
    ├── content_hash   (content field only)
    └── metadata_hash  (type-specific fields only)
```

| Hash | Purpose | Input | Null when |
|------|---------|-------|-----------|
| `identity_hash` | Is this the same object? | Sourced: `SHA-256({type, source})`. Unsourced: `SHA-256({type, 'xt/id': id})`. | Never. |
| `file_hash` | Has the external file changed? | `SHA-256(raw file bytes as UTF-8)`. | Unsourced objects. Discovery stubs (never read). |
| `content_hash` | Has the stored content changed? | `SHA-256(content)`. | Content is null (deleted, stub, non-text). |
| `metadata_hash` | Have type-specific fields changed? | `SHA-256(stableStringify(typeSpecificFields))`. See §2.6 for which fields per type. | Never (always computable, even if fields are empty/default). |
| `object_hash` | Has anything in this version changed? | `SHA-256(stableStringify({file_hash, content_hash, metadata_hash}))`. Composite — changes if any sub-hash changes. | Never. |

**Why `file_hash` and `content_hash` are separate:** For text files today they're identical (both SHA-256 of the file text). They diverge if we ever store transformed content (truncated, annotated, processed) rather than raw file bytes. `file_hash` always reflects the external source; `content_hash` always reflects what we store.

**What `metadata_hash` covers per type:** only the type-specific fields listed in §2.6, via stable serialisation. It does NOT include: `content`, `xt/id`, `type`, `source`, `identity_hash`, `file_hash`, `content_hash`, `metadata_hash`, `object_hash`. The exclusion list is explicit and fixed — immutable envelope fields plus hash fields plus the content field.

### 2.5 Object identity

**Sourced objects:** `xt/id` = `identity_hash` = `SHA-256(stableStringify({type, source}))`. Two clients indexing the same source get the same ID. This is how multi-agent access to the same file resolves to one object.

**Unsourced objects:** `xt/id` is assigned at creation (tool call ID, `chat:{sessionId}`, etc.). `identity_hash` = `SHA-256(stableStringify({type, 'xt/id': assignedId}))` — verifies the ID/type pairing.

**The identity rule:** if agent A changes it and agent B inherently sees the change (same file on same filesystem), it is the same object. If changes don't propagate (different filesystems), they are different objects even if the path string matches.

### 2.6 Object types

#### Content objects

**`file`** — sourced (filesystem). Represents a file on disk.

| Type-specific field | Description | Covered by `metadata_hash` |
|---|---|---|
| `file_type` | File extension (e.g., `ts`, `md`). Derived from source path. | Yes |
| `char_count` | Length of content string. 0 if content is null. | Yes |

Canonical path is in the immutable `source.path`, not in the payload.

**`toolcall`** — unsourced. Result of a tool execution. Single version (created once, never updated).

| Type-specific field | Description | Covered by `metadata_hash` |
|---|---|---|
| `tool` | Tool name (e.g., `bash`, `read`). | Yes |
| `args` | Tool arguments (JSON object). | Yes |
| `args_display` | Optional human-readable args summary. | Yes |
| `status` | `ok` \| `fail`. | Yes |
| `chat_ref` | ID of the parent chat object. | Yes |
| `file_refs` | Optional list of file object IDs referenced. | Yes |

#### Infrastructure objects

Do NOT appear in session index, metadata pool, or active set. Referenced by session wrapper. Rendered in fixed positions.

**`chat`** — unsourced. One per session. New version each turn.

| Type-specific field | Description | Covered by `metadata_hash` |
|---|---|---|
| `turns` | Array of turn objects. | Yes |
| `session_ref` | ID of parent session object. | Yes |
| `turn_count` | Number of turns. | Yes |
| `toolcall_refs` | All tool call IDs across all turns. | Yes |

**`system_prompt`** — unsourced. One per session. Updated if prompt changes.

No type-specific fields beyond `content`.

**`session`** — unsourced. Session wrapper. See §3.

| Type-specific field | Description | Covered by `metadata_hash` |
|---|---|---|
| `session_id` | Stable identifier. | Yes |
| `chat_ref` | Chat object ID. | Yes |
| `system_prompt_ref` | System prompt object ID. | Yes |
| `session_index` | Append-only content object ID set. | Yes |
| `metadata_pool` | Mutable content object ID set. | Yes |
| `active_set` | Mutable content object ID set. | Yes |
| `pinned_set` | Mutable content object ID set. | Yes |

---

## 3) Sessions

### 3.1 Structure

The session wrapper (a `session` infrastructure object in XTDB) contains:

| Field | Mutability | Description |
|-------|-----------|-------------|
| `session_id` | Immutable | Stable identifier. |
| `chat_ref` | Immutable | ID of this session's chat object. |
| `system_prompt_ref` | Immutable | ID of this session's system prompt object. |
| `session_index` | Append-only | Every content object ID this session has encountered. Never shrinks. |
| `metadata_pool` | Mutable | Subset of session index. Content objects visible as metadata. |
| `active_set` | Mutable | Subset of metadata pool. Content objects with full content loaded. |
| `pinned_set` | Mutable | Content objects exempt from auto-collapse. |

Stores object IDs only, not duplicated metadata. Client caches metadata in memory.

### 3.2 Context levels

A content object is in one of three states:

1. **Active** — full content in context. In active set ⊂ metadata pool ⊂ session index.
2. **Metadata** — compact summary visible. In metadata pool ⊂ session index, not in active set.
3. **Indexed only** — in session index only. Not visible to agent. Reserved for future use — currently, no operation demotes from metadata pool. All objects that enter the metadata pool stay there. When metadata pool growth becomes a concern (very long sessions), a demote operation will be added.

Infrastructure objects have no context level. Always rendered in fixed positions.

### 3.3 Agent-facing interface

The agent sees these tools (provided by the client, wrapping the context management system):

| Tool | Effect |
|------|--------|
| `activate(id)` | Load content into active set. Must be in metadata pool (auto-promotes from indexed-only if needed). For discovery stubs (file_hash null, content null): client reads source and runs full indexing first. Fails gracefully if source inaccessible. |
| `deactivate(id)` | Remove from active set. Stays in metadata pool. |
| `pin(id)` | Mark as pinned (exempt from auto-collapse). |
| `unpin(id)` | Remove pin. |
| Standard tools | `read`, `write`, `edit`, `ls`, `grep`, etc. — the client wraps these and handles indexing transparently. |

Only content objects can be activated/deactivated/pinned.

### 3.4 What the agent controls

- Metadata pool membership, active set membership, pinned set membership.
- Triggering new content object creation (reading files, running tools).

### 3.5 What the agent does not control

- Session index (append-only).
- Object version history and identity.
- Infrastructure objects.
- Other sessions' state.

### 3.6 Session lifecycle

**Active** — agent running. Session state updated each turn.

**Paused** — session persisted in database. All references remain valid.

**Resumed:**

1. Fetch session wrapper. Restore all sets.
2. Fetch all content objects in session index (batch Datalog query).
3. For each sourced object: attempt source access.
   - **Accessible:** read source, compute file_hash, run indexing protocol. New version if changed.
   - **Unreachable:** orphaned. Latest version stays.
   - **Confirmed deleted:** new version with null content.
4. Unsourced content objects: no reconciliation.
5. Rebuild metadata cache and active content cache.
6. Re-establish watchers for accessible sourced objects.

### 3.7 Multi-session databases

Multiple sessions in one database. Sessions isolated by design (own index, pools, chat, system prompt). Content objects shared — same file = same object across sessions.

Concurrent writes by multiple clients: both succeed as separate versions. Harmless if content is identical.

---

## 4) Context Assembly

### 4.1 Rendering order

Each turn, the client assembles four sections:

**1. System prompt.** From infrastructure object. Always present.

**2. Metadata pool summary.** One line per content object:

| Type | Format |
|------|--------|
| `file` (indexed) | `id={id} type=file path={displayPath} file_type={file_type} char_count={char_count}` |
| `file` (stub) | `id={id} type=file path={displayPath} file_type={file_type} [unread]` |
| `toolcall` | `id={id} type=toolcall tool={tool} status={status}` |

File stubs (file_hash is null) show `[unread]` instead of `char_count`. This distinguishes "not yet read" from "empty file."

`displayPath` is the **agent-visible path** (reverse-translated from canonical via mount mappings, §5.3). For non-sandboxed agents, canonical = agent-visible.

**3. Chat history.** From infrastructure object. Tool call outputs replaced with `toolcall_ref id={id} tool={tool} status={status}`. Full output only if the tool call is active.

**4. Active content.** One block per active content object:
```
ACTIVE_CONTENT id={id}
{content}
```

### 4.2 Ordering rationale

Stable content at the top (system prompt, metadata pool). Append-only in the middle (chat). Volatile at the bottom (active content). LLM providers cache token prefixes — stable tops reduce re-processing.

### 4.3 Auto-collapse

Tool call outputs: auto-activated on creation, auto-deactivated by sliding window (default: 5 per turn, 3 turns back). Pinned objects exempt.

File objects: never auto-collapsed. Agent manages explicitly.

---

## 5) Clients, Sources, and Tracking

### 5.1 Client

The **client** is the context manager process — instantiated by the harness, running alongside the agent loop.

**Runs:** typically outside the agent's sandbox (on the host). Has network access to XTDB, knowledge of the filesystem topology, ability to read files the agent references.

**Responsibilities:**
- Wrap agent tool calls → index files, create tool call objects.
- Create and maintain infrastructure objects (chat, system prompt, session).
- Run watchers for accessible sourced objects.
- Manage session state (index, pools, sets).
- Assemble context each turn.
- Maintain metadata cache (display paths, file types, char counts, tool names).

**Agent sees:** activate, deactivate, pin, unpin tools plus standard file/tool operations. Database is invisible.

### 5.2 Filesystem awareness and mount detection

The client needs to know which paths inside the sandbox are bind-mounted from the host (shared files — same object as host) vs container-internal (overlay filesystem — isolated, ephemeral).

#### Detection mechanisms

**Primary: `docker inspect` from the harness.** The harness created the container and has the container ID. `docker inspect {id}` returns the Mounts array — each entry has `Source` (host path), `Destination` (container path), `Type` (`bind`), and `RW`. This directly produces the mount mapping table. No parsing, no guessing.

Example from a real sandbox:
```json
{"Source": "/home/abaris/.openclaw/workspaces/dev", "Destination": "/workspace", "Type": "bind", "RW": true}
```
→ mount mapping: `agentPrefix=/workspace`, `canonicalPrefix=/home/abaris/.openclaw/workspaces/dev`, `filesystemId=<host FS ID>`.

**Fallback: `/proc/self/mountinfo` from inside the sandbox.** If docker inspect isn't available, the client execs `cat /proc/self/mountinfo` inside the sandbox. Bind mounts appear as lines with the host device (e.g., `252:3`). Field 4 is the host path, field 5 is the container mount point. Same information, parsed from inside.

**Runtime verification: `stat().dev` inside the sandbox.** Bind-mounted paths have the host device ID (e.g., `64515`). Container overlay paths have a different device ID (e.g., `48`). The client can stat any path to confirm whether it's on a bind mount or container-internal. This catches paths not under any known mount prefix. One stat call per new device encountered, cached.

#### How it works in practice

At client startup:
1. Harness calls `docker inspect` → gets mount table.
2. Client builds mount mappings from each bind mount entry.
3. Host filesystem ID computed from host `/etc/machine-id` (SHA-256).
4. Container overlay filesystem ID computed from container's `/etc/machine-id` or container ID.
5. Default filesystem ID = container overlay (paths not under any mount are container-internal).

At indexing time:
1. Agent accesses a path (e.g., `/workspace/src/main.ts`).
2. Client does longest-prefix match against mount mappings.
3. Match (`/workspace` → `/home/abaris/.openclaw/workspaces/dev`): translate prefix, use host FS ID. Source binding gets the canonical host path. Watcher watches this path (client can access it — it's on the host).
4. No match: path is container-internal. Use container overlay FS ID. Source binding uses the agent path as-is. No watcher (ephemeral, not externally modified).

For the no-sandbox case: no mount mappings. One filesystem ID (host). All paths are canonical. Everything is watchable.

### 5.3 Path translation

**Forward** (agent → canonical): longest-prefix match against mount mappings. Match → replace agent prefix with canonical prefix, use mapping's FS ID. No match → path as-is, default (overlay) FS ID.

**Reverse** (canonical → display): replace canonical prefix with agent prefix. No match → show canonical path. Used for metadata rendering (§4.1).

### 5.4 Filesystem identity

Host: SHA-256 of `/etc/machine-id`. Container overlay: SHA-256 of container ID or container's own `/etc/machine-id`. Bind mounts use the host's FS ID (edits propagate both ways — same filesystem). Database trusts declared IDs.

### 5.5 Sources

A **source** is the external thing a sourced object tracks. Defined by the immutable source binding. Two objects with the same source binding are the same object.

### 5.6 Indexing protocol

Two entry points. Both produce the same object identity.

#### Full indexing

**Triggered by:** agent reads a file, watcher fires, session resume.

**Steps:**

1. **Resolve identity.** Translate path (§5.3) → source binding → `identityHash("file", source)` → object ID.
   - *For watcher events:* the client already knows the source binding and object ID (it set up the watcher). Skip to step 2.
2. **Get content and file_hash.** Content from tool output (agent read) or direct file read (watcher, resume). `file_hash = SHA-256(content as UTF-8)`.
3. **Check database.** Fetch current version by ID.
   - **Not found:** create with full envelope + payload. Return `created`.
   - **Found, stored `file_hash` is null** (discovery stub): update with content + hashes. Return `updated`.
   - **Found, `file_hash` matches:** no-op. Return `unchanged`.
   - **Found, `file_hash` differs:** write new version. Return `updated`.
4. **Update session** (depends on trigger):
   - **Agent read:** add to session index, metadata pool, and active set.
   - **Watcher event:** object already in session sets. Update metadata cache only (char_count, content_hash may have changed). Do NOT change set membership — don't force-activate something the agent deactivated.
   - **Session resume:** sets already restored from persisted session. No set changes. Metadata cache updated from fresh data.

#### Discovery

**Triggered by:** side-effect path extraction from tool output (ls, grep, find, tree).

1. **Resolve identity.** Same as full indexing step 1.
2. **Check database.**
   - **Not found:** create discovery stub — full envelope, payload: `content: null`, `file_hash: null`, `content_hash: null`, `char_count: 0`, `file_type` from extension. Return `created`.
   - **Found:** no-op. Discovery never overwrites. Return `unchanged`.
3. **Update session.** Add to session index and metadata pool (not active set).

### 5.7 Unsourced object creation

**Tool calls:** created on tool execution. ID from harness. Written once. Added to session index + metadata pool + active set.

**Infrastructure:** chat, system_prompt, session created at session start. Updated as described in §2.6.

### 5.8 Trackers

File watchers run by the client. For bind-mounted files, the client watches the canonical host-side path (it has direct access — the file is on the host filesystem). For container-internal files (overlay), no watcher — these are ephemeral and only indexed when the agent accesses them via tool calls.

Multiple clients can watch the same source. All resolve to the same object.

### 5.9 Tracker lifecycle

**Attached** → actively watching, pushes updates via indexing protocol.

**Orphaned** → no active tracker. Latest version stays. Normal state (sandbox gone, machine offline, etc.).

**Resumed** → tracker re-attaches. Runs indexing protocol. New version if source changed.

**Deleted** → watcher receives unlink. Client writes version with null content. Object and history remain.

---

## 6) Evaluation and Experiments

### 6.1 Policy

Fixed prompt/protocol for fair evaluation. Assembled context is what the model sees.

### 6.2 Infrastructure

Scripts in `scripts/`. Reports in `docs/experiments/`.

### 6.3 Database isolation

Options: separate XTDB process per experiment, in-memory backend (`xtdb.mem/->kv-store`), or same instance with unique session IDs (weaker — sourced objects shared if same files).

---

## 7) Implementation Status

> Last updated: 2026-02-24.

Tracks what exists, not design intent (§1–6).

### 7.1 Modules

| Module | Path | Status |
|--------|------|--------|
| XTDB client | `src/xtdb-client.ts` | Working |
| Core types | `src/types.ts` | **Needs update** — missing source bindings, new hashes, content/infrastructure split |
| Hashing | `src/hashing.ts` | **Needs update** — has 3 mixed-concern hashes, needs 5 clean hashes per §2.4 |
| Context manager | `src/context-manager.ts` | Working — toolcall-only |
| Extension | `src/phase3-extension.ts` | **Needs update** — file IDs, FS resolver, session index, ID-only pools, infrastructure split |
| Exports | `src/index.ts` | Working |

### 7.2 Tests

25 tests across 5 suites against real XTDB. All need updating for new types/hashes.

### 7.3 Not yet implemented

- Object model, hashes, document structure per §2.
- Content/infrastructure split per §2.1.
- Source bindings, filesystem identity, path translation per §5.
- Session index (append-only, separate from metadata pool) per §3.1.
- Indexing protocol with discovery stubs per §5.6.
- Metadata rendering with stub indicator and display paths per §4.1.
- Token budget enforcement (future).

### 7.4 XTDB

v1.24.3 standalone, RocksDB. Single process. 91MB jar. ~477MB data. Config: `xtdb/xtdb.edn`. Portable across same-architecture machines. In-memory option for ephemeral use.

---

## 8) Glossary

| Term | Definition |
|------|-----------|
| **Object** | Versioned entity in the database. |
| **Content object** | `file`, `toolcall`. Participates in context management (activate/deactivate/pin). |
| **Infrastructure object** | `chat`, `system_prompt`, `session`. Persistence/versioning only. Fixed rendering positions. |
| **Sourced** | Bound to external source. Identity from source binding. |
| **Unsourced** | Database-only. Assigned identity. |
| **Source binding** | Immutable `source` field. Tagged union by source type. |
| **Client** | Context manager process. Indexes, tracks, assembles context. |
| **Tracker** | Watcher process pushing source changes to database. |
| **Orphaned** | Sourced object with no active tracker. Normal state. |
| **Discovery stub** | File object created from path discovery (ls, grep). content/file_hash null. Upgraded on first read. |
| **Canonical path** | Host-side absolute path. Stored in source binding. |
| **Agent-visible path** | Path as agent sees it (container-side). Used in metadata rendering. |
| **Mount mapping** | Agent prefix ↔ canonical prefix + filesystem ID. |
| **Session** | Agent's complete interaction state. The portable unit. |
| **Session index** | Append-only set of content object IDs encountered. |
| **Metadata pool** | Mutable subset of session index. Compact summaries in context. |
| **Active set** | Mutable subset of metadata pool. Full content in context. |
| **Pinned set** | Exempt from auto-collapse. |
| **identity_hash** | Sourced: SHA-256(type + source) = xt/id. Unsourced: SHA-256(type + xt/id). |
| **file_hash** | SHA-256 of raw file bytes. External source check. |
| **content_hash** | SHA-256 of stored content field. |
| **metadata_hash** | SHA-256 of type-specific fields (excludes content and hashes). |
| **object_hash** | SHA-256(file_hash + content_hash + metadata_hash). Full version fingerprint. |
| **Harness** | External agent runtime (loop, tools, UI). |

---

## 9) Change Policy

1. Behaviour first, then update SSOT in same commit.
2. Mark: `Design change`, `Implementation alignment`, or `Implementation divergence`.
3. Keep §7 honest — never describe unshipped as shipped.
4. Document uncertainty explicitly.
