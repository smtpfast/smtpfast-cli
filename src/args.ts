import { CliError, UsageError } from "./errors.js";
import { suggest } from "./util.js";

export interface FlagDef {
  /** Canonical long name without dashes. */
  name: string;
  /** Other accepted long names. */
  aliases?: string[];
  short?: string;
  kind: "value" | "boolean";
  /** The flag may be given more than once; values accumulate. */
  multiple?: boolean;
  description?: string;
  /** Placeholder in help, like "email" for --to <email>. */
  valueName?: string;
  required?: boolean;
  hidden?: boolean;
}

export type FlagValues = Record<string, string[] | boolean>;

export interface ParseResult {
  values: FlagValues;
  positionals: string[];
}

interface Lookup {
  long: Map<string, FlagDef>;
  short: Map<string, FlagDef>;
}

function index(defs: FlagDef[]): Lookup {
  const long = new Map<string, FlagDef>();
  const short = new Map<string, FlagDef>();
  for (const d of defs) {
    long.set(d.name, d);
    for (const a of d.aliases ?? []) if (!long.has(a)) long.set(a, d);
    if (d.short) short.set(d.short, d);
  }
  return { long, short };
}

/** The definition a long flag name refers to. --no-<name> negates a boolean flag. */
function lookupLong(long: Map<string, FlagDef>, name: string): { def?: FlagDef; negated: boolean } {
  const def = long.get(name);
  if (def || !name.startsWith("no-")) return { def, negated: false };
  const base = long.get(name.slice(3));
  return base?.kind === "boolean" ? { def: base, negated: true } : { negated: false };
}

function parseBool(raw: string, flag: string): boolean {
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new UsageError(`--${flag} takes true or false, got "${raw}"`);
}

/**
 * Parse flags. Value flags always take the next token, even one that starts
 * with a dash, so `--data -`, `--limit -1` and `--subject --help` work.
 */
export function parseArgs(tokens: string[], defs: FlagDef[]): ParseResult {
  const { long, short } = index(defs);
  const values: FlagValues = {};
  const positionals: string[] = [];

  const setValue = (def: FlagDef, raw: string) => {
    const existing = values[def.name];
    if (Array.isArray(existing)) {
      if (!def.multiple) throw new UsageError(`--${def.name} was given more than once`);
      existing.push(raw);
    } else {
      values[def.name] = [raw];
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const { def, negated } = lookupLong(long, name);
      if (!def) {
        const hint = suggest(name, [...long.keys()].filter((k) => !long.get(k)?.hidden));
        throw new UsageError(`Unknown flag --${name}`, hint ? `Did you mean --${hint}?` : undefined);
      }
      if (def.kind === "boolean") {
        if (negated && inline !== undefined) throw new UsageError(`--${name} does not take a value`);
        values[def.name] = negated ? false : inline === undefined ? true : parseBool(inline, def.name);
        continue;
      }
      if (inline !== undefined) {
        setValue(def, inline);
        continue;
      }
      if (i + 1 >= tokens.length) throw new UsageError(`--${def.name} needs a value`);
      setValue(def, tokens[++i]!);
      continue;
    }
    if (token.startsWith("-") && token.length === 2 && token !== "--") {
      const def = short.get(token.slice(1));
      if (!def) throw new UsageError(`Unknown flag ${token}`);
      if (def.kind === "boolean") {
        values[def.name] = true;
        continue;
      }
      if (i + 1 >= tokens.length) throw new UsageError(`${token} needs a value`);
      setValue(def, tokens[++i]!);
      continue;
    }
    positionals.push(token);
  }
  return { values, positionals };
}

export interface CommandLine {
  /** The words that name the command, like ["emails", "list"] or ["send"]. */
  words: string[];
  /** Global flags, with their values, found before or between the command words. */
  globalTokens: string[];
  /** Everything after the command words, not parsed yet. */
  rest: string[];
}

/**
 * Find the command words before the command's own flags are known. Global
 * flags may come before or between the words; they are set aside with their
 * values. The scan stops at any other flag, or when `wordsFor(first)` words
 * are found. After "--", the next tokens complete the command and the rest
 * stay positional.
 */
export function splitCommandLine(argv: string[], globals: FlagDef[], wordsFor: (first: string) => number): CommandLine {
  const { long, short } = index(globals);
  const arity = (token: string): number | undefined => {
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const { def, negated } = lookupLong(long, token.slice(2, eq === -1 ? undefined : eq));
      if (!def) return undefined;
      return def.kind === "value" && eq === -1 && !negated ? 1 : 0;
    }
    const def = token.length === 2 ? short.get(token.slice(1)) : undefined;
    return def ? (def.kind === "value" ? 1 : 0) : undefined;
  };
  const words: string[] = [];
  const globalTokens: string[] = [];
  const wanted = () => (words.length === 0 ? 1 : wordsFor(words[0]!));
  let i = 0;
  while (i < argv.length && words.length < wanted()) {
    const token = argv[i]!;
    if (token === "--") {
      const tail = argv.slice(i + 1);
      while (tail.length > 0 && words.length < wanted()) words.push(tail.shift()!);
      return { words, globalTokens, rest: tail.length > 0 ? ["--", ...tail] : [] };
    }
    if (token.startsWith("-") && token !== "-") {
      const n = arity(token);
      if (n === undefined) break;
      globalTokens.push(...argv.slice(i, i + 1 + n));
      i += 1 + n;
      continue;
    }
    words.push(token);
    i++;
  }
  return { words, globalTokens, rest: argv.slice(i) };
}

/**
 * Parse a command's flags and the global flags together, so each value flag
 * takes its next token even when that token looks like a flag. A command flag
 * that would shadow a global flag, or its --no- form, is an error; such an
 * alias is dropped.
 */
export function parseWithGlobals(tokens: string[], local: FlagDef[], globals: FlagDef[]): { local: ParseResult; global: FlagValues } {
  const claimed = new Set<string>();
  for (const g of globals) {
    for (const n of [g.name, ...(g.aliases ?? [])]) {
      claimed.add(n);
      if (g.kind === "boolean") claimed.add(`no-${n}`);
    }
  }
  const shorts = new Set(globals.map((g) => g.short).filter((s): s is string => Boolean(s)));
  const clashes = (d: FlagDef, name: string) => claimed.has(name) || (d.kind === "boolean" && claimed.has(`no-${name}`));
  const own = local.map((d) => {
    if (clashes(d, d.name) || (d.short !== undefined && shorts.has(d.short))) {
      throw new CliError(`The flag --${d.name} of this command clashes with a global flag`, 1, "Upgrade smtpfast. Until then, pass the field with --data.");
    }
    return { ...d, aliases: (d.aliases ?? []).filter((a) => !clashes(d, a)) };
  });
  const parsed = parseArgs(tokens, [...own, ...globals]);
  const globalNames = new Set(globals.map((g) => g.name));
  const localValues: FlagValues = {};
  const globalValues: FlagValues = {};
  for (const [k, v] of Object.entries(parsed.values)) (globalNames.has(k) ? globalValues : localValues)[k] = v;
  return { local: { values: localValues, positionals: parsed.positionals }, global: globalValues };
}

/** The single value of a flag, or undefined. */
export function one(values: FlagValues, name: string): string | undefined {
  const v = values[name];
  return Array.isArray(v) ? v[v.length - 1] : undefined;
}

export function many(values: FlagValues, name: string): string[] {
  const v = values[name];
  return Array.isArray(v) ? v : [];
}

export function bool(values: FlagValues, name: string): boolean | undefined {
  const v = values[name];
  return typeof v === "boolean" ? v : undefined;
}
