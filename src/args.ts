import { UsageError } from "./errors.js";
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
  /** Tokens left alone in lenient mode, in their original order. */
  rest: string[];
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

function parseBool(raw: string, flag: string): boolean {
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new UsageError(`--${flag} takes true or false, got "${raw}"`);
}

/**
 * Parse flags. Value flags always take the next token, even one that starts
 * with a dash, so `--data -` and `--limit -1` work. In lenient mode unknown
 * tokens are kept in `rest` untouched; this is how global flags are pulled out
 * of a command line before the command is known.
 */
export function parseArgs(tokens: string[], defs: FlagDef[], options: { lenient?: boolean } = {}): ParseResult {
  const { long, short } = index(defs);
  const values: FlagValues = {};
  const positionals: string[] = [];
  const rest: string[] = [];

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
      const tail = tokens.slice(i + 1);
      if (options.lenient) rest.push(...tokens.slice(i));
      else positionals.push(...tail);
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      let def = long.get(name);
      let negated = false;
      if (!def && name.startsWith("no-")) {
        const base = long.get(name.slice(3));
        if (base?.kind === "boolean") {
          def = base;
          negated = true;
        }
      }
      if (!def) {
        if (options.lenient) {
          rest.push(token);
          continue;
        }
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
      if (!def) {
        if (options.lenient) {
          rest.push(token);
          continue;
        }
        throw new UsageError(`Unknown flag ${token}`);
      }
      if (def.kind === "boolean") {
        values[def.name] = true;
        continue;
      }
      if (i + 1 >= tokens.length) throw new UsageError(`${token} needs a value`);
      setValue(def, tokens[++i]!);
      continue;
    }
    if (options.lenient) rest.push(token);
    else positionals.push(token);
  }
  return { values, positionals, rest };
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
