# Storage & Tracking Subsystem — v1 Intent Spec

Status: **Canonical intent spec (design contract; not implemented)**
Date: 2026-03-03

---

## 0) Role and authority

This document is the canonical behavioral contract for storage/tracking.

Authority rules:
1. This document defines behavior, invariants, and conflict semantics.
2. `docs/implementation-ssot-v1.md` is the single implementation SSOT.
3. If intent vs implementation wording conflicts, this document wins; implementation docs must be updated.

---

## 1) What v1 is optimizing for

v1 is intentionally **minimal and stable**.

Primary goals:
1. Immutable versioned writes.
2. Strong idempotency and explicit optimistic conflicts.
3. Explicit structured references (no text parsing).
4. Reverse reference lookup.
5. First-class session tracking.
6. Permanent typed envelope fields for anti-manipulation stability.

Non-goals for v1:
- structural node-tree projections,
- temporal-validity interval semantics,
- field-scoped hash pinning,
- built-in FTS,
- built-in GC APIs.

---

## 2) Core model

### 2.1 Object identity and ordering

Each `object_id` has immutable versions.

Ordering is authoritative by:
- `version_no` (strictly monotonic per object), and
- `tx_seq` (strictly monotonic global sequence).

Timestamps are recorded for observability only and are **not** ordering authority.

### 2.2 Object types

Closed v1 set:
- `file`
- `toolcall`
- `chat`
- `session`
- `system_prompt`

### 2.3 Canonical data split

Every version is split into three semantic zones:

1. **Typed envelope columns (canonical + permanent)**
   - stable identity/relationship/status fields.
   - immutable once version is written.
2. **`content_struct_json` (canonical semantic payload)**
   - domain body content.
3. **`metadata_json` (auxiliary non-core metadata)**
   - persisted, hashed, immutable per version.

Rule: if a field is defined as typed-envelope canonical, payload JSON must not contradict it.

---

## 3) Canonical typed envelope (v1)

The following are canonical immutable fields on each version record:
- `object_id`, `version_id`, `version_no`, `tx_seq`
- provenance: `writer_id`, `writer_kind`, `write_reason`
- typed permanence fields: `path`, `session_id`, `tool_name`, `status`, `char_count`
- hashes: `content_struct_hash`, `file_bytes_hash` (nullable), `metadata_hash`, `refs_hash`, `object_hash`

`path/session_id/tool_name/status/char_count` are not convenience projections in v1; they are canonical envelope fields.

---

## 4) Write behavior

### 4.1 API-only writes

All writes must go through subsystem APIs (no direct app DB writes).

### 4.2 Immutable append model

Accepted write => new immutable version row for an object.

### 4.3 Idempotency first

`request_id` is mandatory.

For the same `request_id`:
- if incoming write fingerprint matches committed fingerprint => replay prior success (`idempotentReplay=true`),
- otherwise => `idempotency_mismatch` conflict.

Idempotency decision runs before optimistic guard checks.

### 4.4 Optimistic guard

Optional `expectedCurrentVersionId` guard is supported.
Mismatch => `version_conflict`.

---

## 5) Structured reference model

### 5.1 Explicit-only rule

References must be explicit structured objects in `content_struct_json`.

No free-text parsing or heuristic extraction.

### 5.2 Canonical `Ref` shape

```ts
interface Ref {
  target_object_id: string;
  mode: 'dynamic' | 'pinned';

  // pinned anchors (at least one required when mode='pinned')
  target_version_id?: string;
  target_object_hash?: string;

  // provenance/context
  ref_kind: string;
  ref_metadata?: Record<string, unknown>;
}
```

Pinned rule:
- `mode='pinned'` requires `target_version_id` or `target_object_hash`.

### 5.3 Extraction and persistence

For each accepted version write:
1. Enumerate declared ref-bearing fields for that object type.
2. Validate each `Ref`.
3. Insert one `doc_references` row per source location with:
   - `from_version_id`
   - `from_path` (canonical slash path)
   - target anchor fields
   - `mode`, `ref_kind`, `resolved`

### 5.4 Unresolved refs

Missing target object must not reject ingestion.
Store as `resolved=false`; keep queryable.

### 5.5 Dynamic vs pinned

- `dynamic`: resolves to target object HEAD at query time.
- `pinned`: anchored to specific target version or target object hash.

---

## 6) Session tracking semantics (first-class)

Sessions are core, not optional.

### 6.1 Session as versioned object

`session` is a normal object type with immutable versions.

Canonical session tracking is represented in session payload + typed envelope:
- typed envelope: `session_id` (canonical)
- payload: `chat_ref`, `system_prompt_ref?`, `active_set[]`, `inactive_set[]`, `pinned_set[]`

### 6.2 Session references

Session sets (`active_set`, `inactive_set`, `pinned_set`) emit references the same way as any other explicit refs.

### 6.3 Consistency

Session change = new immutable session version write.
No hidden mutable side-channel is authoritative in v1.

---

## 7) Hash semantics

Per version:
- `content_struct_hash`
- `file_bytes_hash` (nullable)
- `metadata_hash`
- `refs_hash`
- `object_hash`

`object_hash` preimage contract:

```text
H("v1|object_id|version_no|content_struct_hash|file_bytes_hash|metadata_hash|refs_hash")
```

Hash inputs use canonical serialization and fixed ordering.

---

## 8) Conflict outcomes (v1)

`putVersion` returns either:

- success `{ ok: true, record, idempotentReplay }`, or
- conflict `{ ok: false, conflict: true, reason }` where `reason` is one of:
  - `version_conflict`
  - `idempotency_mismatch`

No interval-conflict path exists in v1.

---

## 9) Required query capabilities

The subsystem must support:
1. latest version by object,
2. full version history by object,
3. references by source scope (`from_version_id`, `from_path` prefix),
4. reverse lookups by target object/version/hash,
5. filters on `mode` and `resolved`.

---

## 10) Explicit v1 cuts (removed by design)

The following are intentionally not part of v1:
1. `doc_nodes` structural tree projection.
2. Temporal validity intervals (`valid_from` / `valid_to`) and as-of-time semantics.
3. Field-hash pinning (`field_hash:*`, `field_hashes_json`).
4. Full-text indexing APIs.
5. Built-in GC APIs (`gcDryRun`, `gcExecute`, etc.).

These are cut from core scope, not deferred-internals pretending to be active.

---

## 11) Cross-doc canonical map

- Canonical intent (this doc): `docs/storage-tracking-spec-v1.md`
- Canonical implementation SSOT: `docs/implementation-ssot-v1.md`
- Evaluation roadmap: `docs/eval-plan.md`
- Historical/non-normative docs: `docs/archive/` and `archive/xtdb-prototype/`
