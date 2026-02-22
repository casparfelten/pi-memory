import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { computeContentHash, computeMetadataViewHash, computeObjectHash } from './hashing.js';
import type { FileObject } from './types.js';
import { XtdbClient } from './xtdb-client.js';

function fileTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '');
  return ext || 'unknown';
}

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private watchedPaths = new Set<string>();
  private pathToObjectId = new Map<string, string>();
  private recentlyUnlinked = new Map<string, { objectId: string; ts: number }>();

  constructor(private readonly xtdb: XtdbClient) {}

  watchFile(filePath: string): void {
    if (this.watchedPaths.has(filePath)) return;

    const objectId = `file:${filePath}`;
    this.watchedPaths.add(filePath);
    this.pathToObjectId.set(filePath, objectId);

    if (!this.watcher) {
      this.watcher = chokidar.watch([], { ignoreInitial: true });
      this.watcher.on('change', (p) => void this.onFileChanged(p));
      this.watcher.on('unlink', (p) => void this.onFileDeleted(p));
      this.watcher.on('add', (p) => void this.onFileAdded(p));
    }

    void this.watcher.add(filePath);
  }

  async onFileChanged(filePath: string): Promise<void> {
    const objectId = this.pathToObjectId.get(filePath) ?? `file:${filePath}`;
    try {
      const content = await readFile(filePath, 'utf8');
      const doc: FileObject = {
        id: objectId,
        type: 'file',
        content,
        locked: false,
        provenance: { origin: 'watcher', generator: 'system' },
        content_hash: '',
        metadata_view_hash: '',
        object_hash: '',
        path: filePath,
        file_type: fileTypeFromPath(filePath),
        char_count: content.length,
      };
      doc.content_hash = computeContentHash(doc.content);
      doc.metadata_view_hash = computeMetadataViewHash(doc);
      doc.object_hash = computeObjectHash(doc);
      await this.xtdb.put(doc);
    } catch {
      await this.onFileDeleted(filePath);
    }
  }

  async onFileDeleted(filePath: string): Promise<void> {
    const objectId = this.pathToObjectId.get(filePath) ?? `file:${filePath}`;
    const doc: FileObject = {
      id: objectId,
      type: 'file',
      content: null,
      locked: false,
      provenance: { origin: 'watcher', generator: 'system' },
      content_hash: '',
      metadata_view_hash: '',
      object_hash: '',
      path: null,
      file_type: fileTypeFromPath(filePath),
      char_count: 0,
    };
    doc.content_hash = computeContentHash(doc.content);
    doc.metadata_view_hash = computeMetadataViewHash(doc);
    doc.object_hash = computeObjectHash(doc);
    await this.xtdb.put(doc);

    this.recentlyUnlinked.set(filePath, { objectId, ts: Date.now() });
    this.watchedPaths.delete(filePath);
    this.pathToObjectId.delete(filePath);
  }

  private async onFileAdded(filePath: string): Promise<void> {
    const now = Date.now();
    const renameCandidate = [...this.recentlyUnlinked.entries()]
      .find(([, value]) => now - value.ts < 1500);

    if (renameCandidate) {
      const [oldPath, value] = renameCandidate;
      this.recentlyUnlinked.delete(oldPath);
      this.pathToObjectId.set(filePath, value.objectId);
      this.watchedPaths.add(filePath);
      await this.onFileChanged(filePath);
      return;
    }

    this.watchFile(filePath);
    await this.onFileChanged(filePath);
  }

  getWatchedPaths(): string[] {
    return [...this.watchedPaths];
  }

  shutdown(): void {
    void this.watcher?.close();
    this.watcher = null;
    this.watchedPaths.clear();
    this.pathToObjectId.clear();
    this.recentlyUnlinked.clear();
  }
}
