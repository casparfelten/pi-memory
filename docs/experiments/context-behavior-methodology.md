# Context-Behavior Live-Drive Methodology

## Purpose
Evaluate whether context handling emerges as a **natural problem-solving behavior** (not a scripted ritual):
- Activate detailed content only when needed
- Deactivate stale working context when focus shifts
- Recall previously seen artifacts when required for synthesis
- Keep metadata awareness high while active set stays intentionally small

## Core Hypotheses
1. **Prompt-pressure hypothesis**: A system prompt that frames active context as scarce will increase timely deactivations and reduce active-set bloat.
2. **Task-shape hypothesis**: Tasks with explicit phase changes (scan -> deep dive -> synthesis) induce healthier activate/deactivate transitions than flat tasks.
3. **Recall-quality hypothesis**: Natural behavior includes selective reactivation/reread of prior artifacts at synthesis time, not one-pass reading or indiscriminate accumulation.
4. **Control hypothesis**: Without explicit memory discipline language, active context tends to grow monotonically and deactivation is delayed or absent.

## Experiment Design

### 1) Task shape (choose at least 3 per batch)
Use varied shapes in each batch:
- **Broad triage**: many files, sparse signal, one concise output
- **Contradiction resolution**: compare early planning vs late runtime evidence
- **Interrupted workflow**: switch to secondary task, then return to prior hypothesis
- **Temporal update**: artifact edited mid-run; verify re-read/refresh behavior

Each task should require:
- discovery (`ls/find/grep`-style behavior),
- selective deep reads,
- synthesis with at least one revisit/recall event.

### 2) Prompt variants
Run multiple variants in same batch:
- **Control**: task-quality focused, no special memory discipline language
- **Policy-light**: mention compact working context and pruning stale detail
- **Policy-strong**: explicitly require small active set, metadata-first, and frequent deactivate-on-focus-shift

### 3) Controls
Keep constant across variants where possible:
- same XTDB endpoint (real/live)
- similar dataset size and noise level
- same tool surface
- similar expected deliverable size

Vary only:
- prompt policy language
- task shape complexity (by design)

## Instrumentation Metrics
Collect per experiment:
- **Active trajectory**: active count over time/steps
- **Metadata trajectory**: metadata count over time/steps
- **Activation count**: number of explicit `activate` operations
- **Deactivation count**: number of explicit `deactivate` operations
- **Recall events**:
  - activate of a previously deactivated id, or
  - deliberate reread of previously seen artifact for synthesis
- **Timing**:
  - total runtime
  - timestamp/step indices for activate/deactivate events
  - time-to-first-deactivate

Recommended derived metrics:
- peak active count
- end active count
- deactivation latency (first deactivate step)
- recall-after-prune ratio

## Success / Failure Criteria for Natural Context Management

### Success indicators
- Active set shows **rise-prune-recall** pattern (not just rise).
- Deactivations occur near focus shifts (phase transition, hypothesis switch, post-extraction).
- Recall is selective and justified by synthesis needs.
- Metadata pool can grow while active set remains bounded.
- Final synthesis quality is maintained with lower active footprint.

### Failure indicators
- Monotonic active growth with little/no pruning.
- Deactivation only at very end (cleanup ritual, not reasoning behavior).
- No recall after pruning despite cross-file synthesis needs.
- Excessive churn (activate/deactivate loops without progress).

## Anti-Patterns to Watch
- **Hoarding**: keeping every read artifact active.
- **Ceremonial deactivation**: bulk prune only after task complete.
- **Blind reactivation**: reactivating many objects without clear need.
- **Context thrash**: frequent toggling of same IDs with no new evidence.
- **Prompt overfitting**: behavior only appears under unnatural instruction text.

## Iteration Protocol (Prompt Changes Only on Failure)
1. Run baseline/control and policy variants unchanged.
2. Diagnose failure mode from trajectories and event timing.
3. Modify **only** system prompt wording if behavior quality failed:
   - add/remove one concrete instruction at a time
   - keep task/data/tooling fixed for the next validation run
4. Re-run same task shape once to test causal effect.
5. Accept prompt change only if it improves behavior without harming output quality.

Do **not** keep rewriting prompt when behavior already meets criteria.

## Reporting Template (per experiment)
Use concise behavior-focused notes:

- **Experiment ID / prompt variant / task shape**:
- **Runtime**:
- **Active trajectory (start -> peak -> end)**:
- **Metadata trajectory (start -> end)**:
- **Activate / deactivate counts**:
- **Recall events**:
- **Observed behavior** (2-4 bullets):
- **Pass/fail for natural management**:
- **If fail, next prompt adjustment** (single change):
