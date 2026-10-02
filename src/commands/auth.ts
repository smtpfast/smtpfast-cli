import { renderTable } from "../output.js";
import { configPath, validateProfileName, writeConfig } from "../config.js";
import type { Context } from "../context.js";
import { ApiError, CliError, EXIT_INTERRUPTED, UsageError } from "../errors.js";
import type { Session } from "../session.js";
import { maskKey, readAll } from "../util.js";
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

async function readKey(session: Session): Promise<string> {
  const { ctx } = session;
  if (session.globals.apiKey) return session.globals.apiKey;
  if (ctx.stdin.isTTY) {
    session.out.err("Create an API key in the SMTPfast dashboard, then paste it here. It will not be shown.");
    return promptHidden(ctx, "API key: ");
  }
  return (await readAll(ctx.stdin)).trim().split(/\r?\n/)[0]?.trim() ?? "";
}

export const loginCommand: HandCommand = {
  name: "login",
  summary: "Store an API key",
  description:
    "Asks for an API key without showing it, checks it with GET /v1/me, and saves it in the config file with permissions 600. Use --profile to keep keys for several accounts. Pass the key with --api-key or on stdin to log in without a prompt.",
  flags: [],
  examples: ["smtpfast login", "smtpfast login --profile staging --base-url https://staging.example.com/api", 'echo "$KEY" | smtpfast login'],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const settings = session.settings();
    const key = await readKey(session);
    if (!key) throw new UsageError("No API key given");

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

    const config = session.config();
    const profile = config.profiles[settings.profile] ?? {};
    profile.api_key = key;
    if (session.globals.baseUrl) profile.base_url = settings.baseUrl;
    config.profiles[settings.profile] = profile;
    const madeCurrent = !config.current || !config.profiles[config.current] || config.current === settings.profile;
    if (madeCurrent) config.current = settings.profile;
    writeConfig(session.configDir, config);

    const out = session.out;
    const account = (me.account ?? {}) as Record<string, unknown>;
    if (out.json) {
      out.jsonOut({ profile: settings.profile, current: madeCurrent, config: configPath(session.configDir), team_id: me.team_id ?? null, plan: account.tier ?? null, scopes: me.scopes ?? [] });
      return 0;
    }
    const team = me.team_id ? `team ${String(me.team_id)}` : "your account";
    const plan = account.tier ? `, plan ${String(account.tier)}` : "";
    out.out(`${out.c.green("Logged in")} to ${team}${plan}. Saved key ${maskKey(key)} as profile "${settings.profile}".`);
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
