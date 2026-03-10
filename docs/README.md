# Docs

## Canonical active docs

1. `intent-ssot-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
2. `implementation-db-ssot-v1.md` — **DB Implementation SSOT** (SQLite schema + transactional storage contract)
3. `implementation-agentic-ssot-v1.md` — **Agentic Implementation SSOT** (context loading behavior + query-interface boundary)

Authority precedence:
- Intent (`intent-ssot-v1.md`) is canonical for subsystem semantics.
- DB and Agentic implementation SSOTs must conform to intent.

## Implementation status snapshot (as of 2026-03-10)

- Active runtime/storage path is implemented in `src/phase3-extension.ts` + `src/storage/*`.
- DB SSOT conformance coverage: `tests/storage/` (`tests/storage/SSOT_DB_TEST_MAP.md`).
- Agentic SSOT conformance coverage: `tests/agentic/` (`tests/agentic/SSOT_AGENTIC_TEST_MAP.md`).

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

Note: historical docs may reference removed legacy backend artifacts; those references are archival context only.

- `docs/archive/` — historical snapshots moved out of canonical path.
  - `docs/archive/spec-legacy/` — prior SSOT/implementation docs (superseded).
  - `docs/archive/build-notes-legacy/` — rebuild notes and historical execution logs.
  - `docs/archive/experiments-legacy/` — experimental methodology, data, and reports.
  - `docs/archive/session-notes/` — archived working/session notes and handoff prompts (non-normative).
  - `docs/archive/write-down/` — dated checkpoint write-down notes (non-normative).
  - `docs/archive/eval-plan-legacy.md` — evaluation roadmap (historical).
- `docs/temp/` — working notes in progress only; archive to `docs/archive/` at checkpoints/handoff.
