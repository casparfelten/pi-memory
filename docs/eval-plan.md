# Testing Next Steps

This project is currently in an early experimental phase. We have promising mechanics for storing and retrieving structured context, but not enough controlled evidence yet that it reliably improves agent outcomes over long episodes.

## Current limitations (honest snapshot)

- **Small sample size**: most runs are ad-hoc and too few to claim stable gains.
- **Potential prompt drift**: different prompts/rubrics across runs make comparisons noisy.
- **Limited long-horizon coverage**: not enough multi-hour or many-turn episodes.
- **Unclear failure taxonomy**: failures are observed, but not consistently categorized.
- **Ablation gap**: we do not yet isolate which mechanism drives improvement.

## Evaluation plan (next)

### 1) Blind holdout task set

- Build a fixed task bank with hidden expected outcomes (held by evaluator).
- Include short, medium, and long-horizon tasks.
- Keep training/dev tasks separate from holdout tasks.

### 2) Fixed prompt + protocol

- Lock one system prompt and one execution protocol per test phase.
- Keep temperature/model/tool policy fixed within a phase.
- Version and record the exact prompt/protocol used.

### 3) Long-episode testing

- Run extended episodes (e.g., 100+ turns or multi-session continuity).
- Measure context retention, contradiction rate, and recovery after interruptions.

### 4) Required ablations

Compare at least:

- **A:** Baseline agent (no context manager layer)
- **B:** Context manager, retrieval only
- **C:** Context manager, retrieval + write/update pipeline
- **D:** Full system with ranking/selection policy enabled

### 5) Pass/fail criteria

Define up front per phase:

- Task success rate threshold (vs baseline)
- No-regression guardrail on latency/cost bands
- Max tolerated contradiction/error rate
- Minimum statistically meaningful margin over baseline

### 6) Failure logging standard

For every failed run, log:

- task id, run id, model/prompt version
- failure type (retrieval miss, stale context, wrong merge, hallucination, etc.)
- minimal reproduction transcript snippet
- suspected root cause + next action

## Phased execution checklist

- [ ] **Phase 0 — Instrumentation sanity**: lock logging schema, run 5 pilot tasks.
- [ ] **Phase 1 — Controlled short tasks**: fixed prompt, baseline vs ablations on short tasks.
- [ ] **Phase 2 — Mixed horizon holdout**: evaluate on blind holdout set.
- [ ] **Phase 3 — Long episodes**: stress continuity and degradation patterns.
- [ ] **Phase 4 — Decision gate**: ship, iterate, or redesign based on criteria.

Owner note: this roadmap is intentionally minimal; update only when criteria or protocol changes.
