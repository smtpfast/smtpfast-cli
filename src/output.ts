import type { Context, OutStream } from "./context.js";
import { ApiError, CliError, UsageError } from "./errors.js";
import type { OperationSpec } from "./spec/types.js";

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function colors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const PREFERRED_COLUMNS = [
  "id",
  "type",
  "name",
  "email",
  "domain",
  "from",
  "to",
  "subject",
  "url",
  "status",
  "reason",
  "active",
  "created_at",
];

type Row = Record<string, unknown>;

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

function isScalarArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.every(isScalar);
}

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cellText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s*\n\s*/g, " ");
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 3) return s.slice(0, width);
  return `${s.slice(0, width - 3)}...`;
}

const PAGINATION_KEYS = new Set(["object", "has_more", "total", "count", "page", "per_page", "limit", "next", "next_cursor", "cursor", "pages", "total_pages"]);

/**
 * The items of a list response: a bare array, { data: [...] } with scalar
 * fields beside it, or one array of objects next to pagination fields
 * ({ contacts: [...], total: 3 }). An object with its own id, like a domain
 * with dns_records, is a single object, not a list.
 */
export function findList(data: unknown): { items: Row[]; meta: Row } | undefined {
  if (Array.isArray(data)) return data.every(isRow) ? { items: data as Row[], meta: {} } : undefined;
  if (!isRow(data) || "id" in data) return undefined;
  const isRows = (v: unknown) => Array.isArray(v) && v.every(isRow);
  const arrays = Object.entries(data).filter(([, v]) => isRows(v));
  const others = Object.entries(data).filter(([, v]) => !isRows(v));
  if (!others.every(([, v]) => isScalar(v))) return undefined;
  if (isRows(data.data)) {
    const { data: items, ...meta } = data;
    return { items: items as Row[], meta };
  }
  if (arrays.length === 1 && (data.object === "list" || others.every(([k]) => PAGINATION_KEYS.has(k)))) {
    return { items: arrays[0]![1] as Row[], meta: Object.fromEntries(others) };
  }
  return undefined;
}

export function pickColumns(rows: Row[], max = 7): string[] {
  const seen: string[] = [];
  const bad = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    for (const [k, v] of Object.entries(row)) {
      if (!seen.includes(k)) seen.push(k);
      if (!isScalar(v) && !isScalarArray(v)) bad.add(k);
    }
  }
  const usable = seen.filter((k) => !bad.has(k) && k !== "object");
  const ranked = [
    ...PREFERRED_COLUMNS.filter((k) => usable.includes(k)),
    ...usable.filter((k) => !PREFERRED_COLUMNS.includes(k)),
  ];
  return ranked.slice(0, max);
}

export function renderTable(rows: Row[], width: number, c: Colors, columns = pickColumns(rows)): string {
  if (columns.length === 0) return rows.map((r) => JSON.stringify(r)).join("\n");
  const header = columns.map((k) => k.replace(/_/g, " ").toUpperCase());
  const cells = rows.map((r) => columns.map((k) => cellText(r[k])));
  const widths = columns.map((_, i) => Math.max(header[i]!.length, ...cells.map((row) => row[i]!.length)));
  const gap = 2;
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  while (total() > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 8) break;
    widths[widest]!--;
  }
  const line = (values: string[], style?: (s: string) => string) =>
    values
      .map((v, i) => {
        const text = truncate(v, widths[i]!);
        const padded = i === values.length - 1 ? text : text.padEnd(widths[i]!);
        return style ? style(padded) : padded;
      })
      .join(" ".repeat(gap))
      .trimEnd();
  return [line(header, c.bold), ...cells.map((r) => line(r))].join("\n");
}

function flatten(obj: Row, prefix: string, depth: number, out: Array<[string, string]>, tables: Array<[string, Row[]]>): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isScalar(v)) out.push([key, cellText(v)]);
    else if (isScalarArray(v)) out.push([key, cellText(v)]);
    else if (Array.isArray(v) && v.every(isRow)) {
      if (v.length === 0) out.push([key, ""]);
      else tables.push([key, v as Row[]]);
    } else if (isRow(v) && depth < 2) flatten(v, key, depth + 1, out, tables);
    else out.push([key, JSON.stringify(v)]);
  }
}

export function renderKeyValue(obj: Row, width: number, c: Colors): string {
  const pairs: Array<[string, string]> = [];
  const tables: Array<[string, Row[]]> = [];
  // Multi-line strings (email bodies) keep their line breaks below the key.
  const multiline: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.includes("\n")) multiline.push([k, v]);
  }
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !multiline.some(([m]) => m === k)));
  flatten(rest, "", 0, pairs, tables);
  const keyWidth = Math.min(28, Math.max(0, ...pairs.map(([k]) => k.length)));
  const lines = pairs.map(([k, v]) => `${c.bold(k.padEnd(keyWidth))}  ${v}`);
  for (const [k, v] of multiline) {
    lines.push(c.bold(k));
    for (const l of v.replace(/\r\n/g, "\n").split("\n")) lines.push(`  ${l}`);
  }
  for (const [k, rows] of tables) {
    lines.push("", c.bold(k), renderTable(rows, width, c));
  }
  return lines.join("\n");
}

export function collectIds(data: unknown): string[] {
  const list = findList(data);
  const items = list ? list.items : isRow(data) ? [data] : [];
  return items.map((i) => i.id).filter((id): id is string | number => typeof id === "string" || typeof id === "number").map(String);
}

/** Shorter values are not treated as keys. Redacting them would garble unrelated text. */
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

export interface ResultOptions {
  op?: OperationSpec;
  /** Printed on a TTY when the response has no body. */
  emptyMessage?: string;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly tty: boolean;
  readonly c: Colors;
  readonly ce: Colors;
  private readonly secrets = new Set<string>();

  constructor(
    private readonly ctx: Pick<Context, "stdout" | "stderr" | "env">,
    options: { json: boolean; quiet: boolean; noColor: boolean },
  ) {
    this.tty = Boolean(ctx.stdout.isTTY);
    this.json = options.json || !this.tty;
    this.quiet = options.quiet;
    const colorAllowed = !options.noColor && !ctx.env.NO_COLOR && ctx.env.TERM !== "dumb";
    this.c = colors(colorAllowed && this.tty);
    this.ce = colors(colorAllowed && Boolean(ctx.stderr.isTTY));
  }

  get width(): number {
    return Math.max(40, this.ctx.stdout.columns ?? 100);
  }

  out(text: string): void {
    this.ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Remember an API key. Everything written to stderr has it replaced with [redacted]. */
  addSecret(value: string | undefined): void {
    if (!value || value.length < MIN_SECRET_LENGTH) return;
    // Also the forms it takes inside a URL or a JSON string.
    for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) this.secrets.add(form);
  }

  redact(text: string): string {
    let out = text;
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
    return out;
  }

  /** Errors, hints and --debug lines all go through here, so an API key never reaches stderr. */
  err(text: string): void {
    const safe = this.redact(text);
    this.ctx.stderr.write(safe.endsWith("\n") ? safe : `${safe}\n`);
  }

  writeRaw(stream: OutStream, data: string | Uint8Array): void {
    stream.write(data);
  }

  jsonOut(data: unknown): void {
    this.out(JSON.stringify(data, null, 2));
  }

  /** Print an API response the way the current mode asks for. */
  result(data: unknown, options: ResultOptions = {}): void {
    if (this.quiet) {
      for (const id of collectIds(data)) this.out(id);
      return;
    }
    if (data instanceof Uint8Array) {
      if (this.tty) this.err(`Binary response (${data.byteLength} bytes). Redirect it to a file, for example: > file.bin`);
      else this.writeRaw(this.ctx.stdout, data);
      return;
    }
    if (typeof data === "string") {
      this.out(data);
      return;
    }
    if (data === null || data === undefined) {
      if (!this.json) this.out(options.emptyMessage ?? "Done.");
      return;
    }
    if (this.json) {
      this.jsonOut(data);
      return;
    }
    const list = findList(data);
    if (list) {
      if (list.items.length === 0) this.out(this.c.dim("No results."));
      else this.out(renderTable(list.items, this.width, this.c));
      const extra = Object.entries(list.meta).filter(([k, v]) => !PAGINATION_KEYS.has(k) && v !== null && v !== undefined);
      if (extra.length > 0) this.out(this.c.dim(extra.map(([k, v]) => `${k}: ${cellText(v)}`).join("  ")));
      const footer = this.pageHint(list, options.op);
      if (footer) this.out(this.c.dim(footer));
      return;
    }
    if (isRow(data)) {
      this.out(renderKeyValue(data, this.width, this.c));
      return;
    }
    this.jsonOut(data);
  }

  private pageHint(list: { items: Row[]; meta: Row }, op?: OperationSpec): string | undefined {
    if (list.meta.has_more !== true) return undefined;
    const last = list.items[list.items.length - 1]?.id;
    const flags = new Set(op?.queryParams.map((p) => p.flag) ?? []);
    if (flags.has("after") && last !== undefined) return `More results. Next page: --after ${String(last)}`;
    if (flags.has("page")) {
      const page = typeof list.meta.page === "number" ? list.meta.page : 1;
      return `More results. Next page: --page ${page + 1}`;
    }
    return "More results.";
  }

  error(err: unknown, helpCommand?: string, debug = false): number {
    const c = this.ce;
    if (err instanceof ApiError) {
      const text = STATUS_TEXT[err.status] ?? "";
      this.err(`${c.red("Error:")} HTTP ${err.status}${text ? ` ${text}` : ""}: ${err.message}`);
      const scope = err.missingScope;
      if (scope) {
        this.err(
          `${c.yellow("Hint:")} This API key does not have the ${scope} scope. Create a key with that scope in the SMTPfast dashboard, then run smtpfast login.`,
        );
      } else if (err.status === 401) {
        this.err(`${c.yellow("Hint:")} Check the key with smtpfast whoami, or store a new one with smtpfast login.`);
      }
      if (debug && err.body !== undefined) this.err(typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2));
      return err.exitCode;
    }
    if (err instanceof UsageError) {
      this.err(`${c.red("Error:")} ${err.message}`);
      if (err.hint) this.err(`${c.yellow("Hint:")} ${err.hint}`);
      if (helpCommand && err.showUsage) this.err(c.dim(`Run "${helpCommand} --help" for usage.`));
      return err.exitCode;
    }
    if (err instanceof CliError) {
      this.err(`${c.red("Error:")} ${err.message}`);
      if (err.hint) this.err(`${c.yellow("Hint:")} ${err.hint}`);
      return err.exitCode;
    }
    const e = err as Error;
    this.err(`${c.red("Error:")} ${e?.message ?? String(err)}`);
    if (debug && e?.stack) this.err(e.stack);
    return 1;
  }
}
