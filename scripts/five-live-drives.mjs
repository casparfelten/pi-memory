import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PiMemoryPhase3Extension } from '../dist/src/phase3-extension.js';
import { XtdbClient } from '../dist/src/xtdb-client.js';

const xtdbBaseUrl = process.env.XTDB_URL || 'http://172.17.0.1:3000';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = resolve(process.cwd(), `tmp/five-live-drives-${runId}`);
const sessionId = `five-live-drives-${Date.now()}`;

const evidence = {
  startedAt: new Date().toISOString(),
  xtdbBaseUrl,
  workspaceRoot,
  sessionId,
  scenarios: {},
};

const xtdb = new XtdbClient(xtdbBaseUrl);

const stamp = () => new Date().toISOString();

function snapshot(ext, label) {
  const s = ext.getSnapshot();
  return {
    at: stamp(),
    label,
    metadataCount: s.metadataPool.length,
    activeCount: s.activeSet.size,
    pinnedCount: s.pinnedSet.size,
    activeIds: [...s.activeSet],
    pinnedIds: [...s.pinnedSet],
  };
}

function toolResult(id, text, ts, isError = false, toolName = 'bash') {
  return { role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text }], isError, timestamp: ts };
}

await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(workspaceRoot, { recursive: true });

const ext = new PiMemoryPhase3Extension({
  sessionId,
  workspaceRoot,
  systemPrompt: 'Five live drives',
  xtdbBaseUrl,
});
await ext.load();

// Scenario 1: Multi-file research workflow
{
  const scenario = { timeline: [], counts: [], ids: {}, invoked: {}, assessment: {} };
  const note = (event, details = {}) => scenario.timeline.push({ at: stamp(), event, ...details });

  await mkdir(resolve(workspaceRoot, 'research/a'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'research/b'), { recursive: true });
  const files = [
    ['research/a/alpha.md', 'alpha body\n'],
    ['research/a/beta.md', 'beta body\n'],
    ['research/b/gamma.ts', 'export const gamma = 1;\n'],
    ['research/b/delta.json', '{"delta": true}\n'],
    ['research/notes.txt', 'notes\n'],
    ['research/todo.txt', 'todo\n'],
  ];
  for (const [p, c] of files) await writeFile(resolve(workspaceRoot, p), c, 'utf8');

  await ext.wrappedLs(files.map(([p]) => p).join('\n'));
  scenario.invoked.wrappedLs = true;
  scenario.counts.push(snapshot(ext, 'after wrappedLs'));
  note('discovered via wrappedLs', { count: files.length });

  const findOutput = files.map(([p]) => p).filter((p) => p.endsWith('.md') || p.endsWith('.ts')).join('\n');
  await ext.wrappedFind(findOutput);
  scenario.invoked.wrappedFind = true;
  note('discovered via wrappedFind');

  await ext.wrappedGrep('research/a/alpha.md:1:alpha body\nresearch/b/gamma.ts:1:export const gamma = 1;');
  scenario.invoked.wrappedGrep = true;
  note('discovered via wrappedGrep');

  const r1 = await ext.read('research/a/alpha.md');
  const r2 = await ext.read('research/b/gamma.ts');
  scenario.invoked.read = true;
  scenario.ids.readIds = [r1.id, r2.id];
  scenario.counts.push(snapshot(ext, 'after selective reads/activation'));
  note('read selected files', { ids: scenario.ids.readIds });

  const d1 = ext.deactivate(r1.id);
  scenario.invoked.deactivate = true;
  scenario.ids.deactivateResult = d1;
  scenario.counts.push(snapshot(ext, 'after deactivation of alpha.md'));
  note('deactivated one file', { result: d1 });

  scenario.assessment.activeShrank = scenario.counts[2].activeCount < scenario.counts[1].activeCount;
  evidence.scenarios.scenario1 = scenario;
}

// Scenario 2: Tool-result heavy workflow
{
  const scenario = { timeline: [], counts: [], ids: {}, invoked: {}, assessment: {} };
  const note = (event, details = {}) => scenario.timeline.push({ at: stamp(), event, ...details });
  const now = Date.now();

  const heavyMessages = [];
  for (let i = 0; i < 8; i++) {
    const payload = `chunk-${i}\n` + 'x'.repeat(4000 + i * 200);
    heavyMessages.push(toolResult(`tc-heavy-${i}`, payload, now + i));
  }
  await ext.transformContext(heavyMessages);
  scenario.invoked.transformContext = true;
  scenario.ids.toolCallIds = heavyMessages.map((m) => m.toolCallId);
  scenario.counts.push(snapshot(ext, 'after heavy toolResults (no deactivation)'));
  note('added heavy tool results', { count: heavyMessages.length });

  for (let i = 0; i < 5; i++) {
    ext.deactivate(`tc-heavy-${i}`);
  }
  scenario.invoked.deactivate = true;
  scenario.counts.push(snapshot(ext, 'after explicit deactivation policy on first 5 toolcalls'));
  note('deactivated first five tool results');

  scenario.assessment.activeShrank = scenario.counts[1].activeCount < scenario.counts[0].activeCount;
  evidence.scenarios.scenario2 = scenario;
}

// Scenario 3: Long-running workflow >=90s
{
  const scenario = { timeline: [], counts: [], ids: {}, invoked: {}, assessment: {}, historySamples: [] };
  const note = (event, details = {}) => scenario.timeline.push({ at: stamp(), event, ...details });

  const path = 'longrun/stream.log';
  await mkdir(resolve(workspaceRoot, 'longrun'), { recursive: true });
  await ext.wrappedWrite(path, 'tick-0\n');
  scenario.invoked.wrappedWrite = true;
  const id = `file:${resolve(workspaceRoot, path)}`;
  scenario.ids.fileId = id;
  scenario.counts.push(snapshot(ext, 'longrun start'));

  const start = Date.now();
  for (let i = 1; i <= 19; i++) {
    await appendFile(resolve(workspaceRoot, path), `tick-${i} @ ${stamp()}\n`, 'utf8');
    await sleep(5000);

    if (i === 6) {
      const res = ext.deactivate(id);
      scenario.invoked.deactivate = true;
      note('mid-run deactivation', { i, res });
      scenario.counts.push(snapshot(ext, `after deactivate i=${i}`));
    }
    if (i === 12) {
      const res = ext.activate(id);
      scenario.invoked.activate = true;
      note('mid-run reactivation', { i, res });
      scenario.counts.push(snapshot(ext, `after reactivate i=${i}`));
    }

    if (i % 5 === 0) {
      const h = await xtdb.history(id);
      scenario.historySamples.push({ at: stamp(), i, historyLength: h.length });
      scenario.counts.push(snapshot(ext, `sample i=${i}`));
      note('history sample', { i, historyLength: h.length });
    }
  }

  const durationSec = (Date.now() - start) / 1000;
  const finalHistory = await xtdb.history(id);
  scenario.assessment.durationSec = durationSec;
  scenario.assessment.historyLength = finalHistory.length;
  scenario.assessment.met90s = durationSec >= 90;
  scenario.counts.push(snapshot(ext, 'longrun end'));
  note('longrun completed', { durationSec, historyLength: finalHistory.length });

  evidence.scenarios.scenario3 = scenario;
}

// Scenario 4: Session continuity with pin/unpin
{
  const scenario = { timeline: [], counts: [], ids: {}, invoked: {}, assessment: {} };
  const note = (event, details = {}) => scenario.timeline.push({ at: stamp(), event, ...details });

  const p = 'continuity/state.md';
  await mkdir(resolve(workspaceRoot, 'continuity'), { recursive: true });
  await ext.wrappedWrite(p, 'v1\n');
  await ext.read(p);
  const id = `file:${resolve(workspaceRoot, p)}`;
  scenario.ids.fileId = id;

  const pinRes = ext.pin(id);
  scenario.invoked.pin = true;
  note('pin before close', { pinRes });
  scenario.counts.push(snapshot(ext, 'before close'));

  await ext.close();
  note('closed original extension');

  await appendFile(resolve(workspaceRoot, p), 'v2-while-down\n', 'utf8');
  note('mutated file while down');

  const extReload = new PiMemoryPhase3Extension({ sessionId, workspaceRoot, systemPrompt: 'Five live drives', xtdbBaseUrl });
  await extReload.load();
  scenario.invoked.reload = true;
  scenario.counts.push(snapshot(extReload, 'after reload'));

  const unpinRes = extReload.unpin(id);
  scenario.invoked.unpin = true;
  note('unpin after reload', { unpinRes });
  scenario.counts.push(snapshot(extReload, 'after unpin'));

  const entity = await extReload.getXtEntity(id);
  scenario.assessment.charCountAfterReload = entity?.char_count ?? null;
  scenario.assessment.pinPersistedAcrossReload = scenario.counts[1].pinnedIds.includes(id);

  await extReload.close();
  scenario.assessment.unpinnedAtEnd = !scenario.counts[2].pinnedIds.includes(id);
  evidence.scenarios.scenario4 = scenario;

  // open again for scenario 5 continuation
  const extAgain = new PiMemoryPhase3Extension({ sessionId, workspaceRoot, systemPrompt: 'Five live drives', xtdbBaseUrl });
  await extAgain.load();
  evidence._extForScenario5 = true;
  globalThis.__extAgain = extAgain;
}

// Scenario 5: Failure/edge workflow + recovery
{
  const ext5 = globalThis.__extAgain;
  const scenario = { timeline: [], counts: [], ids: {}, invoked: {}, assessment: {}, failures: [] };
  const note = (event, details = {}) => scenario.timeline.push({ at: stamp(), event, ...details });

  scenario.counts.push(snapshot(ext5, 'start scenario5'));

  const badId = 'file:/nonexistent/path/ghost.txt';
  const f1 = ext5.deactivate('missing:id');
  const f2 = ext5.pin('missing:id');
  const f3 = ext5.unpin('missing:id');
  const f4 = ext5.activate(badId);
  scenario.invoked.deactivate = true;
  scenario.invoked.pin = true;
  scenario.invoked.unpin = true;
  scenario.invoked.activate = true;
  scenario.failures.push({ op: 'deactivate missing', ...f1 });
  scenario.failures.push({ op: 'pin missing', ...f2 });
  scenario.failures.push({ op: 'unpin missing', ...f3 });
  scenario.failures.push({ op: 'activate unread missing file id', ...f4 });
  note('captured invalid operation results');

  const okWrite = 'recover/ok.txt';
  await mkdir(resolve(workspaceRoot, 'recover'), { recursive: true });
  await ext5.wrappedWrite(okWrite, 'recovery path\n');
  const rr = await ext5.read(okWrite);
  const pinOk = ext5.pin(rr.id);
  const deactOk = ext5.deactivate(rr.id);
  const reactOk = ext5.activate(rr.id);
  const unpinOk = ext5.unpin(rr.id);
  note('recovery operations', { rr, pinOk, deactOk, reactOk, unpinOk });
  scenario.ids.recoveryId = rr.id;
  scenario.assessment.recoveryAllOk = [rr.ok, pinOk.ok, deactOk.ok, reactOk.ok, unpinOk.ok].every(Boolean);

  scenario.counts.push(snapshot(ext5, 'end scenario5'));
  await ext5.close();
  evidence.scenarios.scenario5 = scenario;
}

delete evidence._extForScenario5;
delete globalThis.__extAgain;

evidence.finishedAt = stamp();

await mkdir(resolve(process.cwd(), 'docs/rebuild'), { recursive: true });
const outPath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-five-live-drives-evidence.json');
await writeFile(outPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, outPath, sessionId, workspaceRoot }, null, 2));