import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maybeStartRefresh, metaPath, readMeta, REFRESH_INTERVAL_MS, refreshSpec, specPath, writeMeta } from "../src/refresh.js";
import { fixtureSpec, type MockServer, run, sendJson, startMockServer, tempDir } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const NOW = Date.parse("2026-10-03T12:00:00Z");

/** The fixture spec plus one operation this version was not built with. */
function specWithNewOperation(): Record<string, any> {
  const spec = fixtureSpec();
  spec.paths["/v1/emails/{id}/archive"] = {
    post: {
      operationId: "archiveEmail",
      summary: "Archive an email",
      tags: ["Emails"],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
    },
  };
  spec.paths["/v1/widgets"] = { get: { operationId: "listWidgets", summary: "List widgets", tags: ["Widgets"] } };
  return spec;
}

function seedCache(configHome: string, spec: unknown, checkedAt = NOW) {
  const dir = join(configHome, "smtpfast");
  mkdirSync(dir, { recursive: true });
  writeFileSync(specPath(dir), JSON.stringify(spec));
  writeMeta(dir, { checked_at: checkedAt });
  return dir;
}

describe("background refresh trigger", () => {
  test("no cache, or a stale one, starts a refresh and records the attempt", () => {
    const dir = join(tempDir(), "smtpfast");
    const spawned: unknown[] = [];
    const spawn = (a: unknown) => spawned.push(a);
    expect(maybeStartRefresh({ dir, url: "http://x/v1/openapi.json", now: NOW, spawn })).toBe(true);
    expect(readMeta(dir).checked_at).toBe(NOW);
    expect(maybeStartRefresh({ dir, url: "u", now: NOW + 60_000, spawn })).toBe(false);
    expect(maybeStartRefresh({ dir, url: "u", now: NOW + REFRESH_INTERVAL_MS + 1, spawn })).toBe(true);
    expect(spawned).toEqual([
      { configDir: dir, url: "http://x/v1/openapi.json" },
      { configDir: dir, url: "u" },
    ]);
  });

  test("a stale cache triggers a refresh from a normal command, without waiting for it", async () => {
    const configHome = tempDir();
    seedCache(configHome, fixtureSpec(), NOW - REFRESH_INTERVAL_MS - 1000);
    const r = await run(["--help"], { configHome, now: () => NOW, env: { SMTPFAST_NO_UPDATE_CHECK: undefined, SMTPFAST_BASE_URL: "http://127.0.0.1:1/api" } });
    expect(r.code).toBe(0);
    expect(r.spawned).toEqual([{ configDir: join(configHome, "smtpfast"), url: "http://127.0.0.1:1/api/v1/openapi.json" }]);
  });

  test("a fresh cache does not", async () => {
    const configHome = tempDir();
    seedCache(configHome, fixtureSpec(), NOW - 1000);
    const r = await run(["--help"], { configHome, now: () => NOW, env: { SMTPFAST_NO_UPDATE_CHECK: undefined } });
    expect(r.spawned).toEqual([]);
  });

  test("--no-update-check and SMTPFAST_NO_UPDATE_CHECK turn it off", async () => {
    const a = await run(["--no-update-check", "--help"], { env: { SMTPFAST_NO_UPDATE_CHECK: undefined } });
    expect(a.spawned).toEqual([]);
    const b = await run(["--help"], { env: { SMTPFAST_NO_UPDATE_CHECK: "1" } });
    expect(b.spawned).toEqual([]);
    const c = await run(["--help"], { env: { SMTPFAST_NO_UPDATE_CHECK: undefined } });
    expect(c.spawned.length).toBe(1);
  });

  test("SMTPFAST_SPEC_URL overrides where the spec comes from", async () => {
    const r = await run(["--help"], { env: { SMTPFAST_NO_UPDATE_CHECK: undefined, SMTPFAST_SPEC_URL: "http://spec.test/openapi.json" } });
    expect(r.spawned[0]!.url).toBe("http://spec.test/openapi.json");
  });
});

describe("refreshSpec", () => {
  test("stores the spec and ETag, then revalidates with If-None-Match", async () => {
    const body = JSON.stringify(fixtureSpec());
    server = await startMockServer((req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
      res.end(body);
    });
    const dir = join(tempDir(), "smtpfast");
    const args = { dir, url: `${server.url}/api/v1/openapi.json`, fetch: (i: string | URL | Request, o?: RequestInit) => fetch(i, o), userAgent: "t" };
    expect(await refreshSpec({ ...args, now: NOW })).toBe("updated");
    expect(readFileSync(specPath(dir), "utf8")).toBe(body);
    const meta = readMeta(dir);
    expect(meta).toMatchObject({ checked_at: NOW, fetched_at: NOW, etag: '"v1"', operation_count: 78 });
    expect(meta.hash).toHaveLength(64);
    expect(server.requests[0]!.path).toBe("/api/v1/openapi.json");
    expect(server.requests[0]!.headers.authorization).toBeUndefined();

    expect(await refreshSpec({ ...args, now: NOW + 5 })).toBe("unchanged");
    expect(server.requests[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(readMeta(dir)).toMatchObject({ checked_at: NOW + 5, fetched_at: NOW });
  });

  test("failures are silent and keep the old cache", async () => {
    const configHome = tempDir();
    const dir = seedCache(configHome, fixtureSpec(), NOW - REFRESH_INTERVAL_MS * 2);
    const before = readFileSync(specPath(dir), "utf8");
    let mode = "500";
    server = await startMockServer((_req, res) => {
      if (mode === "500") sendJson(res, 500, { error: "boom" });
      else if (mode === "junk") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<html>not json</html>");
      } else if (mode === "not-openapi") sendJson(res, 200, { hello: "world" });
      // "hang": never answer
    });
    const args = { dir, url: `${server.url}/v1/openapi.json`, fetch: (i: string | URL | Request, o?: RequestInit) => fetch(i, o), userAgent: "t", timeoutMs: 100 };
    for (const m of ["500", "junk", "not-openapi", "hang"]) {
      mode = m;
      expect(await refreshSpec({ ...args, now: NOW })).toBe("failed");
      expect(readFileSync(specPath(dir), "utf8")).toBe(before);
    }
    expect(readMeta(dir).checked_at).toBe(NOW);
    expect(readMeta(dir).last_error).toBeTruthy();
    const unreachable = await refreshSpec({ dir, url: "http://127.0.0.1:9/v1/openapi.json", fetch: args.fetch, userAgent: "t", now: NOW });
    expect(unreachable).toBe("failed");
  });

  test("the hidden __refresh-spec command does the same work", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, fixtureSpec()));
    const configHome = tempDir();
    const dir = join(configHome, "smtpfast");
    const r = await run(["__refresh-spec", "--url", `${server.url}/v1/openapi.json`, "--config-dir", dir], { configHome });
    expect(r.code).toBe(0);
    expect(existsSync(specPath(dir))).toBe(true);
    expect(existsSync(metaPath(dir))).toBe(true);
  });
});

describe("operations from the cached live spec", () => {
  test("are runnable with the same naming rules", async () => {
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation());
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1", archived: true }));
    const r = await run(["emails", "archive", "em_1", "--reason", "old"], { configHome, env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(0);
    expect(server.requests[0]).toMatchObject({ method: "POST", path: "/v1/emails/em_1/archive", json: { reason: "old" } });
    const w = await run(["widgets", "list"], { configHome, env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url } });
    expect(w.code).toBe(0);
    expect(server.requests[1]!.path).toBe("/v1/widgets");
  });

  test("show up as new in commands, help and --version", async () => {
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation());
    const tree = await run(["commands", "--json"], { configHome });
    const entries = JSON.parse(tree.stdout) as Array<{ command: string; source: string }>;
    expect(entries.filter((e) => e.source === "live").map((e) => e.command)).toEqual(["emails archive", "widgets list"]);

    const plain = await run(["commands"], { configHome, tty: true });
    expect(plain.stdout).toMatch(/archive <id>\s+Archive an email \(new\)/);
    expect(plain.stdout).toContain("2 API operations are newer than this version of smtpfast.");

    const version = await run(["--version"], { configHome, tty: true });
    expect(version.stdout).toContain("Live spec: 80 operations");
    expect(version.stdout).toContain("smtpfast emails archive <id>");
    expect(version.stdout).toContain("npm install -g smtpfast@latest");

    const piped = await run(["--version"], { configHome });
    expect(piped.stdout).toContain("2 API operations are newer");

    const help = await run(["emails", "archive", "--help"], { configHome });
    expect(help.stdout).toContain("This command comes from the live API spec.");
    expect((await run(["emails", "--help"], { configHome })).stdout).toMatch(/archive <id>\s+Archive an email \(new\)/);
  });

  test("a cache with the same operations shows nothing new", async () => {
    const configHome = tempDir();
    seedCache(configHome, fixtureSpec());
    const version = await run(["--version"], { configHome, tty: true });
    expect(version.stdout).toContain("same as built in");
    expect(version.stdout).not.toContain("newer");
  });

  test("a cached spec with hostile paths adds no commands for them", async () => {
    const configHome = tempDir();
    const spec = fixtureSpec();
    spec.paths["/v1/%2e%2e/%2e%2e/admin/{id}"] = { get: { operationId: "getAdmin", summary: "Get admin", tags: ["Admin"] } };
    spec.paths["/v1/emails/../../admin"] = { post: { operationId: "postAdmin", summary: "Post admin", tags: ["Admin"] } };
    spec.paths["//evil.test/v1/steal"] = { get: { operationId: "listSteal", summary: "Steal", tags: ["Steal"] } };
    seedCache(configHome, spec);
    const tree = await run(["commands", "--json"], { configHome });
    const ids = (JSON.parse(tree.stdout) as Array<{ operationId?: string }>).map((e) => e.operationId);
    for (const id of ["getAdmin", "postAdmin", "listSteal"]) expect(ids).not.toContain(id);
    server = await startMockServer((_req, res) => sendJson(res, 200, {}));
    const r = await run(["steal", "list"], { configHome, env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(2);
    expect(server.requests.length).toBe(0);
  });

  test("a corrupt cache is ignored", async () => {
    const configHome = tempDir();
    const dir = join(configHome, "smtpfast");
    mkdirSync(dir, { recursive: true });
    writeFileSync(specPath(dir), "{not json");
    const r = await run(["commands", "--json"], { configHome });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).some((e: { source: string }) => e.source === "live")).toBe(false);
  });
});
