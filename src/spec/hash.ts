import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so formatting and key order do not change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** A copy with object keys sorted at every level, for a snapshot that does not depend on key order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, sortKeys(obj[k])]),
  );
}

export function specHash(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}
