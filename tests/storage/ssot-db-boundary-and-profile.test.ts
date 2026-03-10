import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §1 profile, §9 boundary, §10 out-of-scope', () => {
  let harness: StorageHarness;
  let inspect: DatabaseSync;

  beforeEach(async () => {
    harness = await createStorageHarness();
    inspect = openInspectDb(harness.dbPath);
  });

  afterEach(async () => {
    inspect.close();
    await cleanupStorageHarness(harness);
  });

  it('§1 includes immutable version store + idempotent writes + typed envelope fields in object_versions', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p1-a',
        objectId: 'file:p1',
        objectType: 'file',
        path: '/p1',
        sessionId: 's1',
        toolName: 'read',
        status: 'ok',
        charCount: 2,
        contentStruct: {
          path: '/p1',
          session_id: 's1',
          tool_name: 'read',
          status: 'ok',
          char_count: 2,
        },
        metadata: {},
      }),
    );

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p1-a',
        objectId: 'file:p1',
        objectType: 'file',
        path: '/p1',
        sessionId: 's1',
        toolName: 'read',
        status: 'ok',
        charCount: 2,
        contentStruct: {
          path: '/p1',
          session_id: 's1',
          tool_name: 'read',
          status: 'ok',
          char_count: 2,
        },
        metadata: {},
      }),
    );

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.idempotentReplay).toBe(true);

    const row = inspect
      .prepare('SELECT path, session_id, tool_name, status, char_count FROM object_versions WHERE version_id = ?')
      .get(first.record.versionId) as {
      path: string;
      session_id: string;
      tool_name: string;
      status: string;
      char_count: number;
    };

    expect(row).toEqual({
      path: '/p1',
      session_id: 's1',
      tool_name: 'read',
      status: 'ok',
      char_count: 2,
    });
  });

  it('§1 includes explicit structured references + session tracking via session object versions', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'p1-chat',
        objectId: 'chat:p1',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    const session = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p1-session',
        objectId: 'session:p1',
        objectType: 'session',
        sessionId: 'session-p1',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:p1', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const refs = await harness.storage.queryReferences({ fromVersionId: session.record.versionId });
    expect(refs).toHaveLength(1);

    const objectType = inspect
      .prepare('SELECT object_type FROM objects WHERE object_id = ?')
      .get('session:p1') as { object_type: string };
    expect(objectType.object_type).toBe('session');
  });

  it('§9 StoragePort boundary exposes required methods', () => {
    const storageAsAny = harness.storage as unknown as Record<string, unknown>;

    const requiredMethods = [
      'putVersion',
      'getLatest',
      'getHistory',
      'queryReferences',
      'getReferrersByTargetVersion',
      'getReferrersByTargetHash',
    ];

    for (const method of requiredMethods) {
      expect(typeof storageAsAny[method]).toBe('function');
    }
  });

  it('§9 putVersion returns success / validation / conflict union shapes as specified', async () => {
    const success = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p9-success',
        objectId: 'obj:p9',
        objectType: 'toolcall',
        contentStruct: {},
        metadata: {},
      }),
    );

    expect(success.ok).toBe(true);
    if (!success.ok) return;

    expect(typeof success.record.versionId).toBe('string');
    expect(typeof success.idempotentReplay).toBe('boolean');

    const validation = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p9-validation',
        objectId: 'session:p9',
        objectType: 'session',
        sessionId: '   ',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:p9', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(validation).toEqual({ ok: false, validation: true, reason: 'invalid_session_id' });

    const conflict = await harness.storage.putVersion(
      baseWrite({
        requestId: 'p9-success',
        objectId: 'obj:p9',
        objectType: 'toolcall',
        contentStruct: { changed: true },
        metadata: {},
      }),
    );

    expect(conflict).toEqual({ ok: false, conflict: true, reason: 'idempotency_mismatch' });
  });

  it('§10 out-of-scope: no doc_nodes table, no temporal columns, no field-hash pinning columns', () => {
    const docNodes = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_nodes'")
      .get() as { name: string } | undefined;
    expect(docNodes).toBeUndefined();

    const versionColumns = inspect
      .prepare("PRAGMA table_info('object_versions')")
      .all() as Array<{ name: string }>;
    const names = versionColumns.map((c) => c.name);

    expect(names).not.toContain('valid_from');
    expect(names).not.toContain('valid_to');
    expect(names).not.toContain('field_hashes_json');
  });

  it('§10 out-of-scope: no built-in FTS tables', () => {
    const ftsRows = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts%'")
      .all() as Array<{ name: string }>;

    expect(ftsRows).toEqual([]);
  });

  it('§10 out-of-scope: storage boundary does not expose as-of/GC APIs', () => {
    const storageAsAny = harness.storage as unknown as Record<string, unknown>;
    expect(storageAsAny.getAsOf).toBeUndefined();
    expect(storageAsAny.gcDryRun).toBeUndefined();
    expect(storageAsAny.gcExecute).toBeUndefined();
    expect(storageAsAny.searchFullText).toBeUndefined();
  });
});
