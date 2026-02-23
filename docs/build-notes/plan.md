# self-context-manager — Build Plan

## What this is

A context management layer that slots into Pi coding agent as an extension. It gives the LLM agent object-level control over its context window. Everything (files, toolcall outputs, chat turns) becomes a versioned object in XTDB. The agent works with references and metadata, not repeated full-text dumps.

**Canonical spec:** `docs/spec/memory-system-v0.md`, `docs/spec/memory-system-v0-fixes.md`, `docs/spec/memory-system-handoff.md`. Read these first. They are the source of truth.

## Architecture overview

```
Pi coding agent (host harness)
  └── self-context-manager extension
        ├── Pi adapter (transformContext, convertToLlm, tool registration)
        ├── Context manager (three pools: metadata, chat history, active content)
        ├── Object store (TypeScript client for XTDB HTTP API)
        ├── File watcher (chokidar, background tracking of indexed files)
        └── XTDB (standalone, SQLite backend, single JVM process)
```

## Build phases

Each phase: implement minimal spec, test, commit. Move to next phase only when tests pass.

### Phase 1: Scaffold + XTDB client

**Goal:** TypeScript project that can start XTDB and do CRUD on versioned documents.

1. Initialize TypeScript project (tsconfig, package.json, build system)
2. Install dependencies:
   - `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent` (types/APIs)
   - `chokidar` (file watching, used later)
   - Test framework (vitest or similar)
3. Install Java 17+ (`apt-get install openjdk-17-jre-headless`)
4. Download XTDB standalone JAR from Maven Central
5. Write start/stop script for XTDB (spawns JVM, waits for ready, provides HTTP endpoint)
6. Build typed HTTP client for XTDB REST API:
   - `put(doc)` — submit a document
   - `get(id)` — get latest version
   - `getAsOf(id, timestamp)` — get version at a point in time
   - `history(id)` — get version history
   - `query(datalog)` — run a Datalog query
7. Implement document types from spec §24:
   - Common base (id, type, content, hashes, provenance, locked, nickname)
   - File object (path, file_type, char_count)
   - Toolcall object (tool, args, status, chat_ref, file_refs)
   - Chat object (turns, session_ref, turn_count, toolcall_refs, locked=true)
   - Session object (harness, session_id, chat_ref, active_set, inactive_set, pinned_set)
8. Implement hashing:
   - `content_hash` = SHA-256 of content field
   - `metadata_view_hash` = SHA-256 of concatenated metadata view fields (see fixes doc §5)
   - `object_hash` = SHA-256 of all fields excluding timestamps and hashes
9. **Tests:**
   - Start XTDB, put a file object, get it back, verify all fields
   - Put a new version (changed content), verify content_hash changed, verify history returns both versions
   - Query by timestamp (getAsOf), verify correct version returned
   - Datalog query: find all objects of type "file"
   - Hash computation: verify deterministic, verify change detection

**Success criteria:** Can start XTDB, store and retrieve versioned documents with correct hashes, query by time and type.

### Phase 2: Context manager

**Goal:** The three-pool model works correctly, can process mock harness events, produces correct assembled context.

1. Build metadata pool:
   - Append-only per session
   - Each entry: object ID + lightweight metadata fields (per spec §24 defaults)
   - Renders as structured text listing
2. Build chat history pool:
   - Append-only (new turns appended)
   - Stores Turn[] structure (user, assistant content, toolcall_ids, assistant_meta)
   - Renders as proper Message[] (UserMessage, AssistantMessage, ToolResultMessage)
   - ToolResultMessage content is always short metadata reference (toolcall ID, tool name, status) — never inline output
3. Build active content pool:
   - Volatile (changes on activate/deactivate)
   - Keyed by object ID
   - Each entry is the object's content field
4. Implement activate/deactivate:
   - `activate(id)` — move object from inactive to active, load content
   - `deactivate(id)` — move from active to inactive, remove content. Deny on locked objects
   - `pin(id)` — exempt from auto-deactivation
5. Implement auto-activate/deactivate for toolcalls:
   - Recent toolcalls auto-activated (last ~5 in current turn, last ~3 turns back)
   - Older ones auto-deactivated
   - Pinned objects exempt
6. Implement cursor-based event processing:
   - Maintain cursor into the harness message array
   - On each call, process messages[cursor:] as events
   - UserMessage → append to chat object
   - AssistantMessage → append to chat object (preserve ToolCall objects with provider IDs)
   - ToolResultMessage → create toolcall object, add to metadata pool, auto-activate
   - Advance cursor
   - Detect array replacement (cursor invalidation) → reset cursor to end
7. Implement context assembly (Message[] output):
   - Order: system prompt → metadata pool → chat history → active content
   - This order maximizes provider prefix caching
8. **Tests:**
   - Feed a sequence of mock AgentMessages (user → assistant with tool calls → tool results → assistant)
   - Verify metadata pool has correct entries
   - Verify chat object has correct turns
   - Verify active content pool has recent toolcall outputs
   - Verify older toolcall outputs auto-deactivated
   - Verify assembled Message[] has correct structure and order
   - Verify ToolResultMessage content is metadata references, not inline output
   - Test activate/deactivate: activate an old toolcall, verify content appears; deactivate, verify it disappears
   - Test locked objects: try to deactivate chat object, verify denial
   - Test cursor invalidation: replace message array, verify cursor resets

**Success criteria:** Can process a realistic sequence of harness events and produce correct, cache-efficient Message[] output.

### Phase 3: Pi extension + tools

**Goal:** Working Pi extension that can be loaded into a Pi session.

1. Check if Pi's `ExtensionAPI` supports `transformContext` hook. If yes, use it. If no, fork pi-coding-agent and add the hook. See spec §22 for the boundary model.
2. Implement the Pi adapter:
   - `transformContext(messages, signal)` → consume new events via cursor, update XTDB, return assembled context from pools
   - `convertToLlm(messages)` → render custom AgentMessage types to standard Message[]
3. Implement new tools (as AgentTool):
   - `read(path)`: Three-step pipeline — index file (read from disk, create/update XTDB object) → add to metadata pool → activate. Returns confirmation, not file content (content appears via active pool). If file already active, report that. Replaces Pi's built-in read entirely.
   - `activate(id)`: Takes object ID or nickname. Loads content into active pool. Confirms activation. Content appears on next transformContext call.
   - `deactivate(id)`: Collapses to metadata only. Denied on locked objects with message.
4. Implement wrapped tools (delegate to Pi's originals, add side effects):
   - `write(path, content)`: Delegate to Pi's write. Side effect: create/update file object in XTDB.
   - `edit(path, changes)`: Delegate to Pi's edit. Side effect: update file object.
   - `ls(path)`: Delegate to Pi's ls. Side effect: parse output paths, index metadata-only file objects.
   - `find(args)`: Same as ls — delegate, parse, index.
   - `grep(args)`: Delegate. Parse file paths from output. Index metadata-only.
5. Implement bash observation:
   - Subscribe to `tool_execution_end` events for bash tool
   - Best-effort: detect file paths in command/output, update index
6. Wire XTDB lifecycle:
   - Start XTDB when extension loads
   - Session keying: use host session ID to load/store XTDB state
7. **Tests:**
   - Load extension in Pi (programmatic via SDK, not interactive TUI)
   - Run `read("some-file.md")` → verify file object in XTDB, verify it appears in metadata pool and active content
   - Run `write("new-file.md", "content")` → verify file object created in XTDB
   - Run `activate(id)` on a metadata-only object → verify content loads
   - Run `deactivate(id)` → verify content removed, metadata stays
   - Run `ls(".")` → verify discovered files appear in metadata pool
   - Verify the assembled Message[] the LLM receives has correct structure

**Success criteria:** Pi session with extension loaded can read/write/activate/deactivate and the LLM sees correctly assembled context.

### Phase 4: File watcher + session resume

**Goal:** Indexed files tracked automatically. Sessions can resume.

1. File watcher (chokidar):
   - On file indexed, start watching it
   - Content change → new XTDB version (new hashes)
   - Move/rename → new version with updated path
   - Delete → new version with null content and null path (object stays in index)
2. Session resume:
   - On session start, check host session ID
   - If existing XTDB state: load session object, reconstruct pools (active_set, inactive_set, pinned_set)
   - Check mtimes of known files, create new versions for any that changed while watcher wasn't running
3. Cursor invalidation:
   - Detect `replaceMessages()` (array identity or length inconsistency)
   - Reset cursor to end of new array
   - XTDB state unaffected
4. **Tests:**
   - Index a file, modify it externally, verify new XTDB version with updated hash
   - Index a file, delete it, verify new version with null content/path
   - Build up session state, stop, resume with same session ID, verify pools reconstructed
   - Simulate replaceMessages, verify cursor resets and context continues correctly

**Success criteria:** Files auto-tracked after indexing. Sessions survive restart.

## Key constraints from spec

- **Store rich, adapt on output.** Structured data in XTDB. Render to whatever the harness needs.
- **Toolcall args stored as structured JSON**, not string. Optional args_display for metadata rendering.
- **System prompts are objects** — type system_prompt, linked to session, locked.
- **Toolcall IDs are provider-native.** No second UUID. Provider IDs are our object IDs.
- **Null content activation returns a message**, not silent no-op.
- **Chat is one document**, not a collection of turn objects. Turns are internal structure.
- **metadata_view_hash** hashes a fixed field list per type for v0 (see fixes doc §5).
- **Nothing is ever removed from the index.** Deletion = new version with null content.

## XTDB reference

XTDB standalone (v1.x) with SQLite backend:
- Download: https://xtdb.com or Maven Central (`com.xtdb/xtdb-standalone`)
- Starts with: `java -jar xtdb-standalone.jar`
- HTTP API on port 3000 by default
- REST endpoints: POST `/xtdb/submit-tx`, GET `/xtdb/entity`, GET `/xtdb/entity?history=true`, POST `/xtdb/query`
- Documents are EDN maps with `:xt/id` as primary key
- Bitemporality: every put creates a temporal version, queryable by transaction time

## Dev agent notes

- You have internet access in your sandbox. Install what you need.
- Use `vitest` for testing.
- Commit after each phase. Push to `casparfelten/self-context-manager`.
- If you hit a blocker (missing package, API not working as expected, extension API limitation), document it clearly in your output. Don't guess or work around silently.
- Read the spec docs in `docs/spec/` before starting each phase. They are detailed and answer most questions.
