import type { FetchFn } from "./context.js";
import { ApiError, CliError, UsageError } from "./errors.js";

export type Query = Array<[string, string]>;

export interface RequestOptions {
  method: string;
  /** Path relative to the base URL, like /v1/emails. May include a query string. */
  path: string;
  query?: Query;
  /** JSON body. Leave undefined to send no body. */
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Set to false for endpoints that need no key, like the spec itself. */
  auth?: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, a string for text, a Uint8Array for binary, or null for an empty body. */
  data: unknown;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  userAgent: string;
  fetch: FetchFn;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  debug?: (line: string) => void;
  timeoutMs?: number;
  /** Longest Retry-After the client waits out before giving up on a 429. */
  maxRetryWaitMs?: number;
}

/** Retry-After is seconds or an HTTP date. Returns milliseconds, or undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export function errorMessage(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error;
    if (b.error && typeof b.error === "object" && typeof (b.error as Record<string, unknown>).message === "string") {
      return (b.error as Record<string, string>).message!;
    }
    if (typeof b.message === "string") return b.message;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return statusText || `HTTP ${status}`;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-ndjson|problem\+json|[a-z.+-]*\+json))/i;

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) return null;
  if (type && !TEXT_TYPES.test(type)) return buf;
  const text = new TextDecoder().decode(buf);
  if (/json/i.test(type) || (!type && /^\s*[[{]/.test(text))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export class ApiClient {
  readonly baseUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  url(path: string, query: Query = []): string {
    let p = path.startsWith("/") ? path : `/${path}`;
    const params = new URLSearchParams();
    const q = p.indexOf("?");
    if (q !== -1) {
      new URLSearchParams(p.slice(q + 1)).forEach((v, k) => params.append(k, v));
      p = p.slice(0, q);
    }
    for (const [k, v] of query) params.append(k, v);
    const qs = params.toString();
    return this.checkUrl(`${this.baseUrl}${p}${qs ? `?${qs}` : ""}`);
  }

  /** The key only goes to the base URL: the final URL must have its origin and a path under its path. */
  private checkUrl(raw: string): string {
    let base: URL | undefined;
    try {
      base = new URL(this.baseUrl);
    } catch {
      base = undefined;
    }
    if (!base || (base.protocol !== "https:" && base.protocol !== "http:")) {
      throw new UsageError(`Invalid base URL "${this.baseUrl}"`, "Use an http or https URL, like https://smtpfa.st/api.", false);
    }
    const url = new URL(raw);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (url.origin !== base.origin || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) {
      throw new UsageError(`Refusing to send a request outside the base URL: ${url.origin}${url.pathname}`, `The base URL is ${this.baseUrl}.`, false);
    }
    return url.href;
  }

  async request(o: RequestOptions): Promise<ApiResponse> {
    const method = o.method.toUpperCase();
    const url = this.url(o.path, o.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.options.userAgent,
      ...o.headers,
    };
    if (o.auth !== false) {
      if (!this.options.apiKey) {
        throw new UsageError("No API key found", "Run smtpfast login, set SMTPFAST_API_KEY, or pass --api-key.", false);
      }
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
    let payload: string | undefined;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
    }

    for (let attempt = 0; ; attempt++) {
      const res = await this.send(method, url, headers, payload, o.signal);
      const data = await readBody(res);
      if (res.status === 429 && attempt === 0) {
        const wait = parseRetryAfter(res.headers.get("retry-after")) ?? 1000;
        if (wait <= (this.options.maxRetryWaitMs ?? 30_000)) {
          this.options.debug?.(`  rate limited, retrying in ${wait} ms`);
          await this.options.sleep(wait, o.signal);
          if (o.signal?.aborted) throw o.signal.reason ?? new Error("Aborted");
          continue;
        }
      }
      if (res.status >= 400) {
        let message = errorMessage(data, res.status, res.statusText);
        if (res.status === 429) {
          const wait = parseRetryAfter(res.headers.get("retry-after"));
          if (wait !== undefined) message += ` (retry after ${Math.ceil(wait / 1000)}s)`;
        }
        throw new ApiError(res.status, message, data, res.headers);
      }
      return { status: res.status, headers: res.headers, data };
    }
  }

  private async send(method: string, url: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<Response> {
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    this.options.debug?.(`> ${method} ${url}`);
    if (headers["Idempotency-Key"]) this.options.debug?.(`> Idempotency-Key: ${headers["Idempotency-Key"]}`);
    try {
      const res = await this.options.fetch(url, { method, headers, body, signal: controller.signal });
      this.options.debug?.(`< ${res.status} ${res.statusText} (${Date.now() - started} ms)`);
      return res;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (timedOut) throw new CliError(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${method} ${url}`);
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (err as Error).message;
      throw new CliError(`Could not reach ${new URL(url).origin}: ${detail}`, 1, "Check your network, or the base URL with --base-url.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
