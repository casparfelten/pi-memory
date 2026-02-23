# Self Context Manager

Context management layer for LLM agents. Controls what is kept, retrieved, and surfaced in the active context window over time. Built as a [Pi coding agent](https://github.com/badlogic/pi-mono) extension.

## Status

Working prototype. API validated against real XTDB. LLM-driven experiments show prompt policy meaningfully changes context management behaviour. See [experiments](docs/experiments/) for details.

## Structure

```
src/                        # TypeScript source
tests/                      # Unit + integration tests (vitest)
scripts/                    # Experiment scripts + XTDB start/stop
docs/
  spec/                     # Design spec (SSOT is authoritative)
  experiments/              # Experiment reports, data, methodology
  build-notes/              # Build plan, decision log, phase notes
  eval-plan.md              # Evaluation roadmap (ablations, holdout tasks)
xtdb/                       # XTDB config (jar/logs/pid gitignored)
tmp/                        # Experiment run outputs (gitignored)
```

## Spec

**Authoritative:** [Context Manager SSOT](docs/spec/context-manager-ssot.md)

Historical design docs in `docs/spec/` — see its README for which is current.

## License

MIT
