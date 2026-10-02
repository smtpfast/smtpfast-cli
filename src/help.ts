import type { FlagDef } from "./args.js";
import type { HandCommand } from "./commands/types.js";
import type { Colors } from "./output.js";
import type { Registry } from "./registry.js";
import { acceptsData, flagParams, valueName } from "./request.js";
import { GLOBAL_FLAGS } from "./session.js";
import type { OperationSpec, ParamSpec } from "./spec/types.js";
import { wrap } from "./util.js";

export const DOCS_URL = "https://smtpfa.st/docs";

interface Row {
  left: string;
  text: string;
}

function renderRows(rows: Row[], width: number, c: Colors, indent = 2): string[] {
  if (rows.length === 0) return [];
  const leftWidth = Math.min(34, Math.max(...rows.map((r) => r.left.length)));
  const textWidth = Math.max(30, width - indent - leftWidth - 3);
  const out: string[] = [];
  for (const r of rows) {
    const text = wrap(r.text.replace(/\s+/g, " ").trim(), textWidth);
    const pad = " ".repeat(indent);
    if (r.left.length > leftWidth) {
      out.push(`${pad}${c.bold(r.left)}`);
      for (const t of text) if (t) out.push(`${pad}${" ".repeat(leftWidth + 3)}${t}`);
      continue;
    }
    out.push(`${pad}${c.bold(r.left.padEnd(leftWidth))}   ${text[0] ?? ""}`.trimEnd());
    for (const t of text.slice(1)) out.push(`${pad}${" ".repeat(leftWidth + 3)}${t}`);
  }
  return out;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function exampleValue(p: ParamSpec): string {
  if (p.example !== undefined) return p.example;
  if (p.enum?.[0]) return p.enum[0];
  if (p.default !== undefined) return String(p.default);
  switch (p.type) {
    case "integer":
      return "10";
    case "number":
      return "1";
    case "object":
      return '{"key":"value"}';
    case "array":
      return p.items === "object" ? '{"key":"value"}' : `<${p.flag}>`;
    default:
      return `<${p.flag}>`;
  }
}

export function exampleFor(op: OperationSpec): string {
  const parts = ["smtpfast", op.group, op.command, ...op.pathParams.map((p) => `<${p.name}>`)];
  const params = flagParams(op);
  const required = params.filter((p) => p.required);
  const chosen = required.length > 0 ? required : params.filter((p) => p.example !== undefined).slice(0, 1);
  for (const p of chosen) {
    if (p.type === "boolean") parts.push(`--${p.flag}`);
    else parts.push(`--${p.flag}`, shellQuote(exampleValue(p)));
  }
  if (op.body?.type === "array") parts.push("--data", "@body.json");
  return parts.join(" ");
}

function paramText(p: ParamSpec): string {
  const bits: string[] = [];
  if (p.required) bits.push("(required)");
  if (p.description) {
    const d = p.description.replace(/\s+/g, " ").trim();
    bits.push(/[.!?:)]$/.test(d) ? d : `${d}.`);
  }
  if (p.type === "array") bits.push(p.items === "object" ? "One JSON object per flag, or a JSON array." : "Repeat the flag or separate values with commas.");
  if (p.type === "object") bits.push("JSON, or key=value (repeatable).");
  if (p.type === "boolean") bits.push(`Use --no-${p.flag} for false.`);
  if (p.enum && p.enum.join("|").length > 40) bits.push(`One of: ${p.enum.join(", ")}.`);
  if (p.default !== undefined) bits.push(`Default: ${String(p.default)}.`);
  if (p.nullable) bits.push('Pass "null" to clear.');
  if (p.in === "header") bits.push(`Sent as the ${p.name} header.`);
  return bits.join(" ");
}

function paramLeft(p: ParamSpec): string {
  if (p.type === "boolean") return `--${p.flag}`;
  return `--${p.flag} <${valueName(p)}>`;
}

function flagLeft(f: FlagDef): string {
  const short = f.short ? `-${f.short}, ` : "";
  return f.kind === "boolean" ? `${short}--${f.name}` : `${short}--${f.name} <${f.valueName ?? "value"}>`;
}

function flagRows(flags: FlagDef[]): Row[] {
  return flags
    .filter((f) => !f.hidden)
    .map((f) => ({
      left: flagLeft(f),
      text: `${f.required ? "(required) " : ""}${f.description ?? ""}${f.multiple ? " Repeatable." : ""}`,
    }));
}

export function operationHelp(op: OperationSpec, opts: { width: number; c: Colors; isNew?: boolean }): string {
  const { width, c } = opts;
  const lines: string[] = [c.bold(op.summary)];
  if (op.deprecated) lines.push(c.yellow("Deprecated."));
  if (op.description) lines.push("", ...wrap(op.description, width));
  if (opts.isNew) {
    lines.push("", c.yellow("This command comes from the live API spec. It runs, but upgrade smtpfast to get it built in."));
  }
  lines.push("", c.bold("Usage:"), `  smtpfast ${op.group} ${op.command}${op.pathParams.map((p) => ` <${p.name}>`).join("")} [flags]`);
  if (op.pathParams.length > 0) {
    lines.push("", c.bold("Arguments:"));
    lines.push(...renderRows(op.pathParams.map((p) => ({ left: `<${p.name}>`, text: p.description ?? "" })), width, c));
  }
  const params = [...flagParams(op)].sort((a, b) => Number(b.required) - Number(a.required));
  const rows: Row[] = params.map((p) => ({ left: paramLeft(p), text: paramText(p) }));
  if (acceptsData(op)) {
    const text =
      op.body?.type === "array"
        ? "(required) The request body: a JSON array, @file.json, or - for stdin."
        : "Request body as JSON, @file.json, or - for stdin. Field flags override its fields.";
    rows.push({ left: "--data <json>", text });
  }
  if (rows.length > 0) lines.push("", c.bold("Flags:"), ...renderRows(rows, width, c));
  lines.push("", c.bold("Example:"), `  ${exampleFor(op)}`);
  lines.push("", c.dim(`API: ${op.method} ${op.path} (${op.operationId})`));
  lines.push(c.dim(`Global flags like --json, --quiet and --profile work here too. Docs: ${DOCS_URL}`));
  return lines.join("\n");
}

export function handHelp(cmd: HandCommand, opts: { width: number; c: Colors }): string {
  const { width, c } = opts;
  const path = cmd.group ? `${cmd.group} ${cmd.name}` : cmd.name;
  const lines: string[] = [c.bold(cmd.summary)];
  if (cmd.description) lines.push("", ...wrap(cmd.description, width));
  const args = (cmd.args ?? []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(" ");
  lines.push("", c.bold("Usage:"), `  smtpfast ${path}${args ? ` ${args}` : ""}${cmd.flags.length > 0 ? " [flags]" : ""}`);
  if (cmd.args && cmd.args.length > 0) {
    lines.push("", c.bold("Arguments:"));
    lines.push(...renderRows(cmd.args.map((a) => ({ left: a.optional ? `[${a.name}]` : `<${a.name}>`, text: a.description })), width, c));
  }
  if (cmd.flags.length > 0) lines.push("", c.bold("Flags:"), ...renderRows(flagRows(cmd.flags), width, c));
  if (cmd.examples.length > 0) lines.push("", c.bold(cmd.examples.length > 1 ? "Examples:" : "Example:"), ...cmd.examples.map((e) => `  ${e}`));
  lines.push("", c.dim(`Global flags like --json, --quiet and --profile work here too. Docs: ${DOCS_URL}`));
  return lines.join("\n");
}

export function groupHelp(
  group: string,
  registry: Registry,
  extensions: HandCommand[],
  opts: { width: number; c: Colors },
): string {
  const { width, c } = opts;
  const info = registry.group(group);
  const replaced = new Set(extensions.map((e) => e.replaces).filter(Boolean));
  const rows: Array<Row & { key: string }> = [];
  for (const op of registry.groupOperations(group)) {
    if (replaced.has(op.operationId)) continue;
    const args = op.pathParams.map((p) => ` <${p.name}>`).join("");
    rows.push({ key: op.command, left: `${op.command}${args}`, text: `${op.summary}${registry.isNew(op) ? " (new)" : ""}` });
  }
  for (const e of extensions) {
    const args = (e.args ?? []).map((a) => (a.optional ? ` [${a.name}]` : ` <${a.name}>`)).join("");
    rows.push({ key: e.name, left: `${e.name}${args}`, text: e.summary });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : 1));
  const lines = [
    c.bold(info?.description ?? group),
    "",
    c.bold("Usage:"),
    `  smtpfast ${group} <command> [args] [flags]`,
    "",
    c.bold("Commands:"),
    ...renderRows(rows, width, c),
    "",
    c.dim(`Run "smtpfast ${group} <command> --help" for a command's flags.`),
  ];
  return lines.join("\n");
}

export function topHelp(registry: Registry, topCommands: HandCommand[], opts: { width: number; c: Colors }): string {
  const { width, c } = opts;
  const visible = topCommands.filter((t) => !t.hidden);
  const lines = [
    `${c.bold("smtpfast")}: the command-line tool for the SMTPfast email API.`,
    "",
    c.bold("Usage:"),
    "  smtpfast <command> [flags]",
    "  smtpfast <group> <command> [args] [flags]",
    "",
    c.bold("Commands:"),
    ...renderRows(
      visible.map((t) => ({ left: t.name, text: t.summary })),
      width,
      c,
    ),
    "",
    c.bold("API groups:"),
    ...renderRows(
      registry.groups.map((g) => ({ left: g.name, text: g.description })),
      width,
      c,
    ),
    "",
    c.bold("Global flags:"),
    ...renderRows(flagRows(GLOBAL_FLAGS), width, c),
    "",
    `Run "smtpfast <group> --help" to see a group's commands, or "smtpfast commands" for the full list.`,
    `API docs: ${DOCS_URL}`,
  ];
  return lines.join("\n");
}
