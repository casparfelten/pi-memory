import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { ExtensionRuntimeState } from './extension-logic.js';

export default function piMemory(pi: ExtensionAPI): void {
  const state = new ExtensionRuntimeState();

  pi.on('session_start', async () => {
    await state.ensureXtdb();
    await state.contextManager.loadSessionState('default-session');
  });

  pi.on('session_shutdown', async () => {
    await state.contextManager.saveSessionState();
    state.shutdown();
  });

  pi.on('context', async (event, ctx) => {
    await state.contextManager.processEvents(event.messages as never[]);
    const assembled = state.contextManager.assembleContext(ctx.getSystemPrompt());
    return { messages: assembled.messages as never[] };
  });

  pi.on('tool_result', async (event) => state.onToolResult(event as never));

  pi.on('tool_execution_end', async () => undefined);

  pi.registerTool({
    name: 'mem_activate',
    label: 'Activate',
    description: 'Load an object into active context using object id.',
    parameters: Type.Object({ id: Type.String({ description: 'Object ID to activate' }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await state.contextManager.activate(params.id);
      return { content: [{ type: 'text', text: result }], details: undefined };
    },
  });

  pi.registerTool({
    name: 'mem_deactivate',
    label: 'Deactivate',
    description: 'Remove object content from active context.',
    parameters: Type.Object({ id: Type.String({ description: 'Object ID to deactivate' }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = state.contextManager.deactivate(params.id);
      return { content: [{ type: 'text', text: result }], details: undefined };
    },
  });

  pi.registerTool({
    name: 'mem_pin',
    label: 'Pin',
    description: 'Pin object so it is not auto-deactivated.',
    parameters: Type.Object({ id: Type.String({ description: 'Object ID to pin' }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = state.contextManager.pin(params.id);
      return { content: [{ type: 'text', text: result }], details: undefined };
    },
  });
}
