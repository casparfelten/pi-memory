import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { XtdbClient } from '../src/xtdb-client.js';
import { computeContentHash, computeMetadataViewHash, computeObjectHash } from '../src/hashing.js';
import type { FileObject } from '../src/types.js';

const client = new XtdbClient('http://127.0.0.1:3000');
const root = new URL('..', import.meta.url).pathname;

function buildFile(content: string): FileObject {
  const base: FileObject = {
    id: 'file-1',
    type: 'file',
    content,
    path: '/tmp/demo.md',
    file_type: 'markdown',
    char_count: content.length,
    nickname: 'demo',
    locked: false,
    provenance: { origin: '/tmp/demo.md', generator: 'agent' },
    content_hash: '',
    metadata_view_hash: '',
    object_hash: '',
  };
  base.content_hash = computeContentHash(base.content);
  base.metadata_view_hash = computeMetadataViewHash(base);
  base.object_hash = computeObjectHash(base);
  return base;
}

describe('phase 1 - xtdb + hashing', () => {
  beforeAll(() => {
    execFileSync(`${root}scripts/xtdb-start.sh`, { stdio: 'inherit' });
  });

  afterAll(() => {
    execFileSync(`${root}scripts/xtdb-stop.sh`, { stdio: 'inherit' });
  });

  it('puts and gets a file object', async () => {
    const v1 = buildFile('hello');
    await client.put(v1);
    const got = await client.get(v1.id);
    expect(got).toMatchObject({ ...v1, 'xt/id': v1.id });
  });

  it('writes a new version and checks history + hash changes', async () => {
    const v1 = buildFile('hello');
    const asOf = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const v2 = buildFile('hello world');
    await client.put(v2);

    expect(v2.content_hash).not.toEqual(v1.content_hash);

    const history = await client.history(v1.id);
    expect(history.length).toBeGreaterThanOrEqual(2);

    const old = await client.getAsOf(v1.id, asOf);
    expect(old?.content).toEqual('hello');
  });

  it('runs a datalog query for all file objects', async () => {
    const rows = await client.query({
      find: ['e'],
      where: [['e', 'type', 'file']],
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('hashing is deterministic and detects changes', () => {
    const a = buildFile('same');
    const b = buildFile('same');
    expect(a.content_hash).toEqual(b.content_hash);
    expect(a.metadata_view_hash).toEqual(b.metadata_view_hash);
    expect(a.object_hash).toEqual(b.object_hash);

    const c = buildFile('different');
    expect(a.content_hash).not.toEqual(c.content_hash);
    expect(a.object_hash).not.toEqual(c.object_hash);
  });
});
