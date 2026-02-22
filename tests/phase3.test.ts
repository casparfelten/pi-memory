import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiMemoryPhase3Extension, type HarnessMessage } from '../src/index.js';

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

describe('phase 3 - pi extension + tools', () => {
  it('loads extension and writes session/chat/system objects to XTDB', async () => {
    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}`, systemPrompt: 'SYS' });
    await ext.load();

    const session = await ext.getXtEntity(ext.sessionObjectId);
    const chat = await ext.getXtEntity(ext.chatObjectId);
    const sys = await ext.getXtEntity(ext.systemPromptObjectId);

    expect(session?.['xt/id']).toBe(ext.sessionObjectId);
    expect(chat?.['xt/id']).toBe(ext.chatObjectId);
    expect(sys?.['xt/id']).toBe(ext.systemPromptObjectId);
  });

  it('read() indexes file, adds metadata, and appears in active context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase3-'));
    const filePath = join(root, 'note.md');
    await writeFile(filePath, 'hello from phase3', 'utf8');

    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-read`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();
    const readResult = await ext.read('note.md');

    expect(readResult.ok).toBe(true);
    const entity = await ext.getXtEntity(readResult.id!);
    expect(entity?.content).toBe('hello from phase3');

    const context = await ext.transformContext([]);
    const metadata = context.find((m) => m.role === 'user' && (m as { content: string }).content.startsWith('METADATA_POOL')) as { content: string };
    expect(metadata.content).toContain(readResult.id!);

    const active = context.find((m) => m.role === 'user' && (m as { content: string }).content.includes(`ACTIVE_CONTENT id=${readResult.id}`)) as { content: string };
    expect(active.content).toContain('hello from phase3');
  });

  it('wrapped write/edit update XTDB file object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase3-'));
    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-write`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();

    await ext.wrappedWrite('doc.txt', 'v1');
    const id = `file:${join(root, 'doc.txt')}`;
    let entity = await ext.getXtEntity(id);
    expect(entity?.content).toBe('v1');

    await writeFile(join(root, 'doc.txt'), 'v2-edit', 'utf8');
    await ext.wrappedEdit('doc.txt');
    entity = await ext.getXtEntity(id);
    expect(entity?.content).toBe('v2-edit');
  });

  it('activate/deactivate behavior with lock denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase3-'));
    await writeFile(join(root, 'a.md'), 'A', 'utf8');

    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-activate`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();
    const r = await ext.read('a.md');

    expect(ext.deactivate(r.id!).ok).toBe(true);
    expect(ext.activate(r.id!).ok).toBe(true);

    const locked = ext.deactivate(ext.chatObjectId);
    expect(locked.ok).toBe(false);
  });

  it('ls discovery indexes metadata-only files and toolResult is metadata ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase3-'));
    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-ls`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();

    await ext.wrappedLs('./x.ts\n./y.md');
    const snapshot = ext.getSnapshot();
    const ids = snapshot.metadataPool.filter((m) => m.type === 'file').map((m) => m.id).join('\n');
    expect(ids).toContain('x.ts');
    expect(ids).toContain('y.md');

    const messages: HarnessMessage[] = [
      { role: 'user', content: 'run ls', timestamp: 1 },
      { role: 'assistant', content: text('calling ls'), timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tc-ls', toolName: 'ls', content: text('raw ls output should not appear inline'), isError: false, timestamp: 3 },
    ];
    const assembled = await ext.transformContext(messages);
    const toolResult = assembled.find((m) => m.role === 'toolResult') as { content: Array<{ text?: string }> };
    const combined = toolResult.content.map((c) => c.text ?? '').join('\n');
    expect(combined).toContain('toolcall_ref id=tc-ls tool=ls status=ok');
    expect(combined).not.toContain('raw ls output should not appear inline');
  });

  it('assembled Message[] structure sanity', async () => {
    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-ctx`, systemPrompt: 'SYS' });
    await ext.load();

    const msgs: HarnessMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: text('hi'), timestamp: 2 },
    ];

    const out = await ext.transformContext(msgs);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect((out[1] as { role: string }).role).toBe('user');
    expect(out.some((m) => m.role === 'assistant')).toBe(true);
  });
});
