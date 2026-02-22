import { createHash } from 'node:crypto';
import type { MemoryObject } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function contentHash(content: string | null): string {
  return sha256(content ?? '');
}

function metadataViewPayload(object: MemoryObject): string {
  switch (object.type) {
    case 'file':
      return [
        object.id,
        object.type,
        object.path ?? '',
        object.file_type,
        String(object.char_count),
        object.nickname ?? '',
      ].join('|');
    case 'toolcall':
      return [
        object.id,
        object.type,
        object.tool,
        object.args_display ?? stableStringify(object.args),
        object.status,
      ].join('|');
    case 'chat':
      return [object.id, object.type, object.session_ref, String(object.turn_count)].join('|');
    case 'session':
      return '';
  }
}

export function metadataViewHash(object: MemoryObject): string {
  return sha256(metadataViewPayload(object));
}

export function objectHash<T extends object>(object: T): string {
  const clone = { ...(object as Record<string, unknown>) };
  delete clone.content_hash;
  delete clone.metadata_view_hash;
  delete clone.object_hash;
  delete clone.created_at;
  delete clone.updated_at;
  return sha256(stableStringify(clone));
}
