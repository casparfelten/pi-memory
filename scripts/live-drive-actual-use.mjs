import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PiMemoryPhase3Extension } from '../dist/src/phase3-extension.js';
import { XtdbClient } from '../dist/src/xtdb-client.js';

const xtdbBaseUrl = process.env.XTDB_URL || 'http://172.17.0.1:3000';
const workspaceRoot = resolve(process.cwd(), 'tmp/live-drive-workspace');
const sessionId = `live-drive-${Date.now()}`;

const out = {
  startedAt: new Date().toISOString(),
  xtdbBaseUrl,
  workspaceRoot,
  sessionId,
  timeline: [],
  checks: {},
};

const stamp = () => new Date().toISOString();
const note = (event, details = {}) => out.timeline.push({ at: stamp(), event, ...details });

await mkdir(resolve(workspaceRoot, 'notes'), { recursive: true });

const ext1 = new PiMemoryPhase3Extension({
  sessionId,
  workspaceRoot,
  systemPrompt: 'Live-drive prompt',
  xtdbBaseUrl,
});

note('load:start');
await ext1.load();
note('load:done', { sessionObjectId: ext1.sessionObjectId });

const livePath = 'notes/live.txt';
const discoveredPath = 'notes/discovered.txt';
await writeFile(resolve(workspaceRoot, discoveredPath), 'discovered\n', 'utf8');

await ext1.wrappedWrite(livePath, 'line-0\n');
note('wrappedWrite', { path: livePath });

await appendFile(resolve(workspaceRoot, livePath), 'line-1-edited\n', 'utf8');
await ext1.wrappedEdit(livePath);
note('wrappedEdit', { path: livePath });

await ext1.wrappedLs(`${livePath}\n${discoveredPath}`);
await ext1.wrappedFind(`${livePath}\n${discoveredPath}`);
await ext1.wrappedGrep(`${livePath}:1:line-0`);
note('wrapped discovery', { methods: ['ls', 'find', 'grep'] });

const readResult = await ext1.read(livePath);
note('read', readResult);

const deactivateResult = ext1.deactivate(readResult.id);
const activateResult = ext1.activate(readResult.id);
note('activate/deactivate', { deactivateResult, activateResult });

const now = Date.now();
const messages = [
  { role: 'user', content: 'Please inspect files', timestamp: now },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running tool calls now.' },
      { type: 'tool-call', toolCallId: 'tc-live-1', toolName: 'bash', input: { command: 'grep -n line notes/live.txt' } },
    ],
    api: 'responses',
    provider: 'openai',
    model: 'gpt-5',
    timestamp: now + 1,
  },
  {
    role: 'toolResult',
    toolCallId: 'tc-live-1',
    toolName: 'bash',
    content: [{ type: 'text', text: '1:line-0\n2:line-1-edited' }],
    isError: false,
    timestamp: now + 2,
  },
];

const transformed = await ext1.transformContext(messages);
note('transformContext', { outputMessages: transformed.length, includesToolResultRef: transformed.some((m) => m.role === 'toolResult') });

await ext1.observeToolExecutionEnd('bash', 'cat notes/live.txt && ls notes/discovered.txt && grep line notes/live.txt');
note('observeToolExecutionEnd', { tool: 'bash' });

const longPath = 'notes/longrun.log';
await ext1.wrappedWrite(longPath, 'tick-0\n');
const longAbs = resolve(workspaceRoot, longPath);
const longId = `file:${longAbs}`;
note('longrun:start', { path: longPath, id: longId });

const xtdb = new XtdbClient(xtdbBaseUrl);
const longrunSamples = [];
for (let i = 1; i <= 16; i++) {
  await appendFile(longAbs, `tick-${i} @ ${new Date().toISOString()}\n`, 'utf8');
  if (i % 4 === 0) {
    await sleep(800);
    const hist = await xtdb.history(longId);
    longrunSamples.push({ i, at: stamp(), historyLength: hist.length });
    note('longrun:sample', { i, historyLength: hist.length });
  }
  await sleep(4000);
}

await sleep(1200);
const historyAfterRun = await xtdb.history(longId);
const currentLongEntity = await ext1.getXtEntity(longId);
note('longrun:done', { historyLength: historyAfterRun.length, charCount: currentLongEntity?.char_count ?? null });

const snapshotBeforeClose = ext1.getSnapshot();
out.checks.activeBeforeClose = [...snapshotBeforeClose.activeSet];
out.checks.metadataCountBeforeClose = snapshotBeforeClose.metadataPool.length;

await ext1.close();
note('close:first-extension');

await appendFile(longAbs, `tick-after-close @ ${new Date().toISOString()}\n`, 'utf8');
const sizeWhileDown = (await readFile(longAbs, 'utf8')).length;
note('mutate:while-down', { sizeWhileDown });

const ext2 = new PiMemoryPhase3Extension({
  sessionId,
  workspaceRoot,
  systemPrompt: 'Live-drive prompt',
  xtdbBaseUrl,
});
await ext2.load();
note('reload:done');

await sleep(1200);
const snapshotAfterReload = ext2.getSnapshot();
const reloadedEntity = await ext2.getXtEntity(longId);
const historyAfterReload = await xtdb.history(longId);

out.checks.activeAfterReload = [...snapshotAfterReload.activeSet];
out.checks.metadataCountAfterReload = snapshotAfterReload.metadataPool.length;
out.checks.longrunHistorySamples = longrunSamples;
out.checks.longrunHistoryAfterRun = historyAfterRun.length;
out.checks.longrunHistoryAfterReload = historyAfterReload.length;
out.checks.reloadedCharCount = reloadedEntity?.char_count ?? null;
out.checks.sessionEntity = await xtdb.get(ext2.sessionObjectId);
out.checks.longEntity = reloadedEntity;
out.checks.readId = readResult.id;
out.checks.transformPreview = transformed.slice(0, 6);

if (historyAfterReload.length > 0) {
  const firstTxTime = historyAfterReload[0]['xtdb.api/tx-time'];
  if (typeof firstTxTime === 'string') {
    out.checks.asOfFirstTx = await xtdb.getAsOf(longId, firstTxTime);
  }
}

await ext2.close();
out.finishedAt = stamp();

const evidencePath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-live-drive-evidence.json');
await mkdir(resolve(process.cwd(), 'docs/rebuild'), { recursive: true });
await writeFile(evidencePath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: true, evidencePath, sessionId, longId, historyAfterReload: historyAfterReload.length }, null, 2));
