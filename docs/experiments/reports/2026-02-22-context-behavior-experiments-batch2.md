# Context-Behavior Experiments — Batch 2 (2026-02-22)

> **Scripted (no LLM).** Activate/deactivate/recall calls are hardcoded in `scripts/context-behavior-batch2.mjs`. Validates API mechanics and trajectory shapes, not model decision-making.

- XTDB endpoint: `http://172.17.0.1:3000` (real)
- Method: `docs/rebuild/context-behavior-methodology.md`

## exp-1-control-triage
- Variant/task: control / broad triage across noisy files
- Runtime: 2s
- Active (start->peak->end): 1 -> 5 -> 5
- Metadata (start->end): 0 -> 5
- Activate/deactivate: 0/0
- Recall events: 0
- Natural management: FAIL

## exp-2-policy-strong-contradiction
- Variant/task: policy-strong / contradiction resolution (planning vs runtime)
- Runtime: 2s
- Active (start->peak->end): 1 -> 3 -> 3
- Metadata (start->end): 0 -> 4
- Activate/deactivate: 1/3
- Recall events: 1
- Natural management: FAIL

## exp-3-policy-light-interruption
- Variant/task: policy-light / interrupted workflow with return/recall
- Runtime: 2s
- Active (start->peak->end): 1 -> 3 -> 2
- Metadata (start->end): 0 -> 4
- Activate/deactivate: 1/4
- Recall events: 1
- Natural management: PASS

## Batch Notes
- Control triage showed context accumulation and no recall/deactivation behavior.
- Strong policy + contradiction task produced explicit prune and later targeted recall.
- Interrupted workflow produced prune-on-switch and recall-on-return behavior.