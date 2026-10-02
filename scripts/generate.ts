/**
 * Build src/generated/manifest.json and the README command reference from the OpenAPI spec.
 *
 *   bun scripts/generate.ts                      use spec/openapi.json
 *   bun scripts/generate.ts --spec <url|file>    read another spec, and save it to spec/openapi.json
 *   bun scripts/generate.ts --check              fail if the generated files are out of date
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "../src/args.js";
import { buildManifest, serializeManifest } from "../src/spec/build.js";
import { updateReadme } from "./reference.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PATHS = {
  spec: join(ROOT, "spec", "openapi.json"),
  manifest: join(ROOT, "src", "generated", "manifest.json"),
  readme: join(ROOT, "README.md"),
};

export async function loadSpecText(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { Accept: "application/json", "User-Agent": "smtpfast-cli-generator" } });
    if (!res.ok) throw new Error(`GET ${source} returned HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(source, "utf8");
}

export interface GenerateResult {
  files: Record<string, string>;
  warnings: string[];
  operationCount: number;
  groupCount: number;
}

/** Everything the generator writes, keyed by path. Pure, so tests can call it. */
export function generate(specText: string, readme: string, paths = PATHS): GenerateResult {
  const spec = JSON.parse(specText) as unknown;
  const { manifest, warnings } = buildManifest(spec);
  const normalizedSpec = `${JSON.stringify(spec, null, 2)}\n`;
  return {
    files: {
      [paths.spec]: normalizedSpec,
      [paths.manifest]: serializeManifest(manifest),
      [paths.readme]: updateReadme(readme, manifest),
    },
    warnings: warnings.map((w) => `${w.operation}: ${w.message}`),
    operationCount: manifest.operationCount,
    groupCount: manifest.groups.length,
  };
}

async function cli(argv: string[]): Promise<number> {
  const { values } = parseArgs(argv, [
    { name: "spec", kind: "value" },
    { name: "check", kind: "boolean" },
  ]);
  const source = Array.isArray(values.spec) ? values.spec[0]! : PATHS.spec;
  const check = values.check === true;
  const specText = await loadSpecText(source);
  const readme = readFileSync(PATHS.readme, "utf8");
  const result = generate(specText, readme);
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);

  const stale: string[] = [];
  for (const [file, content] of Object.entries(result.files)) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (current === content) continue;
    stale.push(file.slice(ROOT.length));
    if (!check) writeFileSync(file, content);
  }
  const summary = `${result.operationCount} operations in ${result.groupCount} groups`;
  if (check) {
    if (stale.length > 0) {
      process.stderr.write(`Out of date: ${stale.join(", ")}\nRun: bun scripts/generate.ts\n`);
      return 1;
    }
    process.stdout.write(`Generated files are up to date (${summary}).\n`);
    return 0;
  }
  process.stdout.write(stale.length > 0 ? `Updated ${stale.join(", ")} (${summary}).\n` : `No changes (${summary}).\n`);
  return 0;
}

if (import.meta.main) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
