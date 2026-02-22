import type { Turn } from './types.js';
import type { Message, ToolResultMessage } from './message-types.js';

export interface ToolcallSummary {
  id: string;
  tool: string;
  argsDisplay: string;
  status: 'ok' | 'fail';
}

export class ChatPool {
  private readonly turns: Turn[] = [];
  private readonly toolcalls = new Map<string, ToolcallSummary>();

  addUserTurn(user: Turn['user']): void {
    this.turns.push({
      user,
      assistant: [],
      toolcall_ids: [],
      assistant_meta: {
        api: 'unknown',
        provider: 'unknown',
        model: 'unknown',
        timestamp: Date.now(),
      },
    });
  }

  completeCurrentTurn(assistant: Turn['assistant'], assistantMeta: Turn['assistant_meta']): void {
    const last = this.turns[this.turns.length - 1];
    if (!last) {
      this.addUserTurn('');
      this.completeCurrentTurn(assistant, assistantMeta);
      return;
    }
    last.assistant = assistant;
    last.assistant_meta = assistantMeta;
    const toolIds = assistant
      .filter((item) => item.type === 'toolCall' && typeof item.id === 'string')
      .map((item) => String(item.id));
    if (toolIds.length > 0) {
      last.toolcall_ids = toolIds;
    }
  }

  registerToolcall(summary: ToolcallSummary): void {
    this.toolcalls.set(summary.id, summary);
  }

  getTurns(): Turn[] {
    return this.turns.map((turn) => ({ ...turn, assistant: [...turn.assistant], toolcall_ids: [...turn.toolcall_ids] }));
  }

  clear(): void {
    this.turns.length = 0;
    this.toolcalls.clear();
  }

  setTurns(turns: Turn[]): void {
    this.turns.length = 0;
    this.turns.push(...turns.map((turn) => ({ ...turn, assistant: [...turn.assistant], toolcall_ids: [...turn.toolcall_ids] })));
  }

  renderAsMessages(): Message[] {
    const out: Message[] = [];
    for (const turn of this.turns) {
      out.push({ role: 'user', content: turn.user, timestamp: turn.assistant_meta.timestamp } as Message);
      out.push({ role: 'assistant', content: turn.assistant, ...turn.assistant_meta } as Message);
      for (const id of turn.toolcall_ids) {
        const ref = this.renderToolReference(id);
        const toolName = this.toolcalls.get(id)?.tool ?? 'unknown';
        const toolResult: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: id,
          toolName,
          content: [{ type: 'text', text: ref }],
          isError: false,
          timestamp: turn.assistant_meta.timestamp,
        };
        out.push(toolResult);
      }
    }
    return out;
  }

  private renderToolReference(id: string): string {
    const summary = this.toolcalls.get(id);
    if (!summary) return `toolcall/${id} tool=unknown args='' status=ok`;
    return `toolcall/${id} tool=${summary.tool} args='${summary.argsDisplay}' status=${summary.status}`;
  }
}
