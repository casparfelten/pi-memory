import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { PiMemoryPhase3Extension, type HarnessMessage } from '../src/index.js';

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

describe('e2e final - realistic lifecycle and continuity', () => {
  it('covers extension load, wrapped discovery/write/edit, activation flow, metadata refs, and cursor replacement ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-e2e-final-'));
    await writeFile(join(root, 'alpha.md'), 'alpha-v1', 'utf8');

    const ext = new PiMemoryPhase3Extension({
      sessionId: `s-${Date.now()}-e2e-lifecycle`,
      workspaceRoot: root,
      systemPrompt: 'SYS-E2E',
    });
    await ext.load();

    // wrapped discovery path: metadata only + inactive
    await ext.wrappedLs('./discovered.ts');
    const discoveredId = `file:${join(root, 'discovered.ts')}`;
    let snap = ext.getSnapshot();
    expect(snap.metadataPool.some((m) => m.id === discoveredId)).toBe(true);
    expect(snap.activeSet.has(discoveredId)).toBe(false);

    // write/edit/read path with object-state transitions
    await ext.wrappedWrite('beta.txt', 'beta-v1');
    await writeFile(join(root, 'beta.txt'), 'beta-v2-edit', 'utf8');
    await ext.wrappedEdit('beta.txt');

    const alphaRead = await ext.read('alpha.md');
    const betaRead = await ext.read('beta.txt');
    expect(alphaRead.ok).toBe(true);
    expect(betaRead.ok).toBe(true);

    const betaEntity = await ext.getXtEntity(betaRead.id!);
    expect(betaEntity?.content).toBe('beta-v2-edit');

    expect(ext.deactivate(betaRead.id!).ok).toBe(true);
    snap = ext.getSnapshot();
    expect(snap.activeSet.has(betaRead.id!)).toBe(false);
    expect(ext.activate(betaRead.id!).ok).toBe(true);
    snap = ext.getSnapshot();
    expect(snap.activeSet.has(betaRead.id!)).toBe(true);

    const firstMessages: HarnessMessage[] = [
      { role: 'user', content: 'scan workspace', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-e2e-1', toolName: 'ls', input: { path: '.' } }],
        api: 'x',
        provider: 'p',
        model: 'm',
        timestamp: 2,
      },
      { role: 'toolResult', toolCallId: 'tc-e2e-1', toolName: 'ls', content: text('RAW-LS-SHOULD-NOT-BE-INLINED'), isError: false, timestamp: 3 },
      { role: 'assistant', content: text('done scanning'), api: 'x', provider: 'p', model: 'm', timestamp: 4 },
    ];

    const out1 = await ext.transformContext(firstMessages);
    expect(out1[0]).toEqual({ role: 'system', content: 'SYS-E2E' });
    expect(out1[1]).toMatchObject({ role: 'user' });
    expect((out1[1] as { content: string }).content.startsWith('METADATA_POOL')).toBe(true);

    const toolRef = out1.find((m) => m.role === 'toolResult' && (m as { toolCallId?: string }).toolCallId === 'tc-e2e-1') as {
      content: Array<{ text?: string }>;
    };
    const toolRefText = toolRef.content.map((p) => p.text ?? '').join('\n');
    expect(toolRefText).toContain('toolcall_ref id=tc-e2e-1 tool=ls status=ok');
    expect(toolRefText).not.toContain('RAW-LS-SHOULD-NOT-BE-INLINED');

    const lastChatIdx = out1.reduce((acc, msg, i) => (msg.role === 'assistant' || msg.role === 'toolResult' ? i : acc), -1);
    const firstActiveIdx = out1.findIndex((m) => m.role === 'user' && (m as { content: string }).content.startsWith('ACTIVE_CONTENT id='));
    expect(firstActiveIdx).toBeGreaterThan(lastChatIdx);

    // cursor replacement robustness: preserve prefix, append one result, no duplicate refs
    const replacedWithSamePrefix: HarnessMessage[] = [
      ...firstMessages,
      { role: 'toolResult', toolCallId: 'tc-e2e-2', toolName: 'bash', content: text('bash output'), isError: false, timestamp: 5 },
    ];
    const out2 = await ext.transformContext(replacedWithSamePrefix);
    const toolResults = out2.filter((m) => m.role === 'toolResult');
    expect(toolResults.filter((m) => (m as { toolCallId: string }).toolCallId === 'tc-e2e-1')).toHaveLength(1);
    expect(toolResults.some((m) => (m as { toolCallId: string }).toolCallId === 'tc-e2e-2')).toBe(true);

    await ext.close();
    await rm(root, { recursive: true, force: true });
  });

  it('covers watcher update + tombstone delete + session save/reload continuity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-e2e-final-'));
    const trackedPath = join(root, 'tracked.md');
    const resumePath = join(root, 'resume.md');
    await writeFile(trackedPath, 'tracked-v1', 'utf8');
    await writeFile(resumePath, 'resume-v1', 'utf8');

    const sessionId = `s-${Date.now()}-e2e-resume`;
    const ext1 = new PiMemoryPhase3Extension({ sessionId, workspaceRoot: root, systemPrompt: 'SYS-E2E' });
    await ext1.load();

    const tracked = await ext1.read('tracked.md');
    const resume = await ext1.read('resume.md');
    expect(ext1.deactivate(resume.id!).ok).toBe(true);

    await writeFile(trackedPath, 'tracked-v2', 'utf8');
    await sleep(950);
    let trackedEntity = await ext1.getXtEntity(tracked.id!);
    expect(trackedEntity?.content).toBe('tracked-v2');

    await rm(trackedPath, { force: true });
    await sleep(950);
    trackedEntity = await ext1.getXtEntity(tracked.id!);
    expect(trackedEntity?.content).toBeNull();
    expect(trackedEntity?.path).toBeNull();

    await ext1.close();

    await writeFile(resumePath, 'resume-v2-while-down', 'utf8');

    const ext2 = new PiMemoryPhase3Extension({ sessionId, workspaceRoot: root, systemPrompt: 'SYS-E2E' });
    await ext2.load();

    const snap = ext2.getSnapshot();
    expect(snap.metadataPool.map((m) => m.id)).toContain(resume.id!);
    expect(snap.activeSet.has(resume.id!)).toBe(false);

    const resumedEntity = await ext2.getXtEntity(resume.id!);
    expect(resumedEntity?.content).toBe('resume-v2-while-down');

    await ext2.close();
    await rm(root, { recursive: true, force: true });
  });
});
