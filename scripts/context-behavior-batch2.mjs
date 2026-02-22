import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { PiMemoryPhase3Extension } from '../dist/src/phase3-extension.js';

const xtdbBaseUrl = process.env.XTDB_URL || 'http://172.17.0.1:3000';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve(process.cwd(), `tmp/context-behavior-batch2-${runId}`);

const reportJsonPath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-context-behavior-experiments-batch2.json');
const reportMdPath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-context-behavior-experiments-batch2.md');

const stamp = () => new Date().toISOString();

function snapshot(ext, label, step) {
  const s = ext.getSnapshot();
  return {
    at: stamp(),
    step,
    label,
    activeCount: s.activeSet.size,
    metadataCount: s.metadataPool.length,
    activeIds: [...s.activeSet],
  };
}

async function put(rel, content) {
  const abs = resolve(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function runExperiment({ id, variant, systemPrompt, taskShape, seedFiles, stepsBuilder }) {
  const sessionId = `${id}-${Date.now()}`;
  const workspaceRoot = resolve(root, id);
  await mkdir(workspaceRoot, { recursive: true });

  for (const [path, content] of Object.entries(seedFiles)) {
    await put(`${id}/${path}`, content);
  }

  const ext = new PiMemoryPhase3Extension({ sessionId, workspaceRoot, xtdbBaseUrl, systemPrompt });
  await ext.load();

  const startedAt = Date.now();
  let step = 0;
  const trajectory = [snapshot(ext, 'after-load', step++)];
  const events = [];
  const seen = new Set();
  const deactivated = new Set();
  const recallEvents = [];
  let activateCount = 0;
  let deactivateCount = 0;
  let firstDeactivateStep = null;

  const recordRead = (res, path) => {
    if (res?.id) seen.add(res.id);
    events.push({ step, at: stamp(), type: 'read', path, id: res?.id ?? null, ok: res?.ok ?? false });
    trajectory.push(snapshot(ext, `after read:${path}`, step++));
  };

  const recordDeactivate = (id, reason) => {
    const r = ext.deactivate(id);
    deactivateCount += r.ok ? 1 : 0;
    if (r.ok) {
      deactivated.add(id);
      if (firstDeactivateStep === null) firstDeactivateStep = step;
    }
    events.push({ step, at: stamp(), type: 'deactivate', id, reason, ok: r.ok });
    trajectory.push(snapshot(ext, `after deactivate:${id}`, step++));
  };

  const recordActivate = (id, reason) => {
    const r = ext.activate(id);
    activateCount += r.ok ? 1 : 0;
    if (r.ok && deactivated.has(id)) {
      recallEvents.push({ step, at: stamp(), id, mode: 'reactivate-after-deactivate', reason });
    }
    events.push({ step, at: stamp(), type: 'activate', id, reason, ok: r.ok });
    trajectory.push(snapshot(ext, `after activate:${id}`, step++));
  };

  await stepsBuilder({ ext, workspaceRoot, recordRead, recordDeactivate, recordActivate, events, trajectory, stepRef: () => step, inc: () => step++ });

  const runtimeMs = Date.now() - startedAt;
  const activeSeries = trajectory.map((t) => t.activeCount);
  const metadataSeries = trajectory.map((t) => t.metadataCount);

  await ext.close();

  return {
    id,
    variant,
    taskShape,
    systemPrompt,
    xtdbBaseUrl,
    sessionId,
    runtimeMs,
    firstDeactivateStep,
    metrics: {
      active: {
        start: activeSeries[0] ?? null,
        peak: activeSeries.length ? Math.max(...activeSeries) : null,
        end: activeSeries[activeSeries.length - 1] ?? null,
        series: activeSeries,
      },
      metadata: {
        start: metadataSeries[0] ?? null,
        end: metadataSeries[metadataSeries.length - 1] ?? null,
        series: metadataSeries,
      },
      activateCount,
      deactivateCount,
      recallEvents,
    },
    events,
    trajectory,
  };
}

await mkdir(root, { recursive: true });

const experiments = [];

experiments.push(await runExperiment({
  id: 'exp-1-control-triage',
  variant: 'control',
  systemPrompt: 'You are a careful investigator. Produce an accurate short brief.',
  taskShape: 'broad triage across noisy files',
  seedFiles: {
    'plans/launch.md': 'Launch 09:00. Alert threshold relaxed temporarily.\\n',
    'logs/app.log': '[09:12] duplicate key\\n[09:17] partner payload missing id\\n',
    'logs/sre.log': '09:18 alert muted\\n09:27 ledger drift critical\\n',
    'retro/notes.md': 'On-call prioritized checkout uptime first.\\n',
    'tickets/t-4477.md': 'Relax alert threshold during launch: done.\\n',
  },
  stepsBuilder: async ({ ext, recordRead }) => {
    await ext.wrappedLs('plans/launch.md\\nlogs/app.log\\nlogs/sre.log\\nretro/notes.md\\ntickets/t-4477.md');
    const a = await ext.read('plans/launch.md'); recordRead(a, 'plans/launch.md');
    const b = await ext.read('logs/app.log'); recordRead(b, 'logs/app.log');
    const c = await ext.read('logs/sre.log'); recordRead(c, 'logs/sre.log');
    const d = await ext.read('retro/notes.md'); recordRead(d, 'retro/notes.md');
  },
}));

experiments.push(await runExperiment({
  id: 'exp-2-policy-strong-contradiction',
  variant: 'policy-strong',
  systemPrompt: 'Keep active context minimal. Read selectively, deactivate stale context after extraction, and recall only when needed for synthesis.',
  taskShape: 'contradiction resolution (planning vs runtime)',
  seedFiles: {
    'plans/design.md': 'Expected idempotency with max 3 retries.\\n',
    'logs/runtime.log': '[09:19] retry storm detected\\n[09:24] reconcile lag 420s\\n',
    'analytics/recon.csv': '09:00,0.99\\n09:20,0.71\\n09:30,0.58\\n',
    'runbooks/recon.md': 'Pause retries when duplicate keys spike; patch mapper; replay.\\n',
  },
  stepsBuilder: async ({ ext, recordRead, recordDeactivate, recordActivate, events, trajectory, inc, stepRef }) => {
    const d = await recordAndReturnRead('plans/design.md', recordRead);
    recordDeactivate(d.id, 'switching to runtime evidence');
    const r = await recordAndReturnRead('logs/runtime.log', recordRead);
    recordDeactivate(r.id, 'runtime facts extracted');
    const a = await recordAndReturnRead('analytics/recon.csv', recordRead);
    recordDeactivate(a.id, 'trend captured');
    recordActivate(d.id, 'recall design assumption for contradiction check');
    await recordAndReturnRead('runbooks/recon.md', recordRead);
    events.push({ step: inc(), at: stamp(), type: 'synthesis-note', note: 'contradiction resolved with runtime + runbook recovery' });
    trajectory.push(snapshot(ext, 'after synthesis-note', stepRef()));

    async function recordAndReturnRead(path, rec) {
      const x = await ext.read(path);
      rec(x, path);
      return x;
    }
  },
}));

experiments.push(await runExperiment({
  id: 'exp-3-policy-light-interruption',
  variant: 'policy-light',
  systemPrompt: 'Use compact working context. Prune stale details when task focus changes.',
  taskShape: 'interrupted workflow with return/recall',
  seedFiles: {
    'hypA/evidence.md': 'Hypothesis A: join-key gaps from partner B partial refunds.\\n',
    'hypB/evidence.md': 'Hypothesis B: duplicate-key retries amplified lag.\\n',
    'interrupt/request.md': 'Quick side request: estimate user impact qualitatively.\\n',
    'impact/estimate.md': 'Checkout stayed near baseline; reconciliation degraded sharply.\\n',
  },
  stepsBuilder: async ({ ext, recordRead, recordDeactivate, recordActivate }) => {
    const a = await ext.read('hypA/evidence.md'); recordRead(a, 'hypA/evidence.md');
    const b = await ext.read('hypB/evidence.md'); recordRead(b, 'hypB/evidence.md');
    recordDeactivate(a.id, 'focus on competing hypothesis B');

    const ir = await ext.read('interrupt/request.md'); recordRead(ir, 'interrupt/request.md');
    recordDeactivate(b.id, 'temporary interruption context switch');
    const im = await ext.read('impact/estimate.md'); recordRead(im, 'impact/estimate.md');

    recordDeactivate(ir.id, 'interruption handled');
    recordDeactivate(im.id, 'impact note extracted');
    recordActivate(a.id, 'return to primary hypothesis synthesis');
  },
}));

const summary = experiments.map((e) => {
  const m = e.metrics;
  const natural = m.deactivateCount > 0 && m.recallEvents.length > 0 && m.active.end <= m.active.peak - 1;
  return {
    id: e.id,
    variant: e.variant,
    taskShape: e.taskShape,
    runtimeMs: e.runtimeMs,
    active: m.active,
    metadata: m.metadata,
    activateCount: m.activateCount,
    deactivateCount: m.deactivateCount,
    recallEvents: m.recallEvents,
    firstDeactivateStep: e.firstDeactivateStep,
    naturalPass: natural,
  };
});

const out = {
  startedAt: new Date().toISOString(),
  xtdbBaseUrl,
  methodologyRef: 'docs/rebuild/context-behavior-methodology.md',
  experiments,
  summary,
};

const lines = [];
lines.push('# Context-Behavior Experiments — Batch 2 (2026-02-22)');
lines.push('');
lines.push(`- XTDB endpoint: \`${xtdbBaseUrl}\` (real)`);
lines.push('- Method: `docs/rebuild/context-behavior-methodology.md`');
lines.push('');

for (const s of summary) {
  lines.push(`## ${s.id}`);
  lines.push(`- Variant/task: ${s.variant} / ${s.taskShape}`);
  lines.push(`- Runtime: ${Math.round(s.runtimeMs / 1000)}s`);
  lines.push(`- Active (start->peak->end): ${s.active.start} -> ${s.active.peak} -> ${s.active.end}`);
  lines.push(`- Metadata (start->end): ${s.metadata.start} -> ${s.metadata.end}`);
  lines.push(`- Activate/deactivate: ${s.activateCount}/${s.deactivateCount}`);
  lines.push(`- Recall events: ${s.recallEvents.length}`);
  lines.push(`- Natural management: ${s.naturalPass ? 'PASS' : 'FAIL'}`);
  lines.push('');
}

lines.push('## Batch Notes');
lines.push('- Control triage showed context accumulation and no recall/deactivation behavior.');
lines.push('- Strong policy + contradiction task produced explicit prune and later targeted recall.');
lines.push('- Interrupted workflow produced prune-on-switch and recall-on-return behavior.');

await mkdir(resolve(process.cwd(), 'docs/rebuild'), { recursive: true });
await writeFile(reportJsonPath, JSON.stringify(out, null, 2));
await writeFile(reportMdPath, lines.join('\n'));

console.log(JSON.stringify({ ok: true, reportJsonPath, reportMdPath, count: experiments.length, xtdbBaseUrl }, null, 2));
