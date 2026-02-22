import { computeContentHash, computeMetadataViewHash, computeObjectHash } from './hashing.js';
import { ActivePool } from './active-pool.js';
import { ChatPool } from './chat-pool.js';
import { MetadataPool } from './metadata-pool.js';
import type { AgentMessage, Message, ToolResultMessage } from './message-types.js';
import type { ChatObject, ToolcallObject } from './types.js';
import { XtdbClient } from './xtdb-client.js';

export class ContextManager {
  private readonly metadataPool = new MetadataPool();
  private readonly chatPool = new ChatPool();
  private readonly activePool = new ActivePool();
  private readonly pinned = new Set<string>();
  private readonly locked = new Set<string>();
  private readonly toolHistory: Array<{ id: string; turnIndex: number }> = [];
  private cursor = 0;
  private lastMessagesRef: AgentMessage[] | null = null;
  private readonly chatObjectId: string;

  constructor(private readonly xtdb: XtdbClient, private readonly sessionId = 'session-1') {
    this.chatObjectId = `chat-${sessionId}`;
    this.locked.add(this.chatObjectId);
    this.locked.add('system_prompt');
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

  async processEvents(messages: AgentMessage[]): Promise<void> {
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
  }

  async activate(id: string): Promise<string> {
    const object = await this.xtdb.get(id);
    if (!object) return `Object not found: ${id}`;
    const content = object.content;
    if (typeof content !== 'string') return 'Content unavailable (non-text file)';
    this.activePool.activate(id, content);
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
    const textContent = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    const toolObj: ToolcallObject = {
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

    toolObj.content_hash = computeContentHash(toolObj.content);
    toolObj.metadata_view_hash = computeMetadataViewHash(toolObj);
    toolObj.object_hash = computeObjectHash(toolObj);

    await this.xtdb.put(toolObj);

    this.metadataPool.add({
      id: toolObj.id,
      type: toolObj.type,
      tool: toolObj.tool,
      args_display: toolObj.args_display,
      status: toolObj.status,
    });

    this.chatPool.registerToolcall({
      id: toolObj.id,
      tool: toolObj.tool,
      argsDisplay: toolObj.args_display ?? '',
      status: toolObj.status,
    });

    this.activePool.activate(toolObj.id, toolObj.content ?? '');
    this.toolHistory.push({ id: toolObj.id, turnIndex: this.chatPool.getTurns().length - 1 });
    this.applyAutoDeactivation();
    this.refreshChatMetadata();
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
