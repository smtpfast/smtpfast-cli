import { bool, type FlagValues, one } from "../args.js";
import { ApiError, CliError, EXIT_API, UsageError } from "../errors.js";
import type { ApiClient } from "../http.js";
import { confirm, interactive, prompt, readLine } from "../prompt.js";
import { InterruptError, type Session } from "../session.js";
import { formatDuration, maskKey, parseDuration } from "../util.js";
import { VERSION } from "../version.js";
import { keyHostname, storeKey } from "./auth.js";
import type { HandCommand } from "./types.js";

type Row = Record<string, unknown>;

/** The reason the API gave, from `error_description` or the message. */
function reason(err: ApiError): string {
  const body = (err.body ?? {}) as Row;
  return typeof body.error_description === "string" ? body.error_description : err.message;
}

const errorCode = (err: unknown): string | undefined =>
  err instanceof ApiError && typeof (err.body as Row | null)?.error === "string" ? String((err.body as Row).error) : undefined;

export interface Activation {
  status: string;
  email?: string;
  plan?: string;
  free_trial_requested_at?: string | null;
  rejection_reason?: string | null;
}

/** GET /v1/account/activation. Null from a server that predates it, which only has active accounts with keys. */
export async function readActivation(client: ApiClient, signal?: AbortSignal): Promise<Activation | null> {
  try {
    const res = await client.request({ method: "GET", path: "/v1/account/activation", signal });
    const data = (res.data ?? {}) as Row;
    return typeof data.status === "string" ? (data as unknown as Activation) : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

const PLANS = ["starter", "growth", "scale"];

export interface ActivationChoice {
  plan?: string;
  interval?: string;
  useCase?: string;
  source?: string;
  invite?: string;
}

/** Ask a person how to activate. Undefined means not now. */
async function chooseActivation(session: Session): Promise<ActivationChoice | undefined> {
  const { ctx, out } = session;
  out.err(
    [
      "Choose how to activate it:",
      "  1) Pay for a plan (opens Stripe Checkout)",
      "  2) Request the free plan (a person reviews the request and emails you)",
      "  3) Enter an invite code",
      "  4) Not now",
    ].join("\n"),
  );
  const pick = await prompt(ctx, "Choice [1-4]: ");
  if (pick === "1") {
    const plan = (await prompt(ctx, `Plan (${PLANS.join(", ")}) [growth]: `)) || "growth";
    const interval = (await prompt(ctx, "Billed monthly or yearly [monthly]: ")) || "monthly";
    return { plan, interval };
  }
  if (pick === "2") {
    const useCase = await prompt(ctx, "What will you send with SMTPfast? A sentence or two: ");
    return useCase ? { useCase } : undefined;
  }
  if (pick === "3") {
    const invite = await prompt(ctx, "Invite code: ");
    return invite ? { invite } : undefined;
  }
  return undefined;
}

/** Poll until the account is active, for the Checkout path. */
async function waitForActive(session: Session, client: ApiClient, timeoutMs: number): Promise<boolean> {
  const { ctx, out } = session;
  out.err(out.ce.dim(`Waiting for the payment to come through (up to ${formatDuration(timeoutMs)}, Ctrl-C to stop)...`));
  const deadline = ctx.now() + timeoutMs;
  const { signal, dispose } = session.interruptSignal();
  try {
    while (ctx.now() < deadline) {
      await ctx.sleep(5000, signal);
      if (signal.aborted) throw new InterruptError();
      const now = await readActivation(client, signal);
      if (!now || now.status === "active") return true;
    }
    return false;
  } finally {
    dispose();
  }
}

/**
 * Carry out one activation choice and say what happened. Returns the account
 * status afterwards: "active", or "pending" when a person still has to act.
 */
export async function activate(
  session: Session,
  client: ApiClient,
  choice: ActivationChoice,
  opts: { openBrowser: boolean; wait: boolean; timeoutMs: number },
): Promise<string> {
  const { ctx, out } = session;
  if (choice.invite) {
    await client.request({ method: "POST", path: "/v1/account/activation/invite", body: { code: choice.invite } });
    out.err(out.ce.green("The account is active on the free plan."));
    return "active";
  }
  if (choice.useCase) {
    const res = await client.request({
      method: "POST",
      path: "/v1/account/activation/free-trial",
      body: { use_case: choice.useCase, ...(choice.source ? { source: choice.source } : {}) },
    });
    const message = typeof (res.data as Row | null)?.message === "string" ? String((res.data as Row).message) : "Request sent.";
    out.err(message);
    return "pending";
  }
  if (choice.plan) {
    const res = await client.request({
      method: "POST",
      path: "/v1/account/activation/checkout",
      body: { plan: choice.plan, ...(choice.interval ? { interval: choice.interval } : {}) },
    });
    const url = (res.data as Row | null)?.url;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new CliError("The API did not return a Checkout link.");
    out.err(`Pay for the ${choice.plan} plan here:\n\n    ${url}\n`);
    if (opts.openBrowser && ctx.openUrl(url)) out.err(out.ce.dim("Opened it in your browser."));
    if (!opts.wait) {
      out.err("The account is active as soon as Stripe confirms the payment. Check with: smtpfast activate");
      return "pending";
    }
    if (await waitForActive(session, client, opts.timeoutMs)) {
      out.err(out.ce.green("Payment received. The account is active."));
      return "active";
    }
    out.err("Not paid yet. The account turns active as soon as Stripe confirms the payment; check with: smtpfast activate");
    return "pending";
  }
  return "pending";
}

function describeStatus(a: Activation): string {
  if (a.status === "active") return `The account is active${a.plan ? ` on the ${a.plan} plan` : ""}.`;
  if (a.status === "rejected") return `The account was not approved${a.rejection_reason ? `: ${a.rejection_reason}` : "."}`;
  if (a.free_trial_requested_at) return "The account is pending. Your free-plan request is waiting for review; you will get an email.";
  return "The account is pending activation. Until it is active, the API key can only check and ask for activation.";
}

/**
 * Show the state and, for a pending account, activate it: with the flags, or
 * by asking when a person is there. Returns the status afterwards.
 */
export async function activationStep(
  session: Session,
  client: ApiClient,
  choice: ActivationChoice,
  opts: { openBrowser: boolean; wait: boolean; timeoutMs: number; ask?: boolean },
): Promise<string> {
  const { out } = session;
  const ask = opts.ask ?? interactive(session.ctx);
  const now = await readActivation(client);
  if (!now) return "active";
  if (now.status !== "pending") {
    out.err(describeStatus(now));
    return now.status;
  }
  const given = choice.plan || choice.useCase || choice.invite;
  if (!given) {
    out.err(describeStatus(now));
    if (now.free_trial_requested_at || !ask) {
      if (!now.free_trial_requested_at) {
        out.err("Activate with one of:\n  smtpfast activate --plan growth\n  smtpfast activate --free-trial \"what you will send\"\n  smtpfast activate --invite SF-XXXX-XXXX");
      }
      return "pending";
    }
    const picked = await chooseActivation(session);
    if (!picked) return "pending";
    return activate(session, client, picked, opts);
  }
  return activate(session, client, choice, opts);
}

function choiceFromFlags(values: FlagValues): ActivationChoice {
  const plan = one(values, "plan");
  if (plan !== undefined && !PLANS.includes(plan)) throw new UsageError(`--plan must be one of ${PLANS.join(", ")}`);
  const interval = one(values, "interval");
  if (interval !== undefined && interval !== "monthly" && interval !== "yearly") throw new UsageError("--interval must be monthly or yearly");
  const choice: ActivationChoice = { plan, interval, useCase: one(values, "free-trial"), source: one(values, "source"), invite: one(values, "invite") };
  const picked = [choice.plan, choice.useCase, choice.invite].filter((v) => v !== undefined).length;
  if (picked > 1) throw new UsageError("Pick one of --plan, --free-trial and --invite");
  if (interval && !plan) throw new UsageError("--interval goes with --plan");
  return choice;
}

const ACTIVATION_FLAGS = [
  { name: "plan", kind: "value" as const, valueName: "plan", description: "Pay for starter, growth or scale through Stripe Checkout" },
  { name: "interval", kind: "value" as const, valueName: "interval", description: "monthly (default) or yearly, with --plan" },
  { name: "free-trial", kind: "value" as const, valueName: "use case", description: "Request the free plan; say what you will send" },
  { name: "source", kind: "value" as const, valueName: "source", description: "With --free-trial: how you heard about SMTPfast", hidden: true },
  { name: "invite", kind: "value" as const, valueName: "code", description: "Activate the free plan with an invite code" },
  { name: "wait", kind: "boolean" as const, description: "With --plan: wait until the payment is confirmed (default on a terminal)" },
  { name: "timeout", kind: "value" as const, valueName: "duration", description: "How long --wait waits. Default 30m." },
  { name: "browser", kind: "boolean" as const, description: "Open the Checkout link in a browser (default). --no-browser only prints it" },
];

export function activationOptions(session: Session, values: FlagValues) {
  return {
    openBrowser: bool(values, "browser") ?? true,
    wait: bool(values, "wait") ?? interactive(session.ctx),
    timeoutMs: parseDuration(one(values, "timeout") ?? "30m", "timeout"),
  };
}

export const activateCommand: HandCommand = {
  name: "activate",
  summary: "Activate a new account: pay for a plan, request the free plan, or use an invite code",
  description:
    "A new account can send once it is active. Shows where the account stands and, while it is pending, activates it with the flag given or, on a terminal, by asking. Works with the key smtpfast signup saved.",
  flags: ACTIVATION_FLAGS,
  examples: [
    "smtpfast activate",
    "smtpfast activate --plan growth --interval yearly",
    'smtpfast activate --free-trial "Password resets and receipts for our app at example.com"',
    "smtpfast activate --invite SF-AB12-CD34",
  ],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const choice = choiceFromFlags(parsed.values);
    const client = session.client();
    const status = await activationStep(session, client, choice, activationOptions(session, parsed.values));
    const out = session.out;
    if (out.json) out.jsonOut({ status });
    else if (status === "active") out.out(out.c.green("Active."));
    return status === "rejected" ? EXIT_API : 0;
  },
};

interface Started {
  signup_id: string;
  email?: string;
  expires_in?: number;
  code_length?: number;
}

async function startSignup(session: Session, baseUrl: string, email: string, name: string | undefined, newsletter: boolean): Promise<Started> {
  const host = keyHostname(session.ctx.hostname());
  const res = await session.client({ baseUrl }).request({
    method: "POST",
    path: "/v1/cli/signup",
    auth: false,
    body: { email, ...(name ? { name } : {}), newsletter, client_name: `SMTPfast CLI ${VERSION}`, ...(host ? { hostname: host } : {}) },
  });
  const data = (res.data ?? {}) as Partial<Started>;
  if (typeof data.signup_id !== "string") throw new CliError("The API did not start a signup. Check the base URL.");
  return data as Started;
}

/** The code from --code, the terminal, or the first line of stdin. Null when there is none. */
async function readCode(session: Session, flag: string | undefined, again: boolean): Promise<string | null> {
  if (flag !== undefined && !again) return flag;
  if (interactive(session.ctx)) return prompt(session.ctx, again ? "Code (try again): " : "Code from the email: ");
  if (again) return null;
  const line = await readLine(session.ctx);
  return line === null ? null : line.trim() || null;
}

export const signupCommand: HandCommand = {
  name: "signup",
  summary: "Create an SMTPfast account from the terminal",
  description:
    "Emails a code to the address; entering it creates the account and saves its first API key, as login does. A new account is pending until it is activated (see smtpfast activate). Agents can pass --email and pipe the code on stdin, or run it in two steps with --send-only and then --signup-id with --code.",
  flags: [
    { name: "email", kind: "value", valueName: "address", description: "The address for the account. Asked for on a terminal." },
    { name: "name", kind: "value", valueName: "name", description: "Your name, optional" },
    { name: "code", kind: "value", valueName: "code", description: "The code from the email. Without it the code is asked for, or read from stdin." },
    { name: "send-only", kind: "boolean", description: "Send the code, print the signup id, and stop" },
    { name: "signup-id", kind: "value", valueName: "id", description: "Finish a signup started with --send-only" },
    { name: "newsletter", kind: "boolean", description: "Get the monthly product update email (default). --no-newsletter to skip it" },
    ...ACTIVATION_FLAGS,
  ],
  examples: [
    "smtpfast signup",
    "smtpfast signup --email you@example.com --plan growth",
    "smtpfast signup --email you@example.com --send-only --json",
    "echo 4831-0927 | smtpfast signup --signup-id <id>",
  ],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    return (await runSignup(session, parsed.values, { fromInit: false })).code;
  },
};

/** The signup command. From init, activation and the next steps are left to init. */
export async function runSignup(session: Session, values: FlagValues, { fromInit }: { fromInit: boolean }): Promise<{ code: number; profile?: string }> {
  const { ctx, out } = session;
  const settings = session.settings();
  const choice = choiceFromFlags(values);
  const sendOnly = bool(values, "send-only") ?? false;
  let signupId = one(values, "signup-id");
  if (sendOnly && signupId) throw new UsageError("--send-only starts a signup; --signup-id finishes one");
  if (!sendOnly && session.config().profiles[settings.profile]?.api_key) {
    throw new UsageError(
      `Profile "${settings.profile}" already has an API key`,
      "Sign up into another profile with --profile <name>, or run smtpfast logout first.",
      false,
    );
  }

  if (!signupId) {
    let email = one(values, "email");
    let name = one(values, "name");
    const asked = !email && interactive(ctx);
    if (asked) {
      email = (await prompt(ctx, "Email: ")) ?? undefined;
      if (name === undefined) name = (await prompt(ctx, "Your name (optional): ")) || undefined;
    }
    if (!email) throw new UsageError("Missing --email", "Pass the address for the new account with --email.");
    // The signup form shows this as a ticked box; a person typing the address gets the same question.
    let newsletter = bool(values, "newsletter");
    if (newsletter === undefined) newsletter = asked ? await confirm(ctx, "Get the monthly product update email?") : true;
    const started = await startSignup(session, settings.baseUrl, email, name, newsletter);
    signupId = started.signup_id;
    const minutes = Math.round((started.expires_in ?? 600) / 60);
    if (sendOnly) {
      if (out.json) out.jsonOut(started);
      else out.out(signupId);
      out.err(`Sent a code to ${email}. Finish within ${minutes} minutes: smtpfast signup --signup-id ${signupId} --code <code>`);
      return { code: 0 };
    }
    out.err(`Sent a code to ${email}. It works for ${minutes} minutes.`);
    out.err(out.ce.dim("If the email says you already have an account, run smtpfast login instead."));
  }

  let data: Row | undefined;
  let again = false;
  for (;;) {
    const code = await readCode(session, one(values, "code"), again);
    if (!code) throw new UsageError("No code given", "Pass it with --code, or on stdin.", false);
    out.addSecret(code);
    out.addSecret(code.replace(/[\s-]/g, ""));
    try {
      const res = await session.client({ baseUrl: settings.baseUrl }).request({
        method: "POST",
        path: "/v1/cli/signup/verify",
        auth: false,
        body: { signup_id: signupId, code },
      });
      data = (res.data ?? {}) as Row;
      break;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const left = (err.body as Row | null)?.attempts_remaining;
      if (errorCode(err) === "invalid_code" && interactive(ctx) && typeof left === "number" && left > 0) {
        out.err(`${reason(err)} ${left} ${left === 1 ? "try" : "tries"} left.`);
        again = true;
        continue;
      }
      const hint = errorCode(err) === "account_exists" ? "Run smtpfast login." : errorCode(err) === "invalid_code" || errorCode(err) === "expired_code" ? "Run smtpfast signup again for a new code." : undefined;
      throw new CliError(reason(err), EXIT_API, hint);
    }
  }

  const key = typeof data.key === "string" ? data.key : "";
  if (!key) throw new CliError("The API created the account but sent no key.");
  out.addSecret(key);
  const team = (data.team ?? {}) as Row;
  const account = (data.account ?? {}) as Row;
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // Another run may have saved a key to this profile while the code was on its way.
  const saved = storeKey(session, settings, key, { email: str(account.email) || undefined, keepExisting: true });
  const target = { ...settings, profile: saved.profile };
  const madeCurrent = saved.current;
  if (saved.profile !== settings.profile) {
    out.err(out.ce.yellow(`Profile "${settings.profile}" got a key meanwhile, so the new key is saved as profile "${saved.profile}".`));
  }

  if (out.json) {
    // From init, init prints the one JSON summary.
    if (fromInit) return { code: 0, profile: saved.profile };
    const client = session.client({ apiKey: key, baseUrl: settings.baseUrl });
    const status = choice.plan || choice.useCase || choice.invite ? await activationStep(session, client, choice, activationOptions(session, values)) : str(account.status) || "pending";
    const summary = {
      profile: target.profile,
      current: madeCurrent,
      account: { id: str(account.id), email: str(account.email), status },
      team: { id: str(team.id), name: str(team.name) },
      key_prefix: str(data.prefix) || null,
      scopes: Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === "string") : [],
    };
    out.out(out.redact(JSON.stringify(summary, null, 2)));
    return { code: 0, profile: saved.profile };
  }
  out.out(out.redact(`${out.c.green("Created")} account ${str(account.email)} and team "${str(team.name)}". Saved key ${maskKey(key)} as profile "${target.profile}".`));
  if (!madeCurrent) out.out(out.c.dim(`Run "smtpfast profiles use ${target.profile}" to make it the default.`));
  out.err(out.ce.dim("The account has no password. To use the dashboard later, set one with Forgot password on the login page."));
  if (fromInit) return { code: 0, profile: saved.profile };

  const client = session.client({ apiKey: key, baseUrl: settings.baseUrl });
  const status = await activationStep(session, client, choice, activationOptions(session, values));
  if (status === "active") out.out(`Next: ${out.c.bold("smtpfast init")} adds a domain and sends a test email.`);
  else out.out(`Next: activate the account with ${out.c.bold("smtpfast activate")}, then run ${out.c.bold("smtpfast init")}.`);
  return { code: 0, profile: saved.profile };
}

/** For init: ask whether a person wants the browser login or a new account. */
export async function askLoginOrSignup(session: Session): Promise<"login" | "signup" | undefined> {
  const answer = await prompt(session.ctx, "No API key yet. [l]og in to an existing account, [s]ign up for a new one, or [q]uit? ");
  if (answer && /^l/i.test(answer)) return "login";
  if (answer && /^s/i.test(answer)) return "signup";
  return undefined;
}

