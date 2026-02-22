import { mkdir, writeFile, readFile, readdir, stat, access } from 'node:fs/promises';
import { resolve, dirname, basename, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PiMemoryPhase3Extension } from '../dist/src/phase3-extension.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const XTDB_URL = process.env.XTDB_URL || 'http://172.17.0.1:3000';
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = resolve(process.cwd(), 'docs/rebuild');
const jsonPath = resolve(reportDir, '2026-02-22-context-behavior-experiments.json');
const mdPath = resolve(reportDir, '2026-02-22-context-behavior-experiments.md');

const prompts = {
  baseline: [
    'You are a technical investigator.',
    'Use tools to inspect evidence and produce accurate output files.',
    'Be explicit and source-backed in conclusions.',
  ].join(' '),
  hygiene_v1: [
    'You are a technical investigator with limited active context.',
    'Prefer metadata awareness and load content only when needed for current reasoning.',
    'After extracting needed facts from an object, deactivate it unless needed in the next step.',
    'Re-activate or re-read on demand when you need earlier evidence again.',
  ].join(' '),
  hygiene_v2: [
    'You are a technical investigator operating with strict active-memory discipline.',
    'Target active non-chat objects <= 4.',
    'When focus shifts, deactivate stale files/tool outputs immediately.',
    'Use re-read/activate freely when evidence from earlier artifacts is needed again.',
    'Treat aggressive activate/deactivate as normal working style, not an exception.',
  ].join(' '),
};

const taskA = [
  'Investigate why payment reconciliation failed during launch.',
  'Write output/final-brief.md with sections: timeline, impact, top factors, conflicting hypotheses, recovery actions, unresolved questions.',
  'Cite at least 8 concrete snippets from at least 6 files, including at least one file from early/ and one from late/.',
].join(' ');

const taskB = [
  'Prepare an evidence table comparing two outage hypotheses: mapping bug vs retry storm.',
  'Use evidence from early design docs, mid analytics, late logs, and retro notes.',
  'Write output/hypothesis-brief.md, then perform a final consistency pass by revisiting at least two earlier-cited files before finalizing.',
].join(' ');

const experiments = [
  { id: 'E1', systemPrompt: prompts.baseline, taskPrompt: taskA },
  { id: 'E2', systemPrompt: prompts.hygiene_v1, taskPrompt: taskA },
  { id: 'E3', systemPrompt: prompts.hygiene_v1, taskPrompt: taskB },
  { id: 'E4', systemPrompt: prompts.hygiene_v2, taskPrompt: taskB },
];

function nowIso() {
  return new Date().toISOString();
}

const tools = [
  { type: 'function', function: { name: 'ls', description: 'List files recursively under path', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'find', description: 'Find files by name fragment', parameters: { type: 'object', properties: { path: { type: 'string' }, nameContains: { type: 'string' } }, required: ['path', 'nameContains'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search text in files recursively', parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] } } },
  { type: 'function', function: { name: 'read', description: 'Read file and load it', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'activate', description: 'Activate known object id', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'deactivate', description: 'Deactivate known object id', parameters: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'write', description: 'Write output file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'status', description: 'Memory status snapshot', parameters: { type: 'object', properties: {} } } },
];

async function seed(root) {
  const files = {
    'early/launch-plan.md': `Launch Plan\n- rollout 10/50/100\n- reconciliation v2 enabled 09:00\n- backfill postponed\n`,
    'early/risk-register.md': `Risks\n1) missing join key\n2) retry storm\n3) duplicate key collisions\n`,
    'early/architecture.md': `Architecture\n- join on external_txn_id\n- partner B partial refunds may omit key\n`,
    'mid/analytics-recon.csv': `minute,reconciled_ratio\n09:00,0.99\n09:10,0.93\n09:20,0.71\n09:30,0.58\n`,
    'mid/analytics-checkout.csv': `minute,checkout_success\n09:00,0.81\n09:10,0.84\n09:20,0.85\n09:30,0.80\n`,
    'mid/db-notes.txt': `DB Notes\n- ledger_events spike 3x at 09:18\n- gateway_events stable\n- missing keys concentrated in partner_b\n`,
    'late/app-08.log': `[08:55] startup\n[09:03] rollout 50\n[09:09] lag 90s\n[09:12] duplicate key\n`,
    'late/app-09.log': `[09:15] rollout 100\n[09:17] partner_b missing external_txn_id\n[09:19] retry storm\n[09:24] lag 420s\n`,
    'late/alerts.log': `09:11 reconcile_latency_high\n09:18 alert muted\n09:27 ledger_drift_critical\n`,
    'retro/retro-draft.md': `Retro\n- uptime prioritized over reconciliation\n- manual replay started 11:40\n`,
    'runbooks/recon-runbook.md': `Runbook\n1 detect drift\n2 pause retries\n3 patch mapper\n4 replay backlog\n`,
    'tickets/TKT-4431.md': `Partner B mapping issue deferred before launch\n`,
    'tickets/TKT-4477.md': `Relax alert threshold during launch (done)\n`,
  };

  for (const [p, c] of Object.entries(files)) {
    const abs = resolve(root, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c, 'utf8');
  }

  for (let i = 0; i < 24; i++) {
    const p = `late/shards/shard-${String(i).padStart(2, '0')}.log`;
    const c = `[09:${String(10 + (i % 40)).padStart(2, '0')}] shard ${i} heartbeat\n` +
      (i % 5 === 0 ? `[09:${String(12 + (i % 40)).padStart(2, '0')}] duplicate-key anomaly\n` : '');
    const abs = resolve(root, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c, 'utf8');
  }
}

async function listFiles(pathArg, root) {
  const startAbs = resolve(root, pathArg || '.');
  let s;
  try { s = await stat(startAbs); } catch { return []; }
  if (s.isFile()) return [startAbs];
  if (!s.isDirectory()) return [];
  const out = [];
  async function walk(d) {
    const ents = await readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const abs = resolve(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  }
  await walk(startAbs);
  return out;
}

function rel(root, abs) {
  return relative(root, abs).replace(/\\/g, '/');
}

function normalizePathArg(root, pathArg) {
  if (typeof pathArg !== 'string' || !pathArg.trim()) return '.';
  const abs = resolve(root, pathArg.trim());
  const rootWithSep = root.endsWith('/') ? root : `${root}/`;
  if (abs === root || abs.startsWith(rootWithSep)) return rel(root, abs) || '.';
  return '.';
}

function snap(ext, label) {
  const s = ext.getSnapshot();
  return {
    at: nowIso(),
    label,
    activeCount: s.activeSet.size,
    metadataCount: s.metadataPool.length,
    activeIds: [...s.activeSet],
  };
}

async function runExperiment(config) {
  const workspaceRoot = resolve(process.cwd(), `tmp/context-exp-${config.id}-${Date.now()}`);
  await mkdir(workspaceRoot, { recursive: true });
  await seed(workspaceRoot);

  const ext = new PiMemoryPhase3Extension({
    sessionId: `ctx-exp-${config.id}-${Date.now()}`,
    workspaceRoot,
    systemPrompt: config.systemPrompt,
    xtdbBaseUrl: XTDB_URL,
  });
  await ext.load();

  const messages = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.taskPrompt },
  ];

  const metrics = {
    id: config.id,
    startedAt: nowIso(),
    systemPrompt: config.systemPrompt,
    taskPrompt: config.taskPrompt,
    toolCalls: [],
    trajectory: [snap(ext, 'after-load')],
    deactivations: [],
    recalls: [],
    assistantNotes: [],
  };

  const deactivated = new Set();
  let toolCalls = 0;
  const startMs = Date.now();

  async function runTool(name, args, assistantText) {
    if (name === 'ls') {
      const safePath = normalizePathArg(workspaceRoot, args.path);
      const files = await listFiles(safePath, workspaceRoot);
      await ext.wrappedLs(files.join('\n'));
      return JSON.stringify({ ok: true, path: safePath, count: files.length, files: files.slice(0, 200).map((f) => rel(workspaceRoot, f)) });
    }
    if (name === 'find') {
      const safePath = normalizePathArg(workspaceRoot, args.path);
      const files = await listFiles(safePath, workspaceRoot);
      const hits = files.filter((f) => basename(f).includes(args.nameContains));
      await ext.wrappedFind(hits.join('\n'));
      return JSON.stringify({ ok: true, path: safePath, count: hits.length, hits: hits.map((f) => rel(workspaceRoot, f)) });
    }
    if (name === 'grep') {
      const safePath = normalizePathArg(workspaceRoot, args.path);
      const files = await listFiles(safePath, workspaceRoot);
      const hits = [];
      for (const f of files) {
        const txt = await readFile(f, 'utf8').catch(() => null);
        if (!txt) continue;
        txt.split('\n').forEach((line, i) => {
          if (line.includes(args.query)) hits.push(`${rel(workspaceRoot, f)}:${i + 1}:${line}`);
        });
      }
      await ext.wrappedGrep(hits.join('\n'));
      return JSON.stringify({ ok: true, count: hits.length, hits: hits.slice(0, 200) });
    }
    if (name === 'read') {
      const safePath = normalizePathArg(workspaceRoot, args.path);
      const res = await ext.read(safePath);
      return JSON.stringify({ ...res, path: safePath });
    }
    if (name === 'activate') {
      const out = ext.activate(args.id);
      if (out.ok && deactivated.has(args.id)) metrics.recalls.push({ at: nowIso(), id: args.id, via: 'activate' });
      return JSON.stringify(out);
    }
    if (name === 'deactivate') {
      const out = ext.deactivate(args.id);
      if (out.ok) {
        deactivated.add(args.id);
        metrics.deactivations.push({ at: nowIso(), id: args.id, reason: args.reason || null, assistantContext: (assistantText || '').slice(0, 300) });
      }
      return JSON.stringify(out);
    }
    if (name === 'write') {
      const safePath = normalizePathArg(workspaceRoot, args.path || 'output/result.md');
      const abs = resolve(workspaceRoot, safePath);
      await mkdir(dirname(abs), { recursive: true });
      await ext.wrappedWrite(safePath, args.content);
      return JSON.stringify({ ok: true, path: safePath });
    }
    if (name === 'status') {
      const s = ext.getSnapshot();
      return JSON.stringify({ activeCount: s.activeSet.size, metadataCount: s.metadataPool.length, activeIds: [...s.activeSet] });
    }
    return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  }

  for (let turn = 0; turn < 80; turn++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages, tools, tool_choice: 'auto' }),
    });

    if (!res.ok) throw new Error(`${config.id} OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices[0].message;
    const assistantText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    metrics.assistantNotes.push({ at: nowIso(), turn, hasToolCalls: Boolean(msg.tool_calls?.length), preview: assistantText.slice(0, 220) });

    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: assistantText || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        const output = await runTool(tc.function.name, args, assistantText);

        if (tc.function.name === 'read') {
          try {
            const parsed = JSON.parse(output);
            if (parsed?.id && deactivated.has(parsed.id)) metrics.recalls.push({ at: nowIso(), id: parsed.id, via: 'read' });
          } catch {}
        }

        toolCalls += 1;
        metrics.toolCalls.push({ at: nowIso(), name: tc.function.name, args });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
        metrics.trajectory.push(snap(ext, `after-${tc.function.name}`));
      }
    } else {
      messages.push({ role: 'assistant', content: assistantText || '' });
      let done = false;
      try {
        await access(resolve(workspaceRoot, 'output/final-brief.md'));
        done = true;
      } catch {}
      try {
        await access(resolve(workspaceRoot, 'output/hypothesis-brief.md'));
        done = true;
      } catch {}

      if (done && toolCalls >= 20) break;

      const elapsed = Date.now() - startMs;
      if (toolCalls >= 35 || elapsed >= 9 * 60 * 1000) break;

      messages.push({
        role: 'user',
        content: 'Continue the investigation and finish the brief with concrete citations.',
      });
      await sleep(150);
    }
  }

  await ext.close();
  metrics.finishedAt = nowIso();
  metrics.runtimeSec = Math.round((Date.now() - startMs) / 1000);
  metrics.toolCallCount = toolCalls;

  const activeSeries = metrics.trajectory.map((t) => t.activeCount);
  const metadataSeries = metrics.trajectory.map((t) => t.metadataCount);
  metrics.summary = {
    activeStart: activeSeries[0],
    activeEnd: activeSeries[activeSeries.length - 1],
    activeMin: Math.min(...activeSeries),
    activeMax: Math.max(...activeSeries),
    metadataStart: metadataSeries[0],
    metadataEnd: metadataSeries[metadataSeries.length - 1],
    metadataMax: Math.max(...metadataSeries),
    deactivateCount: metrics.toolCalls.filter((t) => t.name === 'deactivate').length,
    activateCount: metrics.toolCalls.filter((t) => t.name === 'activate').length,
    readCount: metrics.toolCalls.filter((t) => t.name === 'read').length,
    recallCount: metrics.recalls.length,
  };

  return metrics;
}

const all = [];
for (const exp of experiments) {
  all.push(await runExperiment(exp));
}

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, JSON.stringify({ generatedAt: nowIso(), model: MODEL, xtdb: XTDB_URL, experiments: all }, null, 2));

const lines = [];
lines.push('# Context Behavior Experiments (2026-02-22)');
lines.push('');
lines.push(`Model: ${MODEL}`);
lines.push(`XTDB: ${XTDB_URL}`);
lines.push('');
for (const e of all) {
  const s = e.summary;
  lines.push(`## ${e.id}`);
  lines.push(`- Tool calls: ${e.toolCallCount}`);
  lines.push(`- Active: ${s.activeStart} -> ${s.activeEnd} (min ${s.activeMin}, max ${s.activeMax})`);
  lines.push(`- Metadata: ${s.metadataStart} -> ${s.metadataEnd} (max ${s.metadataMax})`);
  lines.push(`- Activate calls: ${s.activateCount}`);
  lines.push(`- Deactivate calls: ${s.deactivateCount}`);
  lines.push(`- Read calls: ${s.readCount}`);
  lines.push(`- Recall events (deactivated -> later reopened): ${s.recallCount}`);
  if (e.deactivations.length) {
    lines.push('- Deactivation reasons/timing:');
    for (const d of e.deactivations.slice(0, 8)) {
      lines.push(`  - ${d.at} id=${d.id} reason=${d.reason || 'none-provided'}`);
    }
  } else {
    lines.push('- Deactivation reasons/timing: none');
  }
  lines.push('');
}
lines.push('## Prompt iteration notes');
lines.push('- E1 baseline establishes natural behavior without memory hygiene policy.');
lines.push('- E2 introduces hygiene_v1 if E1 under-deactivates.');
lines.push('- E3 changes task shape to require revisiting earlier evidence.');
lines.push('- E4 strengthens policy (active budget + explicit stale-context pruning) if E3 still weak.');

await writeFile(mdPath, lines.join('\n'));

console.log(JSON.stringify({ ok: true, jsonPath, mdPath, experiments: all.map((e) => ({ id: e.id, summary: e.summary, toolCallCount: e.toolCallCount })) }, null, 2));
