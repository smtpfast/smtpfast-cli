import type { FlagDef, FlagValues } from "./args.js";
import { bool, one } from "./args.js";
import { type ConfigFile, configDir, readConfig, resolveSettings, type Settings } from "./config.js";
import type { Context } from "./context.js";
import { ApiClient } from "./http.js";
import { Output } from "./output.js";
import { Registry } from "./registry.js";
import { VERSION } from "./version.js";

export const GLOBAL_FLAGS: FlagDef[] = [
  { name: "api-key", kind: "value", valueName: "key", description: "API key for this command. Overrides SMTPFAST_API_KEY and the profile." },
  { name: "profile", kind: "value", valueName: "name", description: "Stored profile to use" },
  { name: "base-url", kind: "value", valueName: "url", description: "API base URL (default https://smtpfa.st/api)" },
  { name: "json", kind: "boolean", description: "Print JSON. This is the default when output is piped." },
  { name: "quiet", short: "q", kind: "boolean", description: "Print only ids" },
  { name: "idempotency-key", kind: "value", valueName: "key", description: "Send an Idempotency-Key header" },
  { name: "no-update-check", kind: "boolean", description: "Do not refresh the cached API spec" },
  { name: "no-color", kind: "boolean", description: "Turn off colors" },
  { name: "debug", kind: "boolean", description: "Print each HTTP request and response status to stderr" },
  { name: "help", short: "h", kind: "boolean", description: "Show help" },
  { name: "version", short: "v", kind: "boolean", description: "Show the version" },
];

export interface Globals {
  apiKey?: string;
  profile?: string;
  baseUrl?: string;
  json: boolean;
  quiet: boolean;
  idempotencyKey?: string;
  noUpdateCheck: boolean;
  noColor: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
}

export function toGlobals(values: FlagValues, env: Record<string, string | undefined>): Globals {
  const debugEnv = env.SMTPFAST_DEBUG;
  return {
    apiKey: one(values, "api-key"),
    profile: one(values, "profile"),
    baseUrl: one(values, "base-url"),
    json: bool(values, "json") ?? false,
    quiet: bool(values, "quiet") ?? false,
    idempotencyKey: one(values, "idempotency-key"),
    noUpdateCheck: bool(values, "no-update-check") ?? false,
    noColor: bool(values, "no-color") ?? false,
    debug: (bool(values, "debug") ?? false) || (debugEnv !== undefined && debugEnv !== "" && debugEnv !== "0"),
    help: bool(values, "help") ?? false,
    version: bool(values, "version") ?? false,
  };
}

export const USER_AGENT = `smtpfast-cli/${VERSION}`;

/** One CLI run: the parsed global flags plus lazily loaded config, settings, registry and client. */
export class Session {
  readonly out: Output;
  readonly configDir: string;
  private cachedConfig?: ConfigFile;
  private cachedRegistry?: Registry;

  constructor(
    readonly ctx: Context,
    readonly globals: Globals,
  ) {
    this.out = new Output(ctx, { json: globals.json, quiet: globals.quiet, noColor: globals.noColor });
    this.out.addSecret(globals.apiKey);
    this.out.addSecret(ctx.env.SMTPFAST_API_KEY);
    this.configDir = configDir(ctx.env, ctx.platform, ctx.homedir);
  }

  config(): ConfigFile {
    this.cachedConfig ??= readConfig(this.configDir);
    return this.cachedConfig;
  }

  /** Forget the cached config after writing it. */
  reloadConfig(): ConfigFile {
    this.cachedConfig = undefined;
    return this.config();
  }

  settings(): Settings {
    const s = resolveSettings({ apiKey: this.globals.apiKey, profile: this.globals.profile, baseUrl: this.globals.baseUrl }, this.ctx.env, this.config());
    this.out.addSecret(s.apiKey);
    return s;
  }

  registry(): Registry {
    this.cachedRegistry ??= new Registry(this.configDir);
    return this.cachedRegistry;
  }

  client(overrides: { apiKey?: string; baseUrl?: string } = {}): ApiClient {
    const s = this.settings();
    const apiKey = overrides.apiKey ?? s.apiKey;
    this.out.addSecret(apiKey);
    return new ApiClient({
      baseUrl: overrides.baseUrl ?? s.baseUrl,
      apiKey,
      userAgent: USER_AGENT,
      fetch: this.ctx.fetch,
      sleep: (ms, signal) => this.ctx.sleep(ms, signal),
      debug: this.globals.debug ? (line) => this.out.err(this.out.ce.dim(line)) : undefined,
    });
  }

  /** An AbortSignal that fires on Ctrl-C, for commands that run until stopped. */
  interruptSignal(): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const dispose = this.ctx.onInterrupt(() => controller.abort(new InterruptError()));
    return { signal: controller.signal, dispose };
  }
}

export class InterruptError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptError";
  }
}
