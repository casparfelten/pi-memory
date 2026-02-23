# Experiments and Reports

All experiments ran on 2026-02-22 against real XTDB (no mocks).

## Experiment index

### LLM-driven (model makes tool decisions)

These are the real behaviour experiments. An LLM agent loop calls the context management API based on its own reasoning, with different prompt policies.

| Report | Script | Model | What it tests |
|--------|--------|-------|---------------|
| [context-behavior-experiments.md](2026-02-22-context-behavior-experiments.md) | `scripts/context-behavior-experiments.mjs` | GPT-4.1 | 4 experiments (E1-E4) varying prompt policy (baseline → hygiene_v1 → hygiene_v2) and task shape. **Core finding:** baseline never deactivates (active→31); hygiene_v1 deactivates but doesn't recall; hygiene_v1 + recall-requiring task gets best balance (active capped at 5, 4 recalls); strict budget causes more churn. |
| [natural-behavior-drive-report.md](2026-02-22-natural-behavior-drive-report.md) | `scripts/natural-behavior-drive.mjs` | GPT-4.1 (intended) | **Blocked** — missing `OPENAI_API_KEY` at runtime. Never executed. Script and revised prompt ready for rerun. |

### Scripted (no LLM — API validation)

These exercise the extension API with hardcoded calls. They validate that activate/deactivate/pin/unpin/persist/reload work correctly. The "decisions" are baked into the script, not made by a model.

| Report | Script | What it tests |
|--------|--------|---------------|
| [live-drive-report.md](2026-02-22-live-drive-report.md) | `scripts/live-drive-actual-use.mjs` | End-to-end API behaviour and XTDB persistence |
| [five-live-drives-report.md](2026-02-22-five-live-drives-report.md) | `scripts/five-live-drives.mjs` | 5 scenarios: multi-file research, tool-result heavy, long-running task, session continuity (persist/reload/pin), error handling/recovery |
| [context-behavior-experiments-batch2.md](2026-02-22-context-behavior-experiments-batch2.md) | `scripts/context-behavior-batch2.mjs` | API mechanics and trajectory shapes (activate/deactivate/recall patterns) |
| [context-behavior-experiments-batch3.md](2026-02-22-context-behavior-experiments-batch3.md) | `scripts/context-behavior-batch3.mjs` | Forget→recall, competing hypotheses, long-flow with interruptions |

### Supporting documents

| Document | Contents |
|----------|----------|
| [context-behavior-methodology.md](context-behavior-methodology.md) | Experiment design methodology |
| [2026-02-22-decision-log.md](2026-02-22-decision-log.md) | Decision log across the full rebuild |
| [2026-02-22-final-report.md](2026-02-22-final-report.md) | Final rebuild report (all phases, E2E) |

## Key results summary

1. **Without prompt policy**, the model never deactivates anything. Active context grows monotonically. (E1: 0 deactivations, 196 tool calls, active→31)
2. **With hygiene_v1 prompt**, the model deactivates but doesn't recall earlier evidence unless the task requires it. (E2: 11 deactivations, 0 recalls)
3. **Best balance** comes from hygiene_v1 + a task that requires revisiting earlier files. (E3: 6 deactivations, 4 recalls, active capped at 5, only 27 tool calls)
4. **Strict budget policy** (hygiene_v2) increases activate/deactivate churn without clear quality gain. (E4: 8 deactivations, 8 recalls)
5. **API mechanics** are solid across all scripted tests: activate/deactivate/pin/unpin/persist/reload all work correctly against real XTDB.

## What hasn't been tested yet

- Real coding task (all experiments use investigation/research scenarios)
- Natural behaviour drive (script ready, blocked on API key)
- Extended session (>100 turns)
- Multiple models (only GPT-4.1 so far)
