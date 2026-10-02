import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffManifests, prependChangelog, renderDiff } from "../scripts/spec-diff.js";
import { versionSource } from "../scripts/sync-version.js";
import { buildManifest } from "../src/spec/build.js";
import { fixtureSpec } from "./helpers.js";

const ROOT = join(import.meta.dir, "..");

describe("spec-diff", () => {
  test("reports new, changed and removed commands", () => {
    const before = buildManifest(fixtureSpec()).manifest;
    const spec = fixtureSpec();
    spec.paths["/v1/emails/{id}/archive"] = { post: { operationId: "archiveEmail", summary: "Archive an email" } };
    delete spec.paths["/v1/analytics"];
    spec.paths["/v1/emails"].get.parameters.push({ name: "tag", in: "query", schema: { type: "string" } });
    const after = buildManifest(spec).manifest;
    const diff = diffManifests(before, after);
    expect(diff.added.map((o) => o.operationId)).toEqual(["archiveEmail"]);
    expect(diff.removed.map((o) => o.operationId)).toEqual(["getAnalytics"]);
    expect(diff.changed).toEqual([{ op: expect.objectContaining({ operationId: "listEmails" }), changes: ["new flags --tag"] }]);
    const md = renderDiff(diff);
    expect(md).toContain("### New commands\n\n- `smtpfast emails archive` (POST /v1/emails/{id}/archive): Archive an email");
    expect(md).toContain("- `smtpfast emails list`: new flags --tag");
    expect(md).toContain("### Removed commands\n\n- `smtpfast analytics get` (GET /v1/analytics)");
  });

  test("a text-only spec change says so", () => {
    const m = buildManifest(fixtureSpec()).manifest;
    expect(renderDiff(diffManifests(m, m))).toContain("no command, argument or flag did");
  });

  test("changelog entries go above the previous release", () => {
    const changelog = "# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-10-03\n\nFirst release.\n";
    const out = prependChangelog(changelog, "0.2.0", "2026-10-10", "### New commands\n\n- x\n");
    expect(out).toBe("# Changelog\n\nIntro.\n\n## [0.2.0] - 2026-10-10\n\nUpdated from the live API spec.\n\n### New commands\n\n- x\n\n## [0.1.0] - 2026-10-03\n\nFirst release.\n");
  });
});

describe("version", () => {
  test("src/version.ts matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(readFileSync(join(ROOT, "src", "version.ts"), "utf8")).toBe(versionSource(pkg.version));
  });
});
