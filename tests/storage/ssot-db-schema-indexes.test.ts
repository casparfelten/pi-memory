import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §3 schema + §4 indexes', () => {
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

  it('§3 objects table: exact columns and FK to object_versions(version_id)', () => {
    const columns = inspect
      .prepare("PRAGMA table_info('objects')")
      .all() as Array<{ name: string }>;

    expect(columns.map((c) => c.name)).toEqual([
      'object_id',
      'object_type',
      'locked',
      'nickname',
      'created_seq',
      'updated_seq',
      'created_at',
      'updated_at',
      'current_version_id',
    ]);

    const fks = inspect
      .prepare("PRAGMA foreign_key_list('objects')")
      .all() as Array<{ table: string; from: string; to: string }>;

    expect(fks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'object_versions',
          from: 'current_version_id',
          to: 'version_id',
        }),
      ]),
    );
  });

  it('§3 object_versions table: exact columns + JSON CHECKs + UNIQUEs + FK object_id', () => {
    const columns = inspect
      .prepare("PRAGMA table_info('object_versions')")
      .all() as Array<{ name: string }>;

    expect(columns.map((c) => c.name)).toEqual([
      'tx_seq',
      'version_id',
      'object_id',
      'version_no',
      'tx_time',
      'writer_id',
      'writer_kind',
      'write_reason',
      'content_struct_json',
      'file_bytes_blob',
      'path',
      'session_id',
      'tool_name',
      'status',
      'char_count',
      'metadata_json',
      'content_struct_hash',
      'file_bytes_hash',
      'metadata_hash',
      'refs_hash',
      'object_hash',
      'hash_algo',
      'hash_schema_version',
    ]);

    const fks = inspect
      .prepare("PRAGMA foreign_key_list('object_versions')")
      .all() as Array<{ table: string; from: string; to: string }>;

    expect(fks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'objects',
          from: 'object_id',
          to: 'object_id',
        }),
      ]),
    );

    const createSql = inspect
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='object_versions'")
      .get() as { sql: string };

    expect(createSql.sql).toContain('CHECK (json_valid(content_struct_json))');
    expect(createSql.sql).toContain('CHECK (json_valid(metadata_json))');
    expect(createSql.sql).toContain('CHECK (session_id IS NULL OR length(trim(session_id)) > 0)');
    expect(createSql.sql).toContain('UNIQUE (object_id, version_no)');
    expect(createSql.sql).toContain('version_id          TEXT NOT NULL UNIQUE');
  });

  it('§3 doc_references table: exact columns + CHECK/FK contracts', () => {
    const columns = inspect
      .prepare("PRAGMA table_info('doc_references')")
      .all() as Array<{ name: string }>;

    expect(columns.map((c) => c.name)).toEqual([
      'ref_id',
      'from_version_id',
      'from_path',
      'target_object_id',
      'target_version_id',
      'target_object_hash',
      'ref_kind',
      'mode',
      'resolved',
      'ref_metadata_json',
    ]);

    const fks = inspect
      .prepare("PRAGMA foreign_key_list('doc_references')")
      .all() as Array<{ table: string; from: string; to: string }>;

    expect(fks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'object_versions',
          from: 'from_version_id',
          to: 'version_id',
        }),
      ]),
    );

    const createSql = inspect
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='doc_references'")
      .get() as { sql: string };

    expect(createSql.sql).toContain("CHECK (mode IN ('dynamic', 'pinned'))");
    expect(createSql.sql).toContain('CHECK (resolved IN (0,1))');
    expect(createSql.sql).toContain('CHECK (ref_metadata_json IS NULL OR json_valid(ref_metadata_json))');
    expect(createSql.sql).toContain("CHECK (mode != 'pinned' OR target_version_id IS NOT NULL OR target_object_hash IS NOT NULL)");
  });

  it('§3 write_idempotency table: exact columns + PK(request_id)', () => {
    const columns = inspect
      .prepare("PRAGMA table_info('write_idempotency')")
      .all() as Array<{ name: string; pk: number }>;

    expect(columns.map((c) => c.name)).toEqual([
      'request_id',
      'object_id',
      'version_id',
      'content_struct_hash',
      'file_bytes_hash',
      'created_seq',
      'created_at',
    ]);

    const requestId = columns.find((c) => c.name === 'request_id');
    expect(requestId?.pk).toBe(1);
  });

  it('§3 trigger: session object_versions insert requires non-empty session_id', () => {
    const trigger = inspect
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name='trg_session_version_requires_session_id'")
      .get() as { name: string; sql: string } | undefined;

    expect(trigger?.name).toBe('trg_session_version_requires_session_id');
    expect(trigger?.sql).toContain("RAISE(ABORT, 'invalid_session_id')");

    inspect
      .prepare(
        `INSERT INTO objects (
          object_id, object_type, locked, created_seq, updated_seq, created_at, updated_at, current_version_id
        ) VALUES ('session:trigger', 'session', 0, 1, 1, 't', 't', NULL)`,
      )
      .run();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO object_versions (
            version_id, object_id, version_no, tx_time,
            writer_id, writer_kind, write_reason,
            content_struct_json, file_bytes_blob,
            path, session_id, tool_name, status, char_count,
            metadata_json,
            content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash,
            hash_algo, hash_schema_version
          ) VALUES (
            'v-trigger-bad', 'session:trigger', 1, 't',
            'w', 'client', 'manual',
            '{}', NULL,
            NULL, NULL, NULL, NULL, NULL,
            '{}',
            'a', NULL, 'b', 'c', 'd',
            'sha256', 1
          )`,
        )
        .run();
    }).toThrow('invalid_session_id');
  });

  it('§3 enum/CHECK constraints reject invalid data at DB level', () => {
    expect(() => {
      inspect
        .prepare(
          `INSERT INTO objects (
            object_id, object_type, locked, created_seq, updated_seq, created_at, updated_at, current_version_id
          ) VALUES ('bad:1', 'invalid_type', 0, 1, 1, 't', 't', NULL)`,
        )
        .run();
    }).toThrow();

    inspect
      .prepare(
        `INSERT INTO objects (
          object_id, object_type, locked, created_seq, updated_seq, created_at, updated_at, current_version_id
        ) VALUES ('ok:1', 'file', 0, 1, 1, 't', 't', NULL)`,
      )
      .run();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO object_versions (
            version_id, object_id, version_no, tx_time,
            writer_id, writer_kind, write_reason,
            content_struct_json, file_bytes_blob,
            path, session_id, tool_name, status, char_count,
            metadata_json,
            content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash,
            hash_algo, hash_schema_version
          ) VALUES (
            'v-bad-kind', 'ok:1', 1, 't',
            'w', 'invalid_kind', 'manual',
            '{}', NULL,
            NULL, NULL, NULL, NULL, NULL,
            '{}',
            'a', NULL, 'b', 'c', 'd',
            'sha256', 1
          )`,
        )
        .run();
    }).toThrow();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO object_versions (
            version_id, object_id, version_no, tx_time,
            writer_id, writer_kind, write_reason,
            content_struct_json, file_bytes_blob,
            path, session_id, tool_name, status, char_count,
            metadata_json,
            content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash,
            hash_algo, hash_schema_version
          ) VALUES (
            'v-bad-json', 'ok:1', 1, 't',
            'w', 'client', 'manual',
            '{bad-json', NULL,
            NULL, NULL, NULL, NULL, NULL,
            '{}',
            'a', NULL, 'b', 'c', 'd',
            'sha256', 1
          )`,
        )
        .run();
    }).toThrow();
  });

  it('§3 doc_references pinned/mode/metadata JSON checks reject invalid rows', () => {
    inspect
      .prepare(
        `INSERT INTO objects (
          object_id, object_type, locked, created_seq, updated_seq, created_at, updated_at, current_version_id
        ) VALUES ('obj:1', 'file', 0, 1, 1, 't', 't', NULL)`,
      )
      .run();

    inspect
      .prepare(
        `INSERT INTO object_versions (
          version_id, object_id, version_no, tx_time,
          writer_id, writer_kind, write_reason,
          content_struct_json, file_bytes_blob,
          path, session_id, tool_name, status, char_count,
          metadata_json,
          content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash,
          hash_algo, hash_schema_version
        ) VALUES (
          'v-ok', 'obj:1', 1, 't',
          'w', 'client', 'manual',
          '{}', NULL,
          NULL, NULL, NULL, NULL, NULL,
          '{}',
          'a', NULL, 'b', 'c', 'd',
          'sha256', 1
        )`,
      )
      .run();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO doc_references (
            ref_id, from_version_id, from_path, target_object_id, target_version_id,
            target_object_hash, ref_kind, mode, resolved, ref_metadata_json
          ) VALUES (
            'r-invalid-mode', 'v-ok', '/x', 'obj:2', NULL,
            NULL, 'kind', 'bad-mode', 0, NULL
          )`,
        )
        .run();
    }).toThrow();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO doc_references (
            ref_id, from_version_id, from_path, target_object_id, target_version_id,
            target_object_hash, ref_kind, mode, resolved, ref_metadata_json
          ) VALUES (
            'r-invalid-pinned', 'v-ok', '/x', 'obj:2', NULL,
            NULL, 'kind', 'pinned', 0, NULL
          )`,
        )
        .run();
    }).toThrow();

    expect(() => {
      inspect
        .prepare(
          `INSERT INTO doc_references (
            ref_id, from_version_id, from_path, target_object_id, target_version_id,
            target_object_hash, ref_kind, mode, resolved, ref_metadata_json
          ) VALUES (
            'r-invalid-meta-json', 'v-ok', '/x', 'obj:2', NULL,
            NULL, 'kind', 'dynamic', 0, '{bad'
          )`,
        )
        .run();
    }).toThrow();
  });

  it('§4 recommended indexes exist with expected key columns', () => {
    const expected: Record<string, string[]> = {
      idx_versions_object_seq_desc: ['object_id', 'version_no'],
      idx_versions_object_txseq_desc: ['object_id', 'tx_seq'],
      idx_versions_session_id: ['session_id'],
      idx_versions_path: ['path'],
      idx_versions_tool_name_status: ['tool_name', 'status'],

      idx_refs_from_version_path: ['from_version_id', 'from_path'],
      idx_refs_target_object: ['target_object_id'],
      idx_refs_target_version: ['target_version_id'],
      idx_refs_target_hash: ['target_object_hash'],
      idx_refs_mode: ['mode'],
      idx_refs_resolved: ['resolved'],

      idx_objects_type: ['object_type'],
      idx_idempotency_object: ['object_id'],
    };

    for (const [indexName, expectedColumns] of Object.entries(expected)) {
      const row = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
        .get(indexName) as { name: string } | undefined;

      expect(row?.name).toBe(indexName);

      const info = inspect
        .prepare(`PRAGMA index_info('${indexName}')`)
        .all() as Array<{ name: string }>;
      expect(info.map((i) => i.name)).toEqual(expectedColumns);
    }

    const partialSql = inspect
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_refs_resolved'")
      .get() as { sql: string };

    expect(partialSql.sql).toContain('WHERE resolved = 0');
  });
});
