import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { sleep } from "./util.js";

/** The part of fetch the CLI uses. Narrower than typeof fetch so test doubles fit. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OutStream {
  write(chunk: string | Uint8Array): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface InStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** Everything a command touches outside its own memory. Tests swap these out. */
export interface Context {
  env: Record<string, string | undefined>;
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
  cwd: string;
  platform: NodeJS.Platform;
  homedir: string;
  fetch: FetchFn;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** Start the spec refresh without waiting for it. */
  spawnRefresh(args: { configDir: string; url: string }): void;
  /** Run a handler on Ctrl-C. Returns a function that removes it. */
  onInterrupt(handler: () => void): () => void;
}

/** How to run this same CLI again: node + script, bun + script, or a compiled binary on its own. */
export function selfInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || /[\\/]~BUN[\\/]/.test(script) || /^B:[\\/]~BUN/i.test(script);
  return compiled ? { command: process.execPath, args: [] } : { command: process.execPath, args: [script] };
}

function spawnDetachedRefresh({ configDir, url }: { configDir: string; url: string }): void {
  const self = selfInvocation();
  const child = spawn(self.command, [...self.args, "__refresh-spec", "--url", url, "--config-dir", configDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, SMTPFAST_NO_UPDATE_CHECK: "1" },
  });
  child.on("error", () => {});
  child.unref();
}

export function defaultContext(): Context {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: homedir(),
    fetch: (input, init) => fetch(input, init),
    sleep,
    now: () => Date.now(),
    spawnRefresh: spawnDetachedRefresh,
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  };
}
