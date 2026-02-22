import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { XtdbClient } from '../src/xtdb-client.js';
import { contentHash, metadataViewHash, objectHash } from '../src/hashing.js';
import type { FileObject } from '../src/types.js';

const client = new XtdbClient('http://172.17.0.1:3000');

function makeFile(id: string, content: string): FileObject {
  const file: FileObject = {
    id,
    type: 'file',
    content,
    path: `/tmp/${id}.md`,
    file_type: 'markdown',
    char_count: content.length,
    nickname: id,
    locked: false,
    provenance: { origin: `/tmp/${id}.md`, generator: 'agent' },
    content_hash: '',
    metadata_view_hash: '',
    object_hash: '',
  };

  file.content_hash = contentHash(file.content);
  file.metadata_view_hash = metadataViewHash(file);
  file.object_hash = objectHash(file);
  return file;
}

describe('phase 1 - real XTDB + hashing', () => {
  it('put/get works against real XTDB', async () => {
    const id = `phase1-file-${Date.now()}-a`;
    const doc = makeFile(id, 'hello xtdb');

    await client.putAndWait(doc);

    const got = await client.get(id);
    expect(got?.['xt/id']).toBe(id);
    expect(got?.content).toBe('hello xtdb');
    expect(got?.content_hash).toBe(doc.content_hash);
  });

  it('version update changes hash and appears in history', async () => {
    const id = `phase1-file-${Date.now()}-b`;
    const v1 = makeFile(id, 'version one');

    await client.putAndWait(v1);
    await sleep(50);

    const v2 = makeFile(id, 'version two changed');
    await client.putAndWait(v2);

    expect(v1.content_hash).not.toBe(v2.content_hash);

    const history = await client.history(id);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('getAsOf returns the older version', async () => {
    const id = `phase1-file-${Date.now()}-c`;
    const v1 = makeFile(id, 'old state');

    await client.putAndWait(v1);
    const asOf = new Date().toISOString();
    await sleep(50);

    const v2 = makeFile(id, 'new state');
    await client.putAndWait(v2);

    const old = await client.getAsOf(id, asOf);
    expect(old?.content).toBe('old state');
  });

  it('EDN query finds file objects', async () => {
    const rows = await client.query('{:query {:find [e] :where [[e :xt/id] [e :type "file"]]}}');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('hashing is deterministic and detects changes', () => {
    const id = `phase1-file-static`;
    const a = makeFile(id, 'same content');
    const b = makeFile(id, 'same content');
    const c = makeFile(id, 'different content');

    expect(a.content_hash).toBe(b.content_hash);
    expect(a.metadata_view_hash).toBe(b.metadata_view_hash);
    expect(a.object_hash).toBe(b.object_hash);

    expect(a.content_hash).not.toBe(c.content_hash);
    expect(a.object_hash).not.toBe(c.object_hash);
  });
});
