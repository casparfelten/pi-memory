# Docs

## Canonical active docs

1. `storage-tracking-spec-v1.md` — **Intent spec** (authoritative behavior/invariants)
2. `database-spec-sqlite-v1.md` — **Implementation spec** (SQLite schema + `StoragePort` realization)
3. `eval-plan.md` — evaluation roadmap

Authority precedence:
- Intent (`storage-tracking-spec-v1.md`) is canonical for subsystem semantics.
- Implementation (`database-spec-sqlite-v1.md`) must conform to intent.

## Canonical profile summary (v1)

- Minimal immutable version store with idempotent writes
- Global monotonic `tx_seq` + per-object monotonic `version_no`
- Explicit structured references with dynamic/pinned modes
- First-class session tracking via `session` object versions
- Canonical typed envelope fields (`path`, `session_id`, `tool_name`, `status`, `char_count`)

Explicitly out of scope in this profile:
- `doc_nodes` structural projection
- temporal validity intervals / as-of-time API
- field-hash pinning
- built-in FTS and GC APIs

## Process docs (active, non-behavioral)

- `docs/process/` — workflow/process templates for agents and doc maintenance.
- These are not canonical runtime/storage behavior specs.

## Historical/non-normative docs

- `docs/archive/` — historical snapshots and working dumps (non-normative)
- `docs/archive/write-down/` — dated checkpoint notes
- XTDB-era archives:
  - `archive/xtdb-prototype/docs-spec/`
  - `archive/xtdb-prototype/docs-build-notes/`
  - `archive/xtdb-prototype/docs-experiments/`
