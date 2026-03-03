# Self Context Manager

Context management layer for LLM agents. Controls what is kept, retrieved, and surfaced in the active context window over time.

## Status

- XTDB prototype is archived under `archive/xtdb-prototype/`.
- Active storage/tracking work is specified in canonical v1 docs (design contract stage; implementation pending).

## Canonical docs

- `docs/storage-tracking-spec-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
- `docs/implementation-ssot-v1.md` — **Implementation SSOT** (single canonical implementation source: SQLite storage + context-loading query boundary)
- `docs/eval-plan.md` — evaluation roadmap
- `docs/README.md` — docs index + authority map

## Active source layout

```
src/                        # Active TypeScript source (core context manager)
tests/                      # Active tests (vitest)
docs/                       # Canonical specs + docs index
  archive/                  # Historical snapshots (non-normative)
archive/
  xtdb-prototype/           # Archived XTDB implementation + docs + tests + scripts
```

## Archive

See `archive/xtdb-prototype/README.md` for what was moved and why.

## License

MIT
