export type ContentPart = { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input?: Record<string, unknown> };

export type UserMessage = {
  role: 'user';
  content: string | ContentPart[];
  timestamp: number;
};

export type AssistantMessage = {
  role: 'assistant';
  content: ContentPart[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  timestamp: number;
};

export type ToolResultMessage = {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: ContentPart[];
  isError: boolean;
  timestamp: number;
};

export type HarnessMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | AssistantMessage
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: ContentPart[]; isError: boolean; timestamp: number };

export interface MetadataEntry {
  id: string;
  type: 'toolcall';
  tool: string;
  status: 'ok' | 'fail';
  argsDisplay?: string;
}

export interface ChatTurn {
  user: string | ContentPart[];
  assistant: ContentPart[];
  toolcall_ids: string[];
  assistant_meta: {
    api: string;
    provider: string;
    model: string;
    usage?: Record<string, unknown>;
    stopReason?: string;
    timestamp: number;
  };
}

interface ToolcallState {
  id: string;
  tool: string;
  status: 'ok' | 'fail';
  content: string;
  argsDisplay?: string;
  turnIndex: number;
}

export class ContextManager {
  private readonly metadataPool: MetadataEntry[] = [];
  private readonly metadataSeen = new Set<string>();
  private readonly chatTurns: ChatTurn[] = [];
  private readonly toolcalls = new Map<string, ToolcallState>();
  private readonly activeContent = new Map<string, string>();
  private readonly pinned = new Set<string>();
  private readonly locked = new Set<string>();

  private cursor = 0;
  private lastMessagesRef: HarnessMessage[] | null = null;

  constructor(
    private readonly options: { chatObjectId?: string; recentToolcallsPerTurn?: number; recentTurnsWindow?: number } = {},
  ) {
    this.locked.add(options.chatObjectId ?? 'chat');
  }

  processMessages(messages: HarnessMessage[]): void {
    if (this.lastMessagesRef && (messages !== this.lastMessagesRef || messages.length < this.cursor)) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      return;
    }

    for (const message of messages.slice(this.cursor)) {
      if (message.role === 'user') {
        this.chatTurns.push({
          user: message.content,
          assistant: [],
          toolcall_ids: [],
          assistant_meta: {
            api: '',
            provider: '',
            model: '',
            timestamp: message.timestamp,
          },
        });
        continue;
      }

      if (message.role === 'assistant') {
        const currentTurn = this.getOrCreateCurrentTurn(message.timestamp);
        currentTurn.assistant = message.content;
        currentTurn.assistant_meta = {
          api: message.api ?? '',
          provider: message.provider ?? '',
          model: message.model ?? '',
          usage: message.usage,
          stopReason: message.stopReason,
          timestamp: message.timestamp,
        };
        continue;
      }

      const turnIndex = this.chatTurns.length > 0 ? this.chatTurns.length - 1 : 0;
      const turn = this.getOrCreateCurrentTurn(message.timestamp);
      turn.toolcall_ids.push(message.toolCallId);

      const content = this.extractText(message.content);
      const toolcall: ToolcallState = {
        id: message.toolCallId,
        tool: message.toolName,
        status: message.isError ? 'fail' : 'ok',
        content,
        turnIndex,
      };
      this.toolcalls.set(message.toolCallId, toolcall);

      if (!this.metadataSeen.has(message.toolCallId)) {
        this.metadataSeen.add(message.toolCallId);
        this.metadataPool.push({
          id: toolcall.id,
          type: 'toolcall',
          tool: toolcall.tool,
          status: toolcall.status,
        });
      }

      this.activate(message.toolCallId);
      this.applyAutoToolcallWindow();
    }

    this.cursor = messages.length;
    this.lastMessagesRef = messages;
  }

  activate(id: string): { ok: boolean; message: string } {
    const toolcall = this.toolcalls.get(id);
    if (!toolcall) return { ok: false, message: `Object not found: ${id}` };
    if (!toolcall.content) return { ok: false, message: 'Content unavailable (non-text file)' };
    this.activeContent.set(id, toolcall.content);
    return { ok: true, message: `Activated ${id}` };
  }

  deactivate(id: string): { ok: boolean; message: string } {
    if (this.locked.has(id)) return { ok: false, message: `Object is locked: ${id}` };
    this.activeContent.delete(id);
    return { ok: true, message: `Deactivated ${id}` };
  }

  pin(id: string): { ok: boolean; message: string } {
    this.pinned.add(id);
    return { ok: true, message: `Pinned ${id}` };
  }

  assembleContext(systemPrompt: string): LlmMessage[] {
    const messages: LlmMessage[] = [];
    messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: this.renderMetadataPool() });

    for (const turn of this.chatTurns) {
      messages.push({ role: 'user', content: this.extractText(turn.user) });
      messages.push({
        role: 'assistant',
        content: turn.assistant,
        api: turn.assistant_meta.api,
        provider: turn.assistant_meta.provider,
        model: turn.assistant_meta.model,
        usage: turn.assistant_meta.usage,
        stopReason: turn.assistant_meta.stopReason,
        timestamp: turn.assistant_meta.timestamp,
      });

      for (const id of turn.toolcall_ids) {
        const t = this.toolcalls.get(id);
        if (!t) continue;
        messages.push({
          role: 'toolResult',
          toolCallId: id,
          toolName: t.tool,
          content: [{ type: 'text', text: this.toolResultMetadataRef(t) }],
          isError: t.status === 'fail',
          timestamp: turn.assistant_meta.timestamp,
        });
      }
    }

    for (const [id, content] of this.activeContent.entries()) {
      messages.push({ role: 'user', content: `ACTIVE_CONTENT id=${id}\n${content}` });
    }

    return messages;
  }

  getState() {
    return {
      metadataPool: this.metadataPool,
      chatTurns: this.chatTurns,
      activeContent: new Map(this.activeContent),
      cursor: this.cursor,
    };
  }

  private getOrCreateCurrentTurn(timestamp: number): ChatTurn {
    if (this.chatTurns.length === 0) {
      this.chatTurns.push({
        user: '',
        assistant: [],
        toolcall_ids: [],
        assistant_meta: { api: '', provider: '', model: '', timestamp },
      });
    }
    return this.chatTurns[this.chatTurns.length - 1];
  }

  private applyAutoToolcallWindow(): void {
    const perTurn = this.options.recentToolcallsPerTurn ?? 5;
    const turnsBack = this.options.recentTurnsWindow ?? 3;
    const keep = new Set<string>();

    const start = Math.max(0, this.chatTurns.length - turnsBack);
    for (let i = start; i < this.chatTurns.length; i++) {
      const ids = this.chatTurns[i].toolcall_ids;
      const tail = i === this.chatTurns.length - 1 ? ids.slice(-perTurn) : ids;
      for (const id of tail) keep.add(id);
    }

    for (const [id, toolcall] of this.toolcalls.entries()) {
      if (keep.has(id)) {
        if (toolcall.content) this.activeContent.set(id, toolcall.content);
        continue;
      }
      if (!this.pinned.has(id)) this.activeContent.delete(id);
    }
  }

  private renderMetadataPool(): string {
    const lines = ['METADATA_POOL'];
    for (const entry of this.metadataPool) {
      lines.push(`- id=${entry.id} type=${entry.type} tool=${entry.tool} status=${entry.status}`);
    }
    return lines.join('\n');
  }

  private toolResultMetadataRef(toolcall: ToolcallState): string {
    return `toolcall_ref id=${toolcall.id} tool=${toolcall.tool} status=${toolcall.status}`;
  }

  private extractText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
}
