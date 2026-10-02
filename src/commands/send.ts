import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { many, one } from "../args.js";
import { UsageError } from "../errors.js";
import { readAll, splitList } from "../util.js";
import type { HandCommand } from "./types.js";

async function readText(path: string, cwd: string, stdin: NodeJS.ReadableStream, flag: string): Promise<string> {
  if (path === "-") return readAll(stdin);
  try {
    return readFileSync(resolve(cwd, path), "utf8");
  } catch (err) {
    throw new UsageError(`--${flag}: cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

function recipients(values: string[]): string[] {
  return values.flatMap(splitList);
}

/** Attachments in the Resend format: { filename, content } with the content base64 encoded. */
export function encodeAttachment(path: string, cwd: string): { filename: string; content: string } {
  let data: Buffer;
  try {
    data = readFileSync(resolve(cwd, path));
  } catch (err) {
    throw new UsageError(`--attach: cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  return { filename: basename(path), content: data.toString("base64") };
}

export const sendCommand: HandCommand = {
  name: "send",
  summary: "Send an email",
  description:
    "Send one email. Give the body with --text, --html, or both, inline or from a file. Use - as the file name to read from stdin. Attachments are read from disk and base64 encoded.",
  flags: [
    { name: "from", kind: "value", valueName: "address", required: true, description: "Sender address on a verified domain, like 'Acme <hi@acme.com>'" },
    { name: "to", kind: "value", valueName: "address", required: true, multiple: true, description: "Recipient. Repeat the flag or separate addresses with commas." },
    { name: "subject", kind: "value", valueName: "text", required: true, description: "Subject line" },
    { name: "text", kind: "value", valueName: "text", description: "Plain text body" },
    { name: "text-file", kind: "value", valueName: "path", description: "Read the plain text body from a file, or - for stdin" },
    { name: "html", kind: "value", valueName: "html", description: "HTML body" },
    { name: "html-file", kind: "value", valueName: "path", description: "Read the HTML body from a file, or - for stdin" },
    { name: "cc", kind: "value", valueName: "address", multiple: true, description: "Cc recipient" },
    { name: "bcc", kind: "value", valueName: "address", multiple: true, description: "Bcc recipient" },
    { name: "reply-to", kind: "value", valueName: "address", multiple: true, description: "Reply-To address" },
    { name: "attach", kind: "value", valueName: "path", multiple: true, description: "Attach a file" },
    { name: "scheduled-at", kind: "value", valueName: "time", description: "Send later, as an ISO 8601 time like 2026-11-01T09:00:00Z" },
    { name: "tag", kind: "value", valueName: "name=value", multiple: true, description: "Add a tag, used to filter logs and events" },
    { name: "header", kind: "value", valueName: "'Name: value'", multiple: true, description: "Add a custom email header" },
  ],
  examples: [
    "smtpfast send --from hi@acme.com --to jane@example.com --subject 'Hello' --text 'Hi Jane'",
    "smtpfast send --from hi@acme.com --to jane@example.com --subject 'Invoice' --html-file invoice.html --attach invoice.pdf",
    "smtpfast send --from hi@acme.com --to jane@example.com --subject 'Later' --text 'Hi' --scheduled-at 2026-11-01T09:00:00Z",
    "echo 'Build finished' | smtpfast send --from ci@acme.com --to team@acme.com --subject 'CI' --text-file -",
  ],
  async run(session, parsed) {
    const { values, positionals } = parsed;
    if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
    const { cwd, stdin } = session.ctx;
    const from = one(values, "from");
    const to = recipients(many(values, "to"));
    const subject = one(values, "subject");
    const missing = [!from && "--from", to.length === 0 && "--to", subject === undefined && "--subject"].filter(Boolean);
    if (missing.length > 0) throw new UsageError(`Missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    if (one(values, "text") !== undefined && one(values, "text-file") !== undefined) throw new UsageError("Use --text or --text-file, not both");
    if (one(values, "html") !== undefined && one(values, "html-file") !== undefined) throw new UsageError("Use --html or --html-file, not both");
    if (one(values, "text-file") === "-" && one(values, "html-file") === "-") throw new UsageError("Only one of --text-file and --html-file can read stdin");

    const textFile = one(values, "text-file");
    const htmlFile = one(values, "html-file");
    const text = textFile !== undefined ? await readText(textFile, cwd, stdin, "text-file") : one(values, "text");
    const html = htmlFile !== undefined ? await readText(htmlFile, cwd, stdin, "html-file") : one(values, "html");
    if (text === undefined && html === undefined) throw new UsageError("Give a body with --text, --text-file, --html or --html-file");

    const body: Record<string, unknown> = { from, to, subject };
    if (text !== undefined) body.text = text;
    if (html !== undefined) body.html = html;
    const cc = recipients(many(values, "cc"));
    const bcc = recipients(many(values, "bcc"));
    const replyTo = recipients(many(values, "reply-to"));
    if (cc.length > 0) body.cc = cc;
    if (bcc.length > 0) body.bcc = bcc;
    if (replyTo.length > 0) body.reply_to = replyTo.length === 1 ? replyTo[0] : replyTo;
    const attachments = many(values, "attach").map((p) => encodeAttachment(p, cwd));
    if (attachments.length > 0) body.attachments = attachments;
    const scheduledAt = one(values, "scheduled-at");
    if (scheduledAt) body.scheduled_at = scheduledAt;
    const tags = many(values, "tag").map((t) => {
      const eq = t.indexOf("=");
      if (eq <= 0) throw new UsageError(`--tag takes name=value, got "${t}"`);
      return { name: t.slice(0, eq), value: t.slice(eq + 1) };
    });
    if (tags.length > 0) body.tags = tags;
    const headers: Record<string, string> = {};
    for (const h of many(values, "header")) {
      const colon = h.indexOf(":");
      if (colon <= 0) throw new UsageError(`--header takes 'Name: value', got "${h}"`);
      headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
    }
    if (Object.keys(headers).length > 0) body.headers = headers;

    const res = await session.client().request({ method: "POST", path: "/v1/emails", body, idempotencyKey: session.globals.idempotencyKey });
    const out = session.out;
    if (out.quiet || out.json) {
      out.result(res.data);
      return 0;
    }
    const email = (res.data ?? {}) as Record<string, unknown>;
    const id = typeof email.id === "string" ? email.id : "(no id)";
    const when = scheduledAt ? ` for ${scheduledAt}` : "";
    const status = typeof email.status === "string" ? email.status : scheduledAt ? "scheduled" : "queued";
    out.out(`${out.c.green("Email")} ${out.c.bold(id)} ${status}${when}: ${to.join(", ")}`);
    out.out(out.c.dim(`Check it with: smtpfast emails get ${id}`));
    return 0;
  },
};
