# Context Behavior Experiments (2026-02-22)

Model: gpt-4.1
XTDB: http://172.17.0.1:3000

## E1
- Tool calls: 196
- Active: 1 -> 31 (min 1, max 31)
- Metadata: 0 -> 30 (max 30)
- Activate calls: 0
- Deactivate calls: 0
- Read calls: 99
- Recall events (deactivated -> later reopened): 0
- Deactivation reasons/timing: none

## E2
- Tool calls: 69
- Active: 1 -> 11 (min 1, max 22)
- Metadata: 0 -> 31 (max 31)
- Activate calls: 0
- Deactivate calls: 11
- Read calls: 40
- Recall events (deactivated -> later reopened): 0
- Deactivation reasons/timing:
  - 2026-02-22T13:12:28.999Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/shards/shard-15.log reason=Loaded for anomaly and timeline evidence.
  - 2026-02-22T13:12:30.046Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/shards/shard-10.log reason=Loaded for anomaly and timeline evidence.
  - 2026-02-22T13:12:31.781Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/shards/shard-05.log reason=Loaded for anomaly and timeline evidence.
  - 2026-02-22T13:12:33.723Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/shards/shard-00.log reason=Loaded for anomaly and timeline evidence.
  - 2026-02-22T13:12:35.366Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/app-09.log reason=Loaded for timeline and error evidence.
  - 2026-02-22T13:12:36.686Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/app-08.log reason=Loaded for timeline and error evidence.
  - 2026-02-22T13:12:37.956Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/late/alerts.log reason=Loaded for alert and timeline evidence.
  - 2026-02-22T13:12:38.842Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E2-1771765898682/early/architecture.md reason=Loaded for architecture and risk evidence.

## E3
- Tool calls: 27
- Active: 1 -> 1 (min 1, max 5)
- Metadata: 0 -> 33 (max 33)
- Activate calls: 2
- Deactivate calls: 6
- Read calls: 10
- Recall events (deactivated -> later reopened): 4
- Deactivation reasons/timing:
  - 2026-02-22T13:13:45.903Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/late/app-09.log reason=Extracted retry storm log evidence.
  - 2026-02-22T13:13:46.935Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/retro/retro-draft.md reason=Extracted retro notes for both hypotheses.
  - 2026-02-22T13:13:47.813Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/tickets/TKT-4431.md reason=Extracted mapping bug evidence.
  - 2026-02-22T13:13:48.940Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/early/risk-register.md reason=Extracted retry storm risk evidence.
  - 2026-02-22T13:13:56.150Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/late/app-09.log reason=Consistency check complete.
  - 2026-02-22T13:13:56.150Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E3-1771766000302/retro/retro-draft.md reason=Consistency check complete.

## E4
- Tool calls: 55
- Active: 1 -> 5 (min 1, max 6)
- Metadata: 0 -> 38 (max 38)
- Activate calls: 2
- Deactivate calls: 8
- Read calls: 16
- Recall events (deactivated -> later reopened): 8
- Deactivation reasons/timing:
  - 2026-02-22T13:14:19.037Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/late/alerts.log reason=Freeing memory for evidence table synthesis.
  - 2026-02-22T13:14:19.873Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/retro/retro-draft.md reason=Freeing memory for evidence table synthesis.
  - 2026-02-22T13:14:24.221Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/early/architecture.md reason=Freeing memory for synthesis; will reactivate for consistency pass.
  - 2026-02-22T13:14:44.365Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/early/architecture.md reason=No direct mapping/retry evidence; freeing memory.
  - 2026-02-22T13:14:45.432Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/early/risk-register.md reason=Evidence extracted; freeing memory.
  - 2026-02-22T13:14:47.852Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/mid/analytics-checkout.csv reason=Switching to analytics-recon for more detail; freeing memory.
  - 2026-02-22T13:14:50.525Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/mid/analytics-recon.csv reason=No direct mapping/retry evidence; freeing memory.
  - 2026-02-22T13:15:16.550Z id=file:/home/abaris/src/pi-memory/tmp/context-exp-E4-1771766037598/late/app-08.log reason=No direct evidence found; freeing memory.

## Prompt iteration notes
- E1 baseline establishes natural behavior without memory hygiene policy.
- E2 introduces hygiene_v1 if E1 under-deactivates.
- E3 changes task shape to require revisiting earlier evidence.
- E4 strengthens policy (active budget + explicit stale-context pruning) if E3 still weak.