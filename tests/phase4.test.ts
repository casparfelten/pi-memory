import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ContextManager } from '../src/context-manager.js';
import { ExtensionRuntimeState } from '../src/extension-logic.js';
import { FileWatcher } from '../src/file-watcher.js';
import { XtdbClient } from '../src/xtdb-client.js';
import type { Message } from '../src/message-types.js';

const XTDB_URL = 'http://127.0.0.1:3001';
let mock: ChildProcess;

beforeAll(async () => {
  mock = spawn('node', ['scripts/mock-xtdb-server.mjs'], {
    cwd: '/workspace/pi-memory',
    stdio: 'ignore',
    env: { ...process.env, XTDB_PORT: '3001' },
  });
  await sleep(250);
});

afterAll(() => {
  mock?.kill('SIGTERM');
});

describe('phase 4 - file watcher and session resume', () => {
  it('tracks indexed files and updates XTDB on change/delete without auto-activate', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const state = new ExtensionRuntimeState();
    state.xtdb = xtdb;
    state.contextManager = new ContextManager(xtdb, 'default-session');
    state.fileWatcher = new FileWatcher(xtdb);

    const dir = await mkdtemp(path.join(tmpdir(), 'p4-watch-'));
    const filePath = path.join(dir, 'watched.txt');
    await writeFile(filePath, 'one', 'utf8');

    await state.indexFileArtifacts({
      toolCallId: 'p4-tool-1',
      toolName: 'read',
      input: { path: filePath },
      content: [{ type: 'text', text: 'ignored' }],
      isError: false,
    }, filePath);

    expect(state.fileWatcher.getWatchedPaths()).toContain(filePath);
    expect(state.contextManager.getActivePool().isActive(`file:${filePath}`)).toBe(false);

    await writeFile(filePath, 'two-updated', 'utf8');
    await sleep(200);

    const historyAfterChange = await xtdb.history(`file:${filePath}`);
    expect(historyAfterChange.length).toBeGreaterThan(1);
    expect(historyAfterChange.at(-1)?.content).toBe('two-updated');

    await unlink(filePath);
    await sleep(200);

    const historyAfterDelete = await xtdb.history(`file:${filePath}`);
    const deleted = historyAfterDelete.at(-1);
    expect(deleted?.content).toBeNull();
    expect(deleted?.path).toBeNull();

    state.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads saved session state and restores pools while keeping cursor at end', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const sessionId = 'p4-resume';
    const cm1 = new ContextManager(xtdb, sessionId);
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: 'openai-responses', provider: 'openai', model: 'gpt-test', usage: {}, stopReason: 'stop', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'p4-tool-2', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
    ];

    await cm1.processEvents(messages);
    await cm1.activate('p4-tool-2');
    cm1.pin('p4-tool-2');
    await cm1.saveSessionState();

    const cm2 = new ContextManager(xtdb, sessionId);
    const loaded = await cm2.loadSessionState(sessionId);
    expect(loaded).toBe(true);
    expect(cm2.getActivePool().isActive('p4-tool-2')).toBe(true);

    const meta = cm2.getMetadataPool().renderAsText();
    expect(meta).toContain('toolcall/p4-tool-2');

    await cm2.processEvents(messages);
    const turns = cm2.getChatPool().getTurns();
    expect(turns.length).toBe(1);
  });

  it('resets cursor on message array replacement and continues processing', async () => {
    const cm = new ContextManager(new XtdbClient(XTDB_URL), 'p4-cursor');
    const first: Message[] = [
      { role: 'user', content: 'u1', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }], api: 'openai-responses', provider: 'openai', model: 'gpt-test', usage: {}, stopReason: 'stop', timestamp: 2 },
    ];

    await cm.processEvents(first);
    expect(cm.getChatPool().getTurns().length).toBe(1);

    const compacted: Message[] = [{ role: 'user', content: 'compacted', timestamp: 10 }];
    await cm.processEvents(compacted);
    expect(cm.getChatPool().getTurns().length).toBe(1);

    compacted.push({ role: 'assistant', content: [{ type: 'text', text: 'after' }], api: 'openai-responses', provider: 'openai', model: 'gpt-test', usage: {}, stopReason: 'stop', timestamp: 11 });
    await cm.processEvents(compacted);
    expect(cm.getChatPool().getTurns().length).toBe(1);
  });
});
