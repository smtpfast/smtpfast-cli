import { bool, type FlagValues, one } from "../args.js";
import { ApiError, CliError, EXIT_API, UsageError } from "../errors.js";
import { findList, renderTable } from "../output.js";
import { confirm, interactive, prompt } from "../prompt.js";
import { pathSegment } from "../request.js";
import { parseDuration } from "../util.js";
import { loginCommand } from "./auth.js";
import { describeVerification, isVerified, verifyOnce, waitForVerification } from "./domains-verify.js";
import { activationOptions, activationStep, askLoginOrSignup, runSignup } from "./signup.js";
import type { HandCommand } from "./types.js";

type Row = Record<string, unknown>;

const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const STEPS = 6;

export const initCommand: HandCommand = {
  name: "init",
  summary: "Set up sending from the terminal: account, domain, DNS, verification and a test email",
  description:
    "Walks through everything the dashboard would: logs in or signs up when there is no key, activates a new account, adds a domain, sets its DNS records through Domain Connect when the DNS host supports it (or prints them), waits until the domain is verified, and offers a test email to the address smtpfast signup saved (or --to). Every step is skipped when it is already done, so running it again is safe. Without a terminal nothing is asked: pass the flags.",
  flags: [
    { name: "domain", kind: "value", valueName: "name", description: "The domain to send from, like mail.example.com" },
    { name: "skip-domain", kind: "boolean", description: "Stop after the account steps" },
    { name: "domain-connect", kind: "boolean", description: "Set the records through Domain Connect when the DNS host supports it (default). --no-domain-connect only prints them" },
    { name: "wait", kind: "boolean", description: "Wait until the domain is verified (default). --no-wait checks once" },
    { name: "timeout", kind: "value", valueName: "duration", description: "How long to wait for verification, like 10m or 1h. Default 10m." },
    { name: "test-email", kind: "boolean", description: "Send a test email to the account's own address. Asked on a terminal; off without one" },
    { name: "from", kind: "value", valueName: "address", description: "Sender of the test email. Default hello@<domain>" },
    { name: "to", kind: "value", valueName: "address", description: "Recipient of the test email. Default: the address smtpfast signup saved, or asked" },
    { name: "yes", short: "y", kind: "boolean", description: "Take the default answer to every question" },
    { name: "browser", kind: "boolean", description: "Open links in a browser (default). --no-browser only prints them" },
  ],
  examples: [
    "npx smtpfast init",
    "smtpfast init --domain mail.example.com",
    "smtpfast init --domain mail.example.com --no-domain-connect --timeout 30m --test-email --to you@example.com",
  ],
  async run(session, parsed) {
    if (parsed.positionals.length > 0) throw new UsageError(`Unexpected argument "${parsed.positionals[0]}"`);
    const { values } = parsed;
    const { ctx, out } = session;
    const yes = bool(values, "yes") ?? false;
    const ask = interactive(ctx) && !yes;
    const openBrowser = bool(values, "browser") ?? true;
    const timeoutMs = parseDuration(one(values, "timeout") ?? "10m", "timeout");
    const summary: Row = {};
    const step = (n: number, title: string) => out.err(out.ce.bold(`\n[${n}/${STEPS}] ${title}`));
    const finish = (code = 0) => {
      if (out.json) out.out(out.redact(JSON.stringify(summary, null, 2)));
      return code;
    };

    step(1, "Account");
    let settings = session.settings();
    if (settings.apiKey) {
      out.err(`Using profile "${settings.profile}".`);
    } else {
      if (!ask) throw new UsageError("No API key found", "Run smtpfast login or smtpfast signup first, or pass --api-key.", false);
      const pick = await askLoginOrSignup(session);
      if (!pick) return 0;
      const passed: FlagValues = { browser: openBrowser, "from-init": true };
      if (pick === "login") {
        const code = await loginCommand.run(session, { positionals: [], values: passed });
        if (code !== 0) return code;
      } else {
        const signedUp = await runSignup(session, {}, { fromInit: true });
        if (signedUp.code !== 0) return signedUp.code;
        // The key may have gone to another profile; carry on with that one.
        if (signedUp.profile) session.globals.profile = signedUp.profile;
      }
      session.reloadConfig();
      settings = session.settings();
      if (!settings.apiKey) throw new CliError("No API key was saved.");
    }
    summary.profile = settings.profile;
    const client = session.client();

    step(2, "Activation");
    const status = await activationStep(session, client, {}, { ...activationOptions(session, values), wait: ask, ask });
    summary.account_status = status;
    if (status !== "active") {
      if (status === "rejected") throw new CliError("The account cannot be activated.", EXIT_API, "Write to support@smtpfa.st.");
      if (!ask) throw new CliError("The account is not active yet.", EXIT_API, "Activate it with smtpfast activate, then run smtpfast init again.");
      out.err("Run smtpfast init again once the account is active.");
      return finish();
    }

    step(3, "Domain");
    if (bool(values, "skip-domain")) {
      out.err("Skipped.");
      return finish();
    }
    let name = one(values, "domain");
    if (!name && ask) name = (await prompt(ctx, "Domain to send from, like mail.example.com (Enter to skip): ")) || undefined;
    if (!name) {
      out.err("No domain given, so the rest is skipped. Run smtpfast init --domain <name> later.");
      return finish();
    }
    name = name.trim().replace(/\.$/, "").toLowerCase();
    if (!DOMAIN_NAME.test(name)) throw new UsageError(`"${name}" is not a domain name`);
    const listed = await client.request({ method: "GET", path: "/v1/domains" });
    let domain = findList(listed.data)?.items.find((d) => typeof d.domain === "string" && d.domain.toLowerCase() === name);
    if (domain) {
      out.err(`${name} is already on the account.`);
    } else {
      const res = await client.request({ method: "POST", path: "/v1/domains", body: { domain: name } });
      domain = (res.data ?? {}) as Row;
      out.err(`Added ${name}.`);
    }
    if (typeof domain.id !== "string") throw new CliError("The API did not return the domain's id.");
    const id = domain.id;
    summary.domain = { id, name };

    step(4, "DNS records");
    let verified = isVerified(domain);
    if (verified) {
      out.err("Already verified, nothing to change.");
    } else {
      let connected = false;
      if (bool(values, "domain-connect") ?? true) {
        try {
          const res = await client.request({ method: "POST", path: `/v1/domains/${pathSegment(id, "id")}/domain-connect/cloudflare` });
          const link = (res.data as Row | null)?.url;
          if (typeof link === "string" && /^https:\/\//.test(link)) {
            const provider = (res.data as Row).provider;
            out.err(`The DNS for ${name} is on ${typeof provider === "string" && provider ? provider : "Cloudflare"}. Approve the records there:\n\n    ${link}\n`);
            if (openBrowser && ctx.openUrl(link)) out.err(out.ce.dim("Opened it in your browser."));
            summary.domain_connect_url = link;
            connected = true;
          }
        } catch (err) {
          // 409: the DNS host has no Domain Connect, 503: signing is not set up. Either way, print the records.
          if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 503)) throw err;
        }
      }
      if (!connected) {
        const res = await client.request({ method: "GET", path: `/v1/domains/${pathSegment(id, "id")}` });
        const records = (res.data as Row | null)?.dns_records;
        if (Array.isArray(records) && records.length > 0) {
          out.err(`Add these records at the DNS host of ${name}:`);
          out.err(renderTable(records as Row[], out.width, out.ce, ["type", "name", "value"]));
          summary.dns_records = records;
        }
      }
    }

    step(5, "Verification");
    if (!verified) {
      const { signal, dispose } = session.interruptSignal();
      try {
        if (bool(values, "wait") ?? true) {
          try {
            await waitForVerification(session, client, { id, name }, { timeoutMs, intervalMs: 10_000, signal, showRecords: false });
            verified = true;
          } catch (err) {
            if (!(err instanceof CliError) || !/^Timed out/.test(err.message)) throw err;
            summary.verified = false;
            out.err(err.message);
            out.err(`Run smtpfast domains verify ${name} --wait later, or smtpfast init --domain ${name} again.`);
            return finish(EXIT_API);
          }
        } else {
          const result = await verifyOnce(client, id, signal);
          out.err(describeVerification(result, out.ce, name).join("\n"));
          verified = isVerified(result);
        }
      } finally {
        dispose();
      }
    }
    summary.verified = verified;
    if (!verified) {
      out.err(`Not verified yet. Check again with smtpfast domains verify ${name} --wait.`);
      return finish();
    }
    out.err(out.ce.green(`${name} is verified.`));

    step(6, "Test email");
    // The account's address is not something the API hands to any key, so it comes from --to or from signup.
    let to = one(values, "to") ?? session.config().profiles[settings.profile]?.email;
    let send = bool(values, "test-email");
    if (send === undefined) {
      if (ask && to) send = await confirm(ctx, out.redact(`Send a test email to ${to}?`));
      else if (ask) {
        to = (await prompt(ctx, "Send a test email to (an address, or Enter to skip): ")) || undefined;
        send = !!to;
      } else send = yes && !!to;
    }
    if (!send) {
      out.err("Skipped.");
      return finish();
    }
    if (!to) throw new UsageError("No address for the test email", "Pass --to <address>.");
    const from = one(values, "from") ?? `hello@${name}`;
    const res = await client.request({
      method: "POST",
      path: "/v1/emails",
      body: {
        from,
        to,
        subject: "Your SMTPfast test email",
        text: `This test email was sent by smtpfast init from ${from}. If it reached your inbox, ${name} is ready to send.`,
      },
    });
    const emailId = (res.data as Row | null)?.id;
    summary.test_email = { id: emailId ?? null, from, to };
    out.err(`Sent a test email to ${to}.${typeof emailId === "string" ? ` Follow it with: smtpfast emails get ${emailId}` : ""}`);
    if (!out.json) out.out(out.c.green("All set."));
    return finish();
  },
};
