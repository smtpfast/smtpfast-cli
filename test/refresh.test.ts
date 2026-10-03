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
const DEFAULT_SPEC_URL = "https://smtpfa.st/api/v1/openapi.json";

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

function seedCache(configHome: string, spec: unknown, checkedAt = NOW, url = DEFAULT_SPEC_URL) {
  const dir = join(configHome, "smtpfast");
  mkdirSync(dir, { recursive: true });
  writeFileSync(specPath(dir, url), JSON.stringify(spec));
  writeMeta(dir, url, { checked_at: checkedAt });
  return dir;
}

describe("background refresh trigger", () => {
  test("no cache, or a stale one, starts a refresh and records the attempt", () => {
    const dir = join(tempDir(), "smtpfast");
    const spawned: unknown[] = [];
    const spawn = (a: unknown) => spawned.push(a);
    const url = "http://x/v1/openapi.json";
    expect(maybeStartRefresh({ dir, url, now: NOW, spawn })).toBe(true);
    expect(readMeta(dir, url).checked_at).toBe(NOW);
    expect(maybeStartRefresh({ dir, url, now: NOW + 60_000, spawn })).toBe(false);
    expect(maybeStartRefresh({ dir, url, now: NOW + REFRESH_INTERVAL_MS + 1, spawn })).toBe(true);
    expect(spawned).toEqual([
      { configDir: dir, url },
      { configDir: dir, url },
    ]);
  });

  test("a stale cache triggers a refresh from a normal command, without waiting for it", async () => {
    const configHome = tempDir();
    seedCache(configHome, fixtureSpec(), NOW - REFRESH_INTERVAL_MS - 1000, "http://127.0.0.1:1/api/v1/openapi.json");
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
    expect(readFileSync(specPath(dir, args.url), "utf8")).toBe(body);
    const meta = readMeta(dir, args.url);
    expect(meta).toMatchObject({ checked_at: NOW, fetched_at: NOW, etag: '"v1"', operation_count: 78 });
    expect(meta.hash).toHaveLength(64);
    expect(server.requests[0]!.path).toBe("/api/v1/openapi.json");
    expect(server.requests[0]!.headers.authorization).toBeUndefined();

    expect(await refreshSpec({ ...args, now: NOW + 5 })).toBe("unchanged");
    expect(server.requests[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(readMeta(dir, args.url)).toMatchObject({ checked_at: NOW + 5, fetched_at: NOW });
  });

  test("failures are silent and keep the old cache", async () => {
    let mode = "500";
    server = await startMockServer((_req, res) => {
      if (mode === "500") sendJson(res, 500, { error: "boom" });
      else if (mode === "junk") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<html>not json</html>");
      } else if (mode === "not-openapi") sendJson(res, 200, { hello: "world" });
      // "hang": never answer
    });
    const url = `${server.url}/v1/openapi.json`;
    const dir = seedCache(tempDir(), fixtureSpec(), NOW - REFRESH_INTERVAL_MS * 2, url);
    const before = readFileSync(specPath(dir, url), "utf8");
    const args = { dir, url, fetch: (i: string | URL | Request, o?: RequestInit) => fetch(i, o), userAgent: "t", timeoutMs: 100 };
    for (const m of ["500", "junk", "not-openapi", "hang"]) {
      mode = m;
      expect(await refreshSpec({ ...args, now: NOW })).toBe("failed");
      expect(readFileSync(specPath(dir, url), "utf8")).toBe(before);
    }
    expect(readMeta(dir, url).checked_at).toBe(NOW);
    expect(readMeta(dir, url).last_error).toBeTruthy();
    const unreachable = await refreshSpec({ dir, url: "http://127.0.0.1:9/v1/openapi.json", fetch: args.fetch, userAgent: "t", now: NOW });
    expect(unreachable).toBe("failed");
  });

  test("the hidden __refresh-spec command does the same work", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, fixtureSpec()));
    const configHome = tempDir();
    const dir = join(configHome, "smtpfast");
    const url = `${server.url}/v1/openapi.json`;
    const r = await run(["__refresh-spec", "--url", url, "--config-dir", dir], { configHome });
    expect(r.code).toBe(0);
    expect(existsSync(specPath(dir, url))).toBe(true);
    expect(existsSync(metaPath(dir, url))).toBe(true);
  });
});

describe("operations from the cached live spec", () => {
  test("are runnable with the same naming rules", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1", archived: true }));
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation(), NOW, `${server.url}/v1/openapi.json`);
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
    // The built-in snapshot, not the test fixture: after a spec sync the two differ.
    seedCache(configHome, JSON.parse(readFileSync(join(import.meta.dir, "..", "spec", "openapi.json"), "utf8")));
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
    seedCache(configHome, spec, NOW, `${server.url}/v1/openapi.json`);
    const r = await run(["steal", "list"], { configHome, env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(2);
    expect(server.requests.length).toBe(0);
  });

  test("a live operation whose fields collide with global flags gets renamed flags", async () => {
    const configHome = tempDir();
    const spec = fixtureSpec();
    spec.paths["/v1/widgets"] = {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        tags: ["Widgets"],
        parameters: [
          { name: "no-debug", in: "query", schema: { type: "string" } },
          { name: "color", in: "query", schema: { type: "boolean" } },
          { name: "json", in: "query", schema: { type: "string" } },
        ],
      },
    };
    server = await startMockServer((_req, res) => sendJson(res, 200, { object: "list", data: [] }));
    seedCache(configHome, spec, NOW, `${server.url}/v1/openapi.json`);
    const r = await run(["widgets", "list", "--query-no-debug", "x", "--query-color", "--query-json", "y", "--no-debug", "--no-color"], {
      configHome,
      env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url, SMTPFAST_DEBUG: "1" },
    });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.query.toString()).toBe("color=true&json=y&no-debug=x");
    expect(r.stderr).not.toContain("> GET");
    const help = await run(["widgets", "list", "--help"], { configHome, env: { SMTPFAST_BASE_URL: server.url } });
    expect(help.stdout).toContain("--query-no-debug <string>");
  });

  test("a corrupt cache is ignored", async () => {
    const configHome = tempDir();
    const dir = join(configHome, "smtpfast");
    mkdirSync(dir, { recursive: true });
    writeFileSync(specPath(dir, DEFAULT_SPEC_URL), "{not json");
    writeMeta(dir, DEFAULT_SPEC_URL, { checked_at: NOW });
    const r = await run(["commands", "--json"], { configHome });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).some((e: { source: string }) => e.source === "live")).toBe(false);
  });
});

describe("one cache per server", () => {
  const STAGING = "https://staging.example.test/api";
  const STAGING_SPEC = `${STAGING}/v1/openapi.json`;
  const liveIds = (stdout: string) => (JSON.parse(stdout) as Array<{ source: string; operationId?: string }>).filter((e) => e.source === "live").map((e) => e.operationId);

  test("each spec URL keeps its own files, freshness and ETag", async () => {
    server = await startMockServer((req, res) => {
      if (req.headers["if-none-match"]) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag: `"${req.path}"` });
      res.end(JSON.stringify(req.path.startsWith("/a/") ? fixtureSpec() : specWithNewOperation()));
    });
    const dir = join(tempDir(), "smtpfast");
    const fetchFn = (i: string | URL | Request, o?: RequestInit) => fetch(i, o);
    const a = `${server.url}/a/v1/openapi.json`;
    const b = `${server.url}/b/v1/openapi.json`;
    expect(await refreshSpec({ dir, url: a, fetch: fetchFn, userAgent: "t", now: NOW })).toBe("updated");
    // B has never been fetched: no If-None-Match from A's ETag, so the server's 304 cannot be taken for B.
    expect(await refreshSpec({ dir, url: b, fetch: fetchFn, userAgent: "t", now: NOW })).toBe("updated");
    expect(server.requests[1]!.headers["if-none-match"]).toBeUndefined();
    expect(specPath(dir, a)).not.toBe(specPath(dir, b));
    expect(readMeta(dir, a)).toMatchObject({ url: a, etag: '"/a/v1/openapi.json"', operation_count: 78 });
    expect(readMeta(dir, b)).toMatchObject({ url: b, etag: '"/b/v1/openapi.json"', operation_count: 80 });
    expect(maybeStartRefresh({ dir, url: a, now: NOW + 1000, spawn: () => {} })).toBe(false);
    expect(maybeStartRefresh({ dir, url: "https://other.test/v1/openapi.json", now: NOW + 1000, spawn: () => {} })).toBe(true);
  });

  test("a 304 to a request without If-None-Match is not taken as unchanged", async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(304);
      res.end();
    });
    const dir = join(tempDir(), "smtpfast");
    const url = `${server.url}/v1/openapi.json`;
    expect(await refreshSpec({ dir, url, fetch: (i, o) => fetch(i, o), userAgent: "t", now: NOW })).toBe("failed");
    expect(existsSync(specPath(dir, url))).toBe(false);
  });

  test("only the cache of the active base URL is loaded", async () => {
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation(), NOW, STAGING_SPEC);
    const prod = await run(["commands", "--json"], { configHome });
    expect(liveIds(prod.stdout)).toEqual([]);
    const staging = await run(["commands", "--json"], { configHome, env: { SMTPFAST_BASE_URL: STAGING } });
    expect(liveIds(staging.stdout)).toEqual(["archiveEmail", "listWidgets"]);
    expect((await run(["widgets", "list"], { configHome, env: { SMTPFAST_API_KEY: "k" } })).code).toBe(2);
  });

  test("switching profiles switches the cache", async () => {
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation(), NOW, STAGING_SPEC);
    const dir = join(configHome, "smtpfast");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ current: "prod", profiles: { prod: { api_key: "k1" }, staging: { api_key: "k2", base_url: STAGING } } }));
    expect(liveIds((await run(["commands", "--json"], { configHome })).stdout)).toEqual([]);
    expect(liveIds((await run(["commands", "--json", "--profile", "staging"], { configHome })).stdout)).toEqual(["archiveEmail", "listWidgets"]);
    expect(liveIds((await run(["--profile", "staging", "commands", "--json"], { configHome })).stdout)).toEqual(["archiveEmail", "listWidgets"]);
  });

  test("--base-url after a command from the live spec picks that server's cache", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { object: "list", data: [] }));
    const configHome = tempDir();
    seedCache(configHome, specWithNewOperation(), NOW, `${server.url}/v1/openapi.json`);
    const after = await run(["widgets", "list", "--base-url", server.url], { configHome, env: { SMTPFAST_API_KEY: "k" } });
    expect(after.code).toBe(0);
    const before = await run(["--base-url", server.url, "widgets", "list"], { configHome, env: { SMTPFAST_API_KEY: "k" } });
    expect(before.code).toBe(0);
    expect(server.requests.map((r) => r.path)).toEqual(["/v1/widgets", "/v1/widgets"]);
  });

  test("--base-url as another flag's value does not pick that server's cache", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { object: "list", data: [] }));
    const configHome = tempDir();
    const spec = specWithNewOperation();
    spec.paths["/v1/widgets"].get.parameters = [{ name: "name", in: "query", schema: { type: "string" } }];
    seedCache(configHome, spec, NOW, STAGING_SPEC);
    const r = await run(["widgets", "list", "--name", "--base-url", STAGING], { configHome, env: { SMTPFAST_API_KEY: "k", SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command "widgets"');
    expect(server.requests.length).toBe(0);
  });
});
