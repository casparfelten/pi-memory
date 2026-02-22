import { setTimeout as sleep } from 'node:timers/promises';

export class XtdbClient {
  constructor(
    private readonly baseUrl = 'http://172.17.0.1:3000',
    private readonly timeoutMs = 10_000,
  ) {}

  private async http(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`XTDB HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async put<T extends { id?: string; 'xt/id'?: string }>(doc: T): Promise<{ txId?: number; txTime?: string; [k: string]: unknown }> {
    const withXtId = { ...doc, 'xt/id': doc['xt/id'] ?? doc.id };
    const response = await this.http('/_xtdb/submit-tx', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 'tx-ops': [['put', withXtId]] }),
    });

    return (await response.json()) as { txId?: number; txTime?: string; [k: string]: unknown };
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/_xtdb/entity?eid=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`XTDB HTTP ${response.status} ${response.statusText}`);
      return (await response.json()) as Record<string, unknown> | null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getAsOf(id: string, timestamp: string): Promise<Record<string, unknown> | null> {
    const response = await this.http(
      `/_xtdb/entity?eid=${encodeURIComponent(id)}&valid-time=${encodeURIComponent(timestamp)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );
    return (await response.json()) as Record<string, unknown> | null;
  }

  async history(id: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.http(`/_xtdb/entity?eid=${encodeURIComponent(id)}&history=true&sort-order=asc`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return (await response.json()) as Array<Record<string, unknown>>;
  }

  async query(datalogEdn: string): Promise<Array<unknown>> {
    const response = await this.http('/_xtdb/query', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/edn',
      },
      body: datalogEdn,
    });
    return (await response.json()) as Array<unknown>;
  }

  async putAndWait<T extends { id?: string; 'xt/id'?: string }>(doc: T, waitMs = 400): Promise<void> {
    await this.put(doc);
    await sleep(waitMs);
  }
}
