# Docs

## Canonical active docs

1. `storage-tracking-spec-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
2. `database-spec-sqlite-v1.md` — **Implementation SSOT** (single SQLite schema + `StoragePort` realization source)
3. `eval-plan.md` — evaluation roadmap

Authority precedence:
- Intent (`storage-tracking-spec-v1.md`) is canonical for subsystem semantics.
- Implementation (`database-spec-sqlite-v1.md`) is the single canonical SQLite implementation spec and must conform to intent.

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

## Historical/non-normative docs

- `docs/archive/` — historical snapshots moved out of canonical path.
  - `docs/archive/spec-legacy/` — prior SSOT/implementation docs (superseded).
  - `docs/archive/build-notes-legacy/` — rebuild notes and historical execution logs.
- `docs/experiments/` — experimental methodology, data, and reports (non-authoritative for runtime contracts).
- XTDB prototype archive:
  - `archive/xtdb-prototype/`
