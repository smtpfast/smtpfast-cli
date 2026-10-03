import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bumpLevel, diffManifests, prependChangelog, renderDiff } from "../scripts/spec-diff.js";
import { versionSource } from "../scripts/sync-version.js";
import { buildManifest } from "../src/spec/build.js";
import { fixtureSpec, tempDir } from "./helpers.js";

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

  test("a text-only change is a patch release, a command change is a minor one", () => {
    const before = buildManifest(fixtureSpec()).manifest;
    const textOnly = fixtureSpec();
    textOnly.paths["/v1/emails"].get.summary = "List the emails you sent";
    expect(bumpLevel(diffManifests(before, buildManifest(textOnly).manifest))).toBe("patch");
    const newFlag = fixtureSpec();
    newFlag.paths["/v1/emails"].get.parameters.push({ name: "tag", in: "query", schema: { type: "string" } });
    expect(bumpLevel(diffManifests(before, buildManifest(newFlag).manifest))).toBe("minor");
    const removed = fixtureSpec();
    delete removed.paths["/v1/analytics"];
    expect(bumpLevel(diffManifests(before, buildManifest(removed).manifest))).toBe("minor");
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

describe("spec sync workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "spec-sync.yml"), "utf8");
  const step = (name: string) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    expect(start).toBeGreaterThan(-1);
    const end = workflow.indexOf("\n      - name:", start + 1);
    return workflow.slice(start, end === -1 ? undefined : end);
  };

  test("decides a change on the spec with sorted keys plus the generated files", () => {
    const diff = step("Check for changes");
    expect(diff).toContain("git show HEAD:spec/openapi.json | jq -S -c .");
    expect(diff).toContain("jq -S -c . spec/openapi.json");
    expect(diff).toContain("git diff --quiet -- src/generated README.md");
    expect(diff).not.toContain("git diff --quiet -- spec");
  });

  test("the version bump comes from the command diff, not always minor", () => {
    const bump = step("Bump the version and write the changelog");
    expect(bump).toContain('--level)');
    expect(bump).toContain('npm version "$level" --no-git-tag-version');
    expect(bump).not.toContain("npm version minor");
  });

  test("every push sends main and the tag together, atomically", () => {
    const pushes = workflow.split("\n").filter((l) => /\bgit push\b/.test(l));
    expect(pushes.length).toBe(2);
    for (const l of pushes) expect(l).toContain('git push --atomic origin HEAD:main "refs/tags/$TAG"');
  });

  /** The shell of the "Commit, tag and push" step, run the way Actions runs it, against local repos. */
  function pushSandbox() {
    const lines = step("Commit, tag and push").split("\n");
    const script: string[] = [];
    for (const l of lines.slice(lines.findIndex((x) => x.trim() === "run: |") + 1)) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      script.push(l.slice(10));
    }
    const root = tempDir("smtpfast-push-");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const write = (dir: string, file: string, text: string) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    for (const f of ["spec/openapi.json", "src/generated/manifest.json", "src/version.ts", "README.md", "CHANGELOG.md", "package.json", "docs/other.md"]) write(seed, f, "v0\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "start");
    const remote = join(root, "remote.git");
    git(root, "clone", "-q", "--bare", seed, remote);
    const clone = (name: string) => {
      git(root, "clone", "-q", remote, name);
      return join(root, name);
    };
    const work = clone("work");
    const bin = join(root, "bin");
    write(bin, "bun", '#!/bin/sh\necho "$*" >> "$BUN_LOG"\nif [ "$1" = test ] && [ -n "$BUN_TEST_FAILS" ]; then exit 1; fi\n');
    chmodSync(join(bin, "bun"), 0o755);
    const bunLog = join(root, "bun.log");
    writeFileSync(bunLog, "");
    /** Another push to main while the sync job works. */
    const moveMain = (file: string, text: string) => {
      const other = clone(`other-${Math.random().toString(36).slice(2)}`);
      write(other, file, text);
      git(other, "commit", "-q", "-am", "meanwhile");
      git(other, "push", "-q", "origin", "main");
      return git(other, "rev-parse", "HEAD");
    };
    const runStep = (extra: Record<string, string> = {}) => {
      write(work, "spec/openapi.json", "v1\n");
      write(work, "package.json", "v1\n");
      return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script.join("\n")], {
        cwd: work,
        env: { ...env, PATH: `${bin}:${process.env.PATH}`, TAG: "v0.2.0", BUN_LOG: bunLog, ...extra },
        encoding: "utf8",
      });
    };
    const remoteTag = () => git(remote, "tag", "--list", "v0.2.0");
    const remoteMain = () => git(remote, "rev-parse", "main");
    return { git, remote, runStep, moveMain, remoteTag, remoteMain, bunCalls: () => readFileSync(bunLog, "utf8") };
  }

  test("the push step lands main and the tag together", () => {
    const box = pushSandbox();
    const r = box.runStep();
    expect(r.status).toBe(0);
    expect(box.remoteTag()).toBe("v0.2.0");
    expect(box.git(box.remote, "rev-parse", "v0.2.0^{commit}")).toBe(box.remoteMain());
    expect(box.bunCalls()).toBe("");
  });

  test("when main moved, the push step rebases, tests and pushes once more", () => {
    const box = pushSandbox();
    const moved = box.moveMain("docs/other.md", "moved\n");
    const r = box.runStep();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("main moved during this run");
    expect(box.git(box.remote, "rev-parse", "main~1")).toBe(moved);
    expect(box.git(box.remote, "rev-parse", "v0.2.0^{commit}")).toBe(box.remoteMain());
    expect(box.bunCalls()).toBe("scripts/generate.ts\nrun typecheck\ntest\n");
  });

  test("a conflicting move of main stops the step without a tag", () => {
    const box = pushSandbox();
    const moved = box.moveMain("package.json", "bumped by hand\n");
    const r = box.runStep();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("does not rebase onto the new main");
    expect(box.remoteTag()).toBe("");
    expect(box.remoteMain()).toBe(moved);
  });

  test("failing tests after the rebase stop the step without a tag", () => {
    const box = pushSandbox();
    const moved = box.moveMain("docs/other.md", "moved\n");
    const r = box.runStep({ BUN_TEST_FAILS: "1" });
    expect(r.status).not.toBe(0);
    expect(box.remoteTag()).toBe("");
    expect(box.remoteMain()).toBe(moved);
  });
});
