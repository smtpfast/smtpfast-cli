import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeFileAtomic } from "./config.js";
import type { FetchFn } from "./context.js";
import { buildManifest } from "./spec/build.js";

/**
 * The live spec cache. Once a day a detached child process downloads
 * <base-url>/v1/openapi.json into the config directory. Commands never wait
 * for it, and a failed refresh changes nothing but the attempt time.
 */

export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TIMEOUT_MS = 10_000;

export interface SpecMeta {
  /** Last attempt, successful or not (ms since epoch). */
  checked_at?: number;
  /** Last time a new spec was stored. */
  fetched_at?: number;
  etag?: string;
  hash?: string;
  operation_count?: number;
  url?: string;
  last_error?: string;
}

export function specPath(dir: string): string {
  return join(dir, "spec.json");
}

export function metaPath(dir: string): string {
  return join(dir, "spec-meta.json");
}

export function readMeta(dir: string): SpecMeta {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(dir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SpecMeta) : {};
  } catch {
    return {};
  }
}

function writeAtomic(file: string, content: string): void {
  writeFileAtomic(file, content, 0o644);
}

export function writeMeta(dir: string, meta: SpecMeta): void {
  ensureDir(dir);
  writeAtomic(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`);
}

export function readCachedSpec(dir: string): unknown | undefined {
  try {
    if (!existsSync(specPath(dir))) return undefined;
    return JSON.parse(readFileSync(specPath(dir), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function updateCheckDisabled(flag: boolean, env: Record<string, string | undefined>): boolean {
  const v = env.SMTPFAST_NO_UPDATE_CHECK;
  return flag || (v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false");
}

export function specUrl(baseUrl: string, env: Record<string, string | undefined>): string {
  return env.SMTPFAST_SPEC_URL || `${baseUrl.replace(/\/+$/, "")}/v1/openapi.json`;
}

/** True when the cache is due for a refresh. A timestamp in the future counts as due. */
export function refreshDue(meta: SpecMeta, now: number): boolean {
  const last = meta.checked_at;
  if (typeof last !== "number") return true;
  return now - last >= REFRESH_INTERVAL_MS || last > now + 60_000;
}

/**
 * Start a background refresh when the cache is stale. Records the attempt
 * first so that parallel runs do not all start one. Never throws.
 */
export function maybeStartRefresh(args: {
  dir: string;
  url: string;
  now: number;
  spawn: (a: { configDir: string; url: string }) => void;
}): boolean {
  try {
    const meta = readMeta(args.dir);
    if (!refreshDue(meta, args.now)) return false;
    writeMeta(args.dir, { ...meta, checked_at: args.now });
    args.spawn({ configDir: args.dir, url: args.url });
    return true;
  } catch {
    return false;
  }
}

export type RefreshResult = "updated" | "unchanged" | "failed";

/** Download the spec. Uses If-None-Match when the server gave an ETag before. Never throws. */
export async function refreshSpec(args: {
  dir: string;
  url: string;
  fetch: FetchFn;
  now: number;
  userAgent: string;
  timeoutMs?: number;
}): Promise<RefreshResult> {
  const meta = readMeta(args.dir);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? REFRESH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": args.userAgent };
    if (meta.etag && existsSync(specPath(args.dir))) headers["If-None-Match"] = meta.etag;
    const res = await args.fetch(args.url, { headers, signal: controller.signal });
    if (res.status === 304) {
      writeMeta(args.dir, { ...meta, checked_at: args.now, url: args.url, last_error: undefined });
      return "unchanged";
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const spec = JSON.parse(text) as unknown;
    // Only store a spec this version can turn into commands.
    const { manifest } = buildManifest(spec);
    const unchanged = manifest.specHash === meta.hash && existsSync(specPath(args.dir));
    ensureDir(args.dir);
    if (!unchanged) writeAtomic(specPath(args.dir), text);
    writeMeta(args.dir, {
      checked_at: args.now,
      fetched_at: unchanged ? meta.fetched_at : args.now,
      etag: res.headers.get("etag") ?? undefined,
      hash: manifest.specHash,
      operation_count: manifest.operationCount,
      url: args.url,
    });
    return unchanged ? "unchanged" : "updated";
  } catch (err) {
    try {
      writeMeta(args.dir, { ...meta, checked_at: args.now, last_error: (err as Error).message || String(err) });
    } catch {
      // The config directory may not be writable. Nothing else to do.
    }
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
