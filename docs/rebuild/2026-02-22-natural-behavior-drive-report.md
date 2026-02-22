# Natural Behavior Drive Report (2026-02-22)

> **LLM-driven (intended).** Script `scripts/natural-behavior-drive.mjs` uses GPT-4.1 in a real agent loop. However, this run was blocked (missing `OPENAI_API_KEY`) and never executed.

## Status
Blocked before live drive execution.

## What was built
- `scripts/natural-behavior-drive.mjs`
  - Instantiates `PiMemoryPhase3Extension`
  - Connects to real XTDB (`http://172.17.0.1:3000` by default)
  - Runs a real OpenAI tool-calling loop (Chat Completions API) with tools mapped to extension APIs:
    - `read`, `activate`, `deactivate`, `ls`, `find`, `grep`, `write`, `status`
  - Uses a strong system policy emphasizing aggressive activation/deactivation and metadata-first behavior
  - Uses a domain-focused user task prompt only (no explicit context-tool coaching)
  - Captures trajectories and deactivation/reactivation events into evidence JSON

## Blocker
- `OPENAI_API_KEY` was not present in environment.
- Run command failed immediately:
  - `node scripts/natural-behavior-drive.mjs`
  - Error: `OPENAI_API_KEY is required`

## Caspar Questions (current run)
- How did active file/object counts change?
  - Not measured (no live drive due to missing API key).
- How did metadata counts change?
  - Not measured (no live drive due to missing API key).
- Did it activate/deactivate?
  - No observed runtime calls (drive did not start).
- Why did it deactivate?
  - Not applicable.
- When did it choose to?
  - Not applicable.

## Assessment
- Cannot assess natural vs forced behavior without a successful live drive.

## If behavior is poor after rerun: revised system prompt text
```text
You are conducting a deep technical investigation with limited working memory. Keep active memory very small: activate an object only when quoting or reasoning from it right now, and deactivate it immediately after extracting needed facts. Rely on metadata/index awareness and re-read later when required. Frequent activate/deactivate is expected whenever your focus changes files or hypotheses. Never keep stale content active across steps unless currently needed for synthesis.
```

## Rerun command
```bash
OPENAI_API_KEY=... node scripts/natural-behavior-drive.mjs
```
