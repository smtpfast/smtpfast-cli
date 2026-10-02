/**
 * Report problems in the OpenAPI spec that make the CLI (or any generated
 * client) worse. It does not change anything.
 *
 *   bun scripts/lint-spec.ts [spec/openapi.json]
 */
import { readFileSync } from "node:fs";
import { buildManifest } from "../src/spec/build.js";

type Obj = Record<string, any>;
const METHODS = ["get", "post", "put", "patch", "delete"];

export function lintSpec(spec: Obj): string[] {
  const issues: string[] = [];
  const declaredTags = new Set((spec.tags ?? []).map((t: Obj) => t.name));
  const usedTags = new Set<string>();
  const pathParamStyles = new Map<string, string[]>();
  const writeOpsWithIdempotency: string[] = [];
  const writeOpsWithout: string[] = [];
  const style = (name: string) => (/_/.test(name) ? "snake_case" : /[a-z][A-Z]/.test(name) ? "camelCase" : "lower");

  for (const [path, item] of Object.entries<Obj>(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const id = op.operationId ?? `${method.toUpperCase()} ${path}`;
      if (!op.operationId) issues.push(`${method.toUpperCase()} ${path}: no operationId`);
      if (!op.summary) issues.push(`${id}: no summary`);
      if (!op.tags?.length) issues.push(`${id}: no tags`);
      for (const t of op.tags ?? []) usedTags.add(t);
      if (["post", "put", "patch"].includes(method) && !op.requestBody) issues.push(`${id}: ${method.toUpperCase()} without a requestBody`);
      const ok = Object.entries<Obj>(op.responses ?? {}).filter(([code]) => code.startsWith("2"));
      for (const [code, res] of ok) if (!res.content && code !== "204") issues.push(`${id}: ${code} response has no schema`);
      const params: Obj[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
      for (const p of params) {
        if (p.in === "path") pathParamStyles.set(style(p.name), [...(pathParamStyles.get(style(p.name)) ?? []), `${id}:${p.name}`]);
        if (p.in === "query" && !p.description && !p.schema?.description) issues.push(`${id}: query parameter ${p.name} has no description`);
      }
      if (["post", "put", "patch"].includes(method)) {
        const declares = params.some((p) => p.in === "header" && String(p.name).toLowerCase() === "idempotency-key");
        (declares ? writeOpsWithIdempotency : writeOpsWithout).push(id);
      }
    }
  }
  for (const t of usedTags) if (!declaredTags.has(t)) issues.push(`tag "${t}" is used by operations but not declared in the top-level tags`);
  if (pathParamStyles.size > 1) {
    const minority = [...pathParamStyles.entries()].filter(([s]) => s !== "lower" && s !== "snake_case");
    for (const [s, list] of minority) issues.push(`path parameters mix naming styles: ${list.join(", ")} use ${s}, the rest use snake_case`);
  }
  if (writeOpsWithIdempotency.length > 0) {
    const sends = writeOpsWithout.filter((id) => /send/i.test(id));
    if (sends.length > 0) issues.push(`Idempotency-Key is declared on ${writeOpsWithIdempotency.join(", ")} but not on ${sends.join(", ")}`);
  }
  for (const [name, schema] of Object.entries<Obj>(spec.components?.schemas ?? {})) {
    const props = Object.keys(schema.properties ?? {});
    const camel = props.filter((p) => style(p) === "camelCase");
    const snake = props.filter((p) => style(p) === "snake_case");
    if (camel.length > 0 && snake.length > 0) issues.push(`schema ${name} mixes camelCase (${camel.join(", ")}) and snake_case (${snake.join(", ")}) properties`);
  }
  const { warnings } = buildManifest(spec);
  for (const w of warnings) issues.push(`generator: ${w.operation}: ${w.message}`);
  return issues;
}

if (import.meta.main) {
  const file = process.argv[2] ?? "spec/openapi.json";
  const issues = lintSpec(JSON.parse(readFileSync(file, "utf8")));
  for (const i of issues) process.stdout.write(`- ${i}\n`);
  process.stdout.write(`${issues.length} issue${issues.length === 1 ? "" : "s"}\n`);
}
