// Tiny fetch wrapper with timeout + JSON helpers. Uses the global fetch that
// ships with Node >= 18. No external deps.

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export class HttpClient {
  constructor(
    private base: string,
    private timeoutMs = 30_000,
  ) {}

  async getJson<T = any>(path: string): Promise<T> {
    return withTimeout(this.timeoutMs, async (signal) => {
      const url = joinUrl(this.base, path);
      const res = await fetch(url, { signal, headers: { accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text);
      return (text ? JSON.parse(text) : null) as T;
    });
  }

  async postJson<T = any>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return withTimeout(this.timeoutMs, async (signal) => {
      const url = joinUrl(this.base, path);
      const res = await fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text);
      return (text ? JSON.parse(text) : null) as T;
    });
  }

  async send<T = any>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return withTimeout(this.timeoutMs, async (signal) => {
      const url = joinUrl(this.base, path);
      const res = await fetch(url, {
        method,
        signal,
        headers: body
          ? { "content-type": "application/json", accept: "application/json", ...headers }
          : { accept: "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, text);
      return (text ? JSON.parse(text) : null) as T;
    });
  }
}

/** Sleep helper used by pollers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
