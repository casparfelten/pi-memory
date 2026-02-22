import { describe, expect, it } from 'vitest';
import { ContextManager, type HarnessMessage } from '../src/context-manager.js';

function text(text: string) {
  return [{ type: 'text' as const, text }];
}

describe('phase 2 - context manager', () => {
  it('processes realistic event sequence and assembles ordered context', () => {
    const manager = new ContextManager({ recentToolcallsPerTurn: 2, recentTurnsWindow: 3, chatObjectId: 'chat-locked' });

    const messages: HarnessMessage[] = [
      { role: 'user', content: 'Find files', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'ls', input: { path: '.' } }],
        api: 'x',
        provider: 'p',
        model: 'm',
        timestamp: 2,
      },
      { role: 'toolResult', toolCallId: 'tc-1', toolName: 'ls', content: text('very long ls output'), isError: false, timestamp: 3 },
      {
        role: 'assistant',
        content: text('Found files. Next step.'),
        api: 'x',
        provider: 'p',
        model: 'm',
        timestamp: 4,
      },
    ];

    manager.processMessages(messages);
    const state = manager.getState();

    expect(state.metadataPool).toHaveLength(1);
    expect(state.metadataPool[0]).toMatchObject({ id: 'tc-1', tool: 'ls', status: 'ok' });
    expect(state.chatTurns).toHaveLength(1);
    expect(state.chatTurns[0].toolcall_ids).toEqual(['tc-1']);
    expect(state.activeContent.get('tc-1')).toBe('very long ls output');

    const assembled = manager.assembleContext('SYSTEM PROMPT');
    expect(assembled[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    expect(assembled[1]).toMatchObject({ role: 'user' });
    expect((assembled[1] as { content: string }).content).toContain('METADATA_POOL');

    const toolResult = assembled.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeTruthy();
    const renderedToolResult = toolResult as { content: Array<{ type: string; text?: string }> };
    const joined = renderedToolResult.content.map((x) => x.text ?? '').join('\n');
    expect(joined).toContain('toolcall_ref id=tc-1 tool=ls status=ok');
    expect(joined).not.toContain('very long ls output');

    const activeBlock = assembled.find((m) => m.role === 'user' && (m as { content: string }).content.includes('ACTIVE_CONTENT id=tc-1')) as { content: string };
    expect(activeBlock.content).toContain('very long ls output');
  });

  it('auto activate/deactivate keeps recent and drops old unless pinned', () => {
    const manager = new ContextManager({ recentToolcallsPerTurn: 1, recentTurnsWindow: 1 });
    const messages: HarnessMessage[] = [];

    messages.push({ role: 'user', content: 'u1', timestamp: 1 });
    messages.push({ role: 'assistant', content: text('a1'), timestamp: 2 });
    messages.push({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: text('out1'), isError: false, timestamp: 3 });

    messages.push({ role: 'user', content: 'u2', timestamp: 4 });
    messages.push({ role: 'assistant', content: text('a2'), timestamp: 5 });
    messages.push({ role: 'toolResult', toolCallId: 't2', toolName: 'bash', content: text('out2'), isError: false, timestamp: 6 });

    manager.processMessages(messages);
    let state = manager.getState();
    expect(state.activeContent.has('t1')).toBe(false);
    expect(state.activeContent.has('t2')).toBe(true);

    expect(manager.pin('t2').ok).toBe(true);

    messages.push({ role: 'user', content: 'u3', timestamp: 7 });
    messages.push({ role: 'assistant', content: text('a3'), timestamp: 8 });
    messages.push({ role: 'toolResult', toolCallId: 't3', toolName: 'bash', content: text('out3'), isError: false, timestamp: 9 });

    manager.processMessages(messages);
    state = manager.getState();
    expect(state.activeContent.has('t3')).toBe(true);
    expect(state.activeContent.has('t2')).toBe(true);
    expect(state.activeContent.has('t1')).toBe(false);
  });

  it('supports explicit activate/deactivate and denies locked object deactivation', () => {
    const manager = new ContextManager({ chatObjectId: 'chat-locked' });
    const messages: HarnessMessage[] = [
      { role: 'user', content: 'u', timestamp: 1 },
      { role: 'assistant', content: text('a'), timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tool-x', toolName: 'grep', content: text('x'), isError: false, timestamp: 3 },
    ];
    manager.processMessages(messages);

    expect(manager.deactivate('tool-x').ok).toBe(true);
    expect(manager.getState().activeContent.has('tool-x')).toBe(false);

    expect(manager.activate('tool-x').ok).toBe(true);
    expect(manager.getState().activeContent.has('tool-x')).toBe(true);

    const deny = manager.deactivate('chat-locked');
    expect(deny.ok).toBe(false);
    expect(deny.message).toContain('locked');
  });

  it('resets cursor on array replacement and does not reprocess old events', () => {
    const manager = new ContextManager();
    const original: HarnessMessage[] = [
      { role: 'user', content: 'u', timestamp: 1 },
      { role: 'assistant', content: text('a'), timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tc-a', toolName: 'bash', content: text('out-a'), isError: false, timestamp: 3 },
    ];

    manager.processMessages(original);
    expect(manager.getState().metadataPool).toHaveLength(1);

    const replaced: HarnessMessage[] = [{ role: 'user', content: 'after replace', timestamp: 4 }];
    manager.processMessages(replaced);

    const state = manager.getState();
    expect(state.cursor).toBe(1);
    expect(state.metadataPool).toHaveLength(1);
  });
});
