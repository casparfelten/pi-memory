# Memory system v0
**Date:** 2026-02-20 (merged/restructured 2026-02-21)
**Status:** Working design.

Structure: Part I covers intent and requirements (what the system must do, substrate-agnostic). Part II covers design choices (what we've decided, pragmatic, can be changed without violating Part I).

---

# Part I: Intent and Requirements

## 1) What we're building

A foundational memory object store that gives the agent **complete control over context** by letting it work in terms of **objects + references**, not repeated full-text reads.

Key properties:
- **Arbitrary objects:** the system can store many kinds of objects (Markdown notes, toolcall results, chat history, external pointers).
- **Versioning:** objects are versioned; references can be pinned to a specific version (by content hash or by timestamp).
- **Flexible structure:** metadata is schemaless / extensible; derived fields can be added later without migrations.
- **Markdown is a DSL / representation, not the whole backend:** Markdown is a convenient way to *express* documents (links/tags), but the store holds structured documents, not strings.
- **First-class toolcalls + chat:** toolcall results and chat history are stored as rich objects that reference other objects.

## 2) What this is trying to prevent

- Repeatedly reading the same file and dumping it into chat.
- Tool results bloating context.
- Having to constantly do manual git ceremony just to keep shared memory coherent.

## 3) Object types

Everything in the system is an **object** in the same store, with the same ref/version mechanics. Object types differ in how they're created and how they're typically presented in context, but they are all objects.

### 3.1 Memory objects (durable)
- The agent writes Obsidian-style Markdown files. The system parses these into structured documents with content + metadata + relations.
- Have:
  - **object id** (stable)
  - **versions** (history)
  - **metadata** (type/tags/links/updated/etc.)
- Are separate objects loaded into context by reference, not inline in chat.

### 3.2 Toolcall objects (derived from execution)
- Every tool execution becomes a **toolcall object**.
- The toolcall object's **content field is the stdout/output**. This is what gets loaded into the active content pool when the toolcall is activated.
- Metadata includes: tool name, args (e.g. the bash command), status (ok/fail), optional summary. This is what the LLM sees in the chat message sequence — **tool results are always metadata references in the chat, never inline output.** The actual output is a separate object accessed via activation.
- Toolcall objects link back to:
  - the triggering chat turn (bidirectional: chat → toolcall and toolcall → chat, including position within the chat)
  - files indexed/activated/modified by the tool
- Recent toolcall objects are **auto-activated** (content in active pool); older ones are **auto-deactivated** (content removed from active pool). The chat message sequence does not change — it always has metadata references. What changes is which toolcall objects are in the active set.

### 3.3 Chat object
Chat is a **single structured document**. It contains:
- User messages
- Agent messages
- Toolcall metadata references (tool name, args, status, toolcall object ID — **not** the full output)
- Optionally: agent reasoning traces

Each turn and toolcall entry has structured fields within the document. Chat is not a collection of separate turn objects — it's one document with internal structure. The context management system maintains the chat object; the agent doesn't manage it directly.

For the LLM, the chat object is rendered as proper `Message[]` (correct `UserMessage`/`AssistantMessage`/`ToolResultMessage` structure with roles, tool call IDs, etc.). `ToolResultMessage` content is always a short metadata reference — the actual output lives on the toolcall object and appears in the active content pool when activated. The chat stores structured turn data; the markdown-with-delimiters format (§24.3) is for storage/display, not what the LLM directly sees.

### 3.4 User objects (optional)
- Large user pastes can be turned into an object (full or partial) with a short summary + reference.

### 3.5 External pointers (later)
- Objects may point to external stores (vector DB, web URL, database row, etc.) via optional pointer fields.

## 4) Object structure

### 4.1 Object identity and versioning
- **Stable ID:** UUIDv7 (time-ordered), minted on first index. This is the canonical identifier. Never changes. UUIDv7 chosen because time-ordering is useful for queries by creation time.
- **Nickname (optional):** human-readable name, must be unique if present. The agent can reference objects by nickname. E.g. `memory-system-spec`. Not required.
- **Version (immutable):** a snapshot of the object at a point in time. Can be addressed by content hash or by timestamp — both point to the same thing.

Default behavior: the LLM uses stable IDs (or nicknames) and gets "latest" unless it explicitly asks for an earlier version.

### 4.2 Content, metadata, and additional fields

Each object has:
- **content (default, required to exist, may be null):** the primary content field. This is what `activate` loads into the active content pool. Almost always text. For a file: the file contents (null for non-text/binary files). For a toolcall: the stdout/output. For a chat: the `content` field is a storage/display rendering (markdown with delimiters), while the canonical chat structure lives in the `turns` field (see §24.3). Activating an object with null content is a no-op (or returns a note that content is unavailable). This is "the thing the LLM would usually see" — what it would get if it just ran the tool or opened the file.
  - Content can be plain text or a structured document (sections, nested parts). Structured internals live *inside* the content field, not as additional fields.
  - Content that is a structured document (like chat history) is rendered as simple markdown with delimiters between sections (e.g. `--- toolcall (metadata)` / `--- thinking` / `--- llm message`). Not raw code dumps.
- **metadata:** lightweight fields that tell you what an object is without loading its content. Varies per object type. Minimum sets are provisional and specified in §24 (Part II).
- **additional fields (optional):** genuinely separate things beyond the default content. E.g. a generated summary, an alternative representation. Not for nesting document structure — that goes inside content. An additional field is for something the LLM doesn't have to see but can optionally access.
- **relations:** references to other documents (derived from content and/or stored explicitly).

### 4.2.1 Default metadata view

Each object can define a **`view`** field that specifies which of its fields should be exposed in the metadata view (what the LLM sees when the object is inactive in the metadata pool). If blank/absent, the system uses type-specific defaults.

This allows per-object customization. E.g. if you add both `short_summary` and `long_summary` as additional fields, you can set `view` to include `short_summary` but not `long_summary` in the metadata presentation.

### 4.3 Hashing

**Versioning is timestamp-based** (see §7). Hashing is a separate concern from version lookup.

Three required hashes on every object (SHA-256):
- **`content_hash`**: hash of the default content field. Enables change detection without loading content, deduplication, cache efficiency.
- **`metadata_view_hash`**: hash of all fields that appear in the metadata view (as a group). Enables quick check of whether the metadata presentation changed.
- **`object_hash`**: hash of all fields together (excluding timestamps and hashes themselves). Single-comparison "has anything changed?" check.

Additional content fields (e.g. `short_summary`, `long_summary`) should get their own hashes when added. Small string fields (tool name, path, nickname, args) do not need individual hashes — use judgment. The three hashes above are sufficient for v0.

Hashes auto-update when the underlying fields change. Hashes are **top-level only** for now — if content contains nested document structure, we do not hash the internals separately.

Derived fields (embeddings, computed indices) are irrelevant to hashing.

### 4.4 Minimum metadata

Every object must have metadata sufficient to tell you what it is without loading content. The specific fields vary by type and are provisional — see §24 (Part II) for the current minimum field sets per type. These are a starting point and do not lock anything in. The requirement here is only: metadata exists, is lightweight, and is meaningful to the LLM.

### 4.5 References are document structure
The agent writes references in Markdown as plain wikilinks (`[[object-id]]`). The system parses these into **structured document fields** — references are stored as object references within the document, not as raw strings. The Markdown is an input representation; the store holds structured documents.

## 5) Context model

There are three levels, each a subset of the one above:

1. **Index (global, persists across sessions):** all objects the system has ever seen, across all sessions. The full database. Objects enter the index when first discovered (via `read`, `ls`, `find`, `grep`, `write`, `edit`, or background watcher). Objects are never removed from the index — deletion on disk creates a new version with null content/path, but the object and its history remain.
2. **Metadata pool (per-session, starts empty):** the subset of the index that this session's agent knows about. Each object in the metadata pool is visible to the agent as a metadata entry (type, path, status, etc. — lightweight). Append-only within a session: objects are added but not removed. The metadata pool starts empty when a new session begins — objects from previous sessions exist in the index but are not automatically visible. They re-enter the metadata pool when the agent discovers them again (via `read`, `ls`, `find`, etc., which detect the object is already indexed and skip re-indexing).
3. **Active context (per-session):** the subset of the metadata pool whose content is currently loaded in the active content pool.

From the agent's perspective, objects are in one of three states:
- **Active**: content loaded. The agent can see it.
- **Inactive** (metadata-only): the agent knows the object exists and can see its metadata, but content is not loaded.
- **Not present**: not in this session's metadata pool (may exist in the index but the agent doesn't know about it).

Changing context means **activating or deactivating objects** — promoting inactive to active (load content) or demoting active to inactive (collapse to metadata). Adding new objects to the metadata pool happens via `read`, `ls`, `find`, `grep`, etc.

### 5.1 Files float separately
File/note objects are loaded alongside chat, not embedded in it. They have their own versioning and caching. When a file is active, its content is present; when inactive, only its metadata is visible.

### 5.2 Reference navigation from active objects
If an active object contains references to other objects (e.g. a loaded file has wikilinks to other files), the system can bring in **metadata** for those referenced objects — making them inactive/visible without loading their full content. The reference graph is navigable from whatever is active.

### 5.3 Key rule
The agent should **not** keep re-loading what is already in context.

## 6) Context operations

These operate on **any object**, not just toolcalls.

### 6.1 Deactivate (active → inactive)
- An active object is demoted to metadata-only. Content removed from the active pool.
- For toolcalls: the chat message sequence is unaffected (it always has metadata references). The toolcall object's content is removed from the active content pool.
- For files/notes: the content is unloaded from the active pool; metadata remains visible.

### 6.2 Activate (inactive → active)
- An inactive object's content is loaded into the active content pool.
- The agent can explicitly request activation of any object it can see in its metadata set.

### 6.3 Load (not present → active or inactive)
- An object not currently in context can be brought in, either as active (with content) or inactive (metadata only).

### 6.4 Default behavior: auto-activation of recent toolcalls
- Recent toolcall objects are **auto-activated** (content in active pool). Older ones are **auto-deactivated** (content removed from active pool). The threshold is configurable (default: last ~5 toolcalls within the current turn, last ~3 turns of toolcalls).
- The chat message sequence never changes due to activation/deactivation — it always has metadata references for tool results.
- The agent can explicitly:
  - **Activate** any toolcall object to see its output.
  - **Pin** a toolcall object (stays active until explicitly deactivated).
- Context management tool calls (activate/deactivate) do not count toward the auto-deactivation window.
- Later: token-budget-based deactivation (small results kept active longer, large results deactivated faster). Not for now.

### 6.5 Automatic toolcall summarisation (optional, not v0)
- After a toolcall, a small summariser can generate 1–2 line summary fields.
- This summary would appear in the metadata reference in the chat. Not required for v0.

## 7) Versioning semantics

### 7.1 Object identifiers
- Every object has a **stable identifier** that persists across all versions. This is what the LLM usually works with — just the object ID, without thinking about versions.
- Versions are addressed by **transaction timestamp** (primary lookup) with per-field **hashes** stored alongside for verification and diffing (see §4.3). The LLM doesn't need to deal with any of this unless it explicitly wants a historical state.

### 7.2 Two kinds of references: dynamic and static

**Dynamic references** (latest version):
- Point to an object by its stable ID. Resolve to whatever the current version is.
- This is what the **LLM writes** — `[[object-id]]` in notes, plans, file-to-file links.
- File-to-file references are dynamic: if the referenced file changes, you want the latest.

**Static references** (pinned to a version):
- Point to an object at a specific point in time. Include enough information to both resolve and verify.
- A static reference records: **object ID, transaction timestamp, content_hash, metadata_view_hash, object_hash**.
- This is what the **system generates** — in chat history, to record exactly what was loaded at that time for later reproducibility.
- Toolcall references are typically static: the content doesn't change (you might append metadata fields, but the content field is frozen).
- Primary resolution is by **timestamp** (the database can look up "this object as-of time T"). Hashes are for verification — confirming the resolved content matches what was originally recorded, catching clock errors, enabling diffs.

**Who writes which kind:**
- LLM writes → dynamic references (it doesn't think about versions)
- System records → static references (for chat history reproducibility)

### 7.3 No double-injection of old + new
- If an object is edited, the agent should not automatically carry both versions.
- Default is: active context points to the current selected version.
- Older versions are only exposed if explicitly requested.

## 8) References and graph

### 8.1 References inside documents (location matters)
- Documents can contain **references inside any field**, not only top-level "edges".
- The **path/location** of a reference within a document matters (e.g. chat turns, toolcall slots within the chat document).
- The reference graph may contain **cycles**; do not assume DAG-only.
- References support:
  - "latest" resolution (via stable ref / dynamic)
  - "pinned version" resolution (via timestamp + hash / static)
  - optional **field/path targeting** (e.g. referencing the `content` field vs metadata), so expand/select can be precise.

### 8.2 Graph semantics
- Links between objects are first-class.
- Search/listing should generally return **metadata-only** entries; full content is loaded only when activated.

### 8.3 Relations
Relations can come from:
- **document-derived** structure (wikilinks/tags/frontmatter parsed into structured refs)
- optional explicit typed relations (when needed)

The graph is not necessarily a separate system; it can be derived on demand or cached/indexed for speed.

## 9) Expand/select semantics (critical)

Support deterministic structural operations like:
- "expand the `content` field of these references"
- "expand all toolcall references inside this chat document"
- "expand only metadata for these refs"

Expansion must respect **pinned versions** when the reference is static.

## 10) Markdown's role

Markdown is treated as:
- a **native input format** for durable "notes" (Obsidian-like)
- a **DSL** for expressing links (`[[ref]]`), tags (`#tag`), frontmatter metadata (YAML)

The system parses Markdown into structured documents. The store holds structured documents, not Markdown strings. The agent writes Markdown; the system understands it.

Not all objects need to be Markdown. Not all metadata needs to be expressible in Markdown.

## 11) Substrate requirements

These are the capabilities required of the underlying store. They are substrate-agnostic — any database satisfying them is acceptable.

### 11.1 Documents are the unit
- The primary stored entities are **documents** (objects = documents) with nested fields.
- Documents are almost always text / structured text.
- Not a blob store. Non-text/binary is handled as references to external storage.

### 11.2 Versioning + stable refs
- Each document has immutable versions.
- Stable logical refs resolve to latest by default.
- Pinned references resolve to a specific version (by hash or timestamp).
- The LLM should not need to think about versioning unless it explicitly wants a historical state.

### 11.3 References inside documents
- References can appear inside any field, not only top-level edges.
- Path/location of a reference within a document matters.
- The reference graph may contain cycles.
- Must support latest resolution, pinned version resolution, and optional field/path targeting.

### 11.4 Live query/index
- Fast queryable view over document fields/metadata and relationships/backlinks.
- Must support metadata-only queries (no full content load).

### 11.5 Expand/select over references
- Deterministic structural expansion as described in §9.
- Must respect pinned versions.

### 11.6 Portability at rest
- Documents and version history must be exportable/importable and usable outside the live DB.
- Prefer inspectable, robust representations over opaque engine-only state.

### 11.7 Extensibility without brittle schemas
- Metadata and additional fields are flexible and optional.
- Derived fields can be added later without migrations.

## 12) Ingestion requirements

### 12.1 Filesystem / Obsidian-like notes
- A Markdown file emits versions by hashing content.
- Path is not identity — if a file moves but content stays the same, it is the same **object** with a new **version** (same `content_hash`, changed path/metadata).
- Content changes → new version. Deleted → marked orphaned.

### 12.2 Toolcall results
- Each toolcall produces a toolcall object. The content field is the stdout/output. No separate payload objects — the toolcall object holds everything.

### 12.3 Chat history
- Chat document references memory objects, toolcall objects, and user objects.
- References are version-aware (static).

### 12.4 External pointers (later)
- Objects may point to external stores via optional pointer fields.

## 13) Minimal canonical fields (small core, extensible)

Every object has at minimum:
- `id`: stable UUIDv7 (minted on first index)
- `type` (file/toolcall/chat/session/note/user/etc.)
- `content`: default content field (required to exist, may be null; what `activate` loads)
- `content_hash` (SHA-256)
- `metadata_view_hash` (SHA-256)
- `object_hash` (SHA-256)
- `provenance` (flexible):
  - origin (file path if applicable; toolcall id; user input)
  - generator (human/agent/tool)
  - optional parent refs (e.g. derived-from)

Type-specific minimum metadata: see §24 (Part II, provisional).

Optional on any object:
- `nickname`: human-readable name (unique if present)
- `view`: defines which fields are exposed in the metadata view (overrides type defaults)
- Additional content fields (e.g. `short_summary`, `long_summary`) with their own hashes

Everything beyond the minimum is optional / additive.

## 14) Indexing and derived layers

The store should allow adding layers incrementally:
- full-text index
- vector index (embeddings)
- entity extraction
- summaries (short + long)
- trust/confidence annotations

These are **derived layers** and should not be required for correctness.

---

# Part II: Design Choices

These are pragmatic decisions. They can be changed without violating Part I.

## 15) Substrate: XTDB

**XTDB** (standalone mode, simplest deployment — SQLite backend, single process).

Why XTDB satisfies the requirements:
- Schemaless document store (§11.1).
- EAV indexing — every field queryable without declaring schemas. Supports metadata-only queries (§11.4).
- Datalog query — graph traversal for reference navigation, including cycles (§11.3).
- Bitemporality — transaction time provides version history for free. Every `put` of the same document ID creates a new temporal version. Old states retained and queryable (§11.2).
- Documents are EDN maps, exportable as JSON/EDN. Transaction log replayable (§11.6).
- Standalone SQLite: single JVM process, single file, no infrastructure beyond JVM.
- "Unbundled database" (Kleppmann): storage, indexing, and query decoupled.

### 15.1 How objects map to XTDB

One XTDB document per object. `:xt/id` = the stable object identifier.

Versioning comes from XTDB's bitemporality: every `put` of the same `:xt/id` creates a new temporal version internally. Old states are retained and queryable. No separate version documents or ref-to-version pointers needed.

- **Dynamic reference** (latest): just the object ID. Normal XTDB get.
- **Static reference** (pinned): primarily resolved by **transaction timestamp** — XTDB natively supports "give me this object as-of time T" via entity-history. Hashes (`content_hash`, `metadata_view_hash`, `object_hash`) stored on the reference for verification.

The system writes static references into chat history automatically — stamps the current transaction time and field hashes when an object is loaded. Later replay/inspection pulls exactly what was there and can verify integrity.

## 16) Architecture: context management layer

This is a **context management layer** that slots into an existing agent harness. It fully controls what the LLM sees, while the host harness handles everything else (tool execution, TUI, user-facing session management, streaming).

- **Pluggable.** Slots into OpenClaw, Pi coding agent, or any harness that exposes a context-assembly hook and tool registration.
- **The execution loop is not ours.** The host runs the React loop (prompt → tool calls → execute → repeat). We don't implement or modify it.
- **We control what the LLM sees.** We replace the host's context assembly entirely. The host's messages array is a raw log; we assemble our own context from our pools and return that to the LLM.
- **We intercept tool results** to index files and enrich output, but tool execution itself is the host's responsibility.

## 17) Object creation

**Agent writes markdown files.** Keep it simple. The agent is encouraged to write markdown files extremely often — normal Obsidian-style. The system parses, understands, and auto-updates the store.

- Agent writes a `.md` file → system parses it into a structured document with content + metadata + relations.
- Frontmatter/wikilinks/tags parsed to derive relations and metadata fields.
- File location stored in metadata.

**What gets content-indexed:** text and text-like files only (markdown, json, code, etc.). Non-text files (mp4, images, etc.) get metadata objects but no content stored.

## 18) Files as first-class objects (tool integration + filesystem tracking)

Files are special. We do not want them to exist only as transient toolcall outputs. Once the agent touches a file, it should become a first-class object with stable metadata and automatic versioning.

### 18.1 Tool integration

The agent's tool surface for file interaction has four **new tools** (ours) and several **wrapped tools** (harness built-ins with our side effects added).

#### New tools (ours)

- **`read(path)`** — filesystem entry point. Takes a file path. Three-step pipeline:
  1. **Index:** read the file from disk. If it fails (doesn't exist, permission error, etc.) → return failure. If the file is not in the global index, create a file object. If already indexed, check if content changed on disk and update if needed.
  2. **Metadata pool:** add the file object to this session's metadata pool (the session-specific subset of the index shown to the agent). If already in the metadata pool → skip.
  3. **Activate:** load the file's content into the active context pool. If already active → refresh if changed, otherwise skip.
  The `AgentToolResult` (what goes into `context.messages`, user-visible via TUI) includes the file content — the user sees the file in the terminal. The LLM does not see this tool result directly; our `transformContext` replaces it with a metadata reference. The LLM sees the file content via the active content pool instead. Includes a reminder to use `activate` for objects already in the metadata pool.
- **`activate(id)`** — object entry point. Takes an object's metadata name/id (not a file path). Updates XTDB state immediately (adds to active set). The content appears in the LLM's context on the **next `transformContext` call** — in Pi, this is the next mini-turn within the same `prompt()` invocation (tool call → result → transformContext → next LLM call), not a full user turn. The tool result itself confirms activation but does not include the content. Assumes the object is already in the metadata pool. Later: field-level activation. For now: on/off for the default content field. Some objects are **locked** and cannot be deactivated (see §20.1).
- **`deactivate(id)`** — collapse an active object to metadata-only. Removes content from active context, keeps metadata visible. Fails silently (or with a message) on locked objects.

The agent does not have to discover a file via `ls`/`find` before reading it. `read(path)` handles the full pipeline. `activate(id)` is for objects already in the metadata pool.

#### Wrapped tools (harness built-ins + our side effects)

- **`write(path, content)`** — delegates to harness for actual FS write. Side effect: create or update the file object (new version with new content hash).
- **`edit(path, changes)`** — delegates to harness for FS edit (diff logic, conflict detection). Side effect: update the file object (new version).
- **`ls(path, …)`** — delegates to harness. Side effect: parse discovered paths, index metadata-only file objects for each, add to metadata pool.
- **`find(args…)`** — same as `ls`: delegates, parses paths, indexes metadata-only, adds to metadata pool.
- **`grep(args…)`** — delegates to harness. Side effect: parse file paths from output, index metadata-only for those files, add to metadata pool. Grep output itself is a normal toolcall output object (ephemeral).

**Note on output parsing:** Path extraction from `ls`/`find`/`grep` output is **best-effort**. Output format varies with flags and platforms. Some paths may be missed. This is acceptable — the agent can always `read` files explicitly. Do not build a fragile parser that treats missed paths as bugs.

#### Observed tools (harness executes, we watch)

- **`bash(command)`** — harness executes. We observe via event subscription and best-effort update the index/metadata pool for files involved. Complex bash chaining attribution remains an open problem (see Open questions).

#### Key distinction: file objects vs toolcall output objects

File operations (`read`/`write`/`edit`) operate on **persistent file objects**. Reading a file does not create a new output object each time — it activates the one file object. Writing/editing creates a new version of that same object. One object per file, versioned.

Other tool outputs (bash results, grep output, arbitrary commands) produce **ephemeral toolcall output objects**. New object each time. Normal collapse lifecycle. This is fine for transient results.

### 18.2 Filesystem tracking (background)

Once a file is indexed (exists as a file-backed object), we track it automatically in the background. This is not a hack — use proper filesystem watching:
- Node `fs.watch` (simple, sometimes flaky across platforms)
- Prefer **chokidar** for robust cross-platform watching (inotify/FSEvents/etc.)

File tracking responsibilities:
- If the real file's **content changes**, create a new version (new hashes, new timestamped version).
- If the file **moves/renames**, update path in metadata (new version with updated path, same content if unchanged).
- If the file is **deleted**, create a new version with **null content and null path**. The object remains in the index — it is not removed. Earlier versions (which may be referenced by chat history or other objects) are preserved. The metadata pool entry shows the object as deleted/missing.

Nothing is ever removed from the index. Deletion on disk means a new version that says "no longer exists." Cleanup of unreferenced objects is a later concern.

This watcher updates the DB/index, but it does not by itself decide what is loaded into the model's context — that's still controlled by the session pools.

### 18.3 What gets indexed

- Files the agent **reads** or **directly edits**.
- Files that appear in `ls`/`find`/`grep` results (discovery tools).
- Text/text-like files get content stored. Non-text files get metadata only.

Principle: we do not index "everything on disk" — we index what the agent touches/learns about.

### 18.4 Other tools

All other tools are just tools + output objects. They can still mention files. We observe tool executions (write/edit/bash/etc.) and, where possible, update the index and metadata pool for files involved. Handling complex bash chaining reliably is an open problem (see Open questions).

## 19) Toolcall handling

Tools execute through the harness (or our wrappers — see §18.1). Each execution produces a **toolcall object**:
- Content field = stdout/output.
- Metadata = tool name, args, status, optional summary.
- References back to the chat turn that triggered it (bidirectional).
- References to files indexed/activated/modified.

The **chat document** records toolcall metadata references inline (tool name, args, status, toolcall object ID). The actual output **never** appears in the chat message sequence — it lives on the toolcall object and is accessed via the active content pool when the toolcall is activated.

In the LLM's `Message[]`, each toolcall appears as:
- A `ToolCall` object in the `AssistantMessage.content[]` (as produced by the LLM — preserved)
- A `ToolResultMessage` with **short metadata content** (toolcall ID, tool name, status, optional summary) — satisfying the provider requirement that every `ToolCall` has a matching `ToolResultMessage`, while keeping the chat message sequence stable

The actual stdout/output appears separately in the active content pool (if the toolcall object is activated). Recent toolcalls are auto-activated; older ones are auto-deactivated. See §6.4.

**User-visible vs LLM-visible:** The `AgentToolResult` (what goes into `context.messages` for TUI display) includes the full output — the user sees it in the terminal. Our `transformContext` replaces this with the metadata reference for the LLM.

## 20) Agent context API

The agent's context tools:
- **`read(path)`** — index + metadata pool + activate. Filesystem entry point. See §18.1.
- **`activate(id)`** — load object's default content field into context. Object entry point.
- **`deactivate(id)`** — collapse to metadata only. Denied on locked objects.

The metadata pool is always injected — the agent sees all known objects with their metadata by default. Richer querying (list/filter over metadata, inspect document structure/keys, field-level activation, graph queries) is deferred to later iterations. For now: on/off for the default content field.

The system emits the current active/inactive sets as part of each turn. Recent toolcall objects are auto-activated and older ones auto-deactivated (configurable thresholds; see §6.4).

### 20.1 Locked objects

Some objects are **locked** — the agent cannot deactivate them. They are always active. If the agent tries to deactivate a locked object, the operation is denied (with a message).

Locked by default:
- **Chat object** — always present. (Later: the agent may be able to "close" a chat and start a new one, but that's not deactivation.)
- **System prompts** — our system prompt and the user's/host's system prompt. These are always-on. In Pi they are rendered via the `systemPrompt` field (not as normal messages). They may still be stored as objects in XTDB for inspection/versioning, but the agent cannot deactivate them.

Everything else (files, toolcall objects, additional content) is unlocked — the agent can activate and deactivate freely.

This is not a special architectural case. Locked objects are still regular objects in the same store with the same structure. "Locked" is just a flag that the activate/deactivate tool checks.

## 21) Context assembly and caching

### 21.1 Three pools

The context is three pools:
1. **Metadata pool** — all known objects with their metadata. Append-only (entries added, not removed). Entries are small (2–3 lines each).
2. **Chat history pool** — the chat rendered as proper `Message[]` (user/assistant/toolResult). `ToolResultMessage` content is always short metadata references (toolcall ID, tool name, status). Append-only (new turns added at end). Stable — tool results never change between inline and expanded.
3. **Active content pool** — the content of currently activated objects (files, toolcall outputs). Volatile — changes as the agent activates/deactivates objects. Each active object is a separate block.

### 21.2 Assembly into Message[]

The pools are assembled into the `Message[]` that the LLM sees. Ordering for cache efficiency:

1. **System prompt** (via `systemPrompt` field, not in messages). Fully stable.
2. **Metadata pool** — rendered as one or more messages at the start of the sequence. Append-only (new entries added at end, old entries never change). Stable prefix.
3. **Chat history** — proper `UserMessage`/`AssistantMessage`/`ToolResultMessage` sequence. `ToolResultMessage` content is always metadata references. Append-only. Stable prefix.
4. **Active content pool** — activated objects' content, rendered as messages after the chat. Volatile — changes on activate/deactivate.

This ordering means: system prompt caches perfectly, metadata pool caches well (prefix stable, new entries at tail), chat history caches well (prefix stable, new turns at tail), active content breaks cache only for its own portion.

The exact `Message` roles and content format for metadata pool entries and active content blocks are implementation details (see open questions). The ordering is the design decision.

### 21.3 Permanent context (cannot be turned off)

- **System prompt** — always present. In Pi this is rendered via the `systemPrompt` field (not as a normal message).
- **User/host system prompt / agents.md** (if provided) — always present. May be stored as an object in XTDB, but rendered in the always-on portion of the prompt.
- **Chat history** — always present (chat object is locked).

### 21.4 Caching

The append-only structure of the metadata pool and chat history is designed to work with provider-level prompt caching (e.g. Anthropic's cache, OpenAI's cache, as exposed through pi-ai):
- System prompts: fully cached, never recomputed.
- Metadata pool: stable prefix, new entries appended.
- Chat history: stable prefix, new turns appended.
- Active content: volatile, cached opportunistically.

### 21.5 Metadata presentation

Metadata is structured text, exposed reasonably raw. What the LLM sees for an inactive object is determined by the object's **`view`** field (if set) or the type-specific defaults (see §4.4).

For a file object, default metadata view: path, file type, char count, nickname (if set).
For a toolcall object, default metadata view: tool name, args, status.

Optional fields like `short_summary` appear in the metadata view only if the object's `view` includes them.

When `ls` runs, metadata entries for listed files are brought into the metadata pool.

## 22) Integration: Pi SDK

Initial implementation targets the Pi stack (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`). This is a design choice — the concepts are not Pi-specific.

### 22.1 Pi stack layers

- **`pi-ai`**: Unified LLM API. Handles streaming, tool calls, multi-provider, context serialization. Context sent to the LLM is `{systemPrompt, messages, tools}`. This is what talks to providers. Both us and the host use this — it's the shared abstraction for provider communication.
- **`pi-agent-core`**: Agent framework. Runs the React loop. Maintains an `AgentMessage[]` array (the raw conversation log). Provides `transformContext`, `convertToLlm`, custom message types, tool definitions (`AgentTool`), steering/follow-up. Events fire when messages are added to the array (TUI subscribes to these).
- **`pi-coding-agent`**: Terminal coding agent. Has extensions, skills, built-in tools (read, write, edit, bash), sessions (JSONL persistence), compaction, TUI.

### 22.2 Harness boundary model

#### Canonical state

**We are canonical.** XTDB holds the true context state — chat history, indexed objects, pool membership, active/inactive sets. The harness's message array (`context.messages` in Pi) is an **event source** we consume, not a state store we synchronize with.

The harness's message array is what the **user** sees (via TUI/events). Our assembled output from `transformContext` is what the **LLM** sees. These are independent views. We never write to the harness's message array.

#### Update processing, not full-state processing

We do not re-process the entire `context.messages` array on each call. We maintain a **cursor** — the index up to which we've already processed. Each `transformContext` call, we look at `messages[cursor:]` for new entries. These are **events**:

- New `UserMessage` → "user said X"
- New `AssistantMessage` → "LLM responded with Y (including any tool calls)"
- New `ToolResultMessage` → "tool W returned result R"

We process these events into XTDB state (append to chat object, create toolcall objects, index files, update pools), then advance the cursor.

#### Discrepancy handling

The harness mutates its message array. In Pi, `agent.replaceMessages()` can swap the entire array (used by compaction, session restore). If this happens:

- Our cursor is invalidated (the message at our cursor position may not match).
- We detect the inconsistency and **reset the cursor** to the end of the new array.
- Our XTDB state is unaffected — we lose no information. The harness lost messages from its view; we didn't.
- We continue processing new events from the reset position.

If the harness injects messages we don't understand (custom types, steering messages, internal notifications), we skip them. If a tool result in `context.messages` differs from what we indexed at execution time, we trust what we indexed.

#### Adapter model

The harness boundary is not uniform across hosts. Each harness has its own message types, mutation patterns, tool APIs, and event systems. We use **adapters** — thin translation layers per harness.

An adapter's responsibilities:
1. **Extract events.** Read the harness's event source (e.g. `context.messages` in Pi), maintain cursor, detect resets/replacements, translate to our internal event types.
2. **Register tools.** Translate our tool definitions into the harness's tool API (e.g. `AgentTool` in Pi).
3. **Return context.** Translate our assembled context (from pools) into the harness's expected return type (e.g. `AgentMessage[]` for `transformContext` in Pi).
4. **Absorb quirks.** Handle harness-specific mutation patterns, custom message types, lifecycle events.

Our core system is harness-agnostic: it processes events, maintains XTDB state, assembles context. The adapter is the boundary.

**Minimum requirements from any harness** (for full integration):
1. A context-assembly hook (function that controls what the LLM sees).
2. Tool registration and replacement.
3. Tool execution events (to observe non-replaced tools).
4. Session IDs (to key our state to theirs).

If a harness provides fewer of these, integration is degraded but still possible (less control, more best-effort).

### 22.3 Pi-specific adapter: concrete types

In pi-agent-core, the call sequence per LLM invocation:

```
context.messages (AgentMessage[]) → transformContext(messages, signal) → AgentMessage[] → convertToLlm(messages) → Message[] → { systemPrompt, messages, tools } → pi-ai → provider
```

#### Harness side types (what we receive)

`context.messages` is a mutable `AgentMessage[]`. The agent loop pushes messages onto it in place during execution. Events fire on each push (TUI subscribes).

`AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`

The three standard message types (from pi-ai `types.ts`):

```typescript
UserMessage {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string, provider: string, model: string
  usage: Usage, stopReason: StopReason
  timestamp: number
}

ToolResultMessage {
  role: "toolResult"
  toolCallId: string, toolName: string
  content: (TextContent | ImageContent)[]
  details?: any, isError: boolean
  timestamp: number
}
```

`transformContext(messages: AgentMessage[], signal?: AbortSignal)` is called once per LLM invocation — after all tool results from the previous turn are appended, before the next LLM call.

Custom `AgentMessage` types can be defined via declaration merging on `CustomAgentMessages`.

#### LLM side types (what we produce)

`convertToLlm(messages: AgentMessage[]) → Message[]` produces the standard pi-ai types above. These go into:

```typescript
Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

Which pi-ai sends to the provider. Provider-level caching is prefix-based (longest matching `Message[]` prefix).

#### Tool types

Pi tools are `AgentTool` (extends `Tool` from pi-ai with `label` and `execute`):

```typescript
AgentTool {
  name: string
  label: string          // human-readable, for TUI
  description: string
  parameters: TSchema    // TypeBox schema
  execute: (toolCallId, params, signal?, onUpdate?) → Promise<AgentToolResult>
}

AgentToolResult {
  content: (TextContent | ImageContent)[]
  details: any
}
```

Tool results are wrapped by the agent loop into `ToolResultMessage` and pushed onto `context.messages`. The user sees this via TUI events. The LLM sees whatever our `transformContext` returns — tool results are decoupled from LLM context.

#### What we implement in the Pi adapter

- **`transformContext`**: consume events from `context.messages` (cursor-based), update XTDB, return assembled context.
- **`convertToLlm`**: render our custom `AgentMessage` types into standard `Message[]`.
- **`systemPrompt`**: set via `agent.setSystemPrompt()`.
- **Tool registrations**: `read`, `activate`, `deactivate` as `AgentTool` definitions. Wrapped versions of `write`, `edit`, `ls`, `find`, `grep` that delegate to host implementations and add side effects. Observation of `bash` and other tools via `tool_execution_end` events.

#### What we don't touch

Agent loop, tool execution pipeline, streaming, event emission, TUI rendering, session management, `context.messages` mutation — all stay as-is.

### 22.4 Ownership summary

| Concern | Host | Us |
|---|---|---|
| React loop (prompt → tools → repeat) | ✓ | |
| Tool execution for wrapped tools (write/edit/ls/find/grep) | ✓ (delegated) | ✓ (side effects: index + metadata pool) |
| Tool execution for observed tools (bash, other) | ✓ | ✓ (observe via events, best-effort) |
| New tools (read/activate/deactivate) | | ✓ |
| Tool streaming and output | ✓ | |
| Events → TUI rendering | ✓ | |
| What the user sees | ✓ (via `context.messages` + events) | |
| User-facing session management (create, resume, list) | ✓ | |
| Raw message log (`context.messages`) | ✓ (owns, mutates) | reads as event source |
| What the LLM sees (assembled context) | | ✓ |
| Canonical context state | | ✓ (XTDB) |
| System prompt content | | ✓ |
| Context state (active/inactive objects, pools) | | ✓ |
| Session state persistence (chat object + pools) | | ✓ (keyed to host session ID) |
| Token counting / context window management | | ✓ |
| Caching strategy | | ✓ |

**Token counting:** The LLM response reports usage based on what it actually processed — our assembled context. Since our context goes up and down (objects activate/deactivate), the reported token counts naturally reflect our managed context, not the host's ever-growing messages array. The host displays these counts to the user.

**Caching:** We control message order in what we return from `transformContext`. Provider-level prompt caching (Anthropic, OpenAI) is prefix-based — the longest matching message prefix gets cached. Our append-only pools produce stable prefixes. Caching strategy and optimization is our responsibility.

### 22.5 Tool ownership

**New tools (ours, registered as `AgentTool`):**
- `read(path)` — index + metadata pool + activate. Replaces the host's `read` entirely.
- `activate(id)` — load object content into context.
- `deactivate(id)` — collapse to metadata only. Denied on locked objects (see §20.1).

**Wrapped tools (host executes, we add side effects):**
- `write`, `edit` — host handles FS mechanics; we intercept to update file objects (new versions).
- `ls`, `find`, `grep` — host handles execution; we intercept to index discovered files + add to metadata pool.

For wrapped tools, the LLM calls the same tool names. Our wrappers delegate to the host's original implementations, then run side effects. The host's TUI sees tool output via events as normal.

**Observed tools (host executes, we watch):**
- `bash` and other non-file tools — host executes; we subscribe to execution events and best-effort update index/metadata pool for files involved.

See §18.1 for full details on per-tool semantics.

### 22.6 Session keying

The host manages session lifecycle (create, resume, list, display). We store our own session state (chat object, metadata pool, active/inactive sets, XTDB transaction pointers) keyed to the host's session ID.

On session resume:
- Host loads its session (JSONL) → fires session event → we get the session ID
- We load our corresponding state from XTDB
- We reconstruct the context (pools, active set) from our stored state
- Next `transformContext` call assembles context from our state

The host's session file (JSONL) is the raw conversation log for the user. Our XTDB state is the managed context state for the LLM. They're parallel, keyed to the same session ID.

### 22.7 Compaction

**Host compaction:** The host's compaction (Pi's auto-compaction) only affects what the LLM sees, not what the user sees — it works through the same `transformContext` mechanism. Since we replace `transformContext`, the host's compaction has no effect. We don't need to explicitly disable it; it simply doesn't run because we own the hook.

**Our compaction (optional/future):** Should rarely be needed — our context management (activate/deactivate, metadata-only for inactive, auto-activation/deactivation of recent toolcalls) keeps context bounded. The expensive parts of context are toolcall outputs and file contents, not chat history (user/assistant messages are cheap).

If compaction is ever needed:
- Generate a **long summary** and **short summary** of the chat history.
- The previous chat becomes a regular object: long summary as the content field, short summary as metadata.
- The agent can choose to load/unload the long summary, or expand the full chat object (or parts of it — "last 10 messages/toolcalls").
- Full partial loading requires **object slicing/projection** (load a structured sub-range of a document), which is a later feature.

### 22.8 Not Pi-specific

The integration requires from an external harness:
1. **A context-assembly hook** — a function that takes the raw message history and returns what the LLM should see. (`transformContext` in Pi.)
2. **Tool registration + replacement** — ability to register custom tools and replace existing ones (e.g. replace the host's `read` with ours). (`AgentTool` in Pi.)
3. **Tool execution events** — ability to observe non-replaced tool results for indexing. (Event subscription in Pi.)
4. **Session IDs** for keying our state to theirs.

OpenClaw (which uses pi-agent-core under the hood), or any other harness exposing these, can host this system. The provider communication layer (pi-ai) is shared.

## 24) Provisional document shapes

**Status: provisional.** Minimal starting set. Does not lock us in. Objects are extensible — fields can be added without migration. New types can be introduced later.

Three real document types (file, toolcall, chat) plus session as bookkeeping. Notes/memory files are structurally file objects.

All documents share a common base shape, then have type-specific fields.

### 24.0 Common base (all objects)

```
id:                 uuid        (required, stable, minted on first index)
type:               string      (required: "file" | "toolcall" | "chat" | "session")
nickname:           string?     (optional, unique if present, human-readable alias)
content:            string?     (required to exist; may be null — default content field; what activate loads)
locked:             boolean     (if true, agent cannot deactivate this object. default false)
provenance: {
  origin:           string      (file path / toolcall context / "user-input" / etc.)
  generator:        string      ("human" | "agent" | "tool" | "system")
  parent_refs:      ref[]?      (optional, e.g. derived-from)
}
content_hash:       string      (hash of content field)
metadata_view_hash: string      (hash of all fields in the metadata view, as a group)
object_hash:        string      (hash of all fields excluding timestamps and hashes)
```

Timestamps (created_at, updated_at) are handled by XTDB bitemporality — transaction time IS the timestamp. Explicit timestamp fields only if we need something XTDB doesn't give us natively.

Optional on any object (not v0):
- `view`: string[] — which fields to expose in named views (metadata view, content view). Null = type defaults.
- Additional content fields get their own hashes when added.

### 24.1 File objects

```
id:                 uuid
type:               "file"
content:            string?     (file text; null for non-text/binary or deleted files)
path:               string?     (filesystem location, absolute; null if file deleted from disk)
file_type:          string      ("markdown" | "python" | "json" | "typescript" | "binary" | ...)
char_count:         integer     (length of content; 0 if content is null)
nickname:           string?
provenance:         { origin: path, generator: "human" | "agent" | "tool" }
content_hash:       string
metadata_view_hash: string
object_hash:        string

--- optional (not v0) ---
short_summary:      string?
long_summary:       string?
view:               string[]?
derived: {                      (parsed from markdown — later)
  links:            ref[]
  tags:             string[]
  frontmatter:      map
}
```

**Metadata view (default):** id, type, path, file_type, char_count, nickname.
**Content:** activate loads content field (the file text).
**Versioning:** content changes → new version. Path changes → new version. File deleted on disk → new version with null content and null path (object remains in index, earlier versions preserved).
**Notes/memory files:** same shape, `type` can be `"note"` if we want to distinguish later.

### 24.2 Toolcall objects

```
id:                 uuid
type:               "toolcall"
content:            string      (stdout/output — what the LLM would normally see as tool result)
tool:               string      (tool name: "bash" | "grep" | "read" | "write" | "edit" | "ls" | "find" | ...)
args:               string      (the command / arguments as a single string)
status:             string      ("ok" | "fail")
chat_ref:           ref         (reference to chat object — static ref with position/turn index)
file_refs:          ref[]?      (references to files indexed/activated/modified, if any)
provenance:         { origin: "toolcall", generator: "tool" }
content_hash:       string
metadata_view_hash: string
object_hash:        string

--- optional (not v0) ---
short_summary:      string?
```

**Metadata view (default):** id, type, tool, args, status.
**Content:** activate loads content field (the stdout/output).
**Versioning:** toolcall objects are effectively immutable once written (the tool ran, it's done). New version only if we append metadata later (e.g. a summary).

### 24.3 Chat objects

```
id:                 uuid
type:               "chat"
locked:             true        (agent cannot deactivate the chat object)
content:            string      (conversation history — storage/display format, see below)
turns:              Turn[]      (structured turn data — what the system uses to render Message[])
session_ref:        ref         (reference to session object)
turn_count:         integer     (number of turns, for quick size check)
toolcall_refs:      ref[]       (ordered references to toolcall objects)
provenance:         { origin: session_id, generator: "system" }
content_hash:       string
metadata_view_hash: string
object_hash:        string

Turn {
  user:             string | (TextContent | ImageContent)[]
  assistant:        (TextContent | ThinkingContent | ToolCall)[]
  toolcall_ids:     uuid[]      (references to toolcall objects for this turn)
  assistant_meta:   { api, provider, model, usage, stopReason, timestamp }
}

--- content field (storage/display format, markdown with delimiters) ---
--- user
<user message text>
--- assistant
<assistant message text>
--- toolcall [ref:toolcall/uuid] tool=bash args="ls -la" status=ok
--- assistant
<assistant message text>
```

**Metadata view (default):** id, type, session_ref, turn_count.
**Content field:** the markdown rendering is for storage, display, and human consumption. It is NOT what the LLM sees directly.
**LLM rendering:** the system renders the `turns` data into proper `Message[]` — `UserMessage`, `AssistantMessage` (preserving `ToolCall` objects), `ToolResultMessage` (with short metadata content: toolcall ID, tool name, status). Actual tool output appears in the active content pool when the toolcall object is activated.
**The agent can** activate/deactivate the toolcall objects referenced by the chat, but not the chat itself.
**Versioning:** new version on every turn. Each put is the full document — this is fine; even a 200-turn session is small in absolute terms.

### 24.4 Session objects

```
id:                 uuid
type:               "session"
harness:            string      ("pi" | "openclaw" | ...)
session_id:         string      (the external harness's session ID — what we key to)
chat_ref:           ref         (reference to the chat object)
active_set:         uuid[]      (object IDs with content currently loaded)
inactive_set:       uuid[]      (object IDs in metadata pool, content not loaded)
pinned_set:         uuid[]      (object IDs exempt from auto-deactivation)
provenance:         { origin: session_id, generator: "system" }
object_hash:        string
```

**Note:** the metadata pool is `active_set ∪ inactive_set` — every object the agent knows about. Active objects are a subset that also have their content loaded. The metadata pool is append-only within a session (objects are added, not removed — even deleted files stay with a deleted/missing status).
**Versioning:** new version whenever pool state changes (activate/deactivate/pin/new objects discovered).

### 24.5 What's not here yet (and that's fine)
- **User objects** (§3.4) — large user pastes as objects. Deferred.
- **External pointers** (§3.5) — references to vector DBs, URLs, etc. Deferred.
- **Rich custom tool documents** — tools with structured output beyond stdout. Later.

## 25) Context control principle

The agent loop should treat:
- "load object" as the primary primitive (not repeated raw reads)
- the context as a set of **references to object versions**
- older versions as available by explicit request, not automatically injected

---

# Resolved questions

- **Auto-collapse window:** Replaced by auto-activate/deactivate. Recent toolcalls auto-activated, older ones auto-deactivated. Configurable thresholds (default: ~5 within current turn, ~3 turns back).
- **Version references:** Two kinds — dynamic (LLM writes `[[object-id]]`, resolves to latest) and static (system generates reference with ID + timestamp + hashes, resolved by timestamp, hashes for verification). See §7.2.
- **Metadata set pruning:** Not a priority. Metadata entries are small. The set accumulates; no duplicates, just additions. Pruning can be revisited later.
- **Hash boundary:** Hashes are top-level. Required: `content_hash`, `metadata_view_hash`, `object_hash`, plus hashes for any additional content fields. Hashing is for verification/diffing/caching, not for version lookup — version lookup is timestamp-based. See §4.3.

# Open questions

- **Pool → Message[] rendering details:** Ordering is decided (§21.2): system prompt → metadata pool → chat history → active content. Remaining:
  - What `Message` role and content format for metadata pool entries? (Likely a `UserMessage` with structured text listing all metadata entries.)
  - What `Message` role and content format for active content blocks? (Likely `UserMessage` per active object, with the content field text.)
  - Whether to use custom `AgentMessage` types (via `CustomAgentMessages` declaration merging) as an intermediate step, or render directly to standard `Message[]` in `transformContext`.
- **Metadata pool cleanup:** Deleted files stay in the pool with deleted/missing status. Cleanup of truly unreferenced objects is a later concern. No mechanism specified yet.

# Implementation details to resolve during build

- **XTDB client integration:** How does Node.js communicate with XTDB? Options include HTTP client to XTDB's REST API, or an embedded JVM. Who starts the XTDB process, and when relative to the harness? To be determined during implementation.
- **File watching lifecycle:** When does chokidar start watching? On session start, do we watch all previously-indexed files from the XTDB index? How do we handle files that changed between sessions (watcher was not running)? Likely: on session start, check mtimes of known files and create new versions for any that changed.
- **Tool delegation mechanism (Pi-specific):** To wrap `write`/`edit`/`ls`/`find`/`grep`, we need to call the original tool implementations. Options: save references to original `AgentTool.execute` functions before replacing, or import directly from `packages/coding-agent/src/core/tools/`. To be determined by inspecting the Pi tool registry.
- **Session ID access:** `transformContext` only receives `(messages, signal)`. The adapter needs the session ID (to load XTDB state) from elsewhere — likely captured from the `Agent` object at setup time.

# Resolved but deferred

- **`print(id)` tool:** Bash primitive to dump object content to stdout for piping. Not needed for v0. May be a CLI binary rather than an AgentTool.
- **Bash observation in complex pipelines:** Best-effort file detection from bash command observation. No special parser. If we miss files from `cat foo | grep | sed`, that's acceptable — the agent can always `read` them explicitly.
- **Pi compaction:** Irrelevant. We replace `transformContext`, so the host's compaction never runs. No action needed.
