# Test Fixtures

This directory contains seed data for context behavior experiments.

## Structure

- `context-behavior-batch2/` — Three experiments testing policy vs context:
  - `exp-1-control-triage/` — Control: basic triage task
  - `exp-2-policy-strong-contradiction/` — Policy strongly contradicts context
  - `exp-3-policy-light-interruption/` — Light policy interruption during task

- `context-behavior-batch3/` — Three experiments testing recall and competing information:
  - `exp-1-forget-recall-multi/` — Multi-step task with recall requirements
  - `exp-2-competing-hypotheses-base/` — Competing hypotheses with conflicting evidence
  - `exp-3-longflow-interruptions/` — Long-running task with multiple interruptions

## Usage

These fixtures are used by the experiment harness. Each experiment directory contains:
- Seed files (logs, tickets, notes, etc.) that populate the agent's context
- Different subdirectory structures depending on the scenario type

To run experiments against these fixtures, see `docs/experiments/README.md`.
