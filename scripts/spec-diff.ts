/**
 * Describe how the commands changed between two manifests, as Markdown.
 * The spec sync workflow uses it for the changelog entry and the release notes.
 *
 *   bun scripts/spec-diff.ts <old-manifest.json> <new-manifest.json>
 *   bun scripts/spec-diff.ts <old> <new> --changelog 0.3.0   also prepend an entry to CHANGELOG.md
 *   bun scripts/spec-diff.ts <old> <new> --level             print "minor" or "patch" only
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest, OperationSpec, ParamSpec } from "../src/spec/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface ManifestDiff {
  added: OperationSpec[];
  removed: OperationSpec[];
  changed: Array<{ op: OperationSpec; changes: string[] }>;
}

function flagsOf(op: OperationSpec): Map<string, ParamSpec> {
  return new Map([...op.queryParams, ...op.headerParams, ...(op.body?.fields ?? [])].map((p) => [p.flag, p]));
}

function name(op: OperationSpec): string {
  return `smtpfast ${op.group} ${op.command}`;
}

export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const oldById = new Map(before.operations.map((o) => [o.operationId, o]));
  const newById = new Map(after.operations.map((o) => [o.operationId, o]));
  const added = after.operations.filter((o) => !oldById.has(o.operationId));
  const removed = before.operations.filter((o) => !newById.has(o.operationId));
  const changed: ManifestDiff["changed"] = [];
  for (const op of after.operations) {
    const prev = oldById.get(op.operationId);
    if (!prev) continue;
    const changes: string[] = [];
    if (name(prev) !== name(op)) changes.push(`renamed from \`${name(prev)}\``);
    if (prev.method !== op.method || prev.path !== op.path) changes.push(`now ${op.method} ${op.path}`);
    const prevArgs = prev.pathParams.map((p) => p.name).join(" ");
    const args = op.pathParams.map((p) => p.name).join(" ");
    if (prevArgs !== args) changes.push(`arguments are now ${args ? op.pathParams.map((p) => `<${p.name}>`).join(" ") : "none"}`);
    const oldFlags = flagsOf(prev);
    const newFlags = flagsOf(op);
    const addedFlags = [...newFlags.keys()].filter((f) => !oldFlags.has(f));
    const removedFlags = [...oldFlags.keys()].filter((f) => !newFlags.has(f));
    const nowRequired = [...newFlags.entries()].filter(([f, p]) => p.required && oldFlags.has(f) && !oldFlags.get(f)!.required).map(([f]) => f);
    const nowOptional = [...newFlags.entries()].filter(([f, p]) => !p.required && oldFlags.get(f)?.required).map(([f]) => f);
    if (addedFlags.length > 0) changes.push(`new flags ${addedFlags.map((f) => `--${f}`).join(", ")}`);
    if (removedFlags.length > 0) changes.push(`removed flags ${removedFlags.map((f) => `--${f}`).join(", ")}`);
    if (nowRequired.length > 0) changes.push(`now required: ${nowRequired.map((f) => `--${f}`).join(", ")}`);
    if (nowOptional.length > 0) changes.push(`now optional: ${nowOptional.map((f) => `--${f}`).join(", ")}`);
    if (changes.length > 0) changed.push({ op, changes });
  }
  return { added, removed, changed };
}

/**
 * The version bump a diff deserves: minor when a command, argument or flag
 * was added, removed or changed, patch when only the spec text changed (help
 * text, descriptions, examples).
 */
export function bumpLevel(diff: ManifestDiff): "minor" | "patch" {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0 ? "minor" : "patch";
}

export function renderDiff(diff: ManifestDiff): string {
  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push("### New commands", "");
    for (const op of diff.added) lines.push(`- \`${name(op)}\` (${op.method} ${op.path}): ${op.summary}`);
    lines.push("");
  }
  if (diff.changed.length > 0) {
    lines.push("### Changed commands", "");
    for (const { op, changes } of diff.changed) lines.push(`- \`${name(op)}\`: ${changes.join("; ")}`);
    lines.push("");
  }
  if (diff.removed.length > 0) {
    lines.push("### Removed commands", "");
    for (const op of diff.removed) lines.push(`- \`${name(op)}\` (${op.method} ${op.path})`);
    lines.push("");
  }
  if (lines.length === 0) lines.push("The API spec changed, but no command, argument or flag did. Help text may have changed.", "");
  return lines.join("\n");
}

export function prependChangelog(changelog: string, version: string, date: string, notes: string): string {
  const entry = `## [${version}] - ${date}\n\nUpdated from the live API spec.\n\n${notes.trim()}\n\n`;
  const idx = changelog.indexOf("\n## ");
  if (idx === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return `${changelog.slice(0, idx + 1)}${entry}${changelog.slice(idx + 1)}`;
}

if (import.meta.main) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    process.stderr.write("Usage: bun scripts/spec-diff.ts <old-manifest.json> <new-manifest.json> [--changelog <version> | --level]\n");
    process.exit(2);
  }
  const before = existsSync(oldPath) ? (JSON.parse(readFileSync(oldPath, "utf8")) as Manifest) : ({ operations: [] } as unknown as Manifest);
  const after = JSON.parse(readFileSync(newPath, "utf8")) as Manifest;
  const diff = diffManifests(before, after);
  if (process.argv.includes("--level")) {
    process.stdout.write(`${bumpLevel(diff)}\n`);
    process.exit(0);
  }
  const notes = renderDiff(diff);
  const i = process.argv.indexOf("--changelog");
  if (i !== -1 && process.argv[i + 1]) {
    const file = join(ROOT, "CHANGELOG.md");
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(file, prependChangelog(readFileSync(file, "utf8"), process.argv[i + 1]!, date, notes));
  }
  process.stdout.write(notes);
}
