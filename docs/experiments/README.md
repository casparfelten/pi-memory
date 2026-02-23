# Context Behavior Experiments

This directory documents experiments testing how LLM agents handle competing context, policy interruptions, and recall tasks.

## Fixtures

Experiment seed data lives in `fixtures/`:
- `fixtures/context-behavior-batch2/` — Policy vs context experiments
- `fixtures/context-behavior-batch3/` — Recall and competing hypotheses experiments

See `fixtures/README.md` for detailed descriptions of each experiment scenario.

## Outputs

When experiments produce notable outputs (e.g., generated briefs, decision logs), they should be saved to `docs/experiments/outputs/` with descriptive names:
- `{experiment-id}-{description}.md` format
- e.g., `batch2-exp1-triage-decision.md`

## Running Experiments

Experiments are run via the harness in `scripts/`. The harness:
1. Copies seed files from `fixtures/` to a temp workspace
2. Invokes the agent with the experiment prompt
3. Captures outputs for analysis

## Notes

- `tmp/` is gitignored for transient experiment runs
- Valuable outputs should be moved to `docs/experiments/outputs/` and committed
