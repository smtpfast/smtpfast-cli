import { canonicalJson, specHash } from "./hash.js";
import { GROUP_DESCRIPTIONS, isPathParam, kebab, nameOperation, synthesizeOperationId } from "./naming.js";
import type {
  BodySpec,
  BuildWarning,
  GroupSpec,
  HttpMethod,
  Json,
  JsonObject,
  Manifest,
  OperationSpec,
  ParamSpec,
  ValueType,
} from "./types.js";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Flags the CLI owns on every command: the global flags, the --no- forms of
 * the global booleans, and --data. A parameter that maps to one of these gets
 * another flag.
 */
export const RESERVED_FLAGS = new Set([
  "api-key",
  "base-url",
  "data",
  "debug",
  "help",
  "idempotency-key",
  "json",
  "no-color",
  "no-debug",
  "no-help",
  "no-json",
  "no-no-color",
  "no-no-update-check",
  "no-quiet",
  "no-update-check",
  "no-version",
  "profile",
  "quiet",
  "version",
]);

/** True when a parameter can use this flag name. A boolean also answers to --no-<flag>, so that form must not be reserved. */
export function flagIsFree(flag: string, type: ValueType, taken: Set<string>): boolean {
  return !taken.has(flag) && !RESERVED_FLAGS.has(flag) && !(type === "boolean" && RESERVED_FLAGS.has(`no-${flag}`));
}

/** Decode percent escapes until nothing changes, so %252e%252e is seen as "..". */
function decodeFully(segment: string): string {
  let s = segment;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(s);
    } catch {
      return s;
    }
    if (next === s) return s;
    s = next;
  }
  return s;
}

/** True for "." and "..", plain or percent-encoded. A URL parser removes these segments, so they can climb out of the base path. */
export function isDotSegment(segment: string): boolean {
  const decoded = decodeFully(segment);
  return segment === "." || segment === ".." || decoded === "." || decoded === "..";
}

const SPEC_PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@{}%/]+$/;

/**
 * A spec path the CLI is willing to call: it starts with /v1/, has no empty
 * or dot segments, and has nothing that could change the scheme, host, query
 * or fragment once it is joined to the base URL.
 */
export function isSafeSpecPath(path: string): boolean {
  if (!path.startsWith("/v1/") || path.includes("//") || !SPEC_PATH_CHARS.test(path)) return false;
  return path.split("/").every((seg) => {
    const decoded = decodeFully(seg);
    return !isDotSegment(seg) && !/[/\\?#]/.test(decoded);
  });
}

/** Headers the HTTP layer sets itself. Declared header params with these names are ignored. */
const MANAGED_HEADERS = new Set(["accept", "authorization", "content-type", "user-agent"]);

export interface BuildResult {
  manifest: Manifest;
  warnings: BuildWarning[];
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: Json | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function cleanText(v: Json | undefined): string | undefined {
  const s = str(v)?.trim();
  return s ? s : undefined;
}

function scalarExample(v: Json | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const first = v[0];
    if (v.every((x) => typeof x === "string" || typeof x === "number")) return v.map(String).join(",");
    return first === undefined ? undefined : canonicalJson(v);
  }
  return canonicalJson(v);
}

class Resolver {
  constructor(
    private readonly spec: JsonObject,
    private readonly warnings: BuildWarning[],
  ) {}

  operation = "";

  warn(message: string): void {
    this.warnings.push({ operation: this.operation, message });
  }

  pointer(ref: string): Json | undefined {
    if (!ref.startsWith("#/")) {
      this.warn(`External $ref is not supported: ${ref}`);
      return undefined;
    }
    let node: Json | undefined = this.spec;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      node = isObj(node) ? node[key] : undefined;
      if (node === undefined) {
        this.warn(`Unresolved $ref: ${ref}`);
        return undefined;
      }
    }
    return node;
  }

  /** Follow $ref chains. Sibling keys next to a $ref override the target, as OpenAPI 3.1 allows. */
  deref(node: Json | undefined, seen: Set<string> = new Set()): JsonObject | undefined {
    if (!isObj(node)) return undefined;
    const ref = str(node.$ref);
    if (!ref) return node;
    if (seen.has(ref)) return {};
    const target = this.deref(this.pointer(ref), new Set([...seen, ref]));
    const { $ref: _ignored, ...siblings } = node;
    return { ...(target ?? {}), ...siblings };
  }

  /** Resolve $ref and merge allOf into one schema with the union of properties and required. */
  flatten(node: Json | undefined, seen: Set<string> = new Set()): JsonObject {
    const s = this.deref(node, seen);
    if (!s) return {};
    if (!Array.isArray(s.allOf)) return s;
    const { allOf, ...rest } = s;
    const merged: JsonObject = {};
    const properties: JsonObject = {};
    const required = new Set<string>();
    for (const part of [...(allOf as Json[]).map((p) => this.flatten(p, seen)), rest as JsonObject]) {
      for (const [k, v] of Object.entries(part)) {
        if (k === "properties" && isObj(v)) Object.assign(properties, v);
        else if (k === "required" && Array.isArray(v)) v.forEach((r) => typeof r === "string" && required.add(r));
        else merged[k] = v;
      }
    }
    if (Object.keys(properties).length > 0) merged.properties = properties;
    if (required.size > 0) merged.required = [...required];
    return merged;
  }

  /** The CLI-level type of a schema: one of the ValueTypes, or "null" for a null-only variant. */
  describe(node: Json | undefined): {
    type: ValueType | "null";
    items?: ValueType;
    nullable: boolean;
    enum?: string[];
  } {
    const s = this.flatten(node);
    let types = Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === "string") : str(s.type) ? [s.type as string] : [];
    let nullable = s.nullable === true || types.includes("null");
    const nonNullTypes = types.filter((t) => t !== "null");
    if (types.length > 0 && nonNullTypes.length === 0) return { type: "null", nullable: true };
    types = nonNullTypes;

    const variants = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : undefined;
    if (types.length === 0 && variants) {
      const described = variants.map((v) => this.describe(v));
      if (described.some((d) => d.type === "null" || d.nullable)) nullable = true;
      const real = described.filter((d) => d.type !== "null");
      const arrayVariant = real.find((d) => d.type === "array");
      if (arrayVariant) {
        // "a string or a list of strings": a list covers both.
        return { type: "array", items: arrayVariant.items ?? "string", nullable, enum: arrayVariant.enum };
      }
      const first = real[0];
      if (first && real.every((d) => d.type === first.type)) return { ...first, nullable };
      if (real.some((d) => d.type === "object")) return { type: "object", nullable };
      if (real.length > 0) return { type: "string", nullable };
    }

    if (types.length === 0) {
      if (isObj(s.properties) || s.additionalProperties !== undefined) types = ["object"];
      else if (s.items !== undefined) types = ["array"];
      else types = ["string"];
    }
    const type = toValueType(types[0]!);
    const out: { type: ValueType; items?: ValueType; nullable: boolean; enum?: string[] } = { type, nullable };
    if (type === "array") {
      const items = this.describe(s.items);
      out.items = items.type === "null" ? "string" : items.type;
      if (items.enum) out.enum = items.enum;
    }
    if (Array.isArray(s.enum)) {
      const values = s.enum.filter((e): e is string | number | boolean => e !== null && typeof e !== "object").map(String);
      if (values.length > 0) out.enum = values;
    }
    return out;
  }

  param(name: string, location: ParamSpec["in"], schemaNode: Json | undefined, required: boolean, description?: string, example?: Json): ParamSpec {
    const schema = this.flatten(schemaNode);
    const d = this.describe(schemaNode);
    const p: ParamSpec = {
      name,
      flag: "",
      in: location,
      type: d.type === "null" ? "string" : d.type,
      required,
    };
    if (d.items) p.items = d.items;
    const desc = description ?? cleanText(schema.description);
    if (desc) p.description = desc;
    if (d.enum) p.enum = d.enum;
    const def = schema.default;
    if (typeof def === "string" || typeof def === "number" || typeof def === "boolean") p.default = def;
    const ex = scalarExample(example ?? schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined));
    if (ex !== undefined) p.example = ex;
    if (d.nullable) p.nullable = true;
    return p;
  }
}

function toValueType(t: string): ValueType {
  switch (t) {
    case "integer":
    case "number":
    case "boolean":
    case "array":
    case "object":
    case "string":
      return t;
    default:
      return "string";
  }
}

function byName(a: ParamSpec, b: ParamSpec): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const VALID_FLAG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Give every query, header and body parameter a distinct flag. The kebab-case
 * name wins when it is free. On a clash (firstName and first_name both want
 * --first-name) query params come first, then names without capitals, and the
 * rest keep their exact API name as the flag.
 */
export function assignFlags(params: ParamSpec[]): void {
  const taken = new Set(RESERVED_FLAGS);
  const rank = (p: ParamSpec) => (p.in === "query" ? 0 : p.in === "header" ? 1 : 2) * 2 + (/[A-Z]/.test(p.name) ? 1 : 0);
  const candidates = new Map<string, ParamSpec[]>();
  for (const p of params) {
    const cand = kebab(p.name) || p.name;
    const list = candidates.get(cand) ?? [];
    list.push(p);
    candidates.set(cand, list);
  }
  const losers: ParamSpec[] = [];
  for (const [cand, list] of candidates) {
    const sorted = [...list].sort((a, b) => rank(a) - rank(b) || byName(a, b));
    const [winner, ...rest] = sorted;
    if (winner && flagIsFree(cand, winner.type, taken)) {
      winner.flag = cand;
      taken.add(cand);
    } else if (winner) {
      losers.push(winner);
    }
    losers.push(...rest);
  }
  for (const p of losers) {
    const options = [p.name, `${p.in}-${kebab(p.name) || p.name}`];
    let flag = options.find((o) => VALID_FLAG.test(o) && flagIsFree(o, p.type, taken));
    for (let i = 2; !flag; i++) {
      const o = `${p.in}-${kebab(p.name) || "param"}-${i}`;
      if (flagIsFree(o, p.type, taken)) flag = o;
    }
    p.flag = flag;
    taken.add(flag);
  }
}

function buildBody(r: Resolver, op: JsonObject): BodySpec | null {
  const rb = r.deref(op.requestBody);
  if (!rb) return null;
  const content = isObj(rb.content) ? rb.content : {};
  const types = Object.keys(content);
  const contentType =
    types.find((t) => t === "application/json") ?? types.find((t) => t.endsWith("+json")) ?? types[0] ?? "application/json";
  const media = isObj(content[contentType]) ? (content[contentType] as JsonObject) : {};
  const schema = r.flatten(media.schema);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  let type: BodySpec["type"] = "unknown";
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (declared.includes("array") || (schema.items !== undefined && !isObj(schema.properties))) type = "array";
  else if (declared.includes("object") || isObj(schema.properties)) type = "object";
  if (!contentType.includes("json")) type = "unknown";

  const fields: ParamSpec[] = [];
  if (type === "object" && isObj(schema.properties)) {
    for (const [name, propNode] of Object.entries(schema.properties)) {
      const prop = r.flatten(propNode);
      if (prop.readOnly === true) continue;
      fields.push(r.param(name, "body", propNode, required.has(name), cleanText(prop.description)));
    }
  }
  fields.sort(byName);
  return { required: rb.required === true, contentType, type, fields };
}

function collectParams(r: Resolver, pathItem: JsonObject, op: JsonObject): JsonObject[] {
  const merged = new Map<string, JsonObject>();
  for (const list of [pathItem.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = r.deref(raw);
      const name = p && str(p.name);
      const loc = p && str(p.in);
      if (!p || !name || !loc) {
        r.warn("Parameter without a name or location");
        continue;
      }
      merged.set(`${loc}:${name}`, p);
    }
  }
  return [...merged.values()];
}

function paramSchema(p: JsonObject): Json | undefined {
  if (p.schema !== undefined) return p.schema;
  if (isObj(p.content)) {
    const first = Object.values(p.content)[0];
    if (isObj(first)) return first.schema;
  }
  return undefined;
}

function buildOperation(r: Resolver, path: string, method: HttpMethod, pathItem: JsonObject, op: JsonObject): OperationSpec {
  let operationId = str(op.operationId)?.trim();
  if (!operationId) {
    operationId = synthesizeOperationId(method, path);
    r.operation = `${method} ${path}`;
    r.warn(`No operationId; using ${operationId}`);
  }
  r.operation = operationId;

  const { group, command } = nameOperation(operationId, method, path);
  const params = collectParams(r, pathItem, op);
  const templateNames = path
    .split("/")
    .filter(isPathParam)
    .map((s) => s.slice(1, -1));

  const pathParams: ParamSpec[] = [];
  for (const name of templateNames) {
    const declared = params.find((p) => p.in === "path" && p.name === name);
    if (!declared) r.warn(`Path parameter {${name}} is not declared`);
    pathParams.push(
      r.param(name, "path", declared ? paramSchema(declared) : { type: "string" }, true, declared ? cleanText(declared.description) : undefined),
    );
  }
  for (const p of pathParams) p.flag = kebab(p.name);
  for (const p of params) {
    if (p.in === "path" && !templateNames.includes(str(p.name) ?? "")) r.warn(`Path parameter ${str(p.name)} is not in the path`);
  }

  const queryParams: ParamSpec[] = [];
  const headerParams: ParamSpec[] = [];
  let idempotencyKey = false;
  for (const p of params) {
    const name = str(p.name)!;
    if (p.in === "query") {
      queryParams.push(r.param(name, "query", paramSchema(p), p.required === true, cleanText(p.description), p.example));
    } else if (p.in === "header") {
      const lower = name.toLowerCase();
      if (lower === "idempotency-key") idempotencyKey = true;
      else if (!MANAGED_HEADERS.has(lower)) headerParams.push(r.param(name, "header", paramSchema(p), p.required === true, cleanText(p.description), p.example));
    }
  }
  queryParams.sort(byName);
  headerParams.sort(byName);

  const body = buildBody(r, op);
  assignFlags([...queryParams, ...headerParams, ...(body?.fields ?? [])]);

  const description = cleanText(op.description);
  let summary = cleanText(op.summary);
  if (!summary) {
    r.warn("No summary");
    summary = description?.split(/(?<=\.)\s/)[0] ?? `${method} ${path}`;
  }
  const tags = Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [];

  const spec: OperationSpec = {
    operationId,
    method,
    path,
    group,
    command,
    summary,
  } as OperationSpec;
  if (description && description !== summary) spec.description = description;
  spec.tags = tags;
  if (op.deprecated === true) spec.deprecated = true;
  if (idempotencyKey) spec.idempotencyKey = true;
  spec.pathParams = pathParams;
  spec.queryParams = queryParams;
  spec.headerParams = headerParams;
  spec.body = body;
  return spec;
}

function groupDescriptions(spec: JsonObject, operations: OperationSpec[]): GroupSpec[] {
  const tagText = new Map<string, string>();
  if (Array.isArray(spec.tags)) {
    for (const t of spec.tags) {
      if (isObj(t) && str(t.name)) tagText.set(t.name as string, cleanText(t.description) ?? (t.name as string));
    }
  }
  const counts = new Map<string, Map<string, number>>();
  for (const op of operations) {
    const tag = op.tags[0];
    if (!tag) continue;
    const m = counts.get(op.group) ?? new Map<string, number>();
    m.set(tag, (m.get(tag) ?? 0) + 1);
    counts.set(op.group, m);
  }
  const names = [...new Set(operations.map((o) => o.group))].sort();
  return names.map((name) => {
    const tags = [...(counts.get(name) ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const tag = tags[0]?.[0];
    const description = GROUP_DESCRIPTIONS[name] ?? (tag ? (tagText.get(tag) ?? tag) : name);
    return { name, description };
  });
}

/** Make (group, command) unique. Clashing operations fall back to the kebab-cased operationId. */
export function ensureUnique(operations: OperationSpec[], taken: Set<string> = new Set(), warn?: (op: OperationSpec, msg: string) => void): void {
  const key = (o: OperationSpec) => `${o.group} ${o.command}`;
  const counts = new Map<string, number>();
  for (const o of operations) counts.set(key(o), (counts.get(key(o)) ?? 0) + 1);
  for (const o of operations) {
    if ((counts.get(key(o)) ?? 0) < 2 && !taken.has(key(o))) continue;
    const before = key(o);
    o.command = kebab(o.operationId) || o.command;
    if (taken.has(key(o)) || operations.some((x) => x !== o && key(x) === key(o))) o.command = `${o.command}-${o.method.toLowerCase()}`;
    warn?.(o, `Name "${before}" is taken; using "${key(o)}"`);
  }
  for (const o of operations) taken.add(key(o));
}

export function buildManifest(specInput: unknown): BuildResult {
  if (!isObj(specInput as Json) || !isObj((specInput as JsonObject).paths)) {
    throw new Error("Not an OpenAPI document: missing paths");
  }
  const spec = specInput as JsonObject;
  const warnings: BuildWarning[] = [];
  const r = new Resolver(spec, warnings);
  const operations: OperationSpec[] = [];
  const paths = spec.paths as JsonObject;
  for (const path of Object.keys(paths).sort()) {
    if (!isSafeSpecPath(path)) {
      warnings.push({ operation: path, message: "Skipped: the path must start with /v1/ and have no dot segments, empty segments, scheme or host" });
      continue;
    }
    const item = r.deref(paths[path]);
    if (!item) continue;
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (isObj(op)) operations.push(buildOperation(r, path, method, item, op));
    }
  }
  ensureUnique(operations, new Set(), (op, message) => warnings.push({ operation: op.operationId, message }));
  operations.sort((a, b) => (a.group === b.group ? (a.command < b.command ? -1 : 1) : a.group < b.group ? -1 : 1));

  const info = isObj(spec.info) ? spec.info : {};
  const manifest: Manifest = {
    manifestVersion: 1,
    specTitle: str(info.title) ?? "API",
    specVersion: str(info.version) ?? "0",
    specHash: specHash(spec),
    operationCount: operations.length,
    groups: groupDescriptions(spec, operations),
    operations,
  };
  return { manifest, warnings };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
