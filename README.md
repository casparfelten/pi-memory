# Self Context Manager

Context management layer for LLM agents. Controls what is kept, retrieved, and surfaced in the active context window over time.

## Status

- Active storage/runtime path is SQLite-based.
- Storage is implemented behind `StoragePort` with DB SSOT conformance tests (`tests/storage/`).
- Runtime (`SelfContextManager`) uses `StoragePort` and no longer depends on the legacy HTTP backend.
- Agentic/context-loading conformance tests live under `tests/agentic/`.

## Canonical docs

- `docs/intent-ssot-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
- `docs/implementation-db-ssot-v1.md` — **DB Implementation SSOT** (SQLite schema + transactional storage contract)
- `docs/implementation-agentic-ssot-v1.md` — **Agentic Implementation SSOT** (context loading behavior + query-interface boundary)
- `docs/README.md` — docs index + authority map

## Active source layout

```text
src/                        # Active TypeScript source (core context manager + sqlite storage)
tests/                      # Active tests (vitest; storage + agentic + phase/e2e)
docs/                       # Canonical specs + docs index
  archive/                  # Historical snapshots (non-normative)
```

## Removal note

- Legacy external-backend client, scripts, and integration tests were removed.
- Legacy `tests/ssot-conformance/` suite was removed with that backend model; current conformance coverage is under `tests/storage/`, `tests/agentic/`, and runtime phase/e2e tests.
- Historical archive docs may still reference the removed backend; treat those as non-normative history.

## License

MIT
