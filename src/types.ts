export type ObjectType = 'file' | 'toolcall' | 'chat' | 'session' | 'system_prompt';

export type DynamicRef = string;

export interface StaticRef {
  id: string;
  timestamp: string;
  content_hash: string;
  metadata_view_hash: string;
  object_hash: string;
}

export type Ref = DynamicRef | StaticRef;

export interface Provenance {
  origin: string;
  generator: 'human' | 'agent' | 'tool' | 'system';
  parent_refs?: Ref[];
}

export interface BaseObject {
  id: string;
  type: ObjectType;
  nickname?: string;
  content: string | null;
  locked: boolean;
  provenance: Provenance;
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
  chat_ref: Ref;
  file_refs?: Ref[];
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
  session_ref: Ref;
  turn_count: number;
  toolcall_refs: Ref[];
}

export interface SessionObject extends BaseObject {
  type: 'session';
  harness: string;
  session_id: string;
  chat_ref: Ref;
  active_set: string[];
  inactive_set: string[];
  pinned_set: string[];
}

export type MemoryObject = FileObject | ToolcallObject | ChatObject | SessionObject;
