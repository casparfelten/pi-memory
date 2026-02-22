# Context-Behavior Live Experiments — Batch 3 (2026-02-22)

- XTDB endpoint: `http://172.17.0.1:3000` (real, no mock/fallback)
- Method continuation: `docs/rebuild/context-behavior-methodology.md`
- Experiments executed: 3

## exp-1-forget-recall-multi
- Variant/task: policy-strong-best / natural forget→recall twice during incident timeline synthesis
- Runtime: 2s
- Active count trajectory (start/max/end): 1 -> 4 -> 3
- Metadata count trajectory (start/end): 0 -> 5
- Activate/deactivate counts: 2/5
- Recall count: 2
- Deactivation reasons/timestamps:
  - 2026-02-22T14:57:58.706Z: captured early timeline anchors; shifting to thresholds
  - 2026-02-22T14:57:59.519Z: partner payload detail parked while validating rollback threshold
  - 2026-02-22T14:57:59.519Z: rollback criterion extracted; no longer active
  - 2026-02-22T14:57:59.926Z: status framing extracted for summary tone
  - 2026-02-22T14:57:59.926Z: drift trend already captured for synthesis
- Assessment: natural-enough

## exp-2-competing-hypotheses-base
- Variant/task: policy-strong-best / competing hypotheses with evidence-set switching
- Runtime: 2s
- Active count trajectory (start/max/end): 1 -> 5 -> 3
- Metadata count trajectory (start/end): 0 -> 5
- Activate/deactivate counts: 2/5
- Recall count: 2
- Deactivation reasons/timestamps:
  - 2026-02-22T14:58:07.227Z: switching to alternative hypothesis set B
  - 2026-02-22T14:58:08.441Z: A evidence parked while pressure-testing B with queue trend
  - 2026-02-22T14:58:08.441Z: B statement extracted; focus on quantitative trend
  - 2026-02-22T14:58:08.441Z: queue trend captured for decision
  - 2026-02-22T14:58:08.441Z: retry evidence already compared and summarized
- Assessment: natural-enough

## exp-3-longflow-interruptions
- Variant/task: policy-strong-best / longer analysis with two interruptions and return to earlier evidence
- Runtime: 3s
- Active count trajectory (start/max/end): 1 -> 5 -> 2
- Metadata count trajectory (start/end): 0 -> 7
- Activate/deactivate counts: 2/7
- Recall count: 1
- Deactivation reasons/timestamps:
  - 2026-02-22T14:58:16.130Z: problem frame captured; moving to interruption request
  - 2026-02-22T14:58:16.940Z: interruption #1 answered
  - 2026-02-22T14:58:16.940Z: impact snippet extracted; returning to root-cause flow
  - 2026-02-22T14:58:16.940Z: consumer restart evidence parked during security interruption
  - 2026-02-22T14:58:17.748Z: security check request handled
  - 2026-02-22T14:58:17.748Z: security conclusion extracted
  - 2026-02-22T14:58:17.748Z: post-rollback log already integrated
- Assessment: natural-enough

## Prompt policy revision
- No revision needed; base policy behaved naturally across required scenarios.
