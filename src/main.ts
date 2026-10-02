import { type CommandLine, type FlagDef, type FlagValues, type ParseResult, parseArgs, parseWithGlobals, splitCommandLine } from "./args.js";
import { catalog } from "./commands/index.js";
import { findExtension, findTop, extensionsFor } from "./commands/catalog.js";
import { runComplete } from "./commands/completion.js";
import { runOperation } from "./commands/generated.js";
import { printVersion } from "./commands/info.js";
import type { HandCommand } from "./commands/types.js";
import { configDir } from "./config.js";
import { type Context, defaultContext } from "./context.js";
import { EXIT_INTERRUPTED, UsageError } from "./errors.js";
import { groupHelp, handHelp, operationHelp, topHelp } from "./help.js";
import { maybeStartRefresh, refreshSpec, specUrl, updateCheckDisabled } from "./refresh.js";
import { Registry } from "./registry.js";
import { operationFlagDefs } from "./request.js";
import { GLOBAL_FLAGS, type Globals, InterruptError, Session, toGlobals, USER_AGENT } from "./session.js";
import type { OperationSpec } from "./spec/types.js";
import { suggest } from "./util.js";

/** What the command words name. */
type Target =
  | { kind: "root" }
  | { kind: "help"; path: string[] }
  | { kind: "hand"; cmd: HandCommand }
  | { kind: "group"; group: string }
  | { kind: "op"; op: OperationSpec };

/** How many words name a command that starts with this one: "help <path...>", "send", or "<group> <command>". */
function commandWords(first: string): number {
  if (first === "help") return Infinity;
  return findTop(first) ? 1 : 2;
}

/** `named` hears the command name as soon as it is known, so a later error can point at the right --help. */
function findTarget(registry: Registry, words: string[], named: (name: string) => void): Target {
  const [first, second] = words;
  if (first === undefined) return { kind: "root" };
  if (first === "help") return { kind: "help", path: words.slice(1) };
  const top = findTop(first);
  if (top) return { kind: "hand", cmd: top };
  if (!registry.hasGroup(first)) registry.loadLive();
  if (!registry.hasGroup(first)) throw unknownCommand(registry, first);
  named(`smtpfast ${first}`);
  if (second === undefined) return { kind: "group", group: first };
  const ext = findExtension(first, second);
  if (ext) return { kind: "hand", cmd: ext };
  const op = registry.find(first, second) ?? registry.loadLive().find(first, second);
  if (!op) throw unknownSubcommand(registry, first, second);
  return { kind: "op", op };
}

function targetFlags(target: Target): FlagDef[] {
  if (target.kind === "hand") return target.cmd.flags;
  if (target.kind === "op") return operationFlagDefs(target.op);
  return [];
}

function targetName(target: Target): string {
  if (target.kind === "hand") return `smtpfast ${target.cmd.group ? `${target.cmd.group} ` : ""}${target.cmd.name}`;
  if (target.kind === "group") return `smtpfast ${target.group}`;
  if (target.kind === "op") return `smtpfast ${target.op.group} ${target.op.command}`;
  return "smtpfast";
}

/** Parse the global flags and the command's flags in one pass over everything but the command words. */
function parseLine(line: CommandLine, target: Target, early: Globals): { local: ParseResult; global: FlagValues } {
  if (target.kind === "group" && line.rest.length > 0) {
    // "smtpfast emails --limit 5": flags need a command first. --help still shows the group.
    if (!early.help) throw new UsageError(`Put the command name before flags, like "smtpfast ${target.group} <command> ${line.rest[0]}"`);
    return parseWithGlobals(line.globalTokens, [], GLOBAL_FLAGS);
  }
  return parseWithGlobals([...line.globalTokens, ...line.rest], targetFlags(target), GLOBAL_FLAGS);
}

async function dispatch(session: Session, target: Target, local: ParseResult): Promise<number> {
  const { globals, out } = session;
  switch (target.kind) {
    case "root":
      if (globals.version) return printVersion(session);
      return showHelpFor(session, []);
    case "help":
      return showHelpFor(session, [...target.path, ...local.positionals]);
    case "group":
      return showHelpFor(session, [target.group]);
    case "hand":
      if (globals.help) {
        out.out(handHelp(target.cmd, { width: out.width, c: out.c }));
        return 0;
      }
      return target.cmd.run(session, local);
    case "op":
      if (globals.help) return showHelpFor(session, [target.op.group, target.op.command]);
      return runOperation(session, target.op, local);
  }
}

/** Hidden: the detached child that refreshes the spec cache. */
async function runRefresh(ctx: Context, tokens: string[]): Promise<number> {
  const parsed = parseArgs(tokens, [
    { name: "url", kind: "value" },
    { name: "config-dir", kind: "value" },
  ]);
  const url = parsed.values.url;
  const dir = parsed.values["config-dir"];
  if (!Array.isArray(url) || !Array.isArray(dir)) return 0;
  await refreshSpec({ dir: dir[0]!, url: url[0]!, fetch: ctx.fetch, now: ctx.now(), userAgent: USER_AGENT });
  return 0;
}

function showHelpFor(session: Session, path: string[]): number {
  const out = session.out;
  const opts = { width: out.width, c: out.c };
  const [first, second] = path;
  const registry = session.registry();
  if (!first) {
    out.out(topHelp(registry.loadLive(), catalog.top, opts));
    return 0;
  }
  const top = findTop(first);
  if (top) {
    out.out(handHelp(top, opts));
    return 0;
  }
  if (!registry.hasGroup(first)) registry.loadLive();
  if (!registry.hasGroup(first)) throw unknownCommand(registry, first);
  if (!second) {
    out.out(groupHelp(first, registry.loadLive(), extensionsFor(first), opts));
    return 0;
  }
  const ext = findExtension(first, second);
  if (ext) {
    out.out(handHelp(ext, opts));
    return 0;
  }
  const op = registry.find(first, second) ?? registry.loadLive().find(first, second);
  if (!op) throw unknownSubcommand(registry, first, second);
  out.out(operationHelp(op, { ...opts, isNew: registry.isNew(op) }));
  return 0;
}

function unknownCommand(registry: Registry, name: string): UsageError {
  registry.loadLive();
  const names = [...catalog.top.filter((t) => !t.hidden).map((t) => t.name), ...registry.groups.map((g) => g.name)];
  const hint = suggest(name, names);
  return new UsageError(`Unknown command "${name}"`, hint ? `Did you mean "smtpfast ${hint}"?` : 'Run "smtpfast --help" to see all commands.');
}

function unknownSubcommand(registry: Registry, group: string, name: string): UsageError {
  registry.loadLive();
  const names = [...registry.groupOperations(group).map((o) => o.command), ...extensionsFor(group).map((e) => e.name)];
  const hint = suggest(name, names);
  return new UsageError(
    `Unknown command "${group} ${name}"`,
    hint ? `Did you mean "smtpfast ${group} ${hint}"?` : `Run "smtpfast ${group} --help" to see its commands.`,
  );
}

/** Values given to --api-key, so an error never shows them, even one raised before the flags are parsed. */
function apiKeysIn(argv: string[]): string[] {
  const keys: string[] = [];
  argv.forEach((token, i) => {
    if (token === "--api-key" && argv[i + 1] !== undefined) keys.push(argv[i + 1]!);
    else if (token.startsWith("--api-key=")) keys.push(token.slice("--api-key=".length));
  });
  return keys;
}

/** Run the CLI and return the exit code. Tests call this with a fake context. */
export async function main(argv: string[], overrides: Partial<Context> = {}): Promise<number> {
  const ctx: Context = { ...defaultContext(), ...overrides };

  // Hidden commands go first: they must not see global flag parsing or start a refresh.
  if (argv[0] === "__complete") {
    try {
      return runComplete(new Session(ctx, toGlobals({}, ctx.env)), argv.slice(1));
    } catch {
      return 0;
    }
  }
  if (argv[0] === "__refresh-spec") return runRefresh(ctx, argv.slice(1)).catch(() => 0);

  let session: Session | undefined;
  // Global flags seen before the command, for errors raised before the rest is parsed.
  let early: Globals | undefined;
  let helpCommand = "smtpfast";
  try {
    const line = splitCommandLine(argv, GLOBAL_FLAGS, commandWords);
    early = toGlobals(parseArgs(line.globalTokens, GLOBAL_FLAGS).values, ctx.env);
    const registry = new Registry(configDir(ctx.env, ctx.platform, ctx.homedir));
    const target = findTarget(registry, line.words, (name) => (helpCommand = name));
    helpCommand = targetName(target);
    const parsed = parseLine(line, target, early);
    const globals = toGlobals(parsed.global, ctx.env);
    session = new Session(ctx, globals, registry);

    if (!updateCheckDisabled(globals.noUpdateCheck, ctx.env)) {
      let base: string | undefined;
      try {
        base = session.settings().baseUrl;
      } catch {
        base = undefined;
      }
      if (base) maybeStartRefresh({ dir: session.configDir, url: specUrl(base, ctx.env), now: ctx.now(), spawn: ctx.spawnRefresh });
    }

    return await dispatch(session, target, parsed.local);
  } catch (err) {
    if (err instanceof InterruptError || (err as Error)?.name === "AbortError") return EXIT_INTERRUPTED;
    const out = session?.out ?? new Session(ctx, early ?? toGlobals({}, ctx.env)).out;
    for (const key of apiKeysIn(argv)) out.addSecret(key);
    return out.error(err, helpCommand, (session?.globals ?? early)?.debug ?? false);
  }
}
