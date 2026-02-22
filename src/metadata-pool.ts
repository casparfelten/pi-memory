import type { ChatObject, FileObject, ToolcallObject } from './types.js';

type MetadataEntry = Pick<FileObject, 'id' | 'type' | 'path' | 'file_type' | 'char_count' | 'nickname'>
  | Pick<ToolcallObject, 'id' | 'type' | 'tool' | 'args_display' | 'status'>
  | Pick<ChatObject, 'id' | 'type' | 'session_ref' | 'turn_count'>;

export class MetadataPool {
  private readonly entries: MetadataEntry[] = [];

  add(entry: MetadataEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }

  getAll(): MetadataEntry[] {
    return [...this.entries];
  }

  renderAsText(): string {
    if (this.entries.length === 0) return 'metadata_pool: (empty)';

    const lines = ['metadata_pool:'];
    for (const entry of this.entries) {
      if (entry.type === 'file') {
        lines.push(
          `- file/${entry.id} path=${entry.path ?? 'null'} file_type=${entry.file_type} char_count=${entry.char_count} nickname=${entry.nickname ?? ''}`,
        );
      } else if (entry.type === 'toolcall') {
        lines.push(
          `- toolcall/${entry.id} tool=${entry.tool} args='${entry.args_display ?? ''}' status=${entry.status}`,
        );
      } else {
        lines.push(
          `- chat/${entry.id} session_ref=${typeof entry.session_ref === 'string' ? entry.session_ref : entry.session_ref.id} turn_count=${entry.turn_count}`,
        );
      }
    }
    return lines.join('\n');
  }
}

export type { MetadataEntry };
