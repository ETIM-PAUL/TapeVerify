import { StrikeApiError } from "./errors.js";
import { type ApiWalletKeys, signRequest } from "./signing.js";

export interface StrikeClientOptions {
  /** Origin only, no path: signatures cover the path exactly as the server sees it. */
  baseUrl: string;
  priceUrl?: string;
  keys?: ApiWalletKeys;
  builderFeeBps?: number;
  fetch?: typeof fetch;
  /** Retry transient failures (network / 5xx / 429) on idempotent requests. */
  maxRetries?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Extra unsigned headers. */
  headers?: Record<string, string>;
  /** Mark non-idempotent calls so they are never retried. Default: GET/DELETE retry, POST doesn't. */
  retry?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StrikeClient {
  private clockOffsetSec = 0;
  private readonly f: typeof fetch;

  constructor(readonly opts: StrikeClientOptions) {
    if (new URL(opts.baseUrl).pathname !== "/")
      throw new Error("baseUrl must be an origin with no path");
    this.f = opts.fetch ?? fetch;
  }

  withKeys(keys: ApiWalletKeys): StrikeClient {
    return new StrikeClient({ ...this.opts, keys });
  }

  /** Sync with server time to survive local clock drift (server allows 3 minutes). */
  async syncClock(): Promise<number> {
    const t0 = Date.now();
    const res = await this.f(`${this.opts.baseUrl}/v2/time`);
    if (!res.ok) throw new StrikeApiError(res.status, "time sync failed", "GET", "/v2/time");
    const { serverTime } = (await res.json()) as { serverTime: number };
    const mid = (t0 + Date.now()) / 2;
    this.clockOffsetSec = Math.round((serverTime - mid) / 1000);
    return this.clockOffsetSec;
  }

  async publicGet<T>(path: string, base = this.opts.baseUrl): Promise<T> {
    return this.send<T>("GET", path, { retry: true }, false, base);
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path, { retry: true }, true);
  }

  post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.send<T>("POST", path, { ...opts, body }, true);
  }

  /** Unsigned public POST (builder connect). */
  publicPost<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, { body }, false);
  }

  delete<T>(path: string, body: unknown = {}): Promise<T> {
    return this.send<T>("DELETE", path, { body, retry: true }, true);
  }

  /** `X-Builder-Fee-Bps` header; capped to 0..100 and never above the configured fee. */
  builderFeeHeaders(bps = this.opts.builderFeeBps ?? 0): Record<string, string> {
    const max = this.opts.builderFeeBps ?? 100;
    const v = Math.max(0, Math.min(Math.floor(bps), 100, max));
    return v > 0 ? { "X-Builder-Fee-Bps": String(v) } : {};
  }

  private async send<T>(
    method: string,
    path: string,
    o: RequestOptions,
    signed: boolean,
    base = this.opts.baseUrl,
  ): Promise<T> {
    const retriable = o.retry ?? false;
    const max = retriable ? (this.opts.maxRetries ?? 3) : 0;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= max; attempt++) {
      if (attempt > 0) await sleep(Math.min(250 * 2 ** (attempt - 1), 4000));
      const bodyStr = o.body === undefined ? "" : JSON.stringify(o.body);
      const headers: Record<string, string> = { ...o.headers };
      if (bodyStr) headers["Content-Type"] = "application/json";
      if (signed) {
        if (!this.opts.keys) throw new Error("StrikeClient: API wallet keys required");
        // Fresh timestamp + nonce on every attempt; nonces are single use.
        const ts = Math.floor(Date.now() / 1000) + this.clockOffsetSec;
        Object.assign(
          headers,
          signRequest(method, path, bodyStr, this.opts.keys, { timestamp: ts }),
        );
      }
      let res: Response;
      try {
        res = await this.f(`${base}${path}`, { method, headers, body: bodyStr || undefined });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => "");
      let msg = text;
      try {
        msg = String((JSON.parse(text) as { error?: unknown }).error ?? text);
      } catch {}
      lastErr = new StrikeApiError(res.status, msg || res.statusText, method, path);
      if (res.status === 429 || res.status >= 500) continue;
      throw lastErr;
    }
    throw lastErr;
  }
}
