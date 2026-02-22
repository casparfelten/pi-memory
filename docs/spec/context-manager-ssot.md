# Context Manager SSOT (Single Source of Truth)

> **Authoritative document**: This is the canonical specification for the project’s current intent, design, and implementation reality.
>
> If any other doc conflicts with this one, **this SSOT wins** until explicitly updated.

## 1) Fundamentals

### 1.1 Problem

LLM agents lose continuity in long tasks because context windows are limited and tool outputs/files are repeatedly re-injected as raw text. This causes context bloat, drift, and inconsistent behavior across turns.

### 1.2 Goals

- Provide a **context manager layer** (not just a memory bucket).
- Let agents operate over **objects + references** instead of repeated full-text re-reading.
- Keep context controllable through explicit **activation/deactivation**.
- Preserve reproducibility with version-aware references and durable history.

### 1.3 Principles

- **Separation of concerns**: host harness runs loop/tools/UI; this layer controls LLM-visible context.
- **Metadata first**: inactive objects remain visible via compact metadata.
- **Explicit context logistics**: active content is a deliberate subset, not everything ever seen.
- **Store rich, render adapted**: preserve structured internal state, adapt at model/harness boundary.
- **Docs and behavior must match**: this SSOT tracks both intended design and as-built state.

### 1.4 Invariants

- Objects have stable identity and version history.
- Chat history remains present as canonical conversation state.
- Tool result payloads are separate from chat inline metadata references.
- Active/inactive transitions change what content is loaded, not object identity.
- No package/repo rename is implied by this document.

---

## 2) Design Decisions

### 2.1 Context model

Three levels are assumed:

1. **Index**: globally known objects (durable)
2. **Metadata pool** (session): known objects as lightweight entries
3. **Active content pool** (session): loaded object content

Object states from agent perspective:
- **Active** (content loaded)
- **Inactive** (metadata only)
- **Not present** (not in metadata pool)

### 2.2 Activation/deactivation semantics

- `activate(id)`: load object default content into active pool.
- `deactivate(id)`: remove content from active pool, keep metadata visible.
- Locked objects (e.g. chat/system prompts) are not deactivatable.
- Recent toolcall outputs are expected to be auto-active by policy; older outputs auto-collapse.

### 2.3 Metadata vs active content

- Metadata pool is compact and append-oriented.
- Active pool is volatile and context-budget sensitive.
- Agent should browse metadata broadly, activate narrowly.

### 2.4 Tool-result handling

- Each tool execution yields a toolcall object.
- Chat keeps **tool metadata references**, not full output blobs inline.
- Full tool output is accessed through the toolcall object’s content when active.

### 2.5 Persistence model

- Durable object store with versioned objects and referenceability.
- Static references should allow replay/verification of historical context.
- Session state tracks active/inactive/pinned sets.

### 2.6 Watcher semantics

- Indexed files are watched for external changes.
- File change/move/delete should create updated object versions (or missing/deleted state), not erase history.
- Watchers update persistent state; they do not automatically force active-context expansion.

### 2.7 Prompt and behavior-policy assumptions

- Fixed prompt/protocol is required for fair evaluation phases.
- Harness raw message logs are treated as event input; assembled context is what the model actually sees.
- Context manager output ordering should favor stable prefixes for cache efficiency.

---

## 3) Implementation (as-is, current)

This section reflects what is currently implemented in this repository today.

### 3.1 What exists now

- TypeScript package scaffold and build/test setup (`src`, `dist`, `tests`, `scripts`).
- Design/spec docs for memory/context architecture in `docs/spec/`.
- Planning notes and roadmap docs.

### 3.2 Current implementation reality

- The repository currently contains **primarily specification/planning artifacts**.
- Full runtime behavior described in design docs (complete context manager loop integration, durable object store wiring, watcher lifecycle, adapter behavior) is **not yet fully implemented end-to-end in this repo**.
- Therefore, this project is best described as an **in-progress context manager design + partial implementation groundwork**.

### 3.3 Key modules/directories (present now)

- `src/`: implementation surface (early-stage)
- `tests/`: automated tests (limited vs final intended behavior)
- `docs/spec/`: design decisions and evolving spec source material
- `docs/testing-next-steps.md`: upcoming evaluation protocol/checklist

### 3.4 Known gaps/deviations

- No completed, validated end-to-end demonstration yet of all SSOT semantics.
- Evaluation protocol is newly documented and not yet fully executed at scale.
- Some decisions remain policy-level in docs rather than enforced in production code paths.

---

## 4) Change Policy (how to update this SSOT)

Update this SSOT whenever behavior, assumptions, or architecture materially changes.

Required process:

1. **Behavior first**: implement/change behavior (or decide explicit design change).
2. **Same PR/commit window**: update this SSOT in the same change set whenever practical.
3. **Mark impact** in the changed section as one of:
   - `Design change`
   - `Implementation alignment`
   - `Implementation divergence`
4. **Keep “Implementation (as-is)” honest**: never describe unshipped behavior as shipped.
5. **Cross-link**: if detailed docs are changed elsewhere, add or adjust links/references here.

If there is uncertainty, default to documenting uncertainty explicitly rather than over-claiming.

---

## 5) Concise glossary

- **Context manager layer**: subsystem that decides what the LLM sees each turn.
- **Object**: versioned unit of stored context (file, toolcall, chat, etc.).
- **Metadata pool**: session-visible object summaries without full content.
- **Active pool**: subset of objects whose content is loaded into context.
- **Activate/Deactivate**: promote/demote object content between active and metadata-only states.
- **Toolcall object**: persisted record of one tool execution and its output content.
- **Static reference**: reference pinned to a historical version/time for reproducibility.
- **Dynamic reference**: reference to latest version of an object.
- **Harness**: external agent runtime (loop/tools/UI) integrated by adapter/boundary logic.
