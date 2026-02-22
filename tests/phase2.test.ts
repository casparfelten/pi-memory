import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ContextManager } from '../src/context-manager.js';
import { XtdbClient } from '../src/xtdb-client.js';
import type { Message } from '../src/message-types.js';

let mock: ChildProcess;

async function startMock(): Promise<void> {
  try {
    await fetch('http://127.0.0.1:3000/_xtdb/status');
    return;
  } catch {
    mock = spawn('node', ['scripts/mock-xtdb-server.mjs'], { cwd: '/workspace/pi-memory', stdio: 'ignore' });
    await sleep(250);
  }
}

afterAll(() => {
  mock?.kill('SIGTERM');
});

beforeAll(async () => {
  await startMock();
});

function assistantWithToolCall(id: string, ts: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'bash', arguments: { cmd: 'ls -la' } }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-test',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: ts,
  };
}

describe('phase 2 - context manager', () => {
  it('processes sequence and assembles metadata -> chat -> active', async () => {
    const cm = new ContextManager(new XtdbClient('http://127.0.0.1:3000'), 's1');
    const messages: Message[] = [
      { role: 'user', content: 'read config.json', timestamp: 1 },
      assistantWithToolCall('tool-1', 2),
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', content: [{ type: 'text', text: 'SECRET_OUTPUT' }], isError: false, timestamp: 3 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-test',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 4,
      },
    ];

    await cm.processEvents(messages);

    const metadataText = cm.getMetadataPool().renderAsText();
    expect(metadataText).toContain('toolcall/tool-1');

    const turns = cm.getChatPool().getTurns();
    expect(turns.length).toBe(1);
    expect(turns[0].toolcall_ids).toEqual(['tool-1']);

    const active = cm.getActivePool().getAll();
    expect(active['tool-1']).toContain('SECRET_OUTPUT');

    const assembled = cm.assembleContext('sys');
    expect(assembled.messages[0].role).toBe('user');
    expect(String((assembled.messages[0] as Message).content)).toContain('metadata_pool');
    const last = assembled.messages[assembled.messages.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('active/tool-1');

    const toolResult = assembled.messages.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeTruthy();
    expect(JSON.stringify(toolResult)).not.toContain('SECRET_OUTPUT');
    expect(JSON.stringify(toolResult)).toContain('toolcall/tool-1');
  });

  it('auto-deactivates old toolcalls, pinning works, activate/deactivate works', async () => {
    const cm = new ContextManager(new XtdbClient('http://127.0.0.1:3000'), 's2');
    const msgs: Message[] = [];

    for (let i = 0; i < 6; i += 1) {
      msgs.push({ role: 'user', content: `u${i}`, timestamp: i * 10 + 1 });
      msgs.push(assistantWithToolCall(`tool-${i}`, i * 10 + 2));
      msgs.push({ role: 'toolResult', toolCallId: `tool-${i}`, toolName: 'bash', content: [{ type: 'text', text: `out-${i}` }], isError: false, timestamp: i * 10 + 3 });
    }

    await cm.processEvents(msgs);
    expect(cm.getActivePool().isActive('tool-0')).toBe(false);

    const pinMsg = cm.pin('tool-0');
    expect(pinMsg).toContain('Pinned');
    await cm.activate('tool-0');
    expect(cm.getActivePool().isActive('tool-0')).toBe(true);

    const more: Message[] = [
      ...msgs,
      { role: 'user', content: 'extra', timestamp: 100 },
      assistantWithToolCall('tool-extra', 101),
      { role: 'toolResult', toolCallId: 'tool-extra', toolName: 'bash', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: 102 },
    ];
    await cm.processEvents(more);
    expect(cm.getActivePool().isActive('tool-0')).toBe(true);

    const deactivated = cm.deactivate('tool-0');
    expect(deactivated).toContain('Deactivated');
    expect(cm.getActivePool().isActive('tool-0')).toBe(false);
    expect(cm.getMetadataPool().renderAsText()).toContain('toolcall/tool-0');

    const locked = cm.deactivate('chat-s2');
    expect(locked).toContain('Cannot deactivate locked object');
  });
});
