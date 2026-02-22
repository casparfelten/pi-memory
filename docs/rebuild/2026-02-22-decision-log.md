# Pi-Memory Rebuild Decision Log — 2026-02-22

## Scope and constraints

**Run scope**
- Rebuild run decision record for pi-memory.
- Capture decisions, rationale, rejected alternatives, and verification evidence by phase.
- This document is the auditable trail for go/no-go and merge readiness.

**Execution constraints**
- Documentation-only changes for this step.
- No modifications to implementation code or behavior (`src/`, `tests/`, package config, scripts).
- Record only current setup and explicit outcomes observed; no speculative completion claims.

## Non-negotiables

1. **Real XTDB only**
   - All verification must use real XTDB flows/services.
   - No mocked XTDB paths for acceptance evidence.
2. **No mocks for acceptance truth**
   - Test doubles may not be used as final proof for integration correctness.
3. **Clean, minimal code intent**
   - Rebuild decisions must prefer smallest correct change-set.
   - Remove incidental complexity when a simpler equivalent exists.
4. **Evidence-first merge discipline**
   - Every accepted phase decision must include reproducible evidence references.

## Phase checkpoints template (Phase 1–4)

> Status key: `Pending` | `In Progress` | `Blocked` | `Complete`

### Phase 1
- **Status:** Complete
- **Decision:** Accept Phase 1 rebuild output and proceed to Phase 2.
- **Rationale:**
  - Minimal Phase 1 scope was delivered (XTDB client/types/hashing + real-XTDB-oriented tests).
  - Independent verification reported PASS, including manual XTDB flow proof highlights.
  - Phase 1 branch was merged into `main`, satisfying go/no-go for next phase.
- **Alternatives rejected:**
  - Hold Phase 1 open for additional refactor polish (rejected: unnecessary scope expansion).
  - Re-run implementation on a new branch before merge (rejected: existing evidence and merge were sufficient).
- **Evidence:**
  - **Builder branch/commit (what was implemented):**
    - Branch: `phase-1`
    - Commit: `7253904d65abf722906373b691249bded47b5f9f`
    - Implemented files: `src/xtdb-client.ts`, `src/types.ts`, `src/hashing.ts`, `src/index.ts`, `tests/phase1.test.ts`, `scripts/xtdb-start.sh`, `scripts/xtdb-stop.sh`.
  - **Independent tester + manual XTDB proof highlights:**
    - Independent tester result: **PASS** (recorded in run/tester output associated with the 2026-02-22 rebuild session).
    - Manual XTDB proof highlights: real XTDB put/get + query-path verification and observed expected responses (captured in tester/run transcript for this phase).
  - **Merge to `main` commit(s):**
    - `83e780828e53cc356cae8449bb1e234caa26e5ef` — merge of `phase-1` into `main`.
- **Accepted deviations/risks:** None.

### Phase 2
- **Status:** Complete
- **Decision:** Accept Phase 2 rebuild output and proceed to Phase 3.
- **Rationale:**
  - Phase 2 scope was delivered on `phase-2` and merged to `main` with a focused implementation footprint.
  - Independent tester verification recorded **PASS** for the phase, including manual real-XTDB flow confirmation.
  - Merge evidence is present and traceable to the specific `phase-2` implementation commit.
- **Alternatives rejected:**
  - Delay Phase 2 closure pending additional refactor/cleanup beyond planned scope (rejected: unnecessary scope expansion).
  - Rework Phase 2 on a fresh branch despite passing independent verification (rejected: current implementation and evidence satisfy gate).
- **Evidence:**
  - **Builder branch/commit (what was implemented):**
    - Branch: `phase-2`
    - Commit: `074d9fe6bbcac67a4e4938250e658e7a05a3d112` (`074d9fe`)
    - Implemented files: `src/context-manager.ts`, `src/index.ts`, `tests/phase2.test.ts`.
  - **Independent tester + manual XTDB proof highlights:**
    - Independent tester result: **PASS** (recorded in run/tester output associated with the 2026-02-22 rebuild session for Phase 2).
    - Manual XTDB proof highlights: real XTDB-backed context/event-path validation recorded in tester transcript, with observed expected behavior (no mock-only acceptance evidence).
  - **Merge to `main` commit(s):**
    - `9b35271f9d99c25dce8a932e7f408668f2982c46` — merge of `phase-2` into `main`.
- **Accepted deviations/risks:** None.

### Phase 3
- **Status:** Complete
- **Decision:** Accept Phase 3 rebuild output and advance to Phase 4.
- **Rationale:**
  - Phase 3 implementation scope landed on `phase-3` and includes extension integration plus side-effect indexing behavior required by the spec.
  - Independent retest recorded **PASS** after evidence-gap closure work, explicitly confirming the prior FAIL condition was resolved.
  - Phase 3 has been merged to `main`, providing a traceable integration point for subsequent work.
- **Alternatives rejected:**
  - Keep Phase 3 open for additional non-required refactor cleanup (rejected: out-of-scope vs. phase acceptance criteria).
  - Rebuild Phase 3 from scratch on a new branch despite passing independent retest and merge readiness (rejected: redundant churn without risk reduction).
- **Evidence:**
  - **Builder branch/commit(s) (what was implemented/fixed):**
    - Branch: `phase-3`
    - Primary implementation commit: `2b7391c` (`phase3: add pi extension tools and side-effect indexing`)
    - Evidence-fix commit: `0bf2a20` (`test: add explicit phase3 evidence for find/grep/bash observation`)
  - **Independent retest PASS highlights (including prior FAIL closure):**
    - Retest verdict: **PASS** after adding explicit evidence tests for:
      - `wrappedFind` side-effects (metadata-only XTDB file object indexing)
      - `wrappedGrep` side-effects (grep output path extraction/indexing)
      - `observeToolExecutionEnd` bash-only indexing behavior (and non-bash non-index behavior)
    - Validation highlights recorded in retest session output:
      - `npm run build` passed
      - `npm test` passed with `tests/phase3.test.ts` at 9/9 and full suite 18/18
    - Explicit closure statement in retest output: prior FAIL condition (missing explicit test coverage for find/grep/bash observation) is closed.
  - **Merge to `main` commit(s):**
    - `b90e2e4` — merge of `phase-3` into `main` (`Merge phase-3: extension/tools integration and coverage fixes`).
- **Accepted deviations/risks:** None.

### Phase 4
- **Status:** Complete
- **Decision:** Accept Phase 4 rebuild output and move the run into final E2E/reporting.
- **Rationale:**
  - Phase 4 implementation delivered watcher + session resume + cursor invalidation robustness on the `phase-4` builder branch and is now merged to `main`.
  - Independent tester verification recorded **PASS** for Phase 4 and included manual real-XTDB proof steps, satisfying the non-negotiable evidence bar.
  - No additional scope expansion is required before final E2E/report consolidation.
- **Alternatives rejected:**
  - Keep Phase 4 open for further non-required refactor polish (rejected: out-of-scope, no additional acceptance risk reduction).
  - Re-implement on a fresh branch despite PASS + merge evidence (rejected: redundant churn without new signal).
- **Evidence:**
  - **Builder branch/commit (what was implemented):**
    - Branch: `phase-4`
    - Commit: `bb9a67b2a682a5646e78abcb4f4e07b9b5fc1e51` (`bb9a67b`)
    - Implemented files: `src/phase3-extension.ts`, `src/xtdb-client.ts`, `tests/phase4.test.ts`.
  - **Independent tester PASS highlights + manual XTDB proof:**
    - Independent tester verdict: **PASS** for Phase 4 (recorded in rebuild run/tester session output).
    - PASS highlights: watcher/resume/cursor-invalidating behavior validated by phase-specific test coverage and replay checks in the independent test run.
    - Manual XTDB proof highlights: tester transcript includes real XTDB write/query verification during Phase 4 validation (no mock-only acceptance evidence).
  - **Merge to `main` commit(s):**
    - `ae8139a` — merge of `phase-4` into `main` (`Merge phase-4: watcher, session resume, cursor invalidation robustness`).
- **Accepted deviations/risks:** None.

## Verification evidence checklist template

### Automated tests
- [ ] Test command(s) recorded verbatim
- [ ] Exit status captured
- [ ] Relevant suite/case output attached or linked
- [ ] Environment/context noted (service deps, versions, flags)

### Manual XTDB flow (real system)
- [ ] XTDB instance details captured (endpoint/container/service id)
- [ ] Seed/setup commands documented
- [ ] Query/write steps documented with timestamps
- [ ] Observed results captured (not paraphrased when possible)
- [ ] Negative-path or edge-case check recorded
- [ ] Cleanup/reset steps recorded

### Evidence quality bar
- [ ] Reproducible by another engineer from notes alone
- [ ] Distinguishes expected vs observed behavior
- [ ] Includes artifact locations (logs, screenshots, output files)

## Blocker protocol (fix vs escalate)

1. **Declare blocker immediately** with:
   - Symptom
   - Scope impact (phase/task affected)
   - First-fail evidence (command/log excerpt)
2. **Triage window (time-boxed):**
   - Attempt minimal, reversible fix path first.
   - If root cause is outside current phase scope or risks non-minimal churn, escalate.
3. **Decision rule:**
   - **Fix now** when change is small, local, and evidence can be produced in-phase.
   - **Escalate** when dependency/architecture uncertainty or cross-phase risk is high.
4. **Escalation packet must include:**
   - What was attempted
   - Why blocked remains
   - Options with risk/cost tradeoff
   - Recommended next action and owner
5. **Post-resolution update:**
   - Link blocker entry to final decision and evidence.

## Merge gate checklist

- [ ] All four phases have explicit decision entries
- [ ] Each phase includes rationale + alternatives rejected
- [ ] Required evidence checklists are complete and linked
- [ ] Non-negotiables confirmed (real XTDB, no mock acceptance proof, minimal clean approach)
- [ ] All blockers resolved or explicitly accepted with owner and follow-up
- [ ] No out-of-scope file changes included in merge
- [ ] Reviewer can replay verification from documented commands/artifacts

## Initial run setup entries (current state only)

- **Run date:** 2026-02-22
- **Document owner:** decagent/docs track
- **Current phase outcomes:** Phase 1 complete; Phase 2 complete; Phase 3 complete; Phase 4 complete
- **Final E2E/report stage status:** In Progress
- **Known governance baseline:**
  - Real XTDB required for acceptance evidence
  - No mock-based acceptance claims
  - Keep rebuild changes minimal and clean
- **Next required updates:** Populate each phase section only after decision + evidence exist.
