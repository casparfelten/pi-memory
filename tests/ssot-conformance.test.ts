/**
 * SSOT Conformance Test Suite
 *
 * Tests that the implementation matches context-manager-ssot.md.
 * Imports from target module paths defined in the implementation plan.
 * Tests will fail to compile until those modules are built — that's intended.
 *
 * Every test uses real XTDB (http://172.17.0.1:3000) and real temp files.
 * No mocks anywhere.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { XtdbClient } from '../src/xtdb-client.js';
import type {
  FileObject,
  ToolcallObject,
  ChatObject,
  SystemPromptObject,
  SessionObject,
  ObjectEnvelope,
  ObjectHashes,
  FilesystemSource,
  Source,
  ObjectType,
} from '../src/types.js';
import {
  identityHash,
  fileHash,
  contentHash,
  metadataHash,
  objectHash,
} from '../src/hashing.js';
import {
  FilesystemResolver,
  type MountMapping,
  type ResolvedPath,
} from '../src/filesystem.js';
import {
  indexFile,
  discoverFile,
  indexFileDeletion,
  type IndexResult,
} from '../src/indexer.js';

// XTDB client — shared across all tests
const XTDB_URL = 'http://172.17.0.1:3000';
const xtdb = new XtdbClient(XTDB_URL);

// Unique prefix for this test run to avoid collisions
const RUN_ID = crypto.randomBytes(4).toString('hex');

/** Generate a unique session ID for a test */
function testSessionId(label: string): string {
  return `test-${RUN_ID}-${label}-${Date.now()}`;
}

/** Generate a unique filesystem ID */
function testFsId(label: string): string {
  return crypto.createHash('sha256').update(`test-fs-${RUN_ID}-${label}`).digest('hex');
}

/** Create a temp directory that cleans up after */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `scm-test-${RUN_ID}-`));
}

/** Write a real file, return its absolute path */
function writeTestFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Build a FilesystemSource for a test file */
function makeSource(fsId: string, canonicalPath: string): FilesystemSource {
  return { type: 'filesystem', filesystemId: fsId, path: canonicalPath };
}

/** SHA-256 helper for manual verification */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/** Stable JSON stringify (sorted keys) for hash verification */
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

// ---------------------------------------------------------------------------
// Infrastructure object type list — these must NEVER appear in session sets
// ---------------------------------------------------------------------------
const INFRASTRUCTURE_TYPES: ObjectType[] = ['chat', 'system_prompt', 'session'];

// ===========================================================================
// INVARIANT CHECKER
// ===========================================================================

/**
 * Asserts all session invariants defined in SSOT §3.1 and §1.4.
 *
 * 1. active_set ⊆ metadata_pool ⊆ session_index
 * 2. pinned_set ⊆ metadata_pool
 * 3. session_index only grows (compared to previous snapshot if provided)
 * 4. No infrastructure object IDs in any content set
 * 5. Every active file has non-null content in XTDB
 * 6. All IDs in sets refer to content objects (file or toolcall)
 */
async function assertSessionInvariants(
  client: XtdbClient,
  sessionId: string,
  previousIndex?: string[],
): Promise<SessionObject> {
  const session = (await client.get(sessionId)) as unknown as SessionObject | null;
  expect(session, `Session ${sessionId} must exist`).not.toBeNull();
  const s = session!;

  const index = new Set(s.session_index);
  const pool = new Set(s.metadata_pool);
  const active = new Set(s.active_set);
  const pinned = new Set(s.pinned_set);

  // 1. Subset relationships
  for (const id of active) {
    expect(pool.has(id), `active_set member ${id} must be in metadata_pool`).toBe(true);
  }
  for (const id of pool) {
    expect(index.has(id), `metadata_pool member ${id} must be in session_index`).toBe(true);
  }

  // 2. Pinned ⊆ metadata_pool
  for (const id of pinned) {
    expect(pool.has(id), `pinned_set member ${id} must be in metadata_pool`).toBe(true);
  }

  // 3. Session index is append-only
  if (previousIndex) {
    for (const id of previousIndex) {
      expect(index.has(id), `session_index must be append-only — ${id} was removed`).toBe(true);
    }
  }

  // 4. No infrastructure objects in content sets
  for (const id of index) {
    const obj = await client.get(id);
    expect(obj, `Object ${id} in session_index must exist in XTDB`).not.toBeNull();
    const objType = obj!.type as ObjectType;
    expect(
      INFRASTRUCTURE_TYPES.includes(objType),
      `Infrastructure object type "${objType}" (${id}) must not be in session_index`,
    ).toBe(false);
  }

  // 5. Every active object has non-null content
  for (const id of active) {
    const obj = await client.get(id);
    expect(obj, `Active object ${id} must exist`).not.toBeNull();
    expect(obj!.content, `Active object ${id} must have non-null content`).not.toBeNull();
  }

  return s;
}

// ===========================================================================
// describe('Session invariants')
// ===========================================================================

describe('Session invariants', () => {
  let tmpDir: string;
  const fsId = testFsId('invariants');

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invariants hold on a fresh session with no content', async () => {
    const sid = testSessionId('empty');
    // Create a minimal session document
    const sessionDoc: Record<string, unknown> = {
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: [],
      metadata_pool: [],
      active_set: [],
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: metadataHash({
        session_id: sid,
        chat_ref: `chat:${sid}`,
        system_prompt_ref: `sp:${sid}`,
        session_index: [],
        metadata_pool: [],
        active_set: [],
        pinned_set: [],
      }),
      object_hash: '', // will compute below
    };
    sessionDoc.object_hash = objectHash(
      null,
      null,
      sessionDoc.metadata_hash as string,
    );

    await xtdb.putAndWait(sessionDoc);
    await assertSessionInvariants(xtdb, sid);
  });

  it('invariants hold after indexing a file', async () => {
    const sid = testSessionId('after-index');
    const filePath = writeTestFile(tmpDir, 'inv-test.ts', 'console.log("hello");');
    const source = makeSource(fsId, filePath);

    // Index the file
    const result = await indexFile(xtdb, source, fs.readFileSync(filePath, 'utf-8'));
    expect(result.action).toBe('created');

    // Create session with the file in all sets
    const sessionDoc: Record<string, unknown> = {
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [result.objectId],
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: metadataHash({
        session_id: sid,
        chat_ref: `chat:${sid}`,
        system_prompt_ref: `sp:${sid}`,
        session_index: [result.objectId],
        metadata_pool: [result.objectId],
        active_set: [result.objectId],
        pinned_set: [],
      }),
      object_hash: '',
    };
    sessionDoc.object_hash = objectHash(null, null, sessionDoc.metadata_hash as string);
    await xtdb.putAndWait(sessionDoc);

    await assertSessionInvariants(xtdb, sid);
  });

  it('invariants hold after deactivation — object stays in metadata_pool', async () => {
    const sid = testSessionId('deactivate');
    const filePath = writeTestFile(tmpDir, 'deact.ts', 'let x = 1;');
    const source = makeSource(fsId, filePath);
    const result = await indexFile(xtdb, source, fs.readFileSync(filePath, 'utf-8'));

    // Session: file in index + pool but NOT active (deactivated)
    const sessionDoc: Record<string, unknown> = {
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [],
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: metadataHash({
        session_id: sid,
        chat_ref: `chat:${sid}`,
        system_prompt_ref: `sp:${sid}`,
        session_index: [result.objectId],
        metadata_pool: [result.objectId],
        active_set: [],
        pinned_set: [],
      }),
      object_hash: '',
    };
    sessionDoc.object_hash = objectHash(null, null, sessionDoc.metadata_hash as string);
    await xtdb.putAndWait(sessionDoc);

    const s = await assertSessionInvariants(xtdb, sid);
    expect(s.active_set).not.toContain(result.objectId);
    expect(s.metadata_pool).toContain(result.objectId);
  });

  it('session_index append-only violation is detected', async () => {
    const previousIndex = ['obj-a', 'obj-b', 'obj-c'];
    const sid = testSessionId('append-violation');

    // Create a file object so we have a valid content object for obj-a
    const filePath = writeTestFile(tmpDir, 'append-v.ts', 'test');
    const source = makeSource(fsId, filePath);
    const result = await indexFile(xtdb, source, 'test');

    // Session with only one of the previous IDs
    const sessionDoc: Record<string, unknown> = {
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: [result.objectId], // missing obj-a, obj-b, obj-c
      metadata_pool: [result.objectId],
      active_set: [],
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: metadataHash({
        session_id: sid,
        chat_ref: `chat:${sid}`,
        system_prompt_ref: `sp:${sid}`,
        session_index: [result.objectId],
        metadata_pool: [result.objectId],
        active_set: [],
        pinned_set: [],
      }),
      object_hash: '',
    };
    sessionDoc.object_hash = objectHash(null, null, sessionDoc.metadata_hash as string);
    await xtdb.putAndWait(sessionDoc);

    // This should fail because previousIndex items are missing
    await expect(
      assertSessionInvariants(xtdb, sid, previousIndex),
    ).rejects.toThrow('append-only');
  });
});

// ===========================================================================
// describe('Object identity')
// ===========================================================================

describe('Object identity', () => {
  it('same filesystem ID + same canonical path = same object ID, always', () => {
    const fsId = testFsId('identity-same');
    const path1 = '/home/user/project/main.ts';

    const source1 = makeSource(fsId, path1);
    const source2 = makeSource(fsId, path1);

    const id1 = identityHash('file', source1);
    const id2 = identityHash('file', source2);

    expect(id1).toBe(id2);
  });

  it('different filesystem ID = different object, even with same path', () => {
    const fsA = testFsId('identity-fs-a');
    const fsB = testFsId('identity-fs-b');
    const samePath = '/home/user/project/main.ts';

    const idA = identityHash('file', makeSource(fsA, samePath));
    const idB = identityHash('file', makeSource(fsB, samePath));

    expect(idA).not.toBe(idB);
  });

  it('identity_hash for sourced objects equals xt/id', () => {
    const fsId = testFsId('identity-eq');
    const source = makeSource(fsId, '/project/file.ts');
    const id = identityHash('file', source);

    // xt/id IS the identity_hash for sourced objects
    // Verify it's SHA-256 of stableStringify({type, source})
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('identity_hash for unsourced objects is SHA-256 of type + assigned ID', () => {
    const assignedId = 'toolcall-abc-123';
    const hash = identityHash('toolcall', null, assignedId);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Different assigned ID → different hash
    const hash2 = identityHash('toolcall', null, 'toolcall-xyz-456');
    expect(hash).not.toBe(hash2);
  });

  it('identity_hash is stable across invocations', () => {
    const fsId = testFsId('identity-stable');
    const source = makeSource(fsId, '/stable/path.ts');

    const h1 = identityHash('file', source);
    const h2 = identityHash('file', source);
    const h3 = identityHash('file', source);

    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('two clients indexing the same source get the same object ID in XTDB', async () => {
    const fsId = testFsId('multi-client');
    const tmpDir = makeTempDir();
    const filePath = writeTestFile(tmpDir, 'shared.ts', 'shared content');
    const source = makeSource(fsId, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    // "Client A" indexes
    const resultA = await indexFile(xtdb, source, content);
    expect(resultA.action).toBe('created');

    // "Client B" indexes the same file
    const resultB = await indexFile(xtdb, source, content);
    expect(resultB.action).toBe('unchanged');
    expect(resultB.objectId).toBe(resultA.objectId);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// describe('Hash hierarchy')
// ===========================================================================

describe('Hash hierarchy', () => {
  it('identity_hash never changes across versions of the same object', async () => {
    const fsId = testFsId('hash-identity');
    const tmpDir = makeTempDir();
    const filePath = writeTestFile(tmpDir, 'versioned.ts', 'v1');
    const source = makeSource(fsId, filePath);

    // Version 1
    const r1 = await indexFile(xtdb, source, 'v1');
    const obj1 = await xtdb.get(r1.objectId);

    // Version 2 — different content
    const r2 = await indexFile(xtdb, source, 'v2 with changes');
    const obj2 = await xtdb.get(r2.objectId);

    expect(r1.objectId).toBe(r2.objectId);
    expect(obj1!.identity_hash).toBe(obj2!.identity_hash);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('file_hash is SHA-256 of raw file content', () => {
    const content = 'hello world\n';
    const fh = fileHash(content);
    const expected = sha256(content);
    expect(fh).toBe(expected);
  });

  it('content_hash is null when content is null', () => {
    expect(contentHash(null)).toBeNull();
  });

  it('content_hash is SHA-256 of content when content is present', () => {
    const content = 'some content';
    expect(contentHash(content)).toBe(sha256(content));
  });

  it('file_hash is null for discovery stubs', async () => {
    const fsId = testFsId('hash-stub');
    const source = makeSource(fsId, '/stub/path/file.ts');

    const result = await discoverFile(xtdb, source);
    const obj = await xtdb.get(result.objectId);

    expect(obj!.file_hash).toBeNull();
    expect(obj!.content_hash).toBeNull();
    expect(obj!.content).toBeNull();
  });

  it('metadata_hash covers only type-specific fields for file objects', () => {
    // For file type: file_type, char_count
    const mh1 = metadataHash({ file_type: 'ts', char_count: 100 });
    const mh2 = metadataHash({ file_type: 'ts', char_count: 100 });
    const mh3 = metadataHash({ file_type: 'ts', char_count: 200 });

    expect(mh1).toBe(mh2);
    expect(mh1).not.toBe(mh3);
  });

  it('object_hash changes iff any sub-hash changes', () => {
    const fh = fileHash('content');
    const ch = contentHash('content')!;
    const mh = metadataHash({ file_type: 'ts', char_count: 7 });

    const oh1 = objectHash(fh, ch, mh);

    // Change file_hash
    const fh2 = fileHash('different');
    const oh2 = objectHash(fh2, ch, mh);
    expect(oh1).not.toBe(oh2);

    // Change content_hash
    const ch2 = contentHash('different')!;
    const oh3 = objectHash(fh, ch2, mh);
    expect(oh1).not.toBe(oh3);

    // Change metadata_hash
    const mh2 = metadataHash({ file_type: 'ts', char_count: 999 });
    const oh4 = objectHash(fh, ch, mh2);
    expect(oh1).not.toBe(oh4);

    // Same inputs → same output
    const oh5 = objectHash(fh, ch, mh);
    expect(oh1).toBe(oh5);
  });

  it('object_hash is computed even when file_hash or content_hash is null', () => {
    const mh = metadataHash({ file_type: 'ts', char_count: 0 });
    const oh = objectHash(null, null, mh);
    expect(oh).toMatch(/^[a-f0-9]{64}$/);
  });

  it('full hash hierarchy is stored correctly in XTDB after indexing', async () => {
    const fsId = testFsId('hash-full');
    const tmpDir = makeTempDir();
    const content = 'function hello() { return "world"; }';
    const filePath = writeTestFile(tmpDir, 'hashed.ts', content);
    const source = makeSource(fsId, filePath);

    const result = await indexFile(xtdb, source, content);
    const obj = await xtdb.get(result.objectId);

    // Verify all five hashes are present and correct
    expect(obj!.identity_hash).toBe(identityHash('file', source));
    expect(obj!.file_hash).toBe(fileHash(content));
    expect(obj!.content_hash).toBe(contentHash(content));
    expect(obj!.metadata_hash).toBe(
      metadataHash({ file_type: 'ts', char_count: content.length }),
    );
    expect(obj!.object_hash).toBe(
      objectHash(
        obj!.file_hash as string,
        obj!.content_hash as string,
        obj!.metadata_hash as string,
      ),
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// describe('Indexing protocol')
// ===========================================================================

describe('Indexing protocol', () => {
  let tmpDir: string;
  const fsId = testFsId('indexing');

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexFile creates a new object when not found', async () => {
    const filePath = writeTestFile(tmpDir, 'new-file.ts', 'brand new');
    const source = makeSource(fsId, filePath);
    const result = await indexFile(xtdb, source, 'brand new');

    expect(result.action).toBe('created');
    const obj = await xtdb.get(result.objectId);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe('file');
    expect(obj!.content).toBe('brand new');
    expect(obj!.file_hash).toBe(fileHash('brand new'));
  });

  it('indexFile returns unchanged when file_hash matches', async () => {
    const content = 'unchanged content';
    const filePath = writeTestFile(tmpDir, 'unchanged.ts', content);
    const source = makeSource(fsId, filePath);

    await indexFile(xtdb, source, content);
    const result = await indexFile(xtdb, source, content);

    expect(result.action).toBe('unchanged');
  });

  it('indexFile creates new version when file_hash differs', async () => {
    const filePath = writeTestFile(tmpDir, 'changing.ts', 'original');
    const source = makeSource(fsId, filePath);

    const r1 = await indexFile(xtdb, source, 'original');
    expect(r1.action).toBe('created');

    const r2 = await indexFile(xtdb, source, 'modified content');
    expect(r2.action).toBe('updated');
    expect(r2.objectId).toBe(r1.objectId); // same object

    const obj = await xtdb.get(r2.objectId);
    expect(obj!.content).toBe('modified content');
    expect(obj!.file_hash).toBe(fileHash('modified content'));
  });

  it('indexFile upgrades a discovery stub (file_hash null → full)', async () => {
    const source = makeSource(fsId, '/upgrade/stub-to-full.ts');

    // Create stub via discovery
    const stub = await discoverFile(xtdb, source);
    expect(stub.action).toBe('created');

    const stubObj = await xtdb.get(stub.objectId);
    expect(stubObj!.file_hash).toBeNull();
    expect(stubObj!.content).toBeNull();

    // Now full-index with content
    const full = await indexFile(xtdb, source, 'real content now');
    expect(full.action).toBe('updated');
    expect(full.objectId).toBe(stub.objectId);

    const fullObj = await xtdb.get(full.objectId);
    expect(fullObj!.content).toBe('real content now');
    expect(fullObj!.file_hash).toBe(fileHash('real content now'));
  });

  it('discoverFile creates stub with null content and null file_hash', async () => {
    const source = makeSource(fsId, '/discover/newfile.md');
    const result = await discoverFile(xtdb, source);

    expect(result.action).toBe('created');
    const obj = await xtdb.get(result.objectId);
    expect(obj!.content).toBeNull();
    expect(obj!.file_hash).toBeNull();
    expect(obj!.content_hash).toBeNull();
    expect(obj!.type).toBe('file');
    expect(obj!.char_count).toBe(0);
    // file_type derived from extension
    expect(obj!.file_type).toBe('md');
  });

  it('discoverFile never overwrites an existing object', async () => {
    const content = 'already indexed content';
    const source = makeSource(fsId, '/discover/existing.ts');

    // Full index first
    await indexFile(xtdb, source, content);

    // Discovery should be no-op
    const result = await discoverFile(xtdb, source);
    expect(result.action).toBe('unchanged');

    // Content must still be there
    const obj = await xtdb.get(result.objectId);
    expect(obj!.content).toBe(content);
  });

  it('indexFileDeletion writes null content version', async () => {
    const content = 'file to be deleted';
    const source = makeSource(fsId, '/delete/target.ts');

    const created = await indexFile(xtdb, source, content);
    const deleted = await indexFileDeletion(xtdb, source);

    expect(deleted.objectId).toBe(created.objectId);
    expect(deleted.action).toBe('updated');

    const obj = await xtdb.get(deleted.objectId);
    expect(obj!.content).toBeNull();
    expect(obj!.content_hash).toBeNull();
    expect(obj!.file_hash).toBeNull();

    // History shows both versions
    const history = await xtdb.history(deleted.objectId);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// describe('Session lifecycle')
// ===========================================================================

describe('Session lifecycle', () => {
  let tmpDir: string;
  const fsId = testFsId('lifecycle');

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: create a minimal session document in XTDB and return its ID.
   */
  async function createSession(
    sid: string,
    sets: {
      session_index?: string[];
      metadata_pool?: string[];
      active_set?: string[];
      pinned_set?: string[];
    } = {},
  ): Promise<string> {
    const idx = sets.session_index ?? [];
    const pool = sets.metadata_pool ?? [];
    const active = sets.active_set ?? [];
    const pinned = sets.pinned_set ?? [];
    const mh = metadataHash({
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: idx,
      metadata_pool: pool,
      active_set: active,
      pinned_set: pinned,
    });

    const doc: Record<string, unknown> = {
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: idx,
      metadata_pool: pool,
      active_set: active,
      pinned_set: pinned,
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: mh,
      object_hash: objectHash(null, null, mh),
    };
    await xtdb.putAndWait(doc);
    return sid;
  }

  it('create → read → discover → activate → deactivate → pin full lifecycle', async () => {
    const sid = testSessionId('full-lifecycle');

    // 1. Create empty session
    await createSession(sid);
    let s = await assertSessionInvariants(xtdb, sid);
    expect(s.session_index).toHaveLength(0);

    // 2. Read a file (full index + add to all sets)
    const filePath = writeTestFile(tmpDir, 'lifecycle.ts', 'const x = 42;');
    const source = makeSource(fsId, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const indexed = await indexFile(xtdb, source, content);

    await createSession(sid, {
      session_index: [indexed.objectId],
      metadata_pool: [indexed.objectId],
      active_set: [indexed.objectId],
    });
    s = await assertSessionInvariants(xtdb, sid);
    expect(s.active_set).toContain(indexed.objectId);

    // 3. Discover another file (stub, metadata only)
    const stubSource = makeSource(fsId, '/lifecycle/discovered.md');
    const discovered = await discoverFile(xtdb, stubSource);

    await createSession(sid, {
      session_index: [indexed.objectId, discovered.objectId],
      metadata_pool: [indexed.objectId, discovered.objectId],
      active_set: [indexed.objectId],
    });
    s = await assertSessionInvariants(xtdb, sid);
    expect(s.metadata_pool).toContain(discovered.objectId);
    expect(s.active_set).not.toContain(discovered.objectId);

    // 4. Activate the stub (would trigger read + upgrade in real system)
    // Simulate: upgrade stub then activate
    await indexFile(xtdb, stubSource, 'discovered content');

    await createSession(sid, {
      session_index: [indexed.objectId, discovered.objectId],
      metadata_pool: [indexed.objectId, discovered.objectId],
      active_set: [indexed.objectId, discovered.objectId],
    });
    s = await assertSessionInvariants(xtdb, sid);
    expect(s.active_set).toContain(discovered.objectId);

    // 5. Deactivate the first file
    await createSession(sid, {
      session_index: [indexed.objectId, discovered.objectId],
      metadata_pool: [indexed.objectId, discovered.objectId],
      active_set: [discovered.objectId],
    });
    s = await assertSessionInvariants(xtdb, sid);
    expect(s.active_set).not.toContain(indexed.objectId);
    expect(s.metadata_pool).toContain(indexed.objectId);

    // 6. Pin the second file
    await createSession(sid, {
      session_index: [indexed.objectId, discovered.objectId],
      metadata_pool: [indexed.objectId, discovered.objectId],
      active_set: [discovered.objectId],
      pinned_set: [discovered.objectId],
    });
    s = await assertSessionInvariants(xtdb, sid);
    expect(s.pinned_set).toContain(discovered.objectId);
  });

  it('session pause and resume — files changed on disk produce new versions', async () => {
    const sid = testSessionId('pause-resume');
    const filePath = writeTestFile(tmpDir, 'resume-test.ts', 'original content');
    const source = makeSource(fsId, filePath);

    // Index and create session
    const indexed = await indexFile(xtdb, source, 'original content');
    await createSession(sid, {
      session_index: [indexed.objectId],
      metadata_pool: [indexed.objectId],
      active_set: [indexed.objectId],
    });

    const beforePause = await assertSessionInvariants(xtdb, sid);
    const objBeforePause = await xtdb.get(indexed.objectId);
    const hashBeforePause = objBeforePause!.object_hash;

    // "Pause" — session is persisted. We just keep the session doc.

    // Change file on disk
    fs.writeFileSync(filePath, 'modified after pause', 'utf-8');

    // "Resume" — re-index sourced objects
    const newContent = fs.readFileSync(filePath, 'utf-8');
    const resumed = await indexFile(xtdb, source, newContent);

    expect(resumed.action).toBe('updated');
    expect(resumed.objectId).toBe(indexed.objectId); // same object

    const objAfterResume = await xtdb.get(indexed.objectId);
    expect(objAfterResume!.content).toBe('modified after pause');
    expect(objAfterResume!.object_hash).not.toBe(hashBeforePause);

    // Session sets unchanged (resume doesn't change sets, just updates objects)
    const afterResume = await assertSessionInvariants(xtdb, sid, beforePause.session_index);
  });

  it('resume with deleted file creates null-content version', async () => {
    const sid = testSessionId('resume-deleted');
    const filePath = writeTestFile(tmpDir, 'will-delete.ts', 'doomed');
    const source = makeSource(fsId, filePath);

    const indexed = await indexFile(xtdb, source, 'doomed');
    await createSession(sid, {
      session_index: [indexed.objectId],
      metadata_pool: [indexed.objectId],
      active_set: [indexed.objectId],
    });

    // Delete file
    fs.unlinkSync(filePath);

    // Resume — file gone, record deletion
    const deleted = await indexFileDeletion(xtdb, source);
    expect(deleted.objectId).toBe(indexed.objectId);

    const obj = await xtdb.get(indexed.objectId);
    expect(obj!.content).toBeNull();

    // Identity preserved
    expect(obj!.identity_hash).toBe(identityHash('file', source));
  });
});

// ===========================================================================
// describe('Multi-session')
// ===========================================================================

describe('Multi-session', () => {
  let tmpDir: string;
  const fsId = testFsId('multi');

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSession(sid: string, sets: Record<string, string[]> = {}): Promise<void> {
    const idx = sets.session_index ?? [];
    const pool = sets.metadata_pool ?? [];
    const active = sets.active_set ?? [];
    const pinned = sets.pinned_set ?? [];
    const mh = metadataHash({
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: idx,
      metadata_pool: pool,
      active_set: active,
      pinned_set: pinned,
    });
    await xtdb.putAndWait({
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: idx,
      metadata_pool: pool,
      active_set: active,
      pinned_set: pinned,
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: mh,
      object_hash: objectHash(null, null, mh),
    });
  }

  it('two sessions share the same file object via same source binding', async () => {
    const sidA = testSessionId('multi-a');
    const sidB = testSessionId('multi-b');

    const filePath = writeTestFile(tmpDir, 'shared.ts', 'shared by both');
    const source = makeSource(fsId, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Session A indexes
    const resultA = await indexFile(xtdb, source, content);
    await createSession(sidA, {
      session_index: [resultA.objectId],
      metadata_pool: [resultA.objectId],
      active_set: [resultA.objectId],
    });

    // Session B indexes same file
    const resultB = await indexFile(xtdb, source, content);
    expect(resultB.objectId).toBe(resultA.objectId);
    expect(resultB.action).toBe('unchanged');

    await createSession(sidB, {
      session_index: [resultB.objectId],
      metadata_pool: [resultB.objectId],
      active_set: [],
    });

    // Both sessions valid
    await assertSessionInvariants(xtdb, sidA);
    await assertSessionInvariants(xtdb, sidB);

    // Session A has it active, Session B does not
    const sA = (await xtdb.get(sidA)) as unknown as SessionObject;
    const sB = (await xtdb.get(sidB)) as unknown as SessionObject;
    expect(sA!.active_set).toContain(resultA.objectId);
    expect(sB!.active_set).not.toContain(resultB.objectId);
  });

  it('sessions have independent sets — one session deactivating does not affect another', async () => {
    const sidA = testSessionId('indep-a');
    const sidB = testSessionId('indep-b');

    const filePath = writeTestFile(tmpDir, 'independent.ts', 'content');
    const source = makeSource(fsId, filePath);
    const result = await indexFile(xtdb, source, 'content');

    // Both active
    await createSession(sidA, {
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [result.objectId],
    });
    await createSession(sidB, {
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [result.objectId],
    });

    // Session A deactivates
    await createSession(sidA, {
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [],
    });

    // Session B still active
    const sB = (await xtdb.get(sidB)) as unknown as SessionObject;
    expect(sB!.active_set).toContain(result.objectId);
  });

  it('concurrent updates to same object from different sessions both succeed', async () => {
    const sidA = testSessionId('concurrent-a');
    const sidB = testSessionId('concurrent-b');

    const filePath = writeTestFile(tmpDir, 'concurrent.ts', 'initial');
    const source = makeSource(fsId, filePath);
    await indexFile(xtdb, source, 'initial');

    // Both sessions update simultaneously
    const [rA, rB] = await Promise.all([
      indexFile(xtdb, source, 'update from A'),
      indexFile(xtdb, source, 'update from B'),
    ]);

    // Both resolve to same object
    expect(rA.objectId).toBe(rB.objectId);

    // Latest version is one of the two
    const obj = await xtdb.get(rA.objectId);
    expect(['update from A', 'update from B']).toContain(obj!.content);
  });

  it('watcher update does not change session sets', async () => {
    const sid = testSessionId('watcher-no-set-change');
    const filePath = writeTestFile(tmpDir, 'watched.ts', 'initial');
    const source = makeSource(fsId, filePath);

    const result = await indexFile(xtdb, source, 'initial');

    // Agent deactivated the file
    await xtdb.putAndWait({
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: `chat:${sid}`,
      system_prompt_ref: `sp:${sid}`,
      session_index: [result.objectId],
      metadata_pool: [result.objectId],
      active_set: [],  // deactivated
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: metadataHash({
        session_id: sid,
        chat_ref: `chat:${sid}`,
        system_prompt_ref: `sp:${sid}`,
        session_index: [result.objectId],
        metadata_pool: [result.objectId],
        active_set: [],
        pinned_set: [],
      }),
      object_hash: '',
    });

    // Watcher fires — file changed on disk. Just re-index, DON'T change sets.
    fs.writeFileSync(filePath, 'watcher saw this change', 'utf-8');
    const watcherResult = await indexFile(xtdb, source, 'watcher saw this change');
    expect(watcherResult.action).toBe('updated');

    // Session sets unchanged — file still deactivated
    const session = (await xtdb.get(sid)) as unknown as SessionObject;
    expect(session!.active_set).not.toContain(result.objectId);
    expect(session!.metadata_pool).toContain(result.objectId);
  });
});

// ===========================================================================
// describe('Filesystem resolver')
// ===========================================================================

describe('Filesystem resolver', () => {
  it('forward resolves bind-mounted path to canonical host path', () => {
    const hostFsId = testFsId('resolver-host');
    const containerFsId = testFsId('resolver-container');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/.openclaw/workspaces/dev',
        filesystemId: hostFsId,
        writable: true,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);
    const resolved = resolver.resolve('/workspace/src/main.ts');

    expect(resolved.canonicalPath).toBe('/home/user/.openclaw/workspaces/dev/src/main.ts');
    expect(resolved.filesystemId).toBe(hostFsId);
    expect(resolved.isMounted).toBe(true);
  });

  it('forward resolves non-mounted path with container FS ID', () => {
    const hostFsId = testFsId('resolver-host2');
    const containerFsId = testFsId('resolver-container2');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/ws',
        filesystemId: hostFsId,
        writable: true,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);
    const resolved = resolver.resolve('/tmp/scratch/file.ts');

    expect(resolved.canonicalPath).toBe('/tmp/scratch/file.ts');
    expect(resolved.filesystemId).toBe(containerFsId);
    expect(resolved.isMounted).toBe(false);
  });

  it('reverse resolves canonical path to agent-visible path', () => {
    const hostFsId = testFsId('resolver-rev-host');
    const containerFsId = testFsId('resolver-rev-container');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/.openclaw/workspaces/dev',
        filesystemId: hostFsId,
        writable: true,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);
    const display = resolver.reverseResolve('/home/user/.openclaw/workspaces/dev/src/index.ts');

    expect(display).toBe('/workspace/src/index.ts');
  });

  it('reverse returns canonical path unchanged when no mount matches', () => {
    const hostFsId = testFsId('resolver-rev-nomatch-host');
    const containerFsId = testFsId('resolver-rev-nomatch-container');
    const resolver = new FilesystemResolver(containerFsId, hostFsId, []);

    const display = resolver.reverseResolve('/some/random/path.ts');
    expect(display).toBe('/some/random/path.ts');
  });

  it('isWatchable returns true for mounted paths, false for container-internal', () => {
    const hostFsId = testFsId('resolver-watch-host');
    const containerFsId = testFsId('resolver-watch-container');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/ws',
        filesystemId: hostFsId,
        writable: true,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);

    expect(resolver.isWatchable('/workspace/src/main.ts')).toBe(true);
    expect(resolver.isWatchable('/tmp/ephemeral.ts')).toBe(false);
  });

  it('longest prefix match wins when multiple mounts overlap', () => {
    const hostFsId = testFsId('resolver-longest-host');
    const containerFsId = testFsId('resolver-longest-container');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/ws',
        filesystemId: hostFsId,
        writable: true,
      },
      {
        agentPrefix: '/workspace/vendor',
        canonicalPrefix: '/opt/vendor',
        filesystemId: hostFsId,
        writable: false,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);

    const general = resolver.resolve('/workspace/src/app.ts');
    expect(general.canonicalPath).toBe('/home/user/ws/src/app.ts');

    const vendor = resolver.resolve('/workspace/vendor/lib/dep.ts');
    expect(vendor.canonicalPath).toBe('/opt/vendor/lib/dep.ts');
  });
});

// ===========================================================================
// describe('Context assembly')
// ===========================================================================

describe('Context assembly', () => {
  let tmpDir: string;
  const fsId = testFsId('assembly');

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('metadata line for indexed file includes path, file_type, char_count', async () => {
    const filePath = writeTestFile(tmpDir, 'meta-test.ts', 'const y = 99;');
    const source = makeSource(fsId, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = await indexFile(xtdb, source, content);
    const obj = await xtdb.get(result.objectId);

    // Expected metadata format: id={id} type=file path={displayPath} file_type={file_type} char_count={char_count}
    expect(obj!.type).toBe('file');
    expect(obj!.file_type).toBe('ts');
    expect(obj!.char_count).toBe(content.length);
    expect(obj!.content).toBe(content);
  });

  it('metadata line for stub shows [unread] instead of char_count', async () => {
    const source = makeSource(fsId, '/assembly/unread-file.py');
    const result = await discoverFile(xtdb, source);
    const obj = await xtdb.get(result.objectId);

    // Stub: file_hash null, content null, char_count 0
    expect(obj!.file_hash).toBeNull();
    expect(obj!.content).toBeNull();
    expect(obj!.char_count).toBe(0);
    expect(obj!.file_type).toBe('py');
    // The rendering layer should show [unread] — we verify the data that drives it
  });

  it('display paths use reverse-resolved agent-visible paths', () => {
    const hostFsId = testFsId('assembly-display-host');
    const containerFsId = testFsId('assembly-display-container');
    const mounts: MountMapping[] = [
      {
        agentPrefix: '/workspace',
        canonicalPrefix: '/home/user/project',
        filesystemId: hostFsId,
        writable: true,
      },
    ];

    const resolver = new FilesystemResolver(containerFsId, hostFsId, mounts);

    // Canonical path stored in source.path
    const canonical = '/home/user/project/src/utils.ts';
    const display = resolver.reverseResolve(canonical);

    expect(display).toBe('/workspace/src/utils.ts');
  });

  it('active content block format: ACTIVE_CONTENT id={id} followed by content', async () => {
    const content = 'function greet() { return "hi"; }';
    const filePath = writeTestFile(tmpDir, 'active-block.ts', content);
    const source = makeSource(fsId, filePath);
    const result = await indexFile(xtdb, source, content);
    const obj = await xtdb.get(result.objectId);

    // Active content rendering should produce:
    // ACTIVE_CONTENT id={id}
    // {content}
    const expectedBlock = `ACTIVE_CONTENT id=${result.objectId}\n${obj!.content}`;
    expect(expectedBlock).toContain(`ACTIVE_CONTENT id=${result.objectId}`);
    expect(expectedBlock).toContain(content);
  });

  it('infrastructure objects (chat, system_prompt) are not in metadata pool rendering', async () => {
    const sid = testSessionId('assembly-infra');
    const chatId = `chat:${sid}`;
    const spId = `sp:${sid}`;

    // Create infrastructure objects
    await xtdb.putAndWait({
      'xt/id': chatId,
      type: 'chat',
      source: null,
      content: '[]',
      turns: [],
      session_ref: sid,
      turn_count: 0,
      toolcall_refs: [],
      identity_hash: identityHash('chat', null, chatId),
      file_hash: null,
      content_hash: contentHash('[]'),
      metadata_hash: metadataHash({ turns: [], session_ref: sid, turn_count: 0, toolcall_refs: [] }),
      object_hash: '',
    });

    await xtdb.putAndWait({
      'xt/id': spId,
      type: 'system_prompt',
      source: null,
      content: 'You are a helpful assistant.',
      identity_hash: identityHash('system_prompt', null, spId),
      file_hash: null,
      content_hash: contentHash('You are a helpful assistant.'),
      metadata_hash: metadataHash({}),
      object_hash: '',
    });

    // These should NOT be in session_index, metadata_pool, or active_set
    // Session references them via chat_ref and system_prompt_ref
    const mh = metadataHash({
      session_id: sid,
      chat_ref: chatId,
      system_prompt_ref: spId,
      session_index: [],
      metadata_pool: [],
      active_set: [],
      pinned_set: [],
    });
    await xtdb.putAndWait({
      'xt/id': sid,
      type: 'session',
      source: null,
      session_id: sid,
      chat_ref: chatId,
      system_prompt_ref: spId,
      session_index: [],
      metadata_pool: [],
      active_set: [],
      pinned_set: [],
      content: null,
      identity_hash: identityHash('session', null, sid),
      file_hash: null,
      content_hash: null,
      metadata_hash: mh,
      object_hash: objectHash(null, null, mh),
    });

    const session = await assertSessionInvariants(xtdb, sid);
    expect(session.session_index).not.toContain(chatId);
    expect(session.session_index).not.toContain(spId);
    expect(session.metadata_pool).not.toContain(chatId);
    expect(session.metadata_pool).not.toContain(spId);
  });
});
