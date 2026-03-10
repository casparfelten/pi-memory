import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §5 putVersion transaction contract', () => {
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

  it('§5.0 step 0: session write with null/empty/whitespace session_id returns validation failure', async () => {
    const invalidInputs = [
      { requestId: 'pv-s0-null', sessionId: null as string | null | undefined },
      { requestId: 'pv-s0-missing', sessionId: undefined as string | null | undefined },
      { requestId: 'pv-s0-empty', sessionId: '' as string | null | undefined },
      { requestId: 'pv-s0-space', sessionId: '   ' as string | null | undefined },
    ];

    for (const invalid of invalidInputs) {
      const result = await harness.storage.putVersion(
        baseWrite({
          requestId: invalid.requestId,
          objectId: `session:${invalid.requestId}`,
          objectType: 'session',
          sessionId: invalid.sessionId,
          contentStruct: {
            chat_ref: { target_object_id: 'chat:any', mode: 'dynamic', ref_kind: 'chat' },
            active_set: [],
            inactive_set: [],
            pinned_set: [],
          },
          metadata: {},
        }),
      );

      expect(result).toEqual({ ok: false, validation: true, reason: 'invalid_session_id' });

      const objectRow = inspect
        .prepare('SELECT object_id FROM objects WHERE object_id = ?')
        .get(`session:${invalid.requestId}`) as { object_id: string } | undefined;
      expect(objectRow).toBeUndefined();
    }
  });

  it('§5 ordering rule: session identity validation runs before idempotency decisions', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s0-order',
        objectId: 'session:pv-s0-order',
        objectType: 'session',
        sessionId: 'pv-s0',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:any', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s0-order',
        objectId: 'session:pv-s0-order',
        objectType: 'session',
        sessionId: '   ',
        expectedCurrentVersionId: 'wrong-head',
        contentStruct: {
          chat_ref: 'not-a-ref',
        },
        metadata: {},
      }),
    );

    expect(second).toEqual({ ok: false, validation: true, reason: 'invalid_session_id' });

    const versionCount = inspect
      .prepare('SELECT COUNT(*) as c FROM object_versions WHERE object_id = ?')
      .get('session:pv-s0-order') as { c: number };
    expect(versionCount.c).toBe(1);
  });

  it('§5.1 step 1: idempotency replay returns prior record when request_id + hashes match', async () => {
    const input = baseWrite({
      requestId: 'pv-s1',
      objectId: 'file:/idempotent.ts',
      objectType: 'file',
      contentStruct: { body: 'same' },
      fileBytes: new TextEncoder().encode('same-bytes'),
      metadata: {},
    });

    const first = await harness.storage.putVersion(input);
    const second = await harness.storage.putVersion(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.idempotentReplay).toBe(true);
    expect(second.record.versionId).toBe(first.record.versionId);
  });

  it('§5.1 step 1: idempotency_mismatch when request_id exists but fingerprint differs', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s1-mismatch',
        objectId: 'file:/mismatch.ts',
        objectType: 'file',
        contentStruct: { body: 'v1' },
        fileBytes: new TextEncoder().encode('a'),
        metadata: {},
      }),
    );

    const conflict = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s1-mismatch',
        objectId: 'file:/mismatch.ts',
        objectType: 'file',
        contentStruct: { body: 'v2' },
        fileBytes: new TextEncoder().encode('b'),
        metadata: {},
      }),
    );

    expect(conflict).toEqual({ ok: false, conflict: true, reason: 'idempotency_mismatch' });
  });

  it('§5 ordering rule: idempotency decision runs before optimistic conflict check', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-order',
        objectId: 'file:/order.ts',
        objectType: 'file',
        contentStruct: { body: 'initial' },
        metadata: {},
      }),
    );

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-order',
        objectId: 'file:/order.ts',
        objectType: 'file',
        expectedCurrentVersionId: 'wrong-head',
        contentStruct: { body: 'changed' },
        metadata: {},
      }),
    );

    expect(result).toEqual({ ok: false, conflict: true, reason: 'idempotency_mismatch' });
  });

  it('§5 ordering rule: idempotency decision runs before ref validation for reused request_id', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-order-refs',
        objectId: 'session:pv-order-refs',
        objectType: 'session',
        sessionId: 'pv-order-refs',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:any', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-order-refs',
        objectId: 'session:pv-order-refs',
        objectType: 'session',
        sessionId: 'pv-order-refs',
        contentStruct: {
          chat_ref: 'not-a-ref',
        },
        metadata: {},
      }),
    );

    expect(result).toEqual({ ok: false, conflict: true, reason: 'idempotency_mismatch' });
  });

  it('§5.2 step 2: object row is inserted on first write when missing', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s2',
        objectId: 'chat:new',
        objectType: 'chat',
        contentStruct: { turns: [] },
        metadata: {},
      }),
    );
    expect(result.ok).toBe(true);

    const row = inspect
      .prepare('SELECT object_id, object_type FROM objects WHERE object_id = ?')
      .get('chat:new') as { object_id: string; object_type: string } | undefined;

    expect(row).toEqual({ object_id: 'chat:new', object_type: 'chat' });
  });

  it('§5.3 step 3: expectedCurrentVersionId mismatch returns version_conflict', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s3-a',
        objectId: 'chat:head',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s3-b',
        objectId: 'chat:head',
        objectType: 'chat',
        expectedCurrentVersionId: 'not-current',
        contentStruct: {},
        metadata: {},
      }),
    );

    expect(result).toEqual({ ok: false, conflict: true, reason: 'version_conflict' });
  });

  it('§5.4 step 4: nextVersionNo is max(version_no)+1 for the object', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s4-a',
        objectId: 'file:/vno.ts',
        objectType: 'file',
        contentStruct: { n: 1 },
        metadata: {},
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s4-b',
        objectId: 'file:/vno.ts',
        objectType: 'file',
        expectedCurrentVersionId: first.record.versionId,
        contentStruct: { n: 2 },
        metadata: {},
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(first.record.versionNo).toBe(1);
    expect(second.record.versionNo).toBe(2);
  });

  it('§5.5 step 5: typed envelope and payload contradictions are rejected', async () => {
    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'pv-s5',
          objectId: 'file:/env.ts',
          objectType: 'file',
          sessionId: 's1',
          contentStruct: { session_id: 's2' },
          metadata: {},
        }),
      ),
    ).rejects.toThrow('typed_envelope_mismatch:session_id');
  });

  it('§5.6 step 6: immutable object_versions row is inserted for each accepted write', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s6-a',
        objectId: 'file:/append.ts',
        objectType: 'file',
        contentStruct: { body: 'a' },
        metadata: {},
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s6-b',
        objectId: 'file:/append.ts',
        objectType: 'file',
        expectedCurrentVersionId: first.record.versionId,
        contentStruct: { body: 'b' },
        metadata: {},
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const count = inspect
      .prepare('SELECT COUNT(*) as c FROM object_versions WHERE object_id = ?')
      .get('file:/append.ts') as { c: number };
    expect(count.c).toBe(2);

    const firstStillThere = inspect
      .prepare('SELECT version_id FROM object_versions WHERE version_id = ?')
      .get(first.record.versionId) as { version_id: string } | undefined;
    expect(firstStillThere?.version_id).toBe(first.record.versionId);
  });

  it('§5.7 step 7: object head and updated_seq/updated_at are advanced to new version', async () => {
    const a = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s7-a',
        objectId: 'file:/head-advance.ts',
        objectType: 'file',
        contentStruct: { body: '1' },
        metadata: {},
      }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s7-b',
        objectId: 'file:/head-advance.ts',
        objectType: 'file',
        expectedCurrentVersionId: a.record.versionId,
        contentStruct: { body: '2' },
        metadata: {},
      }),
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    const row = inspect
      .prepare('SELECT current_version_id, updated_seq, updated_at FROM objects WHERE object_id = ?')
      .get('file:/head-advance.ts') as {
      current_version_id: string;
      updated_seq: number;
      updated_at: string;
    };

    expect(row.current_version_id).toBe(b.record.versionId);
    expect(row.updated_seq).toBe(b.record.txSeq);
    expect(row.updated_at.length).toBeGreaterThan(0);
  });

  it('§5.8 step 8: references are extracted and stored for each new version', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s8-target',
        objectId: 'chat:pv-s8',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    const v1 = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s8-v1',
        objectId: 'session:pv-s8',
        objectType: 'session',
        sessionId: 'pv-s8',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:pv-s8', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [{ target_object_id: 'chat:pv-s8', mode: 'dynamic', ref_kind: 'active' }],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const refsV1 = await harness.storage.queryReferences({ fromVersionId: v1.record.versionId });
    expect(refsV1).toHaveLength(2);

    const v2 = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s8-v2',
        objectId: 'session:pv-s8',
        objectType: 'session',
        sessionId: 'pv-s8',
        expectedCurrentVersionId: v1.record.versionId,
        contentStruct: {
          chat_ref: { target_object_id: 'chat:pv-s8', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [{ target_object_id: 'chat:pv-s8', mode: 'dynamic', ref_kind: 'inactive' }],
          pinned_set: [],
        },
        metadata: {},
      }),
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;

    const refsV2 = await harness.storage.queryReferences({ fromVersionId: v2.record.versionId });
    expect(refsV2).toHaveLength(2);
    expect(refsV2.some((r) => r.fromPath.startsWith('/inactive_set'))).toBe(true);
  });

  it('§5.9 step 9: refs_hash is stored and deterministic for same ref set', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s9-target',
        objectId: 'chat:pv-s9',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    const a = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s9-a',
        objectId: 'session:pv-s9-a',
        objectType: 'session',
        sessionId: 'pv-s9',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:pv-s9', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [{ target_object_id: 'chat:pv-s9', mode: 'dynamic', ref_kind: 'active', ref_metadata: { a: 1, b: 2 } }],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    const b = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s9-b',
        objectId: 'session:pv-s9-b',
        objectType: 'session',
        sessionId: 'pv-s9',
        contentStruct: {
          chat_ref: { ref_kind: 'chat', mode: 'dynamic', target_object_id: 'chat:pv-s9' },
          active_set: [{ ref_metadata: { b: 2, a: 1 }, ref_kind: 'active', mode: 'dynamic', target_object_id: 'chat:pv-s9' }],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.record.refsHash).toBe(b.record.refsHash);
  });

  it('§5.10 step 10: write_idempotency row is inserted on success', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s10',
        objectId: 'file:/idem-row.ts',
        objectType: 'file',
        contentStruct: { body: 'x' },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const idem = inspect
      .prepare(
        'SELECT request_id, object_id, version_id, content_struct_hash, created_seq FROM write_idempotency WHERE request_id = ?',
      )
      .get('pv-s10') as {
      request_id: string;
      object_id: string;
      version_id: string;
      content_struct_hash: string;
      created_seq: number;
    };

    expect(idem.request_id).toBe('pv-s10');
    expect(idem.object_id).toBe('file:/idem-row.ts');
    expect(idem.version_id).toBe(result.record.versionId);
    expect(idem.created_seq).toBe(result.record.txSeq);
  });

  it('§5.11 step 11: success commits durable row and returns success record', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'pv-s11',
        objectId: 'file:/commit.ts',
        objectType: 'file',
        contentStruct: { body: 'commit' },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = inspect
      .prepare('SELECT version_id FROM object_versions WHERE version_id = ?')
      .get(result.record.versionId) as { version_id: string } | undefined;

    expect(persisted?.version_id).toBe(result.record.versionId);
    expect(result.idempotentReplay).toBe(false);
  });

  it('§5 atomic transaction: failure during write rolls back partial object insert', async () => {
    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'pv-rollback',
          objectId: 'session:rollback',
          objectType: 'session',
          sessionId: 'rollback',
          contentStruct: {
            // invalid ref value causes extraction error after object upsert path
            chat_ref: 'not-a-ref-object',
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow();

    const objectRow = inspect
      .prepare('SELECT object_id FROM objects WHERE object_id = ?')
      .get('session:rollback') as { object_id: string } | undefined;

    const versionCount = inspect.prepare('SELECT COUNT(*) as c FROM object_versions').get() as { c: number };

    expect(objectRow).toBeUndefined();
    expect(versionCount.c).toBe(0);
  });
});
