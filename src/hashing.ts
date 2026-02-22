import { createHash } from 'node:crypto';
import type { MemoryObject } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeContentHash(content: string | null): string {
  return sha256(content ?? '');
}

export function metadataViewString(obj: MemoryObject): string {
  switch (obj.type) {
    case 'file':
      return [obj.id, obj.type, obj.path ?? '', obj.file_type, String(obj.char_count), obj.nickname ?? ''].join('|');
    case 'toolcall':
      return [obj.id, obj.type, obj.tool, obj.args_display ?? stableStringify(obj.args), obj.status].join('|');
    case 'chat':
      return [obj.id, obj.type, typeof obj.session_ref === 'string' ? obj.session_ref : obj.session_ref.id, String(obj.turn_count)].join('|');
    case 'session':
      return [obj.id, obj.type, obj.harness, obj.session_id].join('|');
  }
}

export function computeMetadataViewHash(obj: MemoryObject): string {
  return sha256(metadataViewString(obj));
}

export function computeObjectHash<T extends Record<string, unknown>>(obj: T): string {
  const clone = { ...obj };
  delete clone.content_hash;
  delete clone.metadata_view_hash;
  delete clone.object_hash;
  delete clone.created_at;
  delete clone.updated_at;
  return sha256(stableStringify(clone));
}
