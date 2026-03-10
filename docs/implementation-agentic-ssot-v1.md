# Implementation SSOT v1 — Agentic Context Loading

Status: **Canonical agentic implementation SSOT (active context-loading implementation contract)**
Date: 2026-03-10

Behavioral authority:
- `docs/intent-ssot-v1.md`

Storage authority:
- `docs/implementation-db-ssot-v1.md`

Authority rule:
- This document defines context-loading implementation behavior.
- It must consume storage only through the query interface boundary.

---

## 0) Scope

Defines the runtime context-loading layer:
1. how context is assembled from storage,
2. loading order and determinism requirements,
3. strict boundary with DB internals.

This document does not define SQL tables or write transactions.

---

## 1) Boundary with storage

Context-loading code must not read DB tables directly.

Allowed storage reads are only via `StoragePort` query methods:
1. `getLatest(objectId)`
2. `getHistory(objectId, order)`
3. `queryReferences(...)`
4. `getReferrersByTargetVersion(...)`
5. `getReferrersByTargetHash(...)`

Any additional loader requirement must be added via `StoragePort` contract change in DB SSOT before implementation.

---

## 2) Loader inputs and anchors

Primary anchor is session identity:
- canonical typed envelope field `session_id`.
- session writes without non-empty `session_id` are invalid at the DB boundary (`invalid_session_id`) and must not be treated as recoverable loader state.

Session HEAD resolution model:
1. resolve current `session` object version,
2. read session payload refs (`chat_ref`, `system_prompt_ref?`, `active_set`, `inactive_set`, `pinned_set`),
3. load referenced objects according to mode semantics (dynamic/pinned) and resolved/unresolved status.

---

## 3) Context assembly contract

### 3.1 Deterministic assembly order

Context must be assembled in deterministic stable order:
1. system prompt block,
2. metadata/summary block,
3. chat history block,
4. active content block.

Ordering must be stable for equivalent storage state to preserve model-cache friendliness and reproducibility.

### 3.2 Metadata-first policy

Inactive objects should be represented by compact metadata references, not full content payloads.

### 3.3 Active-content policy

Only active/pinned content objects are expanded into full content blocks unless caller explicitly requests wider expansion.

---

## 4) Reference resolution behavior in loader

Dynamic refs:
- resolve against current HEAD of target object.

Pinned refs:
- resolve to pinned target version/hash anchor.

Unresolved refs (`resolved=false`):
- must remain visible to loader as unresolved entries,
- must not crash or silently disappear from dependency surfaces.

---

## 5) Session mutation interaction model

Session changes are represented as new immutable session versions.

Loader must treat session transitions as version changes (not mutable in-place updates) and re-resolve active/inactive/pinned sets from latest session HEAD.

---

## 6) Out-of-scope for agentic loader v1

Not part of this canonical agentic profile:
- direct SQL usage,
- temporal as-of reconstruction,
- implicit text-parsed references,
- full-text search orchestration,
- GC policy/execution behavior.

---

## 7) Cross-doc references

- Intent SSOT: `docs/intent-ssot-v1.md`
- DB implementation SSOT: `docs/implementation-db-ssot-v1.md`
- Historical/non-normative docs: `docs/archive/`
