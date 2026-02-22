export class ActivePool {
  private readonly active = new Map<string, string>();

  activate(id: string, content: string): void {
    this.active.set(id, content);
  }

  deactivate(id: string): void {
    this.active.delete(id);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.active.entries());
  }

  renderAsTextBlocks(): Array<{ id: string; content: string }> {
    return [...this.active.entries()].map(([id, content]) => ({ id, content }));
  }
}
