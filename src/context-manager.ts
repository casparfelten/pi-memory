import { computeContentHash, computeMetadataViewHash, computeObjectHash } from './hashing.js';
import { ActivePool } from './active-pool.js';
import { ChatPool } from './chat-pool.js';
import { MetadataPool, type MetadataEntry } from './metadata-pool.js';
import type { AgentMessage, Message, ToolResultMessage } from './message-types.js';
import { buildSessionObject, sessionObjectId } from './session-state.js';
import type { ChatObject, MemoryObject, SessionObject, ToolcallObject, Turn } from './types.js';
import { XtdbClient } from './xtdb-client.js';

export class ContextManager {
  private readonly metadataPool = new MetadataPool();
  private readonly chatPool = new ChatPool();
  private readonly activePool = new ActivePool();
  private readonly pinned = new Set<string>();
  private readonly locked = new Set<string>();
  private readonly toolHistory: Array<{ id: string; turnIndex: number }> = [];
  private readonly seenToolcalls = new Set<string>();
  private readonly knownObjectIds = new Set<string>();
  private cursor = 0;
  private lastMessagesRef: AgentMessage[] | null = null;
  private readonly chatObjectId: string;
  private skipToEndOnNextProcess = false;

  constructor(private readonly xtdb: XtdbClient, private readonly sessionId = 'session-1') {
    this.chatObjectId = `chat-${sessionId}`;
    this.locked.add(this.chatObjectId);
    this.locked.add('system_prompt');
    this.knownObjectIds.add(this.chatObjectId);
    this.metadataPool.add({ id: this.chatObjectId, type: 'chat', session_ref: sessionId, turn_count: 0 });
  }

  getMetadataPool(): MetadataPool {
    return this.metadataPool;
  }

  getChatPool(): ChatPool {
    return this.chatPool;
  }

  getActivePool(): ActivePool {
    return this.activePool;
  }

  noteIndexedObject(id: string): void {
    this.knownObjectIds.add(id);
  }

  async processEvents(messages: AgentMessage[]): Promise<void> {
    if (this.skipToEndOnNextProcess) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      this.skipToEndOnNextProcess = false;
      return;
    }

    if (this.lastMessagesRef && (this.lastMessagesRef !== messages || messages.length < this.cursor)) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      return;
    }

    for (let i = this.cursor; i < messages.length; i += 1) {
      const message = messages[i] as Message;
      if (message.role === 'user') {
        this.chatPool.addUserTurn(message.content);
      } else if (message.role === 'assistant') {
        this.chatPool.completeCurrentTurn(message.content, {
          api: message.api,
          provider: message.provider,
          model: message.model,
          usage: message.usage,
          stopReason: message.stopReason,
          timestamp: message.timestamp,
        });
      } else if (message.role === 'toolResult') {
        await this.handleToolResult(message);
      }
    }

    this.cursor = messages.length;
    this.lastMessagesRef = messages;
    await this.saveSessionState();
  }

  async activate(id: string): Promise<string> {
    const object = await this.xtdb.get(id);
    if (!object) return `Object not found: ${id}`;
    const content = object.content;
    if (typeof content !== 'string') return 'Content unavailable (non-text file)';
    this.activePool.activate(id, content);
    this.knownObjectIds.add(id);
    return `Activated ${id}`;
  }

  deactivate(id: string): string {
    if (this.locked.has(id)) return `Cannot deactivate locked object: ${id}`;
    this.activePool.deactivate(id);
    return `Deactivated ${id}`;
  }

  pin(id: string): string {
    this.pinned.add(id);
    return `Pinned ${id}`;
  }

  async saveSessionState(): Promise<void> {
    const activeSet = this.activePool.getIds();
    const known = new Set([...this.knownObjectIds, ...activeSet]);
    const inactiveSet = [...known].filter((id) => !activeSet.includes(id));
    const sessionDoc = buildSessionObject({
      sessionId: this.sessionId,
      chatObjectId: this.chatObjectId,
      activeSet,
      inactiveSet,
      pinnedSet: [...this.pinned],
      objectIds: [...known],
    });
    await this.xtdb.put(sessionDoc);
  }

  async loadSessionState(_sessionId: string): Promise<boolean> {
    const existing = await this.xtdb.get(sessionObjectId(this.sessionId)) as SessionObject | null;
    if (!existing) {
      await this.saveSessionState();
      return false;
    }

    this.metadataPool.clear();
    this.chatPool.clear();
    this.activePool.clear();
    this.pinned.clear();
    this.toolHistory.length = 0;
    this.seenToolcalls.clear();
    this.knownObjectIds.clear();

    this.locked.add(this.chatObjectId);
    this.knownObjectIds.add(this.chatObjectId);

    const objectIds = new Set<string>([
      ...(existing.object_ids ?? []),
      ...(existing.active_set ?? []),
      ...(existing.inactive_set ?? []),
      this.chatObjectId,
    ]);

    for (const id of existing.pinned_set ?? []) this.pinned.add(id);

    for (const id of objectIds) {
      const doc = await this.xtdb.get(id) as MemoryObject | null;
      if (!doc) continue;
      this.knownObjectIds.add(id);
      this.addMetadataForObject(doc);

      if (doc.type === 'chat') {
        this.chatPool.setTurns((doc.turns ?? []) as Turn[]);
      }
      if (doc.type === 'toolcall') {
        this.chatPool.registerToolcall({
          id: doc.id,
          tool: doc.tool,
          argsDisplay: doc.args_display ?? '',
          status: doc.status,
        });
      }
    }

    for (const id of existing.active_set ?? []) {
      const doc = await this.xtdb.get(id);
      if (typeof doc?.content === 'string') this.activePool.activate(id, doc.content);
    }

    this.skipToEndOnNextProcess = true;
    return true;
  }

  assembleContext(systemPrompt: string): { systemPrompt: string; messages: Message[] } {
    const metadataMessage: Message = {
      role: 'user',
      content: this.metadataPool.renderAsText(),
      timestamp: Date.now(),
    };

    const activeMessages: Message[] = this.activePool.renderAsTextBlocks().map((block) => ({
      role: 'user',
      content: `active/${block.id}\n${block.content}`,
      timestamp: Date.now(),
    }));

    return {
      systemPrompt,
      messages: [metadataMessage, ...this.chatPool.renderAsMessages(), ...activeMessages],
    };
  }

  private async handleToolResult(message: ToolResultMessage): Promise<void> {
    if (this.seenToolcalls.has(message.toolCallId)) return;

    const existing = await this.xtdb.get(message.toolCallId) as ToolcallObject | null;
    const textContent = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    const toolObj: ToolcallObject = existing ?? {
      id: message.toolCallId,
      type: 'toolcall',
      content: textContent,
      locked: false,
      provenance: { origin: message.toolName, generator: 'tool' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
      tool: message.toolName,
      args: {},
      args_display: '',
      status: message.isError ? 'fail' : 'ok',
      chat_ref: this.chatObjectId,
      file_refs: [],
    };

    if (!existing) {
      toolObj.content_hash = computeContentHash(toolObj.content);
      toolObj.metadata_view_hash = computeMetadataViewHash(toolObj);
      toolObj.object_hash = computeObjectHash(toolObj);
      await this.xtdb.put(toolObj);
    }

    this.knownObjectIds.add(toolObj.id);
    this.addMetadataForObject(toolObj);

    this.chatPool.registerToolcall({
      id: toolObj.id,
      tool: toolObj.tool,
      argsDisplay: toolObj.args_display ?? '',
      status: toolObj.status,
    });

    this.activePool.activate(toolObj.id, (toolObj.content ?? ''));
    this.toolHistory.push({ id: toolObj.id, turnIndex: this.chatPool.getTurns().length - 1 });
    this.seenToolcalls.add(toolObj.id);
    this.applyAutoDeactivation();
    this.refreshChatMetadata();
  }

  private addMetadataForObject(doc: MemoryObject): void {
    if (doc.type === 'file') {
      const entry: MetadataEntry = {
        id: doc.id,
        type: 'file',
        path: doc.path,
        file_type: doc.file_type,
        char_count: doc.char_count,
        nickname: doc.nickname,
      };
      this.metadataPool.add(entry);
      return;
    }

    if (doc.type === 'toolcall') {
      this.metadataPool.add({
        id: doc.id,
        type: doc.type,
        tool: doc.tool,
        args_display: doc.args_display,
        status: doc.status,
      });
      return;
    }

    if (doc.type === 'chat') {
      this.metadataPool.add({ id: doc.id, type: 'chat', session_ref: this.sessionId, turn_count: doc.turn_count });
    }
  }

  private applyAutoDeactivation(): void {
    const turns = this.chatPool.getTurns();
    const currentTurn = Math.max(0, turns.length - 1);

    const perTurn = this.toolHistory.filter((x) => x.turnIndex === currentTurn).slice(-5).map((x) => x.id);
    const recentTurns = this.toolHistory.filter((x) => x.turnIndex >= currentTurn - 2).map((x) => x.id);
    const keep = new Set([...perTurn, ...recentTurns, ...this.pinned]);

    for (const { id } of this.toolHistory) {
      if (!keep.has(id) && this.activePool.isActive(id)) {
        this.activePool.deactivate(id);
      }
    }
  }

  private refreshChatMetadata(): void {
    const turns = this.chatPool.getTurns();
    this.metadataPool.add({ id: this.chatObjectId, type: 'chat', session_ref: this.sessionId, turn_count: turns.length });
    const chatObject: ChatObject = {
      id: this.chatObjectId,
      type: 'chat',
      content: 'chat-history',
      locked: true,
      provenance: { origin: this.sessionId, generator: 'system' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
      turns,
      session_ref: this.sessionId,
      turn_count: turns.length,
      toolcall_refs: this.toolHistory.map((x) => x.id),
    };
    chatObject.content_hash = computeContentHash(chatObject.content);
    chatObject.metadata_view_hash = computeMetadataViewHash(chatObject);
    chatObject.object_hash = computeObjectHash(chatObject);
    void this.xtdb.put(chatObject);
  }
}
