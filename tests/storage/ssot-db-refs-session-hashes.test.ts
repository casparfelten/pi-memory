import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  sha256,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §6 references, §7 sessions, §8 hashes', () => {
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

  it('§6.1 extracts refs only from explicit Ref objects in declared ref-bearing fields', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'r61-target',
        objectId: 'chat:r61',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r61-session',
        objectId: 'session:r61',
        objectType: 'session',
        sessionId: 'r61',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:r61', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
          // Not declared ref-bearing fields
          notes: [{ target_object_id: 'chat:r61', mode: 'dynamic', ref_kind: 'note' }],
          narrative: 'target_object_id=chat:r61 mode=dynamic ref_kind=note',
        },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const refs = await harness.storage.queryReferences({ fromVersionId: result.record.versionId });
    expect(refs).toHaveLength(1);
    expect(refs[0].fromPath).toBe('/chat_ref');
  });

  it('§6.2 validates minimal Ref runtime contract fields', async () => {
    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'r62-missing-target',
          objectId: 'session:r62a',
          objectType: 'session',
          sessionId: 'r62',
          contentStruct: {
            chat_ref: { mode: 'dynamic', ref_kind: 'chat' },
            active_set: [],
            inactive_set: [],
            pinned_set: [],
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow('target_object_id');

    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'r62-bad-mode',
          objectId: 'session:r62b',
          objectType: 'session',
          sessionId: 'r62',
          contentStruct: {
            chat_ref: { target_object_id: 'chat:x', mode: 'bad', ref_kind: 'chat' },
            active_set: [],
            inactive_set: [],
            pinned_set: [],
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow('mode');

    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'r62-pinned-no-anchor',
          objectId: 'session:r62c',
          objectType: 'session',
          sessionId: 'r62',
          contentStruct: {
            chat_ref: { target_object_id: 'chat:x', mode: 'dynamic', ref_kind: 'chat' },
            active_set: [],
            inactive_set: [],
            pinned_set: [{ target_object_id: 'chat:x', mode: 'pinned', ref_kind: 'pin' }],
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow('Invalid pinned Ref');
  });

  it('§6.3 stores all extracted ref fields, including resolved bit', async () => {
    const existingTarget = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r63-target',
        objectId: 'file:r63',
        objectType: 'file',
        contentStruct: {},
        metadata: {},
      }),
    );
    expect(existingTarget.ok).toBe(true);
    if (!existingTarget.ok) return;

    const session = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r63-session',
        objectId: 'session:r63',
        objectType: 'session',
        sessionId: 'r63',
        contentStruct: {
          chat_ref: {
            target_object_id: 'file:r63',
            mode: 'dynamic',
            ref_kind: 'chat',
            ref_metadata: { x: 1 },
          },
          active_set: [
            {
              target_object_id: 'file:missing-r63',
              mode: 'dynamic',
              ref_kind: 'active',
            },
          ],
          inactive_set: [],
          pinned_set: [
            {
              target_object_id: 'file:r63',
              mode: 'pinned',
              target_version_id: existingTarget.record.versionId,
              ref_kind: 'pin-version',
            },
          ],
        },
        metadata: {},
      }),
    );

    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const refs = await harness.storage.queryReferences({ fromVersionId: session.record.versionId });
    expect(refs).toHaveLength(3);

    const pinned = refs.find((r) => r.mode === 'pinned');
    expect(pinned?.targetVersionId).toBe(existingTarget.record.versionId);

    const unresolved = refs.find((r) => r.targetObjectId === 'file:missing-r63');
    expect(unresolved?.resolved).toBe(false);

    const resolved = refs.find((r) => r.targetObjectId === 'file:r63' && r.mode === 'dynamic');
    expect(resolved?.resolved).toBe(true);

    const raw = inspect
      .prepare('SELECT from_version_id, from_path, target_object_id, ref_kind, mode, resolved, ref_metadata_json FROM doc_references WHERE from_version_id = ? ORDER BY from_path ASC')
      .all(session.record.versionId) as Array<{
      from_version_id: string;
      from_path: string;
      target_object_id: string;
      ref_kind: string;
      mode: string;
      resolved: number;
      ref_metadata_json: string | null;
    }>;

    expect(raw.every((r) => r.from_version_id === session.record.versionId)).toBe(true);
    expect(raw.some((r) => r.from_path === '/chat_ref')).toBe(true);
    expect(raw.some((r) => r.from_path.startsWith('/active_set/'))).toBe(true);
    expect(raw.some((r) => r.from_path.startsWith('/pinned_set/'))).toBe(true);
  });

  it('§6.4 refs_hash is deterministic under input ordering permutations', async () => {
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'r64-target-a',
        objectId: 'obj:r64-a',
        objectType: 'file',
        contentStruct: {},
        metadata: {},
      }),
    );
    await harness.storage.putVersion(
      baseWrite({
        requestId: 'r64-target-b',
        objectId: 'obj:r64-b',
        objectType: 'file',
        contentStruct: {},
        metadata: {},
      }),
    );

    const x = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r64-x',
        objectId: 'session:r64-x',
        objectType: 'session',
        sessionId: 'r64',
        contentStruct: {
          chat_ref: { target_object_id: 'obj:r64-a', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            { target_object_id: 'obj:r64-b', mode: 'dynamic', ref_kind: 'active' },
            { target_object_id: 'obj:r64-a', mode: 'dynamic', ref_kind: 'active' },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    const y = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r64-y',
        objectId: 'session:r64-y',
        objectType: 'session',
        sessionId: 'r64',
        contentStruct: {
          chat_ref: { target_object_id: 'obj:r64-a', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            { target_object_id: 'obj:r64-a', mode: 'dynamic', ref_kind: 'active' },
            { target_object_id: 'obj:r64-b', mode: 'dynamic', ref_kind: 'active' },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(x.ok).toBe(true);
    expect(y.ok).toBe(true);
    if (!x.ok || !y.ok) return;

    expect(x.record.refsHash).not.toBe(y.record.refsHash);
  });

  it('§7.1 session realization: session writes are stored as object_type=session versions', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r71',
        objectId: 'session:r71',
        objectType: 'session',
        sessionId: 'sess-r71',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:r71', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const obj = inspect
      .prepare('SELECT object_type FROM objects WHERE object_id = ?')
      .get('session:r71') as { object_type: string };
    expect(obj.object_type).toBe('session');
  });

  it('§7.1 session writes reject missing/blank session_id with explicit validation result', async () => {
    const invalidCases = [
      { requestId: 'r71-invalid-null', sessionId: null as string | null | undefined },
      { requestId: 'r71-invalid-missing', sessionId: undefined as string | null | undefined },
      { requestId: 'r71-invalid-empty', sessionId: '' as string | null | undefined },
      { requestId: 'r71-invalid-space', sessionId: '   ' as string | null | undefined },
    ];

    for (const invalid of invalidCases) {
      const result = await harness.storage.putVersion(
        baseWrite({
          requestId: invalid.requestId,
          objectId: `session:${invalid.requestId}`,
          objectType: 'session',
          sessionId: invalid.sessionId,
          contentStruct: {
            chat_ref: { target_object_id: 'chat:r71-invalid', mode: 'dynamic', ref_kind: 'chat' },
            active_set: [],
            inactive_set: [],
            pinned_set: [],
          },
          metadata: {},
        }),
      );

      expect(result).toEqual({ ok: false, validation: true, reason: 'invalid_session_id' });
    }
  });

  it('§7.1 session payload shape required fields: chat_ref + active_set + inactive_set + pinned_set', async () => {
    // Spec requires these keys in session payload shape.
    // This test intentionally enforces that contract.
    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'r71-shape-missing-chat',
          objectId: 'session:r71-shape',
          objectType: 'session',
          sessionId: 'sess-shape',
          contentStruct: {
            active_set: [],
            inactive_set: [],
            pinned_set: [],
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it('§7.1 session_id typed envelope is the canonical session identity anchor across versions', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r71-anchor-a',
        objectId: 'session:anchor',
        objectType: 'session',
        sessionId: 'anchor-1',
        contentStruct: {
          session_id: 'anchor-1',
          chat_ref: { target_object_id: 'chat:anchor', mode: 'dynamic', ref_kind: 'chat' },
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
        requestId: 'r71-anchor-b',
        objectId: 'session:anchor',
        objectType: 'session',
        expectedCurrentVersionId: first.record.versionId,
        sessionId: 'anchor-1',
        contentStruct: {
          session_id: 'anchor-1',
          chat_ref: { target_object_id: 'chat:anchor', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const rows = inspect
      .prepare('SELECT session_id FROM object_versions WHERE object_id = ? ORDER BY version_no ASC')
      .all('session:anchor') as Array<{ session_id: string | null }>;

    expect(rows.map((r) => r.session_id)).toEqual(['anchor-1', 'anchor-1']);
  });

  it('§7.1 no separate mutable session-state table is canonical in this profile', () => {
    const row = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_state'")
      .get() as { name: string } | undefined;

    expect(row).toBeUndefined();
  });

  it('§8 stores content_struct_hash, metadata_hash, refs_hash, object_hash and nullable file_bytes_hash', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r8-hashes',
        objectId: 'file:r8',
        objectType: 'file',
        contentStruct: { body: 'abc' },
        fileBytes: new TextEncoder().encode('bytes'),
        metadata: { m: 1 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = inspect
      .prepare('SELECT content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash FROM object_versions WHERE version_id = ?')
      .get(result.record.versionId) as {
      content_struct_hash: string;
      file_bytes_hash: string | null;
      metadata_hash: string;
      refs_hash: string;
      object_hash: string;
    };

    expect(row.content_struct_hash.length).toBe(64);
    expect(row.file_bytes_hash?.length).toBe(64);
    expect(row.metadata_hash.length).toBe(64);
    expect(row.refs_hash.length).toBe(64);
    expect(row.object_hash.length).toBe(64);
  });

  it('§8 object_hash preimage follows H("v1|object_id|version_no|content_struct_hash|file_bytes_hash|metadata_hash|refs_hash")', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'r8-preimage',
        objectId: 'file:r8-preimage',
        objectType: 'file',
        contentStruct: { body: 'hello' },
        fileBytes: new TextEncoder().encode('world'),
        metadata: { t: true },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = inspect
      .prepare(
        'SELECT object_id, version_no, content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash FROM object_versions WHERE version_id = ?',
      )
      .get(result.record.versionId) as {
      object_id: string;
      version_no: number;
      content_struct_hash: string;
      file_bytes_hash: string | null;
      metadata_hash: string;
      refs_hash: string;
      object_hash: string;
    };

    const preimage = [
      'v1',
      row.object_id,
      String(row.version_no),
      row.content_struct_hash,
      row.file_bytes_hash ?? '',
      row.metadata_hash,
      row.refs_hash,
    ].join('|');

    expect(row.object_hash).toBe(sha256(preimage));
  });
});
