import type { HttpMethod } from "./types.js";

/**
 * Naming rules that turn an OpenAPI operation into `smtpfast <group> <command>`.
 *
 * Group: the first path segment after /v1, unless a prefix below maps it to
 * another name. Command: the operationId with the group's resource words
 * removed, kebab-cased. "list" and "get" are dropped when a sub-resource
 * follows (listWebhookDeliveries -> deliveries, getDomainClaimRecord ->
 * claim-record), except "get" on a path with an id.
 *
 * The tables below are the only place that needs editing when a rule gives a
 * bad name. The build and the runtime both use this file, so a command built
 * on the fly from a newer spec gets the same name the next release will give it.
 */

/** Path prefixes (after the version segment) mapped to a group name. The longest match wins. */
export const GROUP_ALIASES: Record<string, string> = {
  "/emails/receiving": "received",
  "/me": "account",
  "/usage": "account",
};

/** Extra resource words stripped from operationIds in a group, on top of the group name. */
export const GROUP_WORDS: Record<string, string[]> = {
  forms: ["signup"],
  received: ["email", "receiving"],
};

/** Per-operation overrides for names the rules get wrong. Keep this small. */
export const COMMAND_OVERRIDES: Record<string, { group?: string; command?: string }> = {
  // PATCH and PUT on the same path. "update" means a partial update everywhere else.
  patchWebhook: { command: "update" },
  updateWebhook: { command: "replace" },
};

/** Group descriptions for groups whose spec tag has none, or a shared one that reads badly. */
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  account: "The API key's scopes, plan, rate limit and usage",
  "contact-properties": "Declare custom contact properties",
  forms: "Signup forms and pending double opt-in signups",
  segments: "Group contacts into segments",
  suppressions: "Addresses that SMTPfast will not send to",
};

/** Hand-written top-level commands. A generated group with one of these names is renamed. */
export const RESERVED_TOP_LEVEL = new Set([
  "api",
  "commands",
  "completion",
  "help",
  "login",
  "logout",
  "profiles",
  "send",
  "version",
  "whoami",
]);

const CONNECTORS = new Set(["a", "an", "at", "by", "for", "from", "in", "of", "on", "the", "to", "with"]);

export function splitWords(name: string): string[] {
  return (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
}

export function kebab(name: string): string {
  return splitWords(name).join("-");
}

export function isPathParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

export function versionlessSegments(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  if (segs.length > 0 && /^v\d+$/.test(segs[0]!)) segs.shift();
  return segs;
}

export function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function plural(word: string): string {
  if (word.endsWith("s")) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export function groupFor(path: string): { group: string; prefix: string[] } {
  const segs = versionlessSegments(path);
  let best: string[] | undefined;
  let bestGroup: string | undefined;
  for (const [key, group] of Object.entries(GROUP_ALIASES)) {
    const parts = key.split("/").filter(Boolean);
    const matches = parts.length <= segs.length && parts.every((p, i) => p === segs[i]);
    if (matches && (!best || parts.length > best.length)) {
      best = parts;
      bestGroup = group;
    }
  }
  if (best && bestGroup) return { group: bestGroup, prefix: best };
  const first = segs[0] && !isPathParam(segs[0]) ? segs[0] : undefined;
  if (!first) return { group: "misc", prefix: [] };
  return { group: kebab(first) || "misc", prefix: [first] };
}

export function resourceWords(group: string): Set<string> {
  const base = [...splitWords(group), ...(GROUP_WORDS[group] ?? []).flatMap(splitWords)];
  const out = new Set<string>();
  for (const w of base) {
    out.add(w);
    out.add(singular(w));
    out.add(plural(w));
  }
  return out;
}

export function defaultVerb(method: HttpMethod, onItem: boolean): string {
  switch (method) {
    case "GET":
      return onItem ? "get" : "list";
    case "POST":
      return "create";
    case "PUT":
      return "replace";
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
  }
}

function endsWithParam(path: string): boolean {
  const segs = versionlessSegments(path);
  return segs.length > 0 && isPathParam(segs[segs.length - 1]!);
}

/** An operationId for an operation that has none, shaped so the normal rules give a sensible name. */
export function synthesizeOperationId(method: HttpMethod, path: string): string {
  const segs = versionlessSegments(path);
  const { prefix } = groupFor(path);
  const tail = segs.slice(prefix.length).filter((s) => !isPathParam(s));
  const onItem = endsWithParam(path);
  let words: string[];
  if (method === "POST" && tail.length > 0 && !onItem) {
    words = [...splitWords(tail[tail.length - 1]!), ...tail.slice(0, -1).flatMap(splitWords)];
  } else {
    words = [defaultVerb(method, onItem), ...tail.flatMap(splitWords)];
  }
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

export interface NameResult {
  group: string;
  command: string;
  /** True when an override decided the name rather than the rules. */
  overridden: boolean;
}

export function nameOperation(operationId: string, method: HttpMethod, path: string): NameResult {
  const { group: pathGroup } = groupFor(path);
  const override = COMMAND_OVERRIDES[operationId];
  const baseGroup = override?.group ?? pathGroup;
  const group = RESERVED_TOP_LEVEL.has(baseGroup) ? `${baseGroup}-api` : baseGroup;
  const hasPathParams = path.includes("{");
  let command = override?.command;
  if (!command) {
    const words = resourceWords(baseGroup);
    const rest = splitWords(operationId).filter((w) => !words.has(w));
    while (rest.length > 1 && CONNECTORS.has(rest[rest.length - 1]!)) rest.pop();
    while (rest.length > 1 && CONNECTORS.has(rest[0]!)) rest.shift();
    if (rest.length === 0) {
      command = defaultVerb(method, endsWithParam(path));
    } else {
      const [verb, ...tail] = rest;
      if (tail.length > 0 && verb === "list") command = tail.join("-");
      else if (tail.length > 0 && verb === "get" && !hasPathParams) command = tail.join("-");
      else command = rest.join("-");
    }
  }
  return { group, command, overridden: Boolean(override) };
}
