import { readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { contentHash, metadataViewHash, objectHash } from './hashing.js';
import type { FileObject } from './types.js';
import type { HarnessMessage, LlmMessage, ContentPart } from './context-manager.js';
import { XtdbClient } from './xtdb-client.js';

type MetadataEntry = {
  id: string;
  type: 'file' | 'toolcall';
  status?: 'ok' | 'fail';
  path?: string | null;
  file_type?: string;
  char_count?: number;
  tool?: string;
};

type ObjectState = { id: string; type: 'file' | 'toolcall' | 'chat' | 'system_prompt'; content: string | null; locked: boolean };

export class PiMemoryPhase3Extension {
  private readonly xtdb: XtdbClient;
  private readonly objects = new Map<string, ObjectState>();
  private readonly metadataPool: MetadataEntry[] = [];
  private readonly metadataSeen = new Set<string>();
  private readonly activeSet = new Set<string>();
  private readonly chatLog: HarnessMessage[] = [];
  private cursor = 0;
  private lastMessagesRef: HarnessMessage[] | null = null;

  readonly sessionObjectId: string;
  readonly chatObjectId: string;
  readonly systemPromptObjectId: string;

  constructor(
    private readonly options: { sessionId: string; workspaceRoot?: string; systemPrompt?: string; xtdbBaseUrl?: string },
  ) {
    this.xtdb = new XtdbClient(options.xtdbBaseUrl ?? 'http://172.17.0.1:3000');
    this.sessionObjectId = `session:${options.sessionId}`;
    this.chatObjectId = `chat:${options.sessionId}`;
    this.systemPromptObjectId = `system_prompt:${options.sessionId}`;
    this.objects.set(this.chatObjectId, { id: this.chatObjectId, type: 'chat', content: '', locked: true });
    this.objects.set(this.systemPromptObjectId, {
      id: this.systemPromptObjectId,
      type: 'system_prompt',
      content: options.systemPrompt ?? '',
      locked: true,
    });
  }

  async load(): Promise<void> {
    await this.xtdb.putAndWait({ 'xt/id': this.systemPromptObjectId, type: 'system_prompt', content: this.options.systemPrompt ?? '', locked: true });
    await this.xtdb.putAndWait({ 'xt/id': this.chatObjectId, type: 'chat', content: '', locked: true, session_ref: this.sessionObjectId, turn_count: 0 });
    await this.xtdb.putAndWait({ 'xt/id': this.sessionObjectId, type: 'session', chat_ref: this.chatObjectId, session_id: this.options.sessionId });
    this.activeSet.add(this.chatObjectId);
  }

  async transformContext(messages: HarnessMessage[]): Promise<LlmMessage[]> {
    this.consumeMessages(messages);
    return this.assembleContext();
  }

  private consumeMessages(messages: HarnessMessage[]): void {
    if (this.lastMessagesRef && (messages !== this.lastMessagesRef || messages.length < this.cursor)) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      return;
    }

    for (const message of messages.slice(this.cursor)) {
      this.chatLog.push(message);
      if (message.role === 'toolResult') {
        const content = this.extractText(message.content);
        const toolcall: ObjectState = {
          id: message.toolCallId,
          type: 'toolcall',
          content,
          locked: false,
        };
        this.objects.set(toolcall.id, toolcall);
        if (!this.metadataSeen.has(toolcall.id)) {
          this.metadataSeen.add(toolcall.id);
          this.metadataPool.push({
            id: toolcall.id,
            type: 'toolcall',
            status: message.isError ? 'fail' : 'ok',
            tool: message.toolName,
          });
        }
        this.activeSet.add(toolcall.id);
      }
    }

    this.cursor = messages.length;
    this.lastMessagesRef = messages;
  }

  async read(path: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const absolutePath = this.resolvePath(path);
    const content = await readFile(absolutePath, 'utf8');
    const id = `file:${absolutePath}`;
    const file = this.buildFileObject(id, absolutePath, content);
    await this.xtdb.putAndWait(file);

    this.objects.set(id, { id, type: 'file', content, locked: false });
    if (!this.metadataSeen.has(id)) {
      this.metadataSeen.add(id);
      this.metadataPool.push({ id, type: 'file', path: absolutePath, file_type: file.file_type, char_count: file.char_count });
    }
    this.activeSet.add(id);
    return { ok: true, message: `read ok id=${id}`, id };
  }

  activate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.content === null) return { ok: false, message: 'Content unavailable (non-text file)' };
    this.activeSet.add(id);
    return { ok: true, message: `activated ${id}` };
  }

  deactivate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.locked) return { ok: false, message: `Object is locked: ${id}` };
    this.activeSet.delete(id);
    return { ok: true, message: `deactivated ${id}` };
  }

  async wrappedWrite(path: string, content: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await writeFile(absolutePath, content, 'utf8');
    await this.indexFileFromDisk(absolutePath);
  }

  async wrappedEdit(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await this.indexFileFromDisk(absolutePath);
  }

  async wrappedLs(output: string): Promise<void> {
    await this.indexDiscoveredPaths(this.extractPathsFromList(output));
  }

  async wrappedFind(output: string): Promise<void> {
    await this.indexDiscoveredPaths(this.extractPathsFromList(output));
  }

  async wrappedGrep(output: string): Promise<void> {
    const paths = output
      .split('\n')
      .map((line) => line.split(':')[0]?.trim())
      .filter((line): line is string => Boolean(line));
    await this.indexDiscoveredPaths(paths);
  }

  async observeToolExecutionEnd(toolName: string, commandOrOutput: string): Promise<void> {
    if (toolName !== 'bash') return;
    const tokens = commandOrOutput.split(/\s+/).filter(Boolean);
    const guessed = tokens.filter((t) => t.includes('/') || t.includes('.'));
    await this.indexDiscoveredPaths(guessed);
  }

  private async indexFileFromDisk(absolutePath: string): Promise<void> {
    const content = await readFile(absolutePath, 'utf8');
    const id = `file:${absolutePath}`;
    const file = this.buildFileObject(id, absolutePath, content);
    await this.xtdb.putAndWait(file);
    this.objects.set(id, { id, type: 'file', content, locked: false });
    if (!this.metadataSeen.has(id)) {
      this.metadataSeen.add(id);
      this.metadataPool.push({ id, type: 'file', path: absolutePath, file_type: file.file_type, char_count: file.char_count });
    }
  }

  private async indexDiscoveredPaths(paths: string[]): Promise<void> {
    for (const rawPath of paths) {
      const absolutePath = this.resolvePath(rawPath);
      const id = `file:${absolutePath}`;
      if (this.metadataSeen.has(id)) continue;
      const fileType = this.fileTypeFromPath(absolutePath);
      const file: FileObject = {
        id,
        type: 'file',
        content: null,
        path: absolutePath,
        file_type: fileType,
        char_count: 0,
        locked: false,
        provenance: { origin: absolutePath, generator: 'tool' },
        content_hash: contentHash(null),
        metadata_view_hash: '',
        object_hash: '',
      };
      file.metadata_view_hash = metadataViewHash(file);
      file.object_hash = objectHash(file);
      await this.xtdb.putAndWait(file);
      this.objects.set(id, { id, type: 'file', content: null, locked: false });
      this.metadataSeen.add(id);
      this.metadataPool.push({ id, type: 'file', path: absolutePath, file_type: fileType, char_count: 0 });
    }
  }

  private buildFileObject(id: string, absolutePath: string, content: string): FileObject {
    const file: FileObject = {
      id,
      type: 'file',
      content,
      path: absolutePath,
      file_type: this.fileTypeFromPath(absolutePath),
      char_count: content.length,
      locked: false,
      provenance: { origin: absolutePath, generator: 'tool' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
    };
    file.content_hash = contentHash(file.content);
    file.metadata_view_hash = metadataViewHash(file);
    file.object_hash = objectHash(file);
    return file;
  }

  private assembleContext(): LlmMessage[] {
    const messages: LlmMessage[] = [{ role: 'system', content: this.options.systemPrompt ?? '' }];
    messages.push({ role: 'user', content: this.renderMetadataPool() });

    for (const msg of this.chatLog) {
      if (msg.role === 'toolResult') {
        messages.push({
          role: 'toolResult',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          content: [{ type: 'text', text: `toolcall_ref id=${msg.toolCallId} tool=${msg.toolName} status=${msg.isError ? 'fail' : 'ok'}` }],
          isError: msg.isError,
          timestamp: msg.timestamp,
        });
        continue;
      }
      if (msg.role === 'assistant') {
        messages.push(msg);
      } else {
        messages.push({ role: 'user', content: this.extractText(msg.content) });
      }
    }

    for (const id of this.activeSet) {
      if (id === this.chatObjectId || id === this.systemPromptObjectId) continue;
      const object = this.objects.get(id);
      if (!object || object.content === null) continue;
      messages.push({ role: 'user', content: `ACTIVE_CONTENT id=${id}\n${object.content}` });
    }

    return messages;
  }

  private renderMetadataPool(): string {
    const lines = ['METADATA_POOL'];
    for (const entry of this.metadataPool) {
      if (entry.type === 'toolcall') {
        lines.push(`- id=${entry.id} type=toolcall tool=${entry.tool} status=${entry.status}`);
      } else {
        lines.push(`- id=${entry.id} type=file path=${entry.path} file_type=${entry.file_type} char_count=${entry.char_count}`);
      }
    }
    return lines.join('\n');
  }

  private resolvePath(path: string): string {
    if (isAbsolute(path)) return path;
    return resolve(this.options.workspaceRoot ?? process.cwd(), path);
  }

  private fileTypeFromPath(path: string): string {
    const ext = extname(path).toLowerCase();
    if (!ext) return 'text';
    return ext.slice(1);
  }

  private extractPathsFromList(output: string): string[] {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private extractText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    return content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n');
  }

  async getXtEntity(id: string): Promise<Record<string, unknown> | null> {
    return this.xtdb.get(id);
  }

  getSnapshot() {
    return {
      metadataPool: [...this.metadataPool],
      activeSet: new Set(this.activeSet),
    };
  }
}
