import { renderTable } from "../output.js";
import { configPath, type Settings, validateProfileName, writeConfig } from "../config.js";
import type { Context } from "../context.js";
import { bool, one } from "../args.js";
import { ApiError, CliError, EXIT_API, EXIT_INTERRUPTED, UsageError } from "../errors.js";
import { InterruptError, type Session } from "../session.js";
import { maskKey, readAll } from "../util.js";
import { VERSION } from "../version.js";
import type { HandCommand } from "./types.js";

/** Read a line from the terminal without echoing it. */
export function promptHidden(ctx: Pick<Context, "stdin" | "stderr">, question: string): Promise<string> {
  const { stdin, stderr } = ctx;
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    let escape = false;
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of chunk.toString()) {
        if (escape) {
          // Skip the rest of an escape sequence such as an arrow key.
          if (/[A-Za-z~]/.test(ch)) escape = false;
          continue;
        }
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("Canceled", EXIT_INTERRUPTED));
          return;
        }
        if (ch === "\u001b") escape = true;
        else if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** A key given with --api-key, pasted with --paste, or piped on stdin. Empty means: log in through the browser. */
async function givenKey(session: Session, paste: boolean): Promise<string> {
  const { ctx } = session;
  if (session.globals.apiKey) return session.globals.apiKey;
  if (paste && ctx.stdin.isTTY) {
    session.out.err("Create an API key in the SMTPfast dashboard, then paste it here. It will not be shown.");
    return promptHidden(ctx, "API key: ");
  }
  if (ctx.stdin.isTTY) return "";
  return (await readAll(ctx.stdin)).trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** What the API accepts as a hostname; anything else is replaced, and an empty result is left out. */
export function keyHostname(raw: string): string | undefined {
  const name = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 63);
  return name || undefined;
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const expired = () => new CliError("The code expired before it was approved.", EXIT_API, "Run smtpfast login again.");

/**
 * The browser login (POST /v1/cli/device, then POST /v1/cli/token): show a
 * code, open the approval page, and poll until someone approves or denies it.
 * Returns the new API key.
 */
async function deviceLogin(session: Session, baseUrl: string, scopes: string[] | undefined, openBrowser: boolean): Promise<{ key: string; teamName?: string }> {
  const { ctx, out } = session;
  const client = session.client({ baseUrl });
  const host = keyHostname(ctx.hostname());
  const started = await client.request({
    method: "POST",
    path: "/v1/cli/device",
    auth: false,
    body: { client_name: `SMTPfast CLI ${VERSION}`, ...(host ? { hostname: host } : {}), ...(scopes ? { scopes } : {}) },
  });
  const start = (started.data ?? {}) as Partial<DeviceStart>;
  if (typeof start.device_code !== "string" || typeof start.user_code !== "string" || !isHttpUrl(start.verification_uri)) {
    throw new CliError("The API did not start a login. Check the base URL, or log in with a key: smtpfast login --paste");
  }
  out.addSecret(start.device_code);
  const link = isHttpUrl(start.verification_uri_complete) ? start.verification_uri_complete : start.verification_uri;
  out.err(`Open ${link} and check that it shows this code:\n\n    ${out.ce.bold(start.user_code)}\n`);
  if (openBrowser && ctx.openUrl(link)) out.err(out.ce.dim("Opened it in your browser."));
  out.err("Waiting for approval... (Ctrl-C to stop)");

  let interval = Math.max(1, Number(start.interval) || 5);
  const deadline = ctx.now() + Math.max(1, Number(start.expires_in) || 600) * 1000;
  let failures = 0;
  const { signal, dispose } = session.interruptSignal();
  try {
    for (;;) {
      await ctx.sleep(interval * 1000, signal);
      if (signal.aborted) throw signal.reason;
      try {
        const res = await client.request({ method: "POST", path: "/v1/cli/token", auth: false, body: { device_code: start.device_code }, signal });
        const data = (res.data ?? {}) as { key?: unknown; team?: { name?: unknown } };
        if (typeof data.key !== "string" || !data.key) throw new CliError("The API approved the login but sent no key.");
        out.addSecret(data.key);
        return { key: data.key, teamName: typeof data.team?.name === "string" && data.team.name ? data.team.name : undefined };
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          failures = 0;
          const body = (err.body ?? {}) as { error?: unknown; error_description?: unknown; interval?: unknown };
          const reason = typeof body.error_description === "string" ? body.error_description : err.message;
          if (body.error === "slow_down") interval = typeof body.interval === "number" && body.interval > interval ? body.interval : interval + 5;
          else if (body.error === "expired_token") throw expired();
          else if (body.error === "access_denied") throw new CliError(`The login was not approved: ${reason}`);
          else if (body.error !== "authorization_pending") throw new CliError(reason, EXIT_API, "Run smtpfast login again.");
        } else if (signal.aborted || err instanceof InterruptError) {
          throw err;
        } else if (((err instanceof ApiError && err.status >= 500) || (err instanceof CliError && !(err instanceof ApiError))) && ++failures < 3) {
          // A network blip or a deploy; the code is still good, so keep polling.
        } else {
          throw err;
        }
      }
      if (ctx.now() >= deadline) throw expired();
    }
  } finally {
    dispose();
  }
}

/**
 * Save a key to the profile in use, and make that profile current when there
 * is none. The file is read again first, since a login or signup waits a
 * while and another run may have written it since. With keepExisting, a
 * profile that holds a key by then is left alone and the key goes to the
 * first free "<profile>-signup" profile, with the same base URL. Reading,
 * choosing and writing happen in one synchronous step.
 */
export function storeKey(
  session: Session,
  settings: Settings,
  key: string,
  extra: { email?: string; keepExisting?: boolean } = {},
): { profile: string; current: boolean } {
  const config = session.reloadConfig();
  let name = settings.profile;
  if (extra.keepExisting && config.profiles[name]?.api_key) {
    const base = `${settings.profile}-signup`;
    for (let n = 1; ; n++) {
      name = n === 1 ? base : `${base}-${n}`;
      if (!config.profiles[name]) break;
    }
  }
  const moved = name !== settings.profile;
  const profile = moved ? {} : (config.profiles[name] ?? {});
  profile.api_key = key;
  if (session.globals.baseUrl || (moved && config.profiles[settings.profile]?.base_url)) profile.base_url = settings.baseUrl;
  if (extra.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extra.email)) profile.email = extra.email;
  config.profiles[name] = profile;
  const current = !config.current || !config.profiles[config.current] || config.current === name;
  if (current) config.current = name;
  writeConfig(session.configDir, config);
  return { profile: name, current };
}

export const loginCommand: HandCommand = {
  name: "login",
  summary: "Log in through the browser, or store an API key",
  description:
    "Shows a code and opens smtpfa.st, where a team owner or admin approves it and picks the team. The CLI then gets a new API key of its own, named after this machine, checks it with GET /v1/me and saves it in the config file with permissions 600. To store a key you already have, pass it with --api-key, pipe it on stdin, or use --paste. Use --profile to keep keys for several accounts.",
  flags: [
    { name: "scopes", kind: "value", valueName: "list", description: "Comma-separated scopes for the new key. Default: the API's default key scopes" },
    { name: "browser", kind: "boolean", description: "Open the approval page in a browser (default). --no-browser only prints the link" },
    { name: "paste", kind: "boolean", description: "Paste an API key made in the dashboard instead" },
  ],
  examples: [
    "smtpfast login",
    "smtpfast login --scopes email:send,email:read,domain:read",
    "smtpfast login --profile staging --base-url https://staging.example.com/api",
    'echo "$KEY" | smtpfast login',
  ],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const settings = session.settings();
    const scopesFlag = one(parsed.values, "scopes");
    const scopes = scopesFlag === undefined ? undefined : scopesFlag.split(",").map((s) => s.trim()).filter(Boolean);
    if (scopes && scopes.length === 0) throw new UsageError("--scopes needs at least one scope");
    const paste = bool(parsed.values, "paste") ?? false;
    let key = await givenKey(session, paste);
    if (key && scopes) throw new UsageError("--scopes is for the browser login", "A key you paste keeps the scopes it was created with.");
    if (!key && paste) throw new UsageError("No API key given");
    const viaBrowser = !key;
    let teamName: string | undefined;
    if (viaBrowser) ({ key, teamName } = await deviceLogin(session, settings.baseUrl, scopes, bool(parsed.values, "browser") ?? true));
    session.out.addSecret(key);

    let me: Record<string, unknown>;
    try {
      const res = await session.client({ apiKey: key, baseUrl: settings.baseUrl }).request({ method: "GET", path: "/v1/me" });
      me = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw new CliError(`The API rejected this key (HTTP ${err.status}: ${err.message}). Nothing was saved.`);
      }
      throw err;
    }

    const madeCurrent = storeKey(session, settings, key).current;

    const out = session.out;
    const account = (me.account ?? {}) as Record<string, unknown>;
    if (out.json) {
      // Set by init, which prints the one JSON summary itself.
      if (parsed.values["from-init"] === true) return 0;
      out.jsonOut({ profile: settings.profile, current: madeCurrent, config: configPath(session.configDir), team_id: me.team_id ?? null, plan: account.tier ?? null, scopes: me.scopes ?? [] });
      return 0;
    }
    const team = teamName ? `team ${teamName}` : me.team_id ? `team ${String(me.team_id)}` : "your account";
    const plan = account.tier ? `, plan ${String(account.tier)}` : "";
    const saved = viaBrowser ? "Created and saved" : "Saved";
    out.out(`${out.c.green("Logged in")} to ${team}${plan}. ${saved} key ${maskKey(key)} as profile "${settings.profile}".`);
    if (!madeCurrent) out.out(out.c.dim(`Run "smtpfast profiles use ${settings.profile}" to make it the default.`));
    if (session.ctx.env.SMTPFAST_API_KEY) out.err(out.ce.yellow("Note: SMTPFAST_API_KEY is set. It takes precedence over the stored key."));
    return 0;
  },
};

export const logoutCommand: HandCommand = {
  name: "logout",
  summary: "Remove the stored API key",
  description: "Removes the key of the current profile, or of the profile given with --profile, from the config file.",
  flags: [],
  examples: ["smtpfast logout", "smtpfast logout --profile staging"],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const { profile } = session.settings();
    const config = session.config();
    const stored = config.profiles[profile];
    const out = session.out;
    if (!stored?.api_key) {
      out.out(`Profile "${profile}" has no stored key.`);
      return 0;
    }
    delete stored.api_key;
    if (Object.keys(stored).length === 0) delete config.profiles[profile];
    if (config.current === profile && !config.profiles[profile]) config.current = undefined;
    writeConfig(session.configDir, config);
    out.out(`Removed the stored key for profile "${profile}".`);
    if (session.ctx.env.SMTPFAST_API_KEY) out.err(out.ce.yellow("Note: SMTPFAST_API_KEY is still set and will be used."));
    return 0;
  },
};

const SOURCE_TEXT: Record<string, string> = {
  flag: "from --api-key",
  env: "from SMTPFAST_API_KEY",
  profile: "from the profile",
  default: "default",
  config: "current profile",
};

export const whoamiCommand: HandCommand = {
  name: "whoami",
  summary: "Show the team, plan and scopes of the API key in use",
  flags: [],
  examples: ["smtpfast whoami", "smtpfast whoami --profile staging --json"],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const s = session.settings();
    const res = await session.client().request({ method: "GET", path: "/v1/me" });
    const out = session.out;
    const me = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
    if (out.quiet) {
      if (me.api_key_id) out.out(String(me.api_key_id));
      return 0;
    }
    if (out.json) {
      out.jsonOut(res.data);
      return 0;
    }
    const account = (me.account ?? {}) as Record<string, unknown>;
    const rate = (me.rate_limit ?? {}) as Record<string, unknown>;
    const rows: Array<[string, unknown]> = [
      ["Profile", `${s.profile} (${SOURCE_TEXT[s.profileSource] ?? s.profileSource})`],
      ["Base URL", s.baseUrl],
      ["API key", s.apiKey ? `${maskKey(s.apiKey)} (${SOURCE_TEXT[s.apiKeySource ?? "profile"]})` : undefined],
      ["Key id", me.api_key_id],
      ["Team", me.team_id],
      ["Plan", account.tier],
      ["Account", account.status],
      ["Sending", me.team_sending_status],
      ["Scopes", Array.isArray(me.scopes) ? (me.scopes as unknown[]).join(", ") : undefined],
      ["Rate limit", rate.per_second !== undefined ? `${String(rate.per_second)} requests per second` : undefined],
    ];
    const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
    const width = Math.max(...shown.map(([k]) => k.length));
    out.out(shown.map(([k, v]) => `${out.c.bold(k.padEnd(width))}  ${String(v)}`).join("\n"));
    return 0;
  },
};

export const profilesCommand: HandCommand = {
  name: "profiles",
  summary: "List, switch and remove stored profiles",
  description: "A profile holds an API key and an optional base URL. The current profile is used when --profile and SMTPFAST_PROFILE are not set.",
  args: [
    { name: "list|use|remove", description: "What to do. Default: list." },
    { name: "name", description: "Profile name, for use and remove", optional: true },
  ],
  flags: [],
  examples: ["smtpfast profiles list", "smtpfast profiles use staging", "smtpfast profiles remove old"],
  async run(session, parsed) {
    const [action = "list", name, extra] = parsed.positionals;
    if (extra !== undefined) throw new UsageError(`Unexpected argument "${extra}"`);
    const config = session.config();
    const out = session.out;
    switch (action) {
      case "list": {
        if (name !== undefined) throw new UsageError(`Unexpected argument "${name}"`);
        const rows = Object.entries(config.profiles)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([n, p]) => ({
            name: n,
            current: n === config.current,
            api_key: p.api_key ? maskKey(p.api_key) : null,
            base_url: p.base_url ?? null,
          }));
        if (out.json) {
          out.jsonOut(rows);
          return 0;
        }
        if (out.quiet) {
          for (const r of rows) out.out(r.name);
          return 0;
        }
        if (rows.length === 0) {
          out.out("No profiles yet. Run smtpfast login to create one.");
          return 0;
        }
        const display = rows.map((r) => ({ " ": r.current ? "*" : "", name: r.name, api_key: r.api_key ?? "", base_url: r.base_url ?? "(default)" }));
        out.out(renderTable(display, out.width, out.c, [" ", "name", "api_key", "base_url"]));
        return 0;
      }
      case "use":
      case "remove": {
        if (!name) throw new UsageError(`Missing argument <name>`, `Usage: smtpfast profiles ${action} <name>`);
        validateProfileName(name);
        if (!config.profiles[name]) {
          const known = Object.keys(config.profiles);
          throw new UsageError(`No profile named "${name}"`, known.length > 0 ? `Known profiles: ${known.join(", ")}.` : "Run smtpfast login --profile <name> to create one.");
        }
        if (action === "use") {
          config.current = name;
          writeConfig(session.configDir, config);
          out.out(`Now using profile "${name}".`);
        } else {
          delete config.profiles[name];
          if (config.current === name) config.current = undefined;
          writeConfig(session.configDir, config);
          out.out(`Removed profile "${name}".`);
        }
        return 0;
      }
      default:
        throw new UsageError(`Unknown action "${action}"`, "Use list, use or remove.");
    }
  },
};
