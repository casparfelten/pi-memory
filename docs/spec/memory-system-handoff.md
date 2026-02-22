# Memory system - handoff + reading list (2026-02-21)

Purpose: preserve enough context that after compaction (or for a new builder agent) we can continue seamlessly.

Canonical spec: `kg/memory-system-v0.md`.

---

## 0) Who/what

- **Owner / direction:** Caspar.
- **Project:** "logistic context management system" for LLM agents.
- **Core idea:** the agent operates over **objects + references** with explicit **active/inactive** context control. Avoid repeated raw reads and tool output bloat.
- **Backend substrate:** XTDB (standalone, simplest deployment). Version lookup is timestamp-based; hashes are for verification/diffing.
- **Critical integration target:** Pi stack (`~/src/pi-mono/…`). Do not confuse with Anthropic "Claude Agent SDK" - this work is based on **pi-mono**.

Terminology:
- **THE system:** the memory/context management layer we're designing.
- **External harness:** the host runtime (Pi coding agent, OpenClaw) that provides the React loop, streaming UI, etc.

---

## 1) High-confidence decisions (do not re-litigate unless Caspar changes them)

### 1.1 Chat history
- Chat is **one structured document** ("chat object").
- Toolcall **metadata** is inline in the chat object.
- Toolcall **results/output** are separate payload objects; they can be expanded/loaded independently.

### 1.2 Context model
- Context is objects in three states:
  - **Active:** content loaded
  - **Inactive:** metadata only
  - **Not present**
- Context assembly uses three conceptual pools:
  - **Metadata pool** (append-only)
  - **Chat history pool** (append-only)
  - **Active content pool** (volatile)

### 1.3 References
- LLM typically writes **dynamic** references (stable object id → latest).
- System records **static** references for reproducibility (object id + timestamp + hashes).

### 1.4 Versioning & hashing
- "Versioning is just versioning." A version can be pointed to by **content hash** or by **timestamp**.
- Implementation choice for XTDB:
  - **Lookup by timestamp** (native temporal queries)
  - **Store hashes** (content hash, metadata hash, whole-object hash) for verification/diffing/dedup.

### 1.5 Toolcall retention
- Default: keep last ~5 toolcall results expanded within a turn; auto-collapse across turns after ~3 turns.
- Pinning overrides collapse.

---

## 2) Files are special (first-class objects)

Goal: files should not exist only as transient toolcall outputs.

### 2.1 Index scope
We **do not index the entire filesystem**.
We index what the agent:
- **reads**, or
- **directly edits**, and/or
- **discovers** via ls/find/grep.

Once a file is known, it becomes a DB object with:
- metadata including **file location** (path)
- automatic versioning on content changes

### 2.2 Background file tracking
Requirement: once a file is indexed, keep it in sync automatically.
- Use proper filesystem watching:
  - Node `fs.watch`, or
  - **chokidar** (preferred, robust cross-platform)

Watcher updates DB/index when:
- file content changes → new version
- file moves/renames → update metadata
- file deleted → mark missing/orphaned

Important: watcher updates DB state; it does not automatically expand files into active context.

### 2.3 Tool surface (decided)

Three new tools (ours):
- **`read(path)`** — filesystem entry point. Three-step pipeline: index (if not already) → add to metadata pool → activate. Returns status for each step. If already indexed and active, reports that.
- **`activate(id)`** — object entry point. Takes a metadata name/id. Loads the default `content` field into context. Every object must have a default content field. Some objects are locked (can't be deactivated — e.g. chat, system prompt). Richer field-level activation deferred to later.
- **`deactivate(id)`** — collapse to metadata-only. Denied on locked objects.

Wrapped tools (host executes, we add side effects):
- **`write`/`edit`** — delegate to host for FS mechanics; update file object (new version).
- **`ls`/`find`/`grep`** — delegate to host; parse discovered paths; index metadata-only; add to metadata pool.

Observed tools:
- **`bash`** and other non-file tools — observe via events, best-effort index update.

Key distinction: file operations (`read`/`write`/`edit`) operate on **persistent file objects** (one object per file, versioned). Other tool outputs produce **ephemeral toolcall output objects** (new object each time, normal collapse lifecycle).

The agent does not need to `ls` before `read` — `read(path)` handles indexing directly. `activate(id)` is for objects already in the metadata pool.

Open question: handling complex bash pipelines reliably (see §5).

---

## 3) Boundary with external harness (Pi/OpenClaw)

Full boundary analysis in v0 doc §22.2–§22.3. Key points:

### 3.1 We are canonical

XTDB holds the true context state. The harness's message array (`context.messages` in Pi) is an **event source** we consume via cursor-based update processing — not a state store. We never re-process the whole array; we read new entries since last call.

If the harness replaces/drops messages (compaction, session restore), our state is unaffected. We detect the inconsistency, reset cursor, continue.

### 3.2 Adapter model

Each harness needs an adapter — a thin translation layer. Adapter responsibilities: extract events from the harness, register tools in the harness's API, return assembled context in the harness's format, absorb harness-specific quirks.

Our core is harness-agnostic. It processes events, maintains XTDB state, assembles context. The adapter is the boundary.

Minimum harness requirements: context-assembly hook, tool registration/replacement, tool execution events, session IDs.

### 3.3 Pi adapter: concrete types

See v0 doc §22.3 for full type definitions (from `pi-agent-core` and `pi-ai` source). Summary:

**Harness side:** `context.messages` is a mutable `AgentMessage[]`. Three message types: `UserMessage`, `AssistantMessage`, `ToolResultMessage`. `transformContext` called once per LLM invocation.

**LLM side:** `convertToLlm` produces `Message[]` (same three types). Goes into `Context = { systemPrompt?, messages, tools }`. Provider caching is prefix-based.

**Tools:** `AgentTool` extends `Tool` with `label` and `execute`. Returns `AgentToolResult = { content, details }`, which the loop wraps into `ToolResultMessage` and pushes onto `context.messages`. Tool results are decoupled from LLM context — the user sees them via TUI events, the LLM sees whatever our `transformContext` returns.

### 3.4 What we implement (Pi adapter)

- `transformContext`: consume events (cursor-based), update XTDB, return assembled context.
- `convertToLlm`: render custom `AgentMessage` types into standard `Message[]`.
- `systemPrompt` via `agent.setSystemPrompt()`.
- Tool registrations (`read`, `activate`, `deactivate`) + wrapped host tools + observation of `bash`/others.

### 3.5 What we don't touch

Agent loop, tool execution, streaming, events, TUI, session management, `context.messages` mutation.

---

## 4) Tools: which Pi built-ins matter

Pi coding agent's built-ins are in:
- `~/src/pi-mono/packages/coding-agent/src/core/tools/index.ts`

Tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.

Decided tool ownership:
- **Replace entirely:** `read` → our `read(path)` (index + activate; replaces host's read)
- **New (no host equivalent):** `activate(id)`, `deactivate(id)`
- **Wrap (delegate + side effects):** `write`, `edit` (update file objects), `ls`, `find`, `grep` (index discovered files + metadata pool)
- **Observe (best-effort):** `bash` and other non-file tools via event subscription

Note: `edit` returns a diff, not full file content.

---

## 5) Open questions (explicit)

1. ~~**Concrete document shapes**~~ **Resolved.** See v0 doc §24 for provisional document shapes (file, toolcall, chat, session).
2. ~~**Pi compaction**~~ **Resolved.** We replace `transformContext`, so host compaction has no effect. Irrelevant.
3. **Pool → AgentMessage[] rendering:** Boundaries now specified (§3 above, v0 doc §22.2). Remaining: what custom `AgentMessage` types to define, how `convertToLlm` renders them, message ordering for cache efficiency, how to track "what's new" in `context.messages`.
4. ~~**Complex bash chaining**~~ **Resolved.** Best-effort observation. No parser needed. Acceptable to miss files from complex pipelines.
5. ~~**Session/chat split**~~ **Resolved.** See v0 doc §24.3 and §24.4.

---

## 6) Reading list (exact files to inspect)

### 6.1 Pi mono repo (local)
Repo root: `~/src/pi-mono/`

Start with READMEs (Caspar requested only these initially):
- `~/src/pi-mono/packages/agent/README.md` (pi-agent-core: message flow, transformContext, convertToLlm, events)
- `~/src/pi-mono/packages/ai/README.md` (pi-ai: context structure, tool calls, streaming)
- `~/src/pi-mono/packages/coding-agent/README.md` (Pi coding agent: sessions, tools, extensions)

Then the seam in code (high signal):
- `~/src/pi-mono/packages/agent/src/agent-loop.ts`
  - `streamAssistantResponse()` shows exactly where `transformContext` and `convertToLlm` run.
- `~/src/pi-mono/packages/agent/src/agent.ts`
  - shows state, events, tool execution recording.

Pi coding agent tools:
- `~/src/pi-mono/packages/coding-agent/src/core/tools/index.ts` (tool registry)
- `~/src/pi-mono/packages/coding-agent/src/core/tools/read.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/ls.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/find.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/grep.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/edit.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/write.ts`
- `~/src/pi-mono/packages/coding-agent/src/core/tools/bash.ts`

### 6.2 OpenClaw docs (local)
Docs root: `/usr/lib/node_modules/openclaw/docs`

Start here:
- `/usr/lib/node_modules/openclaw/docs/index.md`
- `/usr/lib/node_modules/openclaw/docs/pi.md` (OpenClaw ↔ Pi integration docs)
- `/usr/lib/node_modules/openclaw/docs/pi-dev.md` (dev notes for Pi integration)

Then depending on integration work:
- `/usr/lib/node_modules/openclaw/docs/gateway/` (gateway architecture/config)
- `/usr/lib/node_modules/openclaw/docs/tools/` (tooling model)
- `/usr/lib/node_modules/openclaw/docs/reference/` (configs and reference material)

---

## 7) Immediate next steps (when resuming after compaction)

1. ~~Decide "wrap vs replace" precisely for `read/ls/find/grep` in Pi.~~ **Done.** See §2.3 and §4 above. `read` replaced entirely; `ls`/`find`/`grep` wrapped; `write`/`edit` wrapped; `bash` observed.
2. Decide how to implement background file watching + what it updates (DB only vs also metadata pool).
3. Draft concrete XTDB document shapes (EDN examples) for:
   - file-backed object
   - toolcall object (content = stdout; no separate payload object)
   - chat object + session object
4. Specify pool → `AgentMessage[]` mapping (roles, how it renders to model).
