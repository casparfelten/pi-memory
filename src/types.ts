export type ObjectType = 'file' | 'toolcall' | 'chat' | 'session';

export interface Provenance {
  origin: string;
  generator: 'human' | 'agent' | 'tool' | 'system';
  parent_refs?: string[];
}

export interface BaseObject {
  id: string;
  type: ObjectType;
  content: string | null;
  locked: boolean;
  provenance: Provenance;
  nickname?: string;
  content_hash: string;
  metadata_view_hash: string;
  object_hash: string;
}

export interface FileObject extends BaseObject {
  type: 'file';
  path: string | null;
  file_type: string;
  char_count: number;
}

export interface ToolcallObject extends BaseObject {
  type: 'toolcall';
  tool: string;
  args: Record<string, unknown>;
  args_display?: string;
  status: 'ok' | 'fail';
  chat_ref: string;
  file_refs?: string[];
}

export interface AssistantMeta {
  api: string;
  provider: string;
  model: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  timestamp: number;
}

export interface Turn {
  user: string | Array<Record<string, unknown>>;
  assistant: Array<Record<string, unknown>>;
  toolcall_ids: string[];
  assistant_meta: AssistantMeta;
}

export interface ChatObject extends BaseObject {
  type: 'chat';
  locked: true;
  turns: Turn[];
  session_ref: string;
  turn_count: number;
  toolcall_refs: string[];
}

export interface SessionObject extends BaseObject {
  type: 'session';
  harness: string;
  session_id: string;
  chat_ref: string;
  active_set: string[];
  inactive_set: string[];
  pinned_set: string[];
}

export type MemoryObject = FileObject | ToolcallObject | ChatObject | SessionObject;
