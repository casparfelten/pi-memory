export type ObjectType = 'file' | 'toolcall' | 'chat' | 'session' | 'system_prompt';
export type WriterKind = 'client' | 'watcher' | 'system';
export type WriteReason = 'manual' | 'watcher_sync' | 'import' | 'system';
export type ReferenceMode = 'dynamic' | 'pinned';

export interface VersionWriteInput {
  requestId: string;

  objectId: string;
  objectType: ObjectType;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStruct: unknown;
  fileBytes?: Uint8Array | null;

  path?: string | null;
  // required and non-empty when objectType='session'
  sessionId?: string | null;
  toolName?: string | null;
  status?: string | null;
  charCount?: number | null;

  metadata: Record<string, unknown>;

  expectedCurrentVersionId?: string;
  txTime?: string;
}

export interface VersionRecord {
  txSeq: number;
  versionId: string;
  objectId: string;
  versionNo: number;

  txTime: string;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStructJson: string;
  fileBytesHash: string | null;

  path: string | null;
  sessionId: string | null;
  toolName: string | null;
  status: string | null;
  charCount: number | null;

  metadataJson: string;

  contentStructHash: string;
  metadataHash: string;
  refsHash: string;
  objectHash: string;
}

export interface ReferenceRecord {
  refId: string;
  fromVersionId: string;
  fromPath: string;

  targetObjectId: string;
  targetVersionId?: string;
  targetObjectHash?: string;

  refKind: string;
  mode: ReferenceMode;
  resolved: boolean;
  refMetadataJson?: string;
}

export interface StoragePort {
  putVersion(input: VersionWriteInput): Promise<
    | { ok: true; record: VersionRecord; idempotentReplay: boolean }
    | { ok: false; validation: true; reason: 'invalid_session_id' }
    | { ok: false; conflict: true; reason: 'version_conflict' | 'idempotency_mismatch' }
  >;

  getLatest(objectId: string): Promise<VersionRecord | null>;
  getHistory(objectId: string, order?: 'asc' | 'desc'): Promise<VersionRecord[]>;

  queryReferences(params: {
    fromVersionId?: string;
    fromPathPrefix?: string;
    targetObjectId?: string;
    targetVersionId?: string;
    targetObjectHash?: string;
    mode?: ReferenceMode;
    resolved?: boolean;
    limit?: number;
  }): Promise<ReferenceRecord[]>;

  getReferrersByTargetVersion(
    targetVersionId: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;

  getReferrersByTargetHash(
    targetObjectHash: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;
}
