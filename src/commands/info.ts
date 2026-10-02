import type { Registry } from "../registry.js";
import type { Session } from "../session.js";
import type { OperationSpec } from "../spec/types.js";
import { formatAge } from "../util.js";
import { VERSION } from "../version.js";
import { catalog, extensionsFor } from "./catalog.js";
import type { HandCommand } from "./types.js";

export const UPGRADE_HINT = "npm install -g smtpfast@latest";

function opUsage(op: OperationSpec): string {
  return `smtpfast ${op.group} ${op.command}${op.pathParams.map((p) => ` <${p.name}>`).join("")}`;
}

/** Lines telling the user that the live API has operations this version does not include. */
export function behindNotice(registry: Registry): string[] {
  const fresh = registry.newOperations;
  if (fresh.length === 0) return [];
  const lines = [
    `${fresh.length} API operation${fresh.length === 1 ? " is" : "s are"} newer than this version of smtpfast. ${fresh.length === 1 ? "It still runs" : "They still run"}:`,
    ...fresh.slice(0, 10).map((o) => `  ${opUsage(o)}`),
  ];
  if (fresh.length > 10) lines.push(`  and ${fresh.length - 10} more (see smtpfast commands)`);
  lines.push(`Upgrade to get ${fresh.length === 1 ? "it" : "them"} built in: ${UPGRADE_HINT}`);
  return lines;
}

export function printVersion(session: Session): number {
  const registry = session.registry().loadLive();
  const out = session.out;
  const live = registry.live;
  if (session.globals.json) {
    out.jsonOut({
      version: VERSION,
      node: process.version,
      spec: { operations: registry.embedded.operationCount, sha256: registry.embedded.specHash },
      live: live
        ? { operations: live.operationCount, sha256: live.hash, checked_at: live.meta.checked_at ? new Date(live.meta.checked_at).toISOString() : null }
        : null,
      new_operations: registry.newOperations.map((o) => ({ command: `${o.group} ${o.command}`, operationId: o.operationId })),
    });
    return 0;
  }
  out.out(`smtpfast ${VERSION}`);
  if (!out.tty && registry.newOperations.length === 0) return 0;
  out.out(`API spec: ${registry.embedded.operationCount} operations built in (sha256 ${registry.embedded.specHash.slice(0, 12)})`);
  if (live) {
    const age = live.meta.checked_at ? `, checked ${formatAge(session.ctx.now() - live.meta.checked_at)}` : "";
    const same = live.hash === registry.embedded.specHash ? ", same as built in" : "";
    out.out(`Live spec: ${live.operationCount} operations${same}${age}`);
  }
  const notice = behindNotice(registry);
  if (notice.length > 0) out.out(["", ...notice].join("\n"));
  return 0;
}

export const versionCommand: HandCommand = {
  name: "version",
  summary: "Show the version and whether the live API is ahead of it",
  flags: [],
  examples: ["smtpfast version", "smtpfast --version --json"],
  async run(session) {
    return printVersion(session);
  },
};

interface Entry {
  command: string;
  args: string[];
  summary: string;
  method?: string;
  path?: string;
  operationId?: string;
  source: "hand-written" | "built-in" | "live";
}

/** Argument names; optional ones are written as [name]. */
function handArgs(cmd: HandCommand): string[] {
  return (cmd.args ?? []).map((a) => (a.optional ? `[${a.name}]` : a.name));
}

export function commandEntries(registry: Registry): Entry[] {
  const entries: Entry[] = catalog.top
    .filter((t) => !t.hidden)
    .map((t) => ({ command: t.name, args: handArgs(t), summary: t.summary, source: "hand-written" as const }));
  for (const g of registry.groups) {
    const exts = extensionsFor(g.name);
    const replaced = new Map(exts.filter((e) => e.replaces).map((e) => [e.replaces!, e]));
    const groupEntries: Entry[] = [];
    for (const op of registry.groupOperations(g.name)) {
      const ext = replaced.get(op.operationId);
      groupEntries.push({
        command: `${g.name} ${op.command}`,
        args: ext ? handArgs(ext) : op.pathParams.map((p) => p.name),
        summary: ext ? ext.summary : op.summary,
        method: op.method,
        path: op.path,
        operationId: op.operationId,
        source: ext ? "hand-written" : registry.isNew(op) ? "live" : "built-in",
      });
    }
    for (const e of exts.filter((x) => !x.replaces)) {
      groupEntries.push({ command: `${g.name} ${e.name}`, args: handArgs(e), summary: e.summary, source: "hand-written" });
    }
    groupEntries.sort((a, b) => (a.command < b.command ? -1 : 1));
    entries.push(...groupEntries);
  }
  return entries;
}

export const commandsCommand: HandCommand = {
  name: "commands",
  summary: "List every command",
  description: "Prints all commands with their arguments. Commands that come from the live API spec, and not from this version, are marked new.",
  flags: [],
  examples: ["smtpfast commands", "smtpfast commands --json | jq -r '.[].command'"],
  async run(session) {
    const registry = session.registry().loadLive();
    const entries = commandEntries(registry);
    const out = session.out;
    if (out.json) {
      out.jsonOut(entries);
      return 0;
    }
    const c = out.c;
    const left = (e: Entry, name: string) => `${name}${e.args.map((a) => (a.startsWith("[") ? ` ${a}` : ` <${a}>`)).join("")}`;
    const top = entries.filter((e) => !e.command.includes(" "));
    const width = Math.min(46, Math.max(...entries.map((e) => left(e, e.command).length)) + 2);
    const lines: string[] = [];
    for (const e of top) lines.push(`  ${c.bold(left(e, `smtpfast ${e.command}`).padEnd(width + 9))}${e.summary}`);
    for (const g of registry.groups) {
      const items = entries.filter((e) => e.command.startsWith(`${g.name} `));
      lines.push("", `${c.bold(g.name)} ${c.dim(`(${items.length}) ${g.description}`)}`);
      for (const e of items) {
        const name = e.command.slice(g.name.length + 1);
        const tag = e.source === "live" ? ` ${c.yellow("(new)")}` : "";
        lines.push(`  ${left(e, name).padEnd(width)}  ${e.summary}${tag}`);
      }
    }
    out.out(lines.join("\n"));
    const notice = behindNotice(registry);
    if (notice.length > 0) out.out(["", ...notice].join("\n"));
    return 0;
  },
};
