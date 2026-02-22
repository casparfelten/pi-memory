import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { computeContentHash, computeMetadataViewHash, computeObjectHash } from './hashing.js';
import { ContextManager } from './context-manager.js';
import { FileWatcher } from './file-watcher.js';
import type { FileObject, ToolcallObject } from './types.js';
import { XtdbClient } from './xtdb-client.js';

export type ToolResultLike = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

const BUILTIN_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep']);

export function textContent(parts: Array<{ type: string; text?: string }>): string {
  return parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
}

export function toolReferenceText(toolCallId: string, toolName: string, isError: boolean): string {
  return `toolcall/${toolCallId} tool=${toolName} status=${isError ? 'fail' : 'ok'}`;
}

export function extractPaths(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const regex = /(?:\.?\.?\/)?[\w./-]+\.[\w-]+/g;
  return [...new Set((text.match(regex) ?? []).filter((p) => !p.startsWith('toolcall/')))];
}

async function maybeReadFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath, constants.F_OK);
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '');
  return ext || 'unknown';
}

export class ExtensionRuntimeState {
  xtdb = new XtdbClient('http://127.0.0.1:3000');
  contextManager = new ContextManager(this.xtdb, 'default-session');
  fileWatcher = new FileWatcher(this.xtdb);
  mockProcess: ChildProcess | null = null;

  async ensureXtdb(): Promise<void> {
    try {
      await fetch('http://127.0.0.1:3000/_xtdb/status');
      return;
    } catch {
      const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
      this.mockProcess = spawn('node', ['scripts/mock-xtdb-server.mjs'], { cwd, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async onToolResult(event: ToolResultLike): Promise<{ content: Array<{ type: 'text'; text: string }> } | undefined> {
    if (!BUILTIN_TOOLS.has(event.toolName)) return undefined;

    const output = textContent(event.content);
    const toolObj: ToolcallObject = {
      id: event.toolCallId,
      type: 'toolcall',
      content: output,
      locked: false,
      provenance: { origin: event.toolName, generator: 'tool' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
      tool: event.toolName,
      args: event.input,
      args_display: JSON.stringify(event.input),
      status: event.isError ? 'fail' : 'ok',
      chat_ref: `chat-default-session`,
      file_refs: [],
    };
    toolObj.content_hash = computeContentHash(toolObj.content);
    toolObj.metadata_view_hash = computeMetadataViewHash(toolObj);
    toolObj.object_hash = computeObjectHash(toolObj);
    await this.xtdb.put(toolObj);

    await this.indexFileArtifacts(event, output);
    await this.contextManager.activate(event.toolCallId);

    return { content: [{ type: 'text', text: toolReferenceText(event.toolCallId, event.toolName, event.isError) }] };
  }

  async indexFileArtifacts(event: ToolResultLike, output: string): Promise<void> {
    const explicitPath = typeof event.input.path === 'string' ? event.input.path : null;
    const paths = new Set<string>([...extractPaths(output), ...extractPaths(event.input)]);
    if (explicitPath) paths.add(explicitPath);

    for (const p of paths) {
      const fileContent = (event.toolName === 'read' || event.toolName === 'write' || event.toolName === 'edit')
        ? await maybeReadFile(p)
        : null;
      const fileObj: FileObject = {
        id: `file:${p}`,
        type: 'file',
        content: fileContent,
        locked: false,
        provenance: { origin: event.toolName, generator: 'tool' },
        content_hash: '',
        metadata_view_hash: '',
        object_hash: '',
        path: p,
        file_type: fileTypeFromPath(p),
        char_count: fileContent?.length ?? 0,
      };
      fileObj.content_hash = computeContentHash(fileObj.content);
      fileObj.metadata_view_hash = computeMetadataViewHash(fileObj);
      fileObj.object_hash = computeObjectHash(fileObj);
      await this.xtdb.put(fileObj);
      this.contextManager.noteIndexedObject(fileObj.id);
      this.fileWatcher.watchFile(p);
      this.contextManager.getMetadataPool().add({
        id: fileObj.id,
        type: 'file',
        path: fileObj.path,
        file_type: fileObj.file_type,
        char_count: fileObj.char_count,
        nickname: undefined,
      });
    }
  }

  shutdown(): void {
    this.fileWatcher.shutdown();
    this.mockProcess?.kill('SIGTERM');
    this.mockProcess = null;
  }
}
