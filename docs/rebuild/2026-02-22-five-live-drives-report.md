# Five Live Drives Report (2026-02-22)

> **Scripted (no LLM).** All tool calls are hardcoded in `scripts/five-live-drives.mjs`. Validates extension API correctness across varied scenarios, not model decision-making.

Environment used:
- Repo branch: `live-drive/five-scenarios-2026-02-22`
- Runtime class: `PiMemoryPhase3Extension`
- XTDB: `http://172.17.0.1:3000` (real service)
- Evidence file: `docs/rebuild/2026-02-22-five-live-drives-evidence.json`

## Executive verdict
Context management APIs are functionally working (`activate`/`deactivate`/`pin`/`unpin` all executed live and persisted correctly), but **context management is not being used correctly by default behavior** in long workflows: active context tends to accumulate unless explicit deactivation is applied as an operational policy.

---

## Scenario 1 — Multi-file research workflow

### Timeline (live actions)
- Ingested many paths via `wrappedLs` (6 files), then `wrappedFind`, then `wrappedGrep`.
- Selectively read two files (`alpha.md`, `gamma.ts`) using `read(...)`.
- Explicitly deactivated one no-longer-needed object (`alpha.md`).

### Counts over time
- After discovery: metadata=6, active=1, pinned=0 (only chat active)
- After selective reads: metadata=6, active=3, pinned=0
- After explicit deactivation: metadata=6, active=2, pinned=0

### IDs and invocation evidence
- Read IDs:
  - `file:/workspace/pi-memory/tmp/five-live-drives-2026-02-22T12-12-08-610Z/research/a/alpha.md`
  - `file:/workspace/pi-memory/tmp/five-live-drives-2026-02-22T12-12-08-610Z/research/b/gamma.ts`
- Invoked: `wrappedLs`, `wrappedFind`, `wrappedGrep`, `read`, `deactivate`

### Is context management being used correctly?
**Yes, when explicitly driven.** Active set shrank from 3 → 2 after deactivation.

---

## Scenario 2 — Tool-result heavy workflow

### Timeline (live actions)
- Added 8 large `toolResult` events (4k+ chars each) via `transformContext(...)`.
- Observed active growth with no deactivation policy.
- Deactivated first 5 toolcall objects (`tc-heavy-0..4`).

### Counts over time
- After heavy toolResults without policy: metadata=14, active=10, pinned=0
- After explicit deactivation policy: metadata=14, active=5, pinned=0

### IDs and invocation evidence
- Toolcall IDs: `tc-heavy-0` … `tc-heavy-7`
- Invoked: `transformContext`, `deactivate`

### Is context management being used correctly?
**Not by default, yes with explicit policy.** Without deactivation, active set grows quickly. With policy, active set dropped by 50% (10 → 5).

---

## Scenario 3 — Long-running task workflow (>=90s)

### Timeline (live actions)
- Ran 95.065s append loop on `longrun/stream.log` while watcher was active.
- Mid-run deactivation at iteration 6.
- Mid-run reactivation at iteration 12.
- XTDB history sampled at i=5,10,15 and final.

### Counts and history over time
- Start: metadata=15, active=5, pinned=0
- Sample i=5: history length=6, active=5
- After deactivation i=6: active remained 5 (target file was not active at that moment)
- Sample i=10: history length=11, active=5
- After reactivation i=12: active=6 (file re-added)
- Sample i=15: history length=16, active=6
- End: history length=20, active=6

### IDs and invocation evidence
- File ID: `file:/workspace/pi-memory/tmp/five-live-drives-2026-02-22T12-12-08-610Z/longrun/stream.log`
- Invoked: `wrappedWrite`, `deactivate`, `activate`

### Is context management being used correctly?
**Partially.** History growth worked as expected. Active-context shrink did not happen automatically during long run; it only changed when explicit activate/deactivate was called. This confirms the need for runtime deactivation policy.

---

## Scenario 4 — Session continuity workflow (persist/close/mutate/reload + pin/unpin)

### Timeline (live actions)
- Wrote and read `continuity/state.md`.
- Pinned file before close.
- Closed extension.
- Mutated file while extension down.
- Reloaded same session.
- Unpinned file after reload.

### Counts over time
- Before close: metadata=16, active=7, pinned=1
- After reload: metadata=16, active=7, pinned=1 (pin persisted)
- After unpin: metadata=16, active=7, pinned=0

### IDs and invocation evidence
- File ID: `file:/workspace/pi-memory/tmp/five-live-drives-2026-02-22T12-12-08-610Z/continuity/state.md`
- `charCountAfterReload=17` (includes down-time mutation)
- Invoked: `pin`, `unpin`, reload/load cycle

### Is context management being used correctly?
**Yes.** Pin persistence and unpin behavior across session reload were correct and state-consistent.

---

## Scenario 5 — Failure/edge workflow

### Timeline (live actions)
- Tried invalid operations:
  - `deactivate('missing:id')`
  - `pin('missing:id')`
  - `unpin('missing:id')`
  - `activate('file:/nonexistent/path/ghost.txt')`
- Verified failure messages and no crash.
- Recovered with normal flow on `recover/ok.txt`: write/read/pin/deactivate/activate/unpin.

### Counts over time
- Start: metadata=16, active=7, pinned=0
- End: metadata=17, active=8, pinned=0

### Error evidence
- All invalid calls returned `ok=false` with clear `Object not found: ...` messages.
- Recovery flow all returned success (`recoveryAllOk=true`).

### Is context management being used correctly?
**Yes for error handling/recovery semantics.** Invalid IDs are rejected clearly; normal operations remain consistent afterwards.

---

## Cross-scenario assessment: is context management being used correctly?

**Overall: functionally correct API behavior, but operational usage is often insufficient without explicit deactivation guidance.**

What is working:
- Manual deactivate shrinks active set immediately (Scenarios 1 & 2).
- Pin/unpin persistence across reload works (Scenario 4).
- Failure semantics are safe and recoverable (Scenario 5).

What is not happening by default:
- Active set does not self-prune during extended workflows (Scenario 3).
- Tool-result-heavy workloads retain many active entries unless explicitly deactivated (Scenario 2).

---

## Recommended prompt/policy adjustments (exact wording snippets)

Use these snippets in system/developer prompts to encourage proper deactivation behavior.

### 1) Add explicit deactivation trigger after each toolResult/read
> "After each `toolResult` or file `read`, decide whether that object is still needed for the *next 1–2 turns*. If not needed, call `deactivate(id)` immediately. Do not keep objects active by default."

### 2) Add active-set budget rule
> "Maintain an active-context budget: target <= 6 non-chat active objects. If active objects exceed budget, deactivate lowest-priority objects first (old toolResults, superseded files, one-off search outputs)."

### 3) Add long-running loop cadence rule
> "In tasks running longer than 60 seconds, perform context cleanup every 3–5 tool events: deactivate stale objects, keep only currently edited file(s), and reactivate on demand."

### 4) Add toolResult compaction rule
> "Treat large tool outputs as transient. Keep metadata reference, but deactivate full content unless it is directly required for imminent reasoning."

### 5) Add finish-of-subtask hygiene step
> "When a subtask is completed, run a context hygiene step: `deactivate` all subtask-specific objects that are not pinned and not needed for the next step."

---

## Long-running history growth vs. context shrink risk

Observed issue:
- Long-running file updates produced monotonic XTDB history growth (expected), while active-context did not shrink automatically.

Why this is a problem:
- Token/context pressure accumulates even when historical traceability is desired.

Operational mitigation:
1. Keep full history in XTDB (no change).
2. Apply periodic deactivation policy in agent loop (every N events / every 60s).
3. Reactivate only when the object is actively needed.
4. Pin only genuinely durable anchors (requirements, canonical spec, current work file).

This preserves audit/history fidelity while controlling active context size.
