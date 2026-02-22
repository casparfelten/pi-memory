import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
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
  mtime_ms?: number;
};

type ObjectState = { id: string; type: 'file' | 'toolcall' | 'chat' | 'system_prompt'; content: string | null; locked: boolean };

type SessionStateDoc = {
  [k: string]: unknown;
  active_set?: string[];
  inactive_set?: string[];
  pinned_set?: string[];
  metadata_pool?: MetadataEntry[];
};

export class PiMemoryPhase3Extension {
  private readonly xtdb: XtdbClient;
  private readonly objects = new Map<string, ObjectState>();
  private readonly metadataPool: MetadataEntry[] = [];
  private readonly metadataSeen = new Set<string>();
  private readonly activeSet = new Set<string>();
  private readonly pinnedSet = new Set<string>();
  private readonly chatLog: HarnessMessage[] = [];
  private readonly watcher: FSWatcher;
  private readonly watchedPathToId = new Map<string, string>();
  private readonly recentUnlinks: Array<{ id: string; ts: number }> = [];
  private cursor = 0;
  private lastMessagesRef: HarnessMessage[] | null = null;
  private lastCursorSignature: string | null = null;
  private persistChain: Promise<void> = Promise.resolve();

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

    this.watcher = chokidar.watch([], { ignoreInitial: true, persistent: false });
    this.watcher.on('change', (path) => void this.handleWatcherUpsert(path));
    this.watcher.on('add', (path) => void this.handleWatcherUpsert(path));
    this.watcher.on('unlink', (path) => void this.handleWatcherUnlink(path));
  }

  async load(): Promise<void> {
    const existing = (await this.xtdb.get(this.sessionObjectId)) as SessionStateDoc | null;

    await this.xtdb.putAndWait({ 'xt/id': this.systemPromptObjectId, type: 'system_prompt', content: this.options.systemPrompt ?? '', locked: true });
    await this.xtdb.putAndWait({ 'xt/id': this.chatObjectId, type: 'chat', content: '', locked: true, session_ref: this.sessionObjectId, turn_count: 0 });

    if (!existing) {
      this.activeSet.add(this.chatObjectId);
      await this.persistSessionState();
      return;
    }

    for (const entry of existing.metadata_pool ?? []) {
      this.metadataSeen.add(entry.id);
      this.metadataPool.push(entry);
      if (entry.type === 'file' && entry.path) {
        this.watchedPathToId.set(entry.path, entry.id);
        await this.watcher.add(entry.path);
      }
    }

    for (const id of existing.pinned_set ?? []) this.pinnedSet.add(id);
    for (const id of existing.active_set ?? []) this.activeSet.add(id);

    for (const id of this.activeSet) {
      if (id === this.chatObjectId || id === this.systemPromptObjectId) continue;
      const entity = await this.xtdb.get(id);
      if (!entity) continue;
      this.objects.set(id, {
        id,
        type: (entity.type as ObjectState['type']) ?? 'file',
        content: (entity.content as string | null | undefined) ?? null,
        locked: Boolean(entity.locked),
      });
    }

    await this.reconcileKnownFilesAfterResume();
  }

  async transformContext(messages: HarnessMessage[]): Promise<LlmMessage[]> {
    this.consumeMessages(messages);
    return this.assembleContext();
  }

  private consumeMessages(messages: HarnessMessage[]): void {
    if (this.lastMessagesRef && messages !== this.lastMessagesRef) {
      const canContinue = this.cursor === 0 || (messages.length >= this.cursor && this.lastCursorSignature === this.signature(messages[this.cursor - 1]));
      if (!canContinue) {
        this.cursor = messages.length;
        this.lastMessagesRef = messages;
        this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
        return;
      }
    }
    if (messages.length < this.cursor) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
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
    this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
    this.enqueuePersist();
  }

  async read(path: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const absolutePath = this.resolvePath(path);
    const id = `file:${absolutePath}`;
    await this.indexFileFromDisk(absolutePath, id);
    this.activeSet.add(id);
    this.enqueuePersist();
    return { ok: true, message: `read ok id=${id}`, id };
  }

  activate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.content === null) return { ok: false, message: 'Content unavailable (non-text file)' };
    this.activeSet.add(id);
    this.enqueuePersist();
    return { ok: true, message: `activated ${id}` };
  }

  deactivate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.locked) return { ok: false, message: `Object is locked: ${id}` };
    this.activeSet.delete(id);
    this.enqueuePersist();
    return { ok: true, message: `deactivated ${id}` };
  }

  async wrappedWrite(path: string, content: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await writeFile(absolutePath, content, 'utf8');
    await this.indexFileFromDisk(absolutePath, `file:${absolutePath}`);
  }

  async wrappedEdit(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await this.indexFileFromDisk(absolutePath, `file:${absolutePath}`);
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

  private async indexFileFromDisk(absolutePath: string, id: string): Promise<void> {
    const content = await readFile(absolutePath, 'utf8');
    const file = this.buildFileObject(id, absolutePath, content);
    await this.xtdb.putAndWait(file);
    this.objects.set(id, { id, type: 'file', content, locked: false });

    const fileStat = await stat(absolutePath);
    const existing = this.metadataPool.find((m) => m.id === id);
    if (existing) {
      existing.path = absolutePath;
      existing.file_type = file.file_type;
      existing.char_count = file.char_count;
      existing.mtime_ms = fileStat.mtimeMs;
    } else {
      this.metadataSeen.add(id);
      this.metadataPool.push({ id, type: 'file', path: absolutePath, file_type: file.file_type, char_count: file.char_count, mtime_ms: fileStat.mtimeMs });
    }

    this.watchedPathToId.set(absolutePath, id);
    await this.watcher.add(absolutePath);
    this.enqueuePersist();
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
      this.watchedPathToId.set(absolutePath, id);
      await this.watcher.add(absolutePath);
    }
    this.enqueuePersist();
  }

  private buildFileObject(id: string, absolutePath: string | null, content: string | null): FileObject {
    const file: FileObject = {
      id,
      type: 'file',
      content,
      path: absolutePath,
      file_type: this.fileTypeFromPath(absolutePath ?? id),
      char_count: content?.length ?? 0,
      locked: false,
      provenance: { origin: absolutePath ?? 'deleted', generator: 'tool' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
    };
    file.content_hash = contentHash(file.content);
    file.metadata_view_hash = metadataViewHash(file);
    file.object_hash = objectHash(file);
    return file;
  }

  private async handleWatcherUpsert(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    let id = this.watchedPathToId.get(absolutePath);
    if (!id) {
      const candidate = this.recentUnlinks.find((u) => Date.now() - u.ts < 2000);
      if (!candidate) return;
      id = candidate.id;
    }
    await this.indexFileFromDisk(absolutePath, id);
  }

  private async handleWatcherUnlink(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    const id = this.watchedPathToId.get(absolutePath);
    if (!id) return;

    const tombstone = this.buildFileObject(id, null, null);
    await this.xtdb.putAndWait(tombstone);

    const existing = this.metadataPool.find((m) => m.id === id);
    if (existing) {
      existing.path = null;
      existing.char_count = 0;
      existing.mtime_ms = undefined;
    }
    this.objects.set(id, { id, type: 'file', content: null, locked: false });
    this.activeSet.delete(id);
    this.watchedPathToId.delete(absolutePath);
    this.recentUnlinks.push({ id, ts: Date.now() });
    while (this.recentUnlinks.length > 20) this.recentUnlinks.shift();
    this.enqueuePersist();
  }

  private async reconcileKnownFilesAfterResume(): Promise<void> {
    for (const entry of this.metadataPool) {
      if (entry.type !== 'file' || !entry.path) continue;
      try {
        const s = await stat(entry.path);
        if (!entry.mtime_ms || s.mtimeMs > entry.mtime_ms + 1) {
          await this.indexFileFromDisk(entry.path, entry.id);
        }
      } catch {
        await this.handleWatcherUnlink(entry.path);
      }
    }
  }

  private enqueuePersist(): void {
    this.persistChain = this.persistChain.then(() => this.persistSessionState()).catch(() => undefined);
  }

  private async persistSessionState(): Promise<void> {
    const metadataIds = new Set(this.metadataPool.map((m) => m.id));
    const inactiveSet = [...metadataIds].filter((id) => !this.activeSet.has(id));
    await this.xtdb.putAndWait({
      'xt/id': this.sessionObjectId,
      type: 'session',
      chat_ref: this.chatObjectId,
      session_id: this.options.sessionId,
      active_set: [...this.activeSet],
      inactive_set: inactiveSet,
      pinned_set: [...this.pinnedSet],
      metadata_pool: this.metadataPool,
    });
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

  private signature(message: HarnessMessage): string {
    if (message.role === 'toolResult') return `tool:${message.toolCallId}:${message.timestamp}`;
    return `${message.role}:${message.timestamp}:${this.extractText(message.content)}`;
  }

  async getXtEntity(id: string): Promise<Record<string, unknown> | null> {
    return this.xtdb.get(id);
  }

  async close(): Promise<void> {
    await this.persistChain;
    await this.watcher.close();
  }

  getSnapshot() {
    return {
      metadataPool: [...this.metadataPool],
      activeSet: new Set(this.activeSet),
      pinnedSet: new Set(this.pinnedSet),
    };
  }
}
