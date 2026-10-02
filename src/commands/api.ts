import { many, one } from "../args.js";
import { UsageError } from "../errors.js";
import type { Query } from "../http.js";
import { loadData } from "../request.js";
import type { HandCommand } from "./types.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const apiCommand: HandCommand = {
  name: "api",
  summary: "Make a raw API request",
  description:
    "Call any endpoint directly. The path is relative to the base URL, like /v1/emails. Auth, retries and output formatting work the same as for other commands.",
  args: [
    { name: "method", description: "GET, POST, PUT, PATCH or DELETE" },
    { name: "path", description: "Path like /v1/emails. A query string is allowed." },
  ],
  flags: [
    { name: "data", kind: "value", valueName: "json", description: "Request body as JSON, @file.json, or - for stdin" },
    { name: "query", kind: "value", valueName: "key=value", multiple: true, description: "Add a query parameter" },
    { name: "header", kind: "value", valueName: "'Name: value'", multiple: true, description: "Add a request header" },
  ],
  examples: [
    "smtpfast api GET /v1/me",
    "smtpfast api GET /v1/logs --query type=bounced --query limit=5",
    `smtpfast api POST /v1/contacts --data '{"email":"jane@example.com"}'`,
  ],
  async run(session, parsed) {
    const { values, positionals } = parsed;
    const [methodRaw, path, extra] = positionals;
    if (!methodRaw || !path) throw new UsageError("Usage: smtpfast api <method> <path>");
    if (extra !== undefined) throw new UsageError(`Unexpected argument "${extra}"`);
    const method = methodRaw.toUpperCase();
    if (!METHODS.includes(method)) throw new UsageError(`Unknown HTTP method "${methodRaw}"`, `Use one of ${METHODS.join(", ")}.`);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      throw new UsageError("Pass a path like /v1/emails, not a full URL", "Change the host with --base-url. The API key is only sent to the base URL.");
    }
    const query: Query = many(values, "query").map((q) => {
      const eq = q.indexOf("=");
      if (eq <= 0) throw new UsageError(`--query takes key=value, got "${q}"`);
      return [q.slice(0, eq), q.slice(eq + 1)] as [string, string];
    });
    const headers: Record<string, string> = {};
    for (const h of many(values, "header")) {
      const colon = h.indexOf(":");
      if (colon <= 0) throw new UsageError(`--header takes 'Name: value', got "${h}"`);
      headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
    }
    const dataRaw = one(values, "data");
    const body = dataRaw === undefined ? undefined : await loadData(dataRaw, { cwd: session.ctx.cwd, stdin: session.ctx.stdin });
    const res = await session.client().request({
      method,
      path: path.startsWith("/") ? path : `/${path}`,
      query,
      headers,
      body,
      idempotencyKey: session.globals.idempotencyKey,
    });
    session.out.result(res.data, { emptyMessage: `Done (HTTP ${res.status}).` });
    return 0;
  },
};
