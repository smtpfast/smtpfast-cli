/**
 * Write src/version.ts from package.json, so the version is available to the
 * npm build and to the standalone binaries alike.
 *
 *   bun scripts/sync-version.ts           write the file
 *   bun scripts/sync-version.ts --check   fail if it is out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function versionSource(version: string): string {
  return `// Written by scripts/sync-version.ts from package.json. Do not edit.\nexport const VERSION = ${JSON.stringify(version)};\n`;
}

if (import.meta.main) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  const file = join(ROOT, "src", "version.ts");
  const wanted = versionSource(pkg.version);
  const current = readFileSync(file, "utf8");
  if (process.argv.includes("--check")) {
    if (current !== wanted) {
      process.stderr.write(`src/version.ts does not match package.json ${pkg.version}. Run: bun scripts/sync-version.ts\n`);
      process.exit(1);
    }
  } else if (current !== wanted) {
    writeFileSync(file, wanted);
    process.stdout.write(`src/version.ts set to ${pkg.version}\n`);
  }
}
