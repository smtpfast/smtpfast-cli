import { bool, one } from "../args.js";
import { CliError, UsageError } from "../errors.js";
import type { ApiClient } from "../http.js";
import { type Colors, findList, renderTable } from "../output.js";
import { InterruptError } from "../session.js";
import { pathSegment } from "../request.js";
import { formatDuration, parseDuration } from "../util.js";
import type { HandCommand } from "./types.js";

type Row = Record<string, unknown>;

/** Accept a domain id or a domain name. A name is looked up in the domain list. */
export async function resolveDomain(client: ApiClient, input: string, signal?: AbortSignal): Promise<{ id: string; name: string }> {
  const wanted = input.trim().replace(/\.$/, "").toLowerCase();
  if (!wanted.includes(".")) return { id: input, name: input };
  const res = await client.request({ method: "GET", path: "/v1/domains", signal });
  const items = findList(res.data)?.items ?? [];
  const match = items.find((d) => typeof d.domain === "string" && d.domain.toLowerCase() === wanted);
  if (!match || typeof match.id !== "string") {
    throw new CliError(`No domain named ${input} on this account`, 1, "List your domains with smtpfast domains list, or add one with smtpfast domains add --domain <name>.");
  }
  return { id: match.id, name: String(match.domain) };
}

function statusColor(c: Colors, value: string): string {
  const v = value.toLowerCase();
  if (["verified", "success", "active", "valid", "ok", "true"].includes(v)) return c.green(value);
  if (["failed", "failure", "invalid", "error", "false"].includes(v)) return c.red(value);
  return c.yellow(value);
}

function label(key: string): string {
  return key.replace(/_/g, " ").toUpperCase();
}

const RECORD_STATUS_KEYS = ["status", "verified", "valid", "verification_status"];

/** Lines that describe one verify response: the domain status, each check, and any per-record status. */
export function describeVerification(result: Row, c: Colors, fallbackName: string): string[] {
  const name = typeof result.domain === "string" ? result.domain : fallbackName;
  const status = typeof result.status === "string" ? result.status : "unknown";
  const phase = typeof result.verification_phase === "string" ? c.dim(` (${result.verification_phase})`) : "";
  const lines = [`${c.bold(name)}: ${statusColor(c, status)}${phase}`];
  if (result.checks && typeof result.checks === "object") {
    const entries = Object.entries(result.checks as Row);
    const width = Math.max(...entries.map(([k]) => label(k).length));
    for (const [k, v] of entries) lines.push(`  ${label(k).padEnd(width)}  ${statusColor(c, String(v ?? "unknown"))}`);
  }
  if (Array.isArray(result.dns_records)) {
    for (const r of result.dns_records as Row[]) {
      const key = RECORD_STATUS_KEYS.find((k) => r[k] !== undefined);
      const st = key ? String(r[key]) : undefined;
      lines.push(`  ${String(r.type ?? "").padEnd(5)}  ${String(r.name ?? "")}${st ? `  ${statusColor(c, st)}` : ""}`);
    }
  }
  if (typeof result.message === "string" && result.message) lines.push(c.dim(`  ${result.message}`));
  return lines;
}

function isVerified(result: Row): boolean {
  return typeof result.status === "string" && result.status.toLowerCase() === "verified";
}

export const domainsVerifyCommand: HandCommand = {
  group: "domains",
  name: "verify",
  replaces: "verifyDomain",
  summary: "Verify a domain, and optionally wait until its DNS records pass",
  description:
    "Asks SMTPfast to check the domain's DNS records and prints the result of each check. With --wait it checks again at each interval until the domain is verified or the timeout passes. The domain can be its id or its name.",
  args: [{ name: "id-or-name", description: "Domain id, or the domain name like acme.com" }],
  flags: [
    { name: "wait", kind: "boolean", description: "Keep checking until the domain is verified. Exits 1 on timeout." },
    { name: "timeout", kind: "value", valueName: "duration", description: "How long --wait keeps checking, like 30s, 10m or 1h. Default 10m." },
    { name: "interval", kind: "value", valueName: "duration", description: "Time between checks with --wait. Default 10s." },
  ],
  examples: ["smtpfast domains verify acme.com", "smtpfast domains verify acme.com --wait --timeout 30m"],
  async run(session, parsed) {
    const { values, positionals } = parsed;
    const input = positionals[0];
    if (!input) throw new UsageError("Missing argument <id-or-name>");
    if (positionals.length > 1) throw new UsageError(`Unexpected argument "${positionals[1]}"`);
    const wait = bool(values, "wait") ?? false;
    if (!wait && (one(values, "timeout") || one(values, "interval"))) throw new UsageError("--timeout and --interval only work with --wait");
    const timeoutMs = parseDuration(one(values, "timeout") ?? "10m", "timeout");
    const intervalMs = Math.max(1000, parseDuration(one(values, "interval") ?? "10s", "interval"));

    const out = session.out;
    const { signal, dispose } = session.interruptSignal();
    try {
      const client = session.client();
      const domain = await resolveDomain(client, input, signal);
      const verify = async () => {
        const res = await client.request({ method: "POST", path: `/v1/domains/${pathSegment(domain.id, "id-or-name")}/verify`, signal });
        return (res.data && typeof res.data === "object" ? res.data : {}) as Row;
      };

      let result = await verify();
      if (!wait) {
        if (out.json || out.quiet) out.result(result);
        else out.out(describeVerification(result, out.c, domain.name).join("\n"));
        return 0;
      }

      // Progress goes to stdout on a terminal and to stderr when stdout carries JSON.
      const progress = (text: string) => (out.json || out.quiet ? out.err(text) : out.out(text));
      const colors = out.json || out.quiet ? out.ce : out.c;
      const started = session.ctx.now();
      let lastBlock = "";
      let shownRecords = false;
      for (;;) {
        const block = describeVerification(result, colors, domain.name).join("\n");
        if (block !== lastBlock) {
          progress(block);
          lastBlock = block;
        }
        if (isVerified(result)) {
          if (out.json || out.quiet) out.result(result);
          else out.out(out.c.green(`${domain.name} is verified.`));
          return 0;
        }
        if (!shownRecords && !out.json && !out.quiet) {
          shownRecords = true;
          try {
            const res = await client.request({ method: "GET", path: `/v1/domains/${pathSegment(domain.id, "id-or-name")}`, signal });
            const records = (res.data as Row | null)?.dns_records;
            if (Array.isArray(records) && records.length > 0) {
              out.out(`\n${out.c.bold("DNS records for this domain:")}`);
              out.out(renderTable(records as Row[], out.width, out.c, ["type", "name", "value"]));
              out.out("");
            }
          } catch (err) {
            if (signal.aborted) throw err;
          }
        }
        const elapsed = session.ctx.now() - started;
        if (elapsed + intervalMs > timeoutMs) {
          const status = typeof result.status === "string" ? result.status : "not verified";
          const name = typeof result.domain === "string" ? result.domain : domain.name;
          throw new CliError(
            `Timed out after ${formatDuration(timeoutMs)}: ${name} is still ${status}`,
            1,
            "DNS changes can take a while to spread. Run the command again later.",
          );
        }
        progress(colors.dim(`Checking again in ${formatDuration(intervalMs)}. Press Ctrl-C to stop.`));
        await session.ctx.sleep(intervalMs, signal);
        if (signal.aborted) throw new InterruptError();
        result = await verify();
      }
    } finally {
      dispose();
    }
  },
};
