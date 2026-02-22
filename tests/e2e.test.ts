import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ContextManager } from '../src/context-manager.js';
import { ExtensionRuntimeState } from '../src/extension-logic.js';
import { FileWatcher } from '../src/file-watcher.js';
import { computeMetadataViewHash, computeObjectHash } from '../src/hashing.js';
import type { Message } from '../src/message-types.js';
import type { FileObject } from '../src/types.js';
import { XtdbClient } from '../src/xtdb-client.js';

const XTDB_URL = 'http://127.0.0.1:3001';
let mock: ChildProcess;
let tempRoot = '';

function assistantWithToolCall(toolCallId: string, toolName: string, timestamp: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, toolName, input: {} }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-test',
    usage: {},
    stopReason: 'tool_call',
    timestamp,
  } as Message;
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number): Message {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  } as Message;
}

beforeAll(async () => {
  mock = spawn('node', ['scripts/mock-xtdb-server.mjs'], {
    cwd: '/workspace/pi-memory',
    stdio: 'ignore',
    env: { ...process.env, XTDB_PORT: '3001' },
  });
  await sleep(300);
  tempRoot = await mkdtemp(path.join(tmpdir(), `pi-memory-e2e-test-${Date.now()}-`));
});

afterAll(async () => {
  mock?.kill('SIGTERM');
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe('e2e integration', () => {
  it('full lifecycle simulation + activate/deactivate + pin behavior + context assembly ordering', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const sessionId = `e2e-life-${Date.now()}`;
    const cm = new ContextManager(xtdb, sessionId);

    const readId = `${sessionId}-read`;
    const editId = `${sessionId}-edit`;
    const lsId = `${sessionId}-ls`;
    const bashId = `${sessionId}-bash`;

    const readOutput = 'line1\nline2\nSECRET-READ-OUTPUT';
    const editOutput = 'applied patch\nSECRET-EDIT-OUTPUT';
    const lsOutput = 'src/a.ts\nsrc/b.ts\nREADME.md\nSECRET-LS-OUTPUT';
    const bashOutput = 'ok\nSECRET-BASH-OUTPUT';

    const messages: Message[] = [
      { role: 'user', content: 'please read file', timestamp: 1 } as Message,
      assistantWithToolCall(readId, 'read', 2),
      toolResult(readId, 'read', readOutput, 3),
    ];

    await cm.processEvents(messages);
    let meta = cm.getMetadataPool().renderAsText();
    expect(meta).toContain(`toolcall/${readId}`);
    expect(cm.getActivePool().isActive(readId)).toBe(true);

    cm.pin(readId);

    messages.push(
      { role: 'user', content: 'edit it', timestamp: 4 } as Message,
      assistantWithToolCall(editId, 'edit', 5),
      toolResult(editId, 'edit', editOutput, 6),
    );
    await cm.processEvents(messages);
    meta = cm.getMetadataPool().renderAsText();
    expect(meta).toContain(`toolcall/${editId}`);
    expect(cm.getActivePool().isActive(readId)).toBe(true);
    expect(cm.getActivePool().isActive(editId)).toBe(true);

    messages.push(
      { role: 'user', content: 'list files', timestamp: 7 } as Message,
      assistantWithToolCall(lsId, 'ls', 8),
      toolResult(lsId, 'ls', lsOutput, 9),
    );
    await cm.processEvents(messages);
    meta = cm.getMetadataPool().renderAsText();
    expect(meta).toContain(`toolcall/${lsId}`);

    messages.push(
      { role: 'user', content: 'run bash', timestamp: 10 } as Message,
      assistantWithToolCall(bashId, 'bash', 11),
      toolResult(bashId, 'bash', bashOutput, 12),
    );
    await cm.processEvents(messages);

    expect(cm.getActivePool().isActive(bashId)).toBe(true);
    expect(cm.getActivePool().isActive(lsId)).toBe(true);
    expect(cm.getActivePool().isActive(editId)).toBe(true);
    expect(cm.getActivePool().isActive(readId)).toBe(true); // pinned keeps it alive

    const moreIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `${sessionId}-extra-${i}`;
      moreIds.push(id);
      messages.push(
        { role: 'user', content: `extra ${i}`, timestamp: 13 + i * 3 } as Message,
        assistantWithToolCall(id, 'bash', 14 + i * 3),
        toolResult(id, 'bash', `extra-output-${i}`, 15 + i * 3),
      );
      await cm.processEvents(messages);
    }

    expect(cm.getActivePool().isActive(readId)).toBe(true); // pinned still active
    expect(cm.getActivePool().isActive(editId)).toBe(false); // older unpinned auto-deactivated

    // activate/deactivate workflow
    const activateResult = await cm.activate(editId);
    expect(activateResult).toContain(`Activated ${editId}`);
    expect(cm.getActivePool().isActive(editId)).toBe(true);

    const deactivateResult = cm.deactivate(editId);
    expect(deactivateResult).toBe(`Deactivated ${editId}`);
    expect(cm.getActivePool().isActive(editId)).toBe(false);
    expect(cm.getMetadataPool().renderAsText()).toContain(`toolcall/${editId}`);

    const denyChatDeactivate = cm.deactivate(`chat-${sessionId}`);
    expect(denyChatDeactivate).toContain('Cannot deactivate locked object');

    const missingActivate = await cm.activate(`${sessionId}-missing`);
    expect(missingActivate).toContain('Object not found');

    const assembled = cm.assembleContext('system prompt e2e');
    expect(assembled.systemPrompt).toBe('system prompt e2e');
    expect(assembled.messages[0]?.role).toBe('user');
    expect(String(assembled.messages[0]?.content)).toContain('metadata_pool');

    const chatMessageCount = cm.getChatPool().renderAsMessages().length;
    const activeIds = cm.getActivePool().getIds();
    const activeStart = 1 + chatMessageCount;
    expect(assembled.messages.length).toBe(activeStart + activeIds.length);

    for (let i = 0; i < chatMessageCount; i += 1) {
      expect(assembled.messages[1 + i]).toBeDefined();
    }
    for (let i = activeStart; i < assembled.messages.length; i += 1) {
      expect(assembled.messages[i]?.role).toBe('user');
      expect(String(assembled.messages[i]?.content)).toContain('active/');
    }

    const renderedChat = cm.getChatPool().renderAsMessages();
    for (const m of renderedChat) {
      if (m.role !== 'toolResult') continue;
      const text = (m.content?.[0] as { text?: string })?.text ?? '';
      expect(text).toContain('toolcall/');
      expect(text).not.toContain('SECRET-READ-OUTPUT');
      expect(text).not.toContain('SECRET-EDIT-OUTPUT');
      expect(text).not.toContain('SECRET-LS-OUTPUT');
      expect(text).not.toContain('SECRET-BASH-OUTPUT');
    }
  });

  it('file watcher integration via extension logic indexes and tracks file updates/deletes', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const state = new ExtensionRuntimeState();
    state.xtdb = xtdb;
    state.contextManager = new ContextManager(xtdb, `e2e-watch-${Date.now()}`);
    state.fileWatcher = new FileWatcher(xtdb);

    const filePath = path.join(tempRoot, 'watched-e2e.txt');
    await writeFile(filePath, 'initial-content', 'utf8');

    await state.onToolResult({
      toolCallId: `watch-read-${Date.now()}`,
      toolName: 'read',
      input: { path: filePath },
      content: [{ type: 'text', text: 'initial-content' }],
      isError: false,
    });

    expect(state.fileWatcher.getWatchedPaths()).toContain(filePath);

    const before = await xtdb.get(`file:${filePath}`) as FileObject;
    await writeFile(filePath, 'changed-content', 'utf8');
    await sleep(500);

    const afterChange = await xtdb.get(`file:${filePath}`) as FileObject;
    expect(afterChange.content_hash).not.toBe(before.content_hash);

    await unlink(filePath);
    await sleep(500);

    const afterDelete = await xtdb.get(`file:${filePath}`) as FileObject;
    expect(afterDelete.content).toBeNull();
    expect(afterDelete.path).toBeNull();

    state.shutdown();
  });

  it('session save/restore reconstructs pools and continues from end without reprocessing', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const sessionId = `e2e-resume-${Date.now()}`;
    const cm1 = new ContextManager(xtdb, sessionId);
    const t1 = `${sessionId}-t1`;
    const t2 = `${sessionId}-t2`;

    const messages: Message[] = [
      { role: 'user', content: 'one', timestamp: 1 } as Message,
      assistantWithToolCall(t1, 'bash', 2),
      toolResult(t1, 'bash', 'out1', 3),
      { role: 'user', content: 'two', timestamp: 4 } as Message,
      assistantWithToolCall(t2, 'ls', 5),
      toolResult(t2, 'ls', 'out2', 6),
    ];

    await cm1.processEvents(messages);
    cm1.pin(t1);
    await cm1.activate(t1);
    await cm1.saveSessionState();

    const beforeActive = new Set(cm1.getActivePool().getIds());
    const sessionDoc = await xtdb.get(`session-${sessionId}`) as Record<string, unknown>;

    const cm2 = new ContextManager(xtdb, sessionId);
    const loaded = await cm2.loadSessionState(sessionId);
    expect(loaded).toBe(true);

    const afterActive = new Set(cm2.getActivePool().getIds());
    expect(afterActive).toEqual(beforeActive);
    expect((sessionDoc.pinned_set as string[])).toContain(t1);
    expect(cm2.getMetadataPool().renderAsText()).toContain(`toolcall/${t1}`);
    expect(cm2.getMetadataPool().renderAsText()).toContain(`toolcall/${t2}`);

    await cm2.processEvents(messages);
    const turnsAfterReplayAttempt = cm2.getChatPool().getTurns().length;
    expect(turnsAfterReplayAttempt).toBe(2);

    messages.push(
      { role: 'user', content: 'three', timestamp: 7 } as Message,
      assistantWithToolCall(`${sessionId}-t3`, 'bash', 8),
      toolResult(`${sessionId}-t3`, 'bash', 'out3', 9),
    );
    await cm2.processEvents(messages);
    expect(cm2.getChatPool().getTurns().length).toBe(3);
  });

  it('cursor invalidation handles compacted shorter message array safely', async () => {
    const cm = new ContextManager(new XtdbClient(XTDB_URL), `e2e-cursor-${Date.now()}`);
    const original: Message[] = [
      { role: 'user', content: 'u1', timestamp: 1 } as Message,
      assistantWithToolCall('cursor-t1', 'bash', 2),
      toolResult('cursor-t1', 'bash', 'o1', 3),
      { role: 'user', content: 'u2', timestamp: 4 } as Message,
      assistantWithToolCall('cursor-t2', 'bash', 5),
      toolResult('cursor-t2', 'bash', 'o2', 6),
    ];

    await cm.processEvents(original);
    const activeBefore = new Set(cm.getActivePool().getIds());

    const compacted: Message[] = [{ role: 'user', content: 'compacted only', timestamp: 10 } as Message];
    await cm.processEvents(compacted);
    expect(new Set(cm.getActivePool().getIds())).toEqual(activeBefore);
    expect(cm.getChatPool().getTurns().length).toBe(2);

    compacted.push(
      assistantWithToolCall('cursor-t3', 'bash', 11),
      toolResult('cursor-t3', 'bash', 'o3', 12),
    );
    await cm.processEvents(compacted);
    expect(cm.getChatPool().getTurns().length).toBe(2);
  });

  it('hash integrity: content/object hashes change on content update, metadata hash changes only on metadata update', async () => {
    const xtdb = new XtdbClient(XTDB_URL);
    const id = `file:/tmp/hash-e2e-${Date.now()}.txt`;

    const v1: FileObject = {
      id,
      type: 'file',
      content: 'alpha',
      locked: false,
      provenance: { origin: 'test', generator: 'system' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
      path: '/tmp/hash-e2e.txt',
      file_type: 'txt',
      char_count: 5,
    };
    v1.content_hash = createHash('sha256').update(v1.content ?? '').digest('hex');
    v1.metadata_view_hash = computeMetadataViewHash(v1);
    v1.object_hash = computeObjectHash(v1);
    await xtdb.put(v1);

    const stored1 = await xtdb.get(id) as FileObject;
    expect(stored1.content_hash).toBe(createHash('sha256').update('alpha').digest('hex'));

    const v2: FileObject = {
      ...v1,
      content: 'alpha-beta',
      char_count: 10,
    };
    v2.content_hash = createHash('sha256').update(v2.content ?? '').digest('hex');
    v2.metadata_view_hash = computeMetadataViewHash(v2);
    v2.object_hash = computeObjectHash(v2);
    await xtdb.put(v2);

    const stored2 = await xtdb.get(id) as FileObject;
    expect(stored2.content_hash).not.toBe(stored1.content_hash);
    expect(stored2.object_hash).not.toBe(stored1.object_hash);
    expect(stored2.metadata_view_hash).not.toBe(stored1.metadata_view_hash); // char_count is metadata

    const v3: FileObject = {
      ...v2,
      content: 'alpha-gamma',
      char_count: 10,
    };
    v3.content_hash = createHash('sha256').update(v3.content ?? '').digest('hex');
    v3.metadata_view_hash = computeMetadataViewHash(v3);
    v3.object_hash = computeObjectHash(v3);
    await xtdb.put(v3);

    const stored3 = await xtdb.get(id) as FileObject;
    expect(stored3.content_hash).not.toBe(stored2.content_hash);
    expect(stored3.object_hash).not.toBe(stored2.object_hash);
    expect(stored3.metadata_view_hash).toBe(stored2.metadata_view_hash);
  });
});
