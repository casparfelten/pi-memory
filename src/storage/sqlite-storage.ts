import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_INDEX_SQL, SQLITE_SCHEMA_SQL } from './sqlite-schema.js';
import type {
  ObjectType,
  ReferenceMode,
  ReferenceRecord,
  StoragePort,
  VersionRecord,
  VersionWriteInput,
} from './storage-port.js';

type Prepared = ReturnType<DatabaseSync['prepare']>;
type SqlArg = string | number | Uint8Array | null;

type PutResult =
  | { ok: true; record: VersionRecord; idempotentReplay: boolean }
  | { ok: false; validation: true; reason: 'invalid_session_id' }
  | { ok: false; conflict: true; reason: 'version_conflict' | 'idempotency_mismatch' };

type ObjectRow = { object_type: ObjectType; current_version_id: string | null };
type IdemRow = { object_id: string; version_id: string; content_struct_hash: string; file_bytes_hash: string | null };
type VersionRow = {
  tx_seq: number;
  version_id: string;
  object_id: string;
  version_no: number;
  tx_time: string;
  writer_id: string;
  writer_kind: VersionRecord['writerKind'];
  write_reason: VersionRecord['writeReason'];
  content_struct_json: string;
  file_bytes_hash: string | null;
  path: string | null;
  session_id: string | null;
  tool_name: string | null;
  status: string | null;
  char_count: number | null;
  metadata_json: string;
  content_struct_hash: string;
  metadata_hash: string;
  refs_hash: string;
  object_hash: string;
};

type RefRow = {
  ref_id: string;
  from_version_id: string;
  from_path: string;
  target_object_id: string;
  target_version_id: string | null;
  target_object_hash: string | null;
  ref_kind: string;
  mode: ReferenceMode;
  resolved: 0 | 1;
  ref_metadata_json: string | null;
};

type RefDraft = {
  fromPath: string;
  targetObjectId: string;
  targetVersionId: string | null;
  targetObjectHash: string | null;
  refKind: string;
  mode: ReferenceMode;
  refMetadataJson: string | null;
};

const SQL = {
  idempotencyByRequest:
    'SELECT object_id, version_id, content_struct_hash, file_bytes_hash FROM write_idempotency WHERE request_id = ?',
  insertObjectIfMissing:
    "INSERT INTO objects (object_id, object_type, locked, nickname, created_seq, updated_seq, created_at, updated_at, current_version_id) VALUES (?, ?, 0, NULL, 0, 0, ?, ?, NULL) ON CONFLICT(object_id) DO NOTHING",
  objectById: 'SELECT object_type, current_version_id FROM objects WHERE object_id = ?',
  nextVersionNo: 'SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version_no FROM object_versions WHERE object_id = ?',
  insertVersion:
    "INSERT INTO object_versions (version_id, object_id, version_no, tx_time, writer_id, writer_kind, write_reason, content_struct_json, file_bytes_blob, path, session_id, tool_name, status, char_count, metadata_json, content_struct_hash, file_bytes_hash, metadata_hash, refs_hash, object_hash, hash_algo, hash_schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sha256', 1)",
  updateObjectHead:
    'UPDATE objects SET current_version_id = ?, updated_seq = ?, updated_at = ?, created_seq = CASE WHEN created_seq = 0 THEN ? ELSE created_seq END, created_at = CASE WHEN created_seq = 0 THEN ? ELSE created_at END WHERE object_id = ?',
  insertRef:
    'INSERT INTO doc_references (ref_id, from_version_id, from_path, target_object_id, target_version_id, target_object_hash, ref_kind, mode, resolved, ref_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertIdempotency:
    'INSERT INTO write_idempotency (request_id, object_id, version_id, content_struct_hash, file_bytes_hash, created_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  versionById: 'SELECT * FROM object_versions WHERE version_id = ?',
  latestByObject:
    'SELECT v.* FROM objects o JOIN object_versions v ON v.version_id = o.current_version_id WHERE o.object_id = ?',
  historyAsc: 'SELECT * FROM object_versions WHERE object_id = ? ORDER BY version_no ASC',
  historyDesc: 'SELECT * FROM object_versions WHERE object_id = ? ORDER BY version_no DESC',
  objectExists: 'SELECT 1 AS ok FROM objects WHERE object_id = ? LIMIT 1',
} as const;

export class SqliteStorage implements StoragePort {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, Prepared>();

  constructor(options: { path?: string; migrate?: boolean } = {}) {
    this.db = new DatabaseSync(options.path ?? ':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (options.migrate ?? true) this.migrate();
  }

  migrate(): void {
    this.db.exec(SQLITE_SCHEMA_SQL);
    this.db.exec(SQLITE_INDEX_SQL);
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  async putVersion(input: VersionWriteInput): Promise<PutResult> {
    if (isInvalidSessionIdentity(input)) {
      return { ok: false, validation: true, reason: 'invalid_session_id' };
    }

    ensureString(input.requestId, 'requestId', true);
    ensureString(input.objectId, 'objectId', true);
    const txTime = input.txTime ?? new Date().toISOString();

    return this.tx(() => {
      const idem = this.stmt(SQL.idempotencyByRequest).get(input.requestId) as IdemRow | undefined;
      if (idem) {
        const fingerprint = computeIdempotencyFingerprint(input);
        const matches =
          idem.object_id === input.objectId &&
          idem.content_struct_hash === fingerprint.contentStructHash &&
          (idem.file_bytes_hash ?? null) === fingerprint.fileBytesHash;

        if (!matches) return { ok: false, conflict: true, reason: 'idempotency_mismatch' } as const;

        const replay = this.fetchVersion(idem.version_id);
        if (!replay) throw new Error(`idempotency_missing_version:${idem.version_id}`);
        return { ok: true, record: replay, idempotentReplay: true } as const;
      }

      this.stmt(SQL.insertObjectIfMissing).run(input.objectId, input.objectType, txTime, txTime);

      const objectRow = this.stmt(SQL.objectById).get(input.objectId) as ObjectRow | undefined;
      if (!objectRow) throw new Error(`missing_object_row:${input.objectId}`);
      if (objectRow.object_type !== input.objectType) {
        throw new Error(`object_type_mismatch:${input.objectId}:${objectRow.object_type}:${input.objectType}`);
      }
      if (
        input.expectedCurrentVersionId !== undefined &&
        input.expectedCurrentVersionId !== objectRow.current_version_id
      ) {
        return { ok: false, conflict: true, reason: 'version_conflict' } as const;
      }

      const versionNo = Number(
        (this.stmt(SQL.nextVersionNo).get(input.objectId) as { next_version_no: number }).next_version_no,
      );

      const normalized = normalizePutInput(input, txTime);
      const refs = extractRefs(input.objectType, input.contentStruct);
      const refsHash = hashRefs(refs);

      const versionId = randomUUID();
      const resolvedRefs = refs.map((ref) => ({ ...ref, resolved: this.objectExists(ref.targetObjectId) }));

      const objectHash = hashObject({
        objectId: input.objectId,
        versionNo,
        contentStructHash: normalized.contentStructHash,
        fileBytesHash: normalized.fileBytesHash,
        metadataHash: normalized.metadataHash,
        refsHash,
      });

      const insert = this.stmt(SQL.insertVersion).run(
        versionId,
        input.objectId,
        versionNo,
        normalized.txTime,
        input.writerId,
        input.writerKind,
        input.writeReason,
        normalized.contentStructJson,
        normalized.fileBytesBlob,
        input.path ?? null,
        input.sessionId ?? null,
        input.toolName ?? null,
        input.status ?? null,
        normalized.charCount,
        normalized.metadataJson,
        normalized.contentStructHash,
        normalized.fileBytesHash,
        normalized.metadataHash,
        refsHash,
        objectHash,
      ) as { lastInsertRowid: number | bigint };

      const txSeq = Number(insert.lastInsertRowid);

      this.stmt(SQL.updateObjectHead).run(
        versionId,
        txSeq,
        normalized.txTime,
        txSeq,
        normalized.txTime,
        input.objectId,
      );

      const insertRef = this.stmt(SQL.insertRef);
      for (const ref of resolvedRefs) {
        insertRef.run(
          randomUUID(),
          versionId,
          ref.fromPath,
          ref.targetObjectId,
          ref.targetVersionId,
          ref.targetObjectHash,
          ref.refKind,
          ref.mode,
          ref.resolved ? 1 : 0,
          ref.refMetadataJson,
        );
      }

      this.stmt(SQL.insertIdempotency).run(
        input.requestId,
        input.objectId,
        versionId,
        normalized.contentStructHash,
        normalized.fileBytesHash,
        txSeq,
        normalized.txTime,
      );

      const record = this.fetchVersion(versionId);
      if (!record) throw new Error(`missing_inserted_version:${versionId}`);
      return { ok: true, record, idempotentReplay: false } as const;
    });
  }

  async getLatest(objectId: string): Promise<VersionRecord | null> {
    const row = this.stmt(SQL.latestByObject).get(objectId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  async getHistory(objectId: string, order: 'asc' | 'desc' = 'desc'): Promise<VersionRecord[]> {
    const rows = this.stmt(order === 'asc' ? SQL.historyAsc : SQL.historyDesc).all(objectId) as VersionRow[];
    return rows.map(mapVersion);
  }

  async queryReferences(params: {
    fromVersionId?: string;
    fromPathPrefix?: string;
    targetObjectId?: string;
    targetVersionId?: string;
    targetObjectHash?: string;
    mode?: ReferenceMode;
    resolved?: boolean;
    limit?: number;
  }): Promise<ReferenceRecord[]> {
    const where: string[] = [];
    const args: SqlArg[] = [];

    if (params.fromVersionId !== undefined) {
      where.push('from_version_id = ?');
      args.push(params.fromVersionId);
    }
    if (params.fromPathPrefix !== undefined) {
      where.push(`from_path LIKE ? ESCAPE '\\'`);
      args.push(`${escapeLike(params.fromPathPrefix)}%`);
    }
    if (params.targetObjectId !== undefined) {
      where.push('target_object_id = ?');
      args.push(params.targetObjectId);
    }
    if (params.targetVersionId !== undefined) {
      where.push('target_version_id = ?');
      args.push(params.targetVersionId);
    }
    if (params.targetObjectHash !== undefined) {
      where.push('target_object_hash = ?');
      args.push(params.targetObjectHash);
    }
    if (params.mode !== undefined) {
      where.push('mode = ?');
      args.push(params.mode);
    }
    if (params.resolved !== undefined) {
      where.push('resolved = ?');
      args.push(params.resolved ? 1 : 0);
    }

    let sql = 'SELECT * FROM doc_references';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY from_version_id ASC, from_path ASC, ref_id ASC';

    if (params.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(normalizeLimit(params.limit));
    }

    const rows = this.db.prepare(sql).all(...args) as RefRow[];
    return rows.map(mapRef);
  }

  async getReferrersByTargetVersion(
    targetVersionId: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]> {
    return this.queryReferences({
      targetVersionId,
      mode: params?.mode,
      resolved: params?.resolved,
      limit: params?.limit,
    });
  }

  async getReferrersByTargetHash(
    targetObjectHash: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]> {
    return this.queryReferences({
      targetObjectHash,
      mode: params?.mode,
      resolved: params?.resolved,
      limit: params?.limit,
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // no-op
      }
      throw error;
    }
  }

  private stmt(sql: string): Prepared {
    let prepared = this.cache.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.cache.set(sql, prepared);
    }
    return prepared;
  }

  private fetchVersion(versionId: string): VersionRecord | null {
    const row = this.stmt(SQL.versionById).get(versionId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  private objectExists(objectId: string): boolean {
    return Boolean((this.stmt(SQL.objectExists).get(objectId) as { ok: number } | undefined)?.ok);
  }
}

function isInvalidSessionIdentity(input: VersionWriteInput): boolean {
  if (input.objectType !== 'session') return false;
  return typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0;
}

function computeIdempotencyFingerprint(input: VersionWriteInput): {
  contentStructHash: string;
  fileBytesHash: string | null;
} {
  const contentStructJson = canonicalJson(input.contentStruct, 'contentStruct');
  const fileBytesBlob = input.fileBytes == null ? null : Buffer.from(input.fileBytes);

  return {
    contentStructHash: sha256(contentStructJson),
    fileBytesHash: fileBytesBlob ? sha256(fileBytesBlob) : null,
  };
}

function normalizePutInput(input: VersionWriteInput, txTime: string): {
  txTime: string;
  charCount: number | null;
  contentStructJson: string;
  metadataJson: string;
  fileBytesBlob: Uint8Array | null;
  contentStructHash: string;
  fileBytesHash: string | null;
  metadataHash: string;
} {
  ensureString(input.requestId, 'requestId', true);
  ensureString(input.objectId, 'objectId', true);
  ensureString(input.writerId, 'writerId', true);
  ensureString(input.path, 'path');
  ensureString(input.sessionId, 'sessionId');
  ensureString(input.toolName, 'toolName');
  ensureString(input.status, 'status');

  validateEnvelopeConsistency(input.contentStruct, {
    path: input.path,
    sessionId: input.sessionId,
    toolName: input.toolName,
    status: input.status,
    charCount: input.charCount,
  });

  const charCount = normalizeCharCount(input.charCount);
  const contentStructJson = canonicalJson(input.contentStruct, 'contentStruct');
  const metadataJson = canonicalJson(input.metadata, 'metadata');
  const fileBytesBlob = input.fileBytes == null ? null : Buffer.from(input.fileBytes);

  return {
    txTime,
    charCount,
    contentStructJson,
    metadataJson,
    fileBytesBlob,
    contentStructHash: sha256(contentStructJson),
    fileBytesHash: fileBytesBlob ? sha256(fileBytesBlob) : null,
    metadataHash: sha256(metadataJson),
  };
}

function validateEnvelopeConsistency(
  contentStruct: unknown,
  envelope: {
    path?: string | null;
    sessionId?: string | null;
    toolName?: string | null;
    status?: string | null;
    charCount?: number | null;
  },
): void {
  if (!isRecord(contentStruct)) return;

  const checks: Array<[unknown, unknown, string]> = [
    [contentStruct.path, envelope.path, 'path'],
    [contentStruct.session_id, envelope.sessionId, 'session_id'],
    [contentStruct.tool_name, envelope.toolName, 'tool_name'],
    [contentStruct.status, envelope.status, 'status'],
    [contentStruct.char_count, envelope.charCount, 'char_count'],
  ];

  for (const [payload, typed, key] of checks) {
    if (payload === undefined || typed === undefined) continue;
    if (payload !== typed) throw new Error(`typed_envelope_mismatch:${key}`);
  }
}

function extractRefs(objectType: ObjectType, contentStruct: unknown): RefDraft[] {
  if (objectType !== 'session') return [];

  const payload = asRecord(contentStruct, 'contentStruct');
  const refs: RefDraft[] = [parseRef(payload.chat_ref, '/chat_ref')];

  if (payload.system_prompt_ref !== undefined && payload.system_prompt_ref !== null) {
    refs.push(parseRef(payload.system_prompt_ref, '/system_prompt_ref'));
  }

  refs.push(...parseRefArray(payload.active_set, '/active_set'));
  refs.push(...parseRefArray(payload.inactive_set, '/inactive_set'));
  refs.push(...parseRefArray(payload.pinned_set, '/pinned_set'));
  return refs;
}

function parseRefArray(value: unknown, path: string): RefDraft[] {
  if (!Array.isArray(value)) throw new Error(`expected_ref_array:${path}`);
  return value.map((entry, index) => parseRef(entry, `${path}/${index}`));
}

function parseRef(value: unknown, path: string): RefDraft {
  const ref = asRecord(value, path);
  const mode = asMode(ref.mode, `${path}.mode`);
  const targetVersionId = asNullableString(ref.target_version_id, `${path}.target_version_id`);
  const targetObjectHash = asNullableString(ref.target_object_hash, `${path}.target_object_hash`);

  if (mode === 'pinned' && !targetVersionId && !targetObjectHash) {
    throw new Error(`Invalid pinned Ref at ${path}: target_version_id or target_object_hash required`);
  }

  return {
    fromPath: path,
    targetObjectId: ensureString(ref.target_object_id, `${path}.target_object_id`, true),
    targetVersionId,
    targetObjectHash,
    refKind: ensureString(ref.ref_kind, `${path}.ref_kind`, true),
    mode,
    refMetadataJson:
      ref.ref_metadata === undefined ? null : canonicalJson(asRecord(ref.ref_metadata, `${path}.ref_metadata`), `${path}.ref_metadata`),
  };
}

function hashRefs(refs: RefDraft[]): string {
  const sorted = [...refs].sort((a, b) => {
    const left = [a.fromPath, a.refKind, a.targetObjectId, a.targetVersionId ?? '', a.targetObjectHash ?? '', a.mode];
    const right = [b.fromPath, b.refKind, b.targetObjectId, b.targetVersionId ?? '', b.targetObjectHash ?? '', b.mode];

    for (let i = 0; i < left.length; i++) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  });

  return sha256(
    canonicalJson(
      sorted.map((ref) => ({
        from_path: ref.fromPath,
        ref_kind: ref.refKind,
        target_object_id: ref.targetObjectId,
        target_version_id: ref.targetVersionId,
        target_object_hash: ref.targetObjectHash,
        mode: ref.mode,
      })),
      'refs',
    ),
  );
}

function hashObject(parts: {
  objectId: string;
  versionNo: number;
  contentStructHash: string;
  fileBytesHash: string | null;
  metadataHash: string;
  refsHash: string;
}): string {
  return sha256(
    [
      'v1',
      parts.objectId,
      String(parts.versionNo),
      parts.contentStructHash,
      parts.fileBytesHash ?? '',
      parts.metadataHash,
      parts.refsHash,
    ].join('|'),
  );
}

function mapVersion(row: VersionRow): VersionRecord {
  return {
    txSeq: Number(row.tx_seq),
    versionId: row.version_id,
    objectId: row.object_id,
    versionNo: Number(row.version_no),
    txTime: row.tx_time,
    writerId: row.writer_id,
    writerKind: row.writer_kind,
    writeReason: row.write_reason,
    contentStructJson: row.content_struct_json,
    fileBytesHash: row.file_bytes_hash,
    path: row.path,
    sessionId: row.session_id,
    toolName: row.tool_name,
    status: row.status,
    charCount: row.char_count,
    metadataJson: row.metadata_json,
    contentStructHash: row.content_struct_hash,
    metadataHash: row.metadata_hash,
    refsHash: row.refs_hash,
    objectHash: row.object_hash,
  };
}

function mapRef(row: RefRow): ReferenceRecord {
  return {
    refId: row.ref_id,
    fromVersionId: row.from_version_id,
    fromPath: row.from_path,
    targetObjectId: row.target_object_id,
    targetVersionId: row.target_version_id ?? undefined,
    targetObjectHash: row.target_object_hash ?? undefined,
    refKind: row.ref_kind,
    mode: row.mode,
    resolved: row.resolved === 1,
    refMetadataJson: row.ref_metadata_json ?? undefined,
  };
}

function normalizeCharCount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_char_count:${value}`);
  return value;
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid_limit:${value}`);
  return value;
}

function asMode(value: unknown, path: string): ReferenceMode {
  if (value !== 'dynamic' && value !== 'pinned') throw new Error(`invalid_ref_mode:${path}`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`invalid_string:${path}`);
  return value;
}

function ensureString(value: unknown, path: string, nonEmpty = false): string {
  if (value === undefined || value === null) {
    if (nonEmpty) throw new Error(`invalid_non_empty_string:${path}`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`invalid_string:${path}`);
  if (nonEmpty && value.length === 0) throw new Error(`invalid_non_empty_string:${path}`);
  return value;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid_object:${path}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown, label: string): string {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    throw new Error(`non_json_serializable:${label}`);
  }
  if (raw === undefined) throw new Error(`non_json_serializable:${label}`);
  return stableJson(JSON.parse(raw) as JsonValue);
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
