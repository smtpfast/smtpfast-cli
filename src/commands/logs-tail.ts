import { many, one } from "../args.js";
import { ApiError, UsageError } from "../errors.js";
import type { ApiClient, Query } from "../http.js";
import type { Colors } from "../output.js";
import { parseDuration, splitList } from "../util.js";
import type { HandCommand } from "./types.js";

export type LogEvent = Record<string, unknown> & { id?: string };

interface Page {
  events: LogEvent[];
  hasMore: boolean;
}

async function fetchPage(client: ApiClient, query: Query, signal: AbortSignal): Promise<Page> {
  const res = await client.request({ method: "GET", path: "/v1/logs", query, signal });
  const data = (res.data ?? {}) as { data?: unknown; has_more?: unknown };
  const events = Array.isArray(data.data) ? (data.data as LogEvent[]) : Array.isArray(res.data) ? (res.data as LogEvent[]) : [];
  return { events, hasMore: data.has_more === true };
}

/**
 * Print recent events, then poll for newer ones until the signal fires.
 *
 * GET /v1/logs returns newest first. With before=<id> it returns the events
 * just newer than that id, so a burst larger than one page is drained by
 * asking again while has_more is true. Events are printed oldest first.
 */
export async function tailLogs(opts: {
  client: ApiClient;
  filters: Query;
  backlog: number;
  intervalMs: number;
  signal: AbortSignal;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  onEvent(event: LogEvent): void;
  onWarn(message: string): void;
}): Promise<void> {
  const { client, filters, signal } = opts;
  const first = await fetchPage(client, [...filters, ["limit", String(Math.min(100, Math.max(1, opts.backlog)))]], signal);
  for (const e of first.events.slice(0, opts.backlog).reverse()) opts.onEvent(e);
  let newest = first.events[0]?.id;

  while (!signal.aborted) {
    await opts.sleep(opts.intervalMs, signal);
    if (signal.aborted) break;
    try {
      for (;;) {
        const query: Query = [...filters, ["limit", "100"]];
        if (newest) query.push(["before", newest]);
        const page = await fetchPage(client, query, signal);
        for (const e of [...page.events].reverse()) opts.onEvent(e);
        const usedCursor = Boolean(newest);
        if (page.events[0]?.id) newest = page.events[0].id;
        // Without a cursor the page is the newest events, and has_more points at older ones.
        if (!usedCursor || !page.hasMore || page.events.length === 0 || signal.aborted) break;
      }
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw err;
      opts.onWarn(`Could not fetch new events: ${(err as Error).message}. Trying again.`);
    }
  }
}

const DETAIL_KEYS = ["url", "reason", "bounce_type", "error", "message", "diagnostic_code"];

export function formatEvent(e: LogEvent, c: Colors): string {
  const time = typeof e.created_at === "string" ? e.created_at.replace("T", " ").replace(/\.\d+/, "") : "";
  const type = typeof e.type === "string" ? e.type : "event";
  const color = /deliver(ed)?$|^opened|^clicked|^sent/.test(type)
    ? c.green
    : /bounce|fail|complain|suppress/.test(type)
      ? c.red
      : /delay|retry/.test(type)
        ? c.yellow
        : c.dim;
  const to = Array.isArray(e.to) ? e.to.join(", ") : typeof e.to === "string" ? e.to : "";
  const subject = typeof e.subject === "string" ? e.subject : "";
  const data = e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
  const detailKey = DETAIL_KEYS.find((k) => typeof data[k] === "string" && data[k]);
  const detail = detailKey ? c.dim(`${detailKey}=${String(data[detailKey])}`) : "";
  const shortSubject = subject.length > 40 ? `${subject.slice(0, 37)}...` : subject;
  return [c.dim(time), color(type.padEnd(16)), to, shortSubject ? `"${shortSubject}"` : "", c.dim(String(e.email_id ?? "")), detail]
    .filter((p) => p !== "")
    .join("  ");
}

export const logsTailCommand: HandCommand = {
  group: "logs",
  name: "tail",
  summary: "Print email events as they happen",
  description:
    "Shows the most recent events, then checks GET /v1/logs at each interval and prints new events oldest first until you press Ctrl-C. When output is piped, each event is one line of JSON. Needs the logs:read scope.",
  flags: [
    { name: "type", kind: "value", valueName: "type", multiple: true, description: "Only these event types, like delivered or bounced. Repeat the flag or use commas." },
    { name: "recipient", kind: "value", valueName: "address", description: "Only events for this To address" },
    { name: "domain", kind: "value", valueName: "name", description: "Only events from this sending domain" },
    { name: "domain-id", kind: "value", valueName: "id", description: "Only events from this sending domain id" },
    { name: "email-id", kind: "value", valueName: "id", description: "Only events of this email" },
    { name: "tag", kind: "value", valueName: "name:value", description: "Only events with this tag" },
    { name: "interval", kind: "value", valueName: "duration", description: "Time between checks. Default 2s." },
    { name: "backlog", kind: "value", valueName: "n", description: "How many recent events to show first, up to 100. Default 10. Use 0 for new events only." },
  ],
  examples: ["smtpfast logs tail", "smtpfast logs tail --type bounced,complained", "smtpfast logs tail --recipient jane@example.com --json | jq ."],
  async run(session, parsed) {
    const { values, positionals } = parsed;
    if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
    const intervalMs = Math.max(500, parseDuration(one(values, "interval") ?? "2s", "interval"));
    const backlogRaw = one(values, "backlog") ?? "10";
    if (!/^\d+$/.test(backlogRaw)) throw new UsageError(`--backlog takes a number, got "${backlogRaw}"`);
    const backlog = Math.min(100, Number(backlogRaw));

    const filters: Query = [];
    const types = many(values, "type").flatMap(splitList);
    if (types.length > 0) filters.push(["type", types.join(",")]);
    for (const [flag, param] of [
      ["recipient", "recipient"],
      ["domain", "domain"],
      ["domain-id", "domain_id"],
      ["email-id", "email_id"],
      ["tag", "tag"],
    ] as const) {
      const v = one(values, flag);
      if (v) filters.push([param, v]);
    }

    const out = session.out;
    const { signal, dispose } = session.interruptSignal();
    try {
      if (!out.json && !out.quiet) out.err(out.ce.dim("Showing recent events, then new ones as they arrive. Press Ctrl-C to stop."));
      await tailLogs({
        client: session.client(),
        filters,
        backlog,
        intervalMs,
        signal,
        sleep: (ms, s) => session.ctx.sleep(ms, s),
        onEvent(e) {
          if (out.quiet) {
            if (e.id) out.out(String(e.id));
          } else if (out.json) out.out(JSON.stringify(e));
          else out.out(formatEvent(e, out.c));
        },
        onWarn: (m) => out.err(out.ce.yellow(m)),
      });
    } catch (err) {
      if (signal.aborted) return 0;
      throw err;
    } finally {
      dispose();
    }
    return 0;
  },
};
