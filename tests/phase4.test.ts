import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { PiMemoryPhase3Extension, XtdbClient, type HarnessMessage } from '../src/index.js';

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

describe('phase 4 - watcher, resume, cursor robustness', () => {
  it('indexed file change triggers a new XTDB version via watcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase4-'));
    const filePath = join(root, 'tracked.txt');
    await writeFile(filePath, 'v1', 'utf8');

    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-watch-change`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();
    const read = await ext.read('tracked.txt');

    await writeFile(filePath, 'v2-updated', 'utf8');
    await sleep(900);

    const xtdb = new XtdbClient('http://172.17.0.1:3000');
    const history = await xtdb.history(read.id!);
    expect(history.length).toBeGreaterThanOrEqual(2);

    const latest = await ext.getXtEntity(read.id!);
    expect(latest?.content).toBe('v2-updated');
    await ext.close();
    await rm(root, { recursive: true, force: true });
  });

  it('delete triggers tombstone version with null content and null path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase4-'));
    const filePath = join(root, 'tracked-delete.txt');
    await writeFile(filePath, 'to be deleted', 'utf8');

    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-watch-delete`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();
    const read = await ext.read('tracked-delete.txt');

    await rm(filePath, { force: true });
    await sleep(900);

    const latest = await ext.getXtEntity(read.id!);
    expect(latest?.content).toBeNull();
    expect(latest?.path).toBeNull();
    await ext.close();
    await rm(root, { recursive: true, force: true });
  });

  it('watcher updates index but does not auto-activate metadata-only discovered files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase4-'));
    const filePath = join(root, 'discovered.ts');
    await writeFile(filePath, 'const a = 1;', 'utf8');

    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-watch-no-activate`, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext.load();
    await ext.wrappedLs('./discovered.ts');

    await writeFile(filePath, 'const a = 2;', 'utf8');
    await sleep(900);

    const id = `file:${filePath}`;
    const snap = ext.getSnapshot();
    expect(snap.activeSet.has(id)).toBe(false);

    const context = await ext.transformContext([]);
    expect(context.some((m) => m.role === 'user' && (m as { content: string }).content.includes(`ACTIVE_CONTENT id=${id}`))).toBe(false);
    await ext.close();
    await rm(root, { recursive: true, force: true });
  });

  it('session save/load reconstructs pool state and catches while-down file change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-memory-phase4-'));
    const filePath = join(root, 'resume.md');
    await writeFile(filePath, 'before-resume', 'utf8');

    const sessionId = `s-${Date.now()}-resume`;
    const ext1 = new PiMemoryPhase3Extension({ sessionId, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext1.load();
    const read = await ext1.read('resume.md');
    ext1.deactivate(read.id!);
    await ext1.close();

    await writeFile(filePath, 'changed-while-down', 'utf8');

    const ext2 = new PiMemoryPhase3Extension({ sessionId, workspaceRoot: root, systemPrompt: 'SYS' });
    await ext2.load();

    const snap = ext2.getSnapshot();
    expect(snap.metadataPool.map((m) => m.id)).toContain(read.id!);
    expect(snap.activeSet.has(read.id!)).toBe(false);

    const latest = await ext2.getXtEntity(read.id!);
    expect(latest?.content).toBe('changed-while-down');

    await ext2.close();
    await rm(root, { recursive: true, force: true });
  });

  it('cursor invalidation handles array replacement with preserved prefix safely', async () => {
    const ext = new PiMemoryPhase3Extension({ sessionId: `s-${Date.now()}-cursor`, systemPrompt: 'SYS' });
    await ext.load();

    const first: HarnessMessage[] = [
      { role: 'user', content: 'u1', timestamp: 1 },
      { role: 'assistant', content: text('a1'), timestamp: 2 },
    ];
    await ext.transformContext(first);

    const replacedSamePrefix: HarnessMessage[] = [...first, { role: 'toolResult', toolCallId: 'tc-safe', toolName: 'bash', content: text('out'), isError: false, timestamp: 3 }];
    const out = await ext.transformContext(replacedSamePrefix);

    const toolResults = out.filter((m) => m.role === 'toolResult');
    expect(toolResults).toHaveLength(1);
    await ext.close();
  });
});
