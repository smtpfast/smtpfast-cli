/**
 * Build standalone binaries with `bun build --compile`. Bun cross-compiles,
 * so one Linux machine builds all five.
 *
 *   bun scripts/build-binaries.ts                  all targets into dist-bin/
 *   bun scripts/build-binaries.ts linux-arm64      one target
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist-bin");

export const TARGETS: Record<string, string> = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};

if (import.meta.main) {
  const wanted = process.argv.slice(2);
  const names = wanted.length > 0 ? wanted : Object.keys(TARGETS);
  mkdirSync(OUT, { recursive: true });
  const sums: string[] = [];
  for (const name of names) {
    const target = TARGETS[name];
    if (!target) {
      process.stderr.write(`Unknown target ${name}. Known: ${Object.keys(TARGETS).join(", ")}\n`);
      process.exit(2);
    }
    const file = `smtpfast-${name}${name.startsWith("windows") ? ".exe" : ""}`;
    const outfile = join(OUT, file);
    process.stdout.write(`Building ${file}\n`);
    const result = Bun.spawnSync(["bun", "build", "--compile", `--target=${target}`, join(ROOT, "src", "bin.ts"), "--outfile", outfile], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
    sums.push(`${createHash("sha256").update(readFileSync(outfile)).digest("hex")}  ${file}`);
  }
  writeFileSync(join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`);
}
