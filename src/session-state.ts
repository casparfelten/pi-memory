import { computeContentHash, computeMetadataViewHash, computeObjectHash } from './hashing.js';
import type { SessionObject } from './types.js';

export const sessionObjectId = (sessionId: string): string => `session-${sessionId}`;

export function buildSessionObject(input: {
  sessionId: string;
  chatObjectId: string;
  activeSet: string[];
  inactiveSet: string[];
  pinnedSet: string[];
  objectIds: string[];
}): SessionObject {
  const doc: SessionObject = {
    id: sessionObjectId(input.sessionId),
    type: 'session',
    content: 'session-state',
    locked: true,
    provenance: { origin: input.sessionId, generator: 'system' },
    content_hash: '',
    metadata_view_hash: '',
    object_hash: '',
    harness: 'pi-coding-agent',
    session_id: input.sessionId,
    chat_ref: input.chatObjectId,
    active_set: [...input.activeSet],
    inactive_set: [...input.inactiveSet],
    pinned_set: [...input.pinnedSet],
    object_ids: [...input.objectIds],
  };

  doc.content_hash = computeContentHash(doc.content);
  doc.metadata_view_hash = computeMetadataViewHash(doc);
  doc.object_hash = computeObjectHash(doc);
  return doc;
}
