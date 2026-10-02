import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Context, InStream } from "../src/context.js";
import { main } from "../src/main.js";

export const FIXTURE_PATH = join(import.meta.dir, "fixtures", "openapi.json");

export function fixtureSpec(): Record<string, any> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
  json: any;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A local HTTP server that records every request. Tests never reach the network. */
export async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    const rec: RecordedRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, json: parsed };
    requests.push(rec);
    try {
      await handler(rec, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function tempDir(prefix = "smtpfast-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  tty?: boolean;
  stdin?: string;
  stdinTTY?: boolean;
  cwd?: string;
  home?: string;
  sleep?: Context["sleep"];
  now?: () => number;
  onInterrupt?: Context["onInterrupt"];
  configHome?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawned: Array<{ configDir: string; url: string }>;
  configHome: string;
}

/** Run the CLI in this process with captured output and a private config directory. */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const spawned: RunResult["spawned"] = [];
  const configHome = opts.configHome ?? tempDir("smtpfast-xdg-");
  const stdin = Readable.from(opts.stdin !== undefined ? [opts.stdin] : []) as unknown as InStream;
  stdin.isTTY = opts.stdinTTY ?? false;
  const text = (chunk: string | Uint8Array) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  const ctx: Partial<Context> = {
    env: { XDG_CONFIG_HOME: configHome, NO_COLOR: "1", SMTPFAST_NO_UPDATE_CHECK: "1", ...opts.env },
    stdout: { write: (c) => ((stdout += text(c)), true), isTTY: opts.tty ?? false, columns: 120 },
    stderr: { write: (c) => ((stderr += text(c)), true), isTTY: false },
    stdin,
    cwd: opts.cwd ?? process.cwd(),
    homedir: opts.home ?? configHome,
    platform: "linux",
    sleep: opts.sleep ?? (async () => {}),
    now: opts.now ?? (() => Date.now()),
    spawnRefresh: (a) => {
      spawned.push(a);
    },
    onInterrupt: opts.onInterrupt ?? (() => () => {}),
  };
  const code = await main(argv, ctx);
  return { code, stdout, stderr, spawned, configHome };
}
