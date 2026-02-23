# Experiments

All experiments ran on 2026-02-22 against real XTDB (no mocks).

## LLM-driven (model makes tool decisions)

The real behaviour experiments. An LLM agent loop calls the context management API based on its own reasoning, with different prompt policies.

| Report | Script | Model | Summary |
|--------|--------|-------|---------|
| [context-behavior-experiments.md](reports/2026-02-22-context-behavior-experiments.md) | `scripts/context-behavior-experiments.mjs` | GPT-4.1 | 4 runs (E1-E4) varying prompt policy and task. Core finding: baseline never deactivates; hygiene_v1 deactivates but doesn't recall; best balance from hygiene_v1 + recall-requiring task. |
| [natural-behavior-drive-report.md](reports/2026-02-22-natural-behavior-drive-report.md) | `scripts/natural-behavior-drive.mjs` | GPT-4.1 (intended) | **Blocked** — missing API key at runtime. Script and revised prompt ready. |

## Scripted (no LLM — API validation)

Hardcoded tool calls exercising the extension API. Validates that activate/deactivate/pin/unpin/persist/reload work correctly.

| Report | Script | Summary |
|--------|--------|---------|
| [live-drive-report.md](reports/2026-02-22-live-drive-report.md) | `scripts/live-drive-actual-use.mjs` | End-to-end API + XTDB persistence |
| [five-live-drives-report.md](reports/2026-02-22-five-live-drives-report.md) | `scripts/five-live-drives.mjs` | 5 scenarios: multi-file, tool-result heavy, long-running, session continuity, error recovery |
| [context-behavior-experiments-batch2.md](reports/2026-02-22-context-behavior-experiments-batch2.md) | `scripts/context-behavior-batch2.mjs` | Activate/deactivate/recall trajectory shapes |
| [context-behavior-experiments-batch3.md](reports/2026-02-22-context-behavior-experiments-batch3.md) | `scripts/context-behavior-batch3.mjs` | Forget-recall, competing hypotheses, long-flow with interruptions |

## Raw data

JSON evidence files are in [`data/`](data/).

## Methodology

See [methodology.md](methodology.md).

## Key results

1. **No prompt policy** → model never deactivates. Active context grows monotonically. (E1: 0 deactivations, 196 tool calls, active→31)
2. **hygiene_v1** → model deactivates but doesn't recall unless the task requires it. (E2: 11 deactivations, 0 recalls)
3. **hygiene_v1 + recall-requiring task** → best balance. (E3: 6 deactivations, 4 recalls, active capped at 5, 27 tool calls)
4. **Strict budget (hygiene_v2)** → more churn without clear quality gain. (E4: 8 deactivations, 8 recalls)
5. **API mechanics** solid across all scripted tests.

## Not yet tested

- Real coding task (all experiments use investigation/research scenarios)
- Natural behaviour drive (blocked on API key)
- Extended session (>100 turns)
- Multiple models (only GPT-4.1 so far)
- Ablation study (see [eval plan](../eval-plan.md))
