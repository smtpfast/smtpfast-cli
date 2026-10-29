import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keyHostname } from "../src/commands/auth.js";
import { buildManifest } from "../src/spec/build.js";
import { VERSION } from "../src/version.js";
import { type MockServer, type RecordedRequest, run, sendJson, startMockServer } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const NEW_KEY = `sf_${"ab12".repeat(16)}`;
const DEVICE_CODE = "Qm9iYnlzLWNvZGUt.dGhpcy1pcy1ub3QtYS1yZWFsLWRldmljZS1jb2RlLW9r";
const ME = { api_key_id: "key_1", scopes: ["email:send"], team_id: "team_1", account: { tier: "growth", status: "active" } };

type TokenAnswer = [status: number, body: unknown];

/** The API side of a browser login: one device code, then the token answers in order. */
function loginServer(answers: TokenAnswer[], start: Record<string, unknown> = {}) {
  const queue = [...answers];
  return startMockServer((req, res) => {
    if (req.path === "/v1/cli/device") {
      return sendJson(res, 200, {
        device_code: DEVICE_CODE,
        user_code: "BCDF-GHJK",
        verification_uri: "https://smtpfa.st/cli/device",
        verification_uri_complete: "https://smtpfa.st/cli/device?code=BCDF-GHJK",
        expires_in: 600,
        interval: 5,
        ...start,
      });
    }
    if (req.path === "/v1/cli/token") {
      const [status, body] = queue.shift() ?? [400, { error: "authorization_pending" }];
      return sendJson(res, status, body);
    }
    if (req.path === "/v1/me") return sendJson(res, 200, ME);
    sendJson(res, 404, { error: "not found" });
  });
}

const pending: TokenAnswer = [400, { error: "authorization_pending", error_description: "Waiting for someone to approve the code." }];
const issued: TokenAnswer = [200, { id: "key_new", name: "CLI on test-host (2026-10-29)", key: NEW_KEY, prefix: NEW_KEY.slice(0, 12), scopes: ["email:send"], created_at: "2026-10-29T12:00:00.000Z", team: { id: "team_1", name: "Acme" } }];
const paths = (s: MockServer) => s.requests.map((r: RecordedRequest) => `${r.method} ${r.path}`);

function sleeps() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
}

describe("browser login", () => {
  test("shows the code, opens the page, polls at the interval and saves the new key", async () => {
    server = await loginServer([pending, [400, { error: "slow_down", interval: 12 }], issued]);
    const clock = sleeps();
    const r = await run(["login", "--base-url", server.url], { tty: true, stdinTTY: true, hostname: "build 01", sleep: clock.sleep });
    expect(r.code).toBe(0);
    expect(paths(server)).toEqual(["POST /v1/cli/device", "POST /v1/cli/token", "POST /v1/cli/token", "POST /v1/cli/token", "GET /v1/me"]);
    expect(server.requests[0]!.json).toEqual({ client_name: `SMTPfast CLI ${VERSION}`, hostname: "build-01" });
    expect(server.requests[1]!.json).toEqual({ device_code: DEVICE_CODE });
    for (const req of server.requests.slice(0, 4)) expect(req.headers.authorization).toBeUndefined();
    expect(server.requests[4]!.headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    expect(clock.waited).toEqual([5000, 5000, 12000]);
    expect(r.opened).toEqual(["https://smtpfa.st/cli/device?code=BCDF-GHJK"]);
    expect(r.stderr).toContain("BCDF-GHJK");
    expect(r.stderr).toContain("Opened it in your browser.");
    expect(r.stdout).toContain("Logged in to team Acme, plan growth. Created and saved key");
    expect(r.stdout + r.stderr).not.toContain(NEW_KEY);
    expect(r.stdout + r.stderr).not.toContain(DEVICE_CODE);
    const config = JSON.parse(readFileSync(join(r.configHome, "smtpfast", "config.json"), "utf8"));
    expect(config.profiles.default.api_key).toBe(NEW_KEY);
  });

  test("runs when stdin is empty, as in an agent's shell, and keeps the device code out of debug output", async () => {
    server = await loginServer([issued]);
    const r = await run(["login", "--no-browser", "--debug", "--base-url", server.url], { stdin: "" });
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([]);
    expect(r.stderr).toContain("https://smtpfa.st/cli/device?code=BCDF-GHJK");
    expect(r.stderr).not.toContain(DEVICE_CODE);
    expect(r.stderr).not.toContain(NEW_KEY);
  });

  test("asks for the scopes given with --scopes", async () => {
    server = await loginServer([issued]);
    const r = await run(["login", "--scopes", "email:send, domain:read", "--base-url", server.url], { stdinTTY: true });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.json.scopes).toEqual(["email:send", "domain:read"]);
  });

  test("keeps polling through a server error", async () => {
    server = await loginServer([[503, { error: "Service Unavailable" }], issued]);
    const r = await run(["login", "--base-url", server.url], { stdinTTY: true });
    expect(r.code).toBe(0);
  });

  test.each([
    [[400, { error: "access_denied", error_description: "The request was denied." }], "The login was not approved: The request was denied."],
    [[400, { error: "expired_token" }], "The code expired before it was approved."],
    [[400, { error: "invalid_grant", error_description: "Unknown device code." }], "Unknown device code."],
  ] as Array<[TokenAnswer, string]>)("stops on %j and saves nothing", async (answer, message) => {
    server = await loginServer([answer]);
    const r = await run(["login", "--base-url", server.url], { stdinTTY: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
    expect(existsSync(join(r.configHome, "smtpfast", "config.json"))).toBe(false);
    expect(paths(server)).not.toContain("GET /v1/me");
  });

  test("gives up when the code's lifetime is over", async () => {
    server = await loginServer([], { expires_in: 12 });
    let now = 1_000_000;
    const r = await run(["login", "--base-url", server.url], { stdinTTY: true, now: () => now, sleep: async (ms) => void (now += ms) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The code expired before it was approved.");
    expect(paths(server).filter((p) => p === "POST /v1/cli/token")).toHaveLength(3);
  });

  test("does not open a link that is not http(s)", async () => {
    server = await loginServer([issued], { verification_uri_complete: "file:///etc/passwd" });
    const r = await run(["login", "--base-url", server.url], { stdinTTY: true });
    expect(r.code).toBe(0);
    expect(r.opened).toEqual(["https://smtpfa.st/cli/device"]);
  });

  test("still stores a key from --api-key or stdin, and refuses --scopes with one", async () => {
    server = await loginServer([]);
    const flag = await run(["login", "--api-key", NEW_KEY, "--base-url", server.url], { stdinTTY: true });
    expect(flag.code).toBe(0);
    expect(paths(server)).toEqual(["GET /v1/me"]);
    const piped = await run(["login", "--base-url", server.url], { stdin: `${NEW_KEY}\n` });
    expect(piped.code).toBe(0);
    expect(paths(server)).toEqual(["GET /v1/me", "GET /v1/me"]);
    const mixed = await run(["login", "--api-key", NEW_KEY, "--scopes", "email:send", "--base-url", server.url]);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("--scopes is for the browser login");
  });
});

describe("keyHostname", () => {
  test("turns a machine name into one the API accepts", () => {
    expect(keyHostname("Bobbys-MacBook-Pro.local")).toBe("Bobbys-MacBook-Pro.local");
    expect(keyHostname("build 01")).toBe("build-01");
    expect(keyHostname("--x")).toBe("x");
    expect(keyHostname("é")).toBeUndefined();
    expect(keyHostname("a".repeat(80))).toHaveLength(63);
  });
});

describe("operations without an API key", () => {
  test("are marked in the manifest, and their commands send no key", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      security: [{ BearerAuth: [] }],
      paths: {
        "/v1/cli/device": { post: { operationId: "createCliDeviceCode", summary: "Start", tags: ["CLI Login"], security: [], requestBody: { content: { "application/json": { schema: { type: "object", properties: {} } } } }, responses: { "200": { description: "ok" } } } },
        "/v1/me": { get: { operationId: "getCapabilities", summary: "Me", tags: ["Account"], responses: { "200": { description: "ok" } } } },
      },
    };
    const { manifest } = buildManifest(spec);
    expect(manifest.operations.find((o) => o.operationId === "createCliDeviceCode")?.noAuth).toBe(true);
    expect(manifest.operations.find((o) => o.operationId === "getCapabilities")?.noAuth).toBeUndefined();
  });
});
