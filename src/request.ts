import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type FlagDef, type FlagValues, one, type ParseResult } from "./args.js";
import { CliError, UsageError } from "./errors.js";
import type { Query } from "./http.js";
import { flagIsFree, isDotSegment, isSafeSpecPath } from "./spec/build.js";
import type { OperationSpec, ParamSpec, ValueType } from "./spec/types.js";
import { readAll, splitList } from "./util.js";

export interface InputSources {
  cwd: string;
  stdin: NodeJS.ReadableStream;
}

export interface BuiltRequest {
  method: string;
  path: string;
  query: Query;
  headers: Record<string, string>;
  body?: unknown;
}

const DATA_FLAG: FlagDef = {
  name: "data",
  kind: "value",
  valueName: "json",
  description: "Request body as JSON, @file.json, or - for stdin. Field flags override its fields.",
};

export function acceptsData(op: OperationSpec): boolean {
  return op.body !== null || op.method === "POST" || op.method === "PUT" || op.method === "PATCH";
}

export function valueName(p: ParamSpec): string {
  if (p.type === "array") return p.items === "object" ? "json" : (p.items ?? "string");
  if (p.type === "object") return "json|key=value";
  if (p.enum && p.enum.join("|").length <= 40) return p.enum.join("|");
  return p.type;
}

export function flagParams(op: OperationSpec): ParamSpec[] {
  return [...op.queryParams, ...op.headerParams, ...(op.body?.fields ?? [])];
}

/** Flag definitions for a generated command. The exact API name also works as a flag when it is free. */
export function operationFlagDefs(op: OperationSpec): FlagDef[] {
  const params = flagParams(op);
  const canonical = new Set(params.map((p) => p.flag));
  const aliasUsed = new Set<string>();
  const defs: FlagDef[] = params.map((p) => {
    const aliases: string[] = [];
    if (p.name !== p.flag && !canonical.has(p.name) && flagIsFree(p.name, p.type, aliasUsed) && /^[A-Za-z0-9][\w.-]*$/.test(p.name)) {
      aliases.push(p.name);
      aliasUsed.add(p.name);
    }
    return {
      name: p.flag,
      aliases,
      kind: p.type === "boolean" ? "boolean" : "value",
      multiple: p.type === "array" || p.type === "object",
      description: p.description,
      valueName: valueName(p),
      required: p.required,
    };
  });
  if (acceptsData(op)) defs.push(DATA_FLAG);
  return defs;
}

function scalar(raw: string, type: ValueType | undefined, flag: string): unknown {
  switch (type) {
    case "integer":
      if (!/^-?\d+$/.test(raw.trim())) throw new UsageError(`--${flag} takes an integer, got "${raw}"`);
      return Number(raw);
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${flag} takes a number, got "${raw}"`);
      return n;
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "1", "yes"].includes(v)) return true;
      if (["false", "0", "no"].includes(v)) return false;
      throw new UsageError(`--${flag} takes true or false, got "${raw}"`);
    }
    default:
      return raw;
  }
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`${what} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Turn the raw strings of one flag into the value the API expects, using the parameter's schema type. */
export function coerce(p: ParamSpec, raw: string[] | boolean): unknown {
  const flag = p.flag;
  if (typeof raw === "boolean") return raw;
  if (p.nullable && raw.length === 1 && raw[0] === "null") return null;
  switch (p.type) {
    case "array": {
      const out: unknown[] = [];
      for (const v of raw) {
        const t = v.trim();
        if (t.startsWith("[")) {
          const parsed = parseJson(t, `--${flag}`);
          if (!Array.isArray(parsed)) throw new UsageError(`--${flag} must be a JSON array`);
          out.push(...parsed);
        } else if (p.items === "object") {
          const parsed = parseJson(t, `--${flag}`);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`--${flag} takes a JSON object per value`);
          out.push(parsed);
        } else {
          out.push(...splitList(v).map((item) => scalar(item, p.items, flag)));
        }
      }
      return out;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const v of raw) {
        const t = v.trim();
        if (t.startsWith("{")) {
          const parsed = parseJson(t, `--${flag}`);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`--${flag} must be a JSON object`);
          Object.assign(out, parsed);
        } else {
          const eq = v.indexOf("=");
          if (eq <= 0) throw new UsageError(`--${flag} takes JSON or key=value, got "${v}"`);
          out[v.slice(0, eq)] = v.slice(eq + 1);
        }
      }
      return out;
    }
    default:
      return scalar(raw[raw.length - 1]!, p.type, flag);
  }
}

function queryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));
  if (value !== null && typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

/** Read --data: inline JSON, @path, or - (or @-) for stdin. */
export async function loadData(raw: string, io: InputSources): Promise<unknown> {
  let text: string;
  let what = "--data";
  if (raw === "-" || raw === "@-") {
    text = await readAll(io.stdin);
    what = "JSON from stdin";
  } else if (raw.startsWith("@")) {
    const file = resolve(io.cwd, raw.slice(1));
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new UsageError(`Cannot read ${raw.slice(1)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    what = raw.slice(1);
  } else {
    text = raw;
  }
  if (!text.trim()) throw new UsageError(`${what} is empty`);
  return parseJson(text, what);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A user value as one URL path segment. "." and ".." (also percent-encoded) are refused: they would move the request to another route. */
export function pathSegment(value: string, name: string): string {
  if (!value) throw new UsageError(`<${name}> cannot be empty`);
  if (isDotSegment(value)) throw new UsageError(`<${name}> cannot be "${value}"`, "Dot segments like . and .. are not allowed in an argument.");
  return encodeURIComponent(value);
}

export function usageLine(op: OperationSpec): string {
  const args = op.pathParams.map((p) => `<${p.name}>`).join(" ");
  return `smtpfast ${op.group} ${op.command}${args ? ` ${args}` : ""} [flags]`;
}

export async function buildRequest(op: OperationSpec, parsed: ParseResult, io: InputSources): Promise<BuiltRequest> {
  const { values, positionals } = parsed;
  if (positionals.length < op.pathParams.length) {
    const missing = op.pathParams.slice(positionals.length).map((p) => `<${p.name}>`);
    throw new UsageError(`Missing argument${missing.length > 1 ? "s" : ""} ${missing.join(" ")}`, `Usage: ${usageLine(op)}`);
  }
  if (positionals.length > op.pathParams.length) {
    throw new UsageError(`Unexpected argument "${positionals[op.pathParams.length]}"`, `Usage: ${usageLine(op)}`);
  }
  if (!isSafeSpecPath(op.path)) throw new CliError(`Refusing to call ${op.path}: the path must start with /v1/ and have no dot segments`);
  let path = op.path;
  op.pathParams.forEach((p, i) => {
    const segment = pathSegment(positionals[i]!, p.name);
    path = path.replace(`{${p.name}}`, () => segment);
  });

  const missing: string[] = [];
  const query: Query = [];
  for (const p of op.queryParams) {
    const raw = values[p.flag];
    if (raw === undefined) {
      if (p.required) missing.push(`--${p.flag}`);
      continue;
    }
    for (const v of queryValues(coerce(p, raw))) query.push([p.name, v]);
  }
  const headers: Record<string, string> = {};
  for (const p of op.headerParams) {
    const raw = values[p.flag];
    if (raw === undefined) {
      if (p.required) missing.push(`--${p.flag}`);
      continue;
    }
    headers[p.name] = queryValues(coerce(p, raw)).join(",");
  }

  let body: unknown;
  const dataRaw = one(values, "data");
  if (dataRaw !== undefined) body = await loadData(dataRaw, io);
  const fields = fieldValues(op, values);
  if (Object.keys(fields).length > 0) {
    if (body === undefined) body = {};
    if (!isPlainObject(body)) throw new UsageError("--data must be a JSON object when you also pass field flags");
    body = { ...body, ...fields };
  }
  if (op.body) {
    if (body === undefined) {
      if (op.body.type === "array") {
        if (op.body.required) throw new UsageError("This command takes a JSON array as its body", 'Pass it with --data \'[...]\', --data @file.json or --data -.');
      } else {
        // An empty object keeps servers that always parse the body happy.
        body = {};
      }
    }
    if (op.body.type === "object" && isPlainObject(body)) {
      for (const f of op.body.fields) if (f.required && !(f.name in body)) missing.push(`--${f.flag}`);
    }
  }
  if (missing.length > 0) {
    throw new UsageError(`Missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, `Usage: ${usageLine(op)}`);
  }
  return { method: op.method, path, query, headers, body };
}

function fieldValues(op: OperationSpec, values: FlagValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of op.body?.fields ?? []) {
    const raw = values[f.flag];
    if (raw !== undefined) out[f.name] = coerce(f, raw);
  }
  return out;
}
