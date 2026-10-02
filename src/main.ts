import { parseArgs } from "./args.js";
import { catalog } from "./commands/index.js";
import { findExtension, findTop, extensionsFor } from "./commands/catalog.js";
import { runComplete } from "./commands/completion.js";
import { runOperation } from "./commands/generated.js";
import { printVersion } from "./commands/info.js";
import type { HandCommand } from "./commands/types.js";
import { type Context, defaultContext } from "./context.js";
import { EXIT_INTERRUPTED, UsageError } from "./errors.js";
import { groupHelp, handHelp, operationHelp, topHelp } from "./help.js";
import { maybeStartRefresh, refreshSpec, specUrl, updateCheckDisabled } from "./refresh.js";
import { GLOBAL_FLAGS, InterruptError, Session, toGlobals, USER_AGENT } from "./session.js";
import { suggest } from "./util.js";

async function runHand(session: Session, cmd: HandCommand, tokens: string[]): Promise<number> {
  if (session.globals.help) {
    session.out.out(handHelp(cmd, { width: session.out.width, c: session.out.c }));
    return 0;
  }
  return cmd.run(session, parseArgs(tokens, cmd.flags));
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
  if (!registry.hasGroup(first)) throw unknownCommand(session, first);
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
  if (!op) throw unknownSubcommand(session, first, second);
  out.out(operationHelp(op, { ...opts, isNew: registry.isNew(op) }));
  return 0;
}

function unknownCommand(session: Session, name: string): UsageError {
  const registry = session.registry().loadLive();
  const names = [...catalog.top.filter((t) => !t.hidden).map((t) => t.name), ...registry.groups.map((g) => g.name)];
  const hint = suggest(name, names);
  return new UsageError(`Unknown command "${name}"`, hint ? `Did you mean "smtpfast ${hint}"?` : 'Run "smtpfast --help" to see all commands.');
}

function unknownSubcommand(session: Session, group: string, name: string): UsageError {
  const registry = session.registry().loadLive();
  const names = [...registry.groupOperations(group).map((o) => o.command), ...extensionsFor(group).map((e) => e.name)];
  const hint = suggest(name, names);
  return new UsageError(
    `Unknown command "${group} ${name}"`,
    hint ? `Did you mean "smtpfast ${group} ${hint}"?` : `Run "smtpfast ${group} --help" to see its commands.`,
  );
}

/** Run the CLI and return the exit code. Tests call this with a fake context. */
export async function main(argv: string[], overrides: Partial<Context> = {}): Promise<number> {
  const ctx: Context = { ...defaultContext(), ...overrides };
  const fallbackOut = () => new Session(ctx, toGlobals({}, ctx.env)).out;

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
  let helpCommand = "smtpfast";
  try {
    const globalParse = parseArgs(argv, GLOBAL_FLAGS, { lenient: true });
    const globals = toGlobals(globalParse.values, ctx.env);
    session = new Session(ctx, globals);
    const tokens = globalParse.rest;

    if (!updateCheckDisabled(globals.noUpdateCheck, ctx.env)) {
      let base: string | undefined;
      try {
        base = session.settings().baseUrl;
      } catch {
        base = undefined;
      }
      if (base) maybeStartRefresh({ dir: session.configDir, url: specUrl(base, ctx.env), now: ctx.now(), spawn: ctx.spawnRefresh });
    }

    const [first, second] = tokens;
    if (first === undefined) {
      if (globals.version) return printVersion(session);
      return showHelpFor(session, []);
    }
    if (first.startsWith("-") && first !== "-") throw new UsageError(`Unknown flag ${first}`);
    if (first === "help") return showHelpFor(session, tokens.slice(1));

    const top = findTop(first);
    if (top) {
      helpCommand = `smtpfast ${first}`;
      return await runHand(session, top, tokens.slice(1));
    }

    const registry = session.registry();
    if (!registry.hasGroup(first)) registry.loadLive();
    if (!registry.hasGroup(first)) throw unknownCommand(session, first);
    helpCommand = `smtpfast ${first}`;
    if (second === undefined) return showHelpFor(session, [first]);
    if (second.startsWith("-")) {
      if (globals.help) return showHelpFor(session, [first]);
      throw new UsageError(`Put the command name before flags, like "smtpfast ${first} <command> ${second}"`);
    }
    const ext = findExtension(first, second);
    const op = ext ? undefined : (registry.find(first, second) ?? registry.loadLive().find(first, second));
    if (!ext && !op) throw unknownSubcommand(session, first, second);
    helpCommand = `smtpfast ${first} ${second}`;
    if (ext) return await runHand(session, ext, tokens.slice(2));
    if (!op) throw unknownSubcommand(session, first, second);
    if (globals.help) return showHelpFor(session, [first, second]);
    return await runOperation(session, op, tokens.slice(2));
  } catch (err) {
    if (err instanceof InterruptError || (err as Error)?.name === "AbortError") return EXIT_INTERRUPTED;
    const out = session?.out ?? fallbackOut();
    return out.error(err, helpCommand, session?.globals.debug ?? false);
  }
}
