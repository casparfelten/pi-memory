export interface XtRequestOptions {
  timeoutMs?: number;
}

export class XtdbClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

export class XtdbClient {
  constructor(
    private readonly baseUrl = 'http://127.0.0.1:3000',
    private readonly defaultTimeoutMs = 10_000,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, options: XtRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new XtdbClientError(`XTDB request failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof XtdbClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new XtdbClientError(`XTDB request timeout after ${timeoutMs}ms`, error);
      }
      throw new XtdbClientError('XTDB request failed due to connection or transport error', error);
    } finally {
      clearTimeout(timer);
    }
  }

  async put(doc: Record<string, unknown>, validTime?: string): Promise<unknown> {
    return this.request('/_xtdb/submit-tx', {
      method: 'POST',
      body: JSON.stringify({ txOps: [['put', { ...doc, 'xt/id': doc['xt/id'] ?? doc.id }, validTime].filter(Boolean)] }),
    });
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    return this.request(`/_xtdb/entity?eid=${encodeURIComponent(id)}`);
  }

  async getAsOf(id: string, validTime: string): Promise<Record<string, unknown> | null> {
    return this.request(`/_xtdb/entity?eid=${encodeURIComponent(id)}&valid-time=${encodeURIComponent(validTime)}`);
  }

  async history(id: string): Promise<Array<Record<string, unknown>>> {
    return this.request(`/_xtdb/entity?eid=${encodeURIComponent(id)}&history=true&sort-order=asc`);
  }

  async query(query: unknown): Promise<Array<Record<string, unknown>>> {
    return this.request('/_xtdb/query', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }
}
