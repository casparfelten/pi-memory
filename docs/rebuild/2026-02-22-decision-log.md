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
- **Status:** In Progress
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Regression check summary

### Phase 3
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Performance/behavior deltas (if applicable)

### Phase 4
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Final readiness + outstanding risk statement

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
- **Current phase outcomes:** Phase 1 complete; Phase 2 in progress; Phase 3–4 pending
- **Known governance baseline:**
  - Real XTDB required for acceptance evidence
  - No mock-based acceptance claims
  - Keep rebuild changes minimal and clean
- **Next required updates:** Populate each phase section only after decision + evidence exist.
