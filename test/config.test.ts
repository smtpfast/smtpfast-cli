import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promptHidden } from "../src/commands/auth.js";
import { configDir, resolveSettings } from "../src/config.js";
import type { InStream } from "../src/context.js";
import { type MockServer, run, sendJson, startMockServer, tempDir } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ME = {
  api_key_id: "key_1",
  scopes: ["email:send", "domain:read"],
  team_id: "team_1",
  team_sending_status: "active",
  account: { tier: "pro", status: "active" },
  rate_limit: { per_second: 10 },
};

function meServer() {
  return startMockServer((req, res) => {
    if (req.headers.authorization === "Bearer bad") return sendJson(res, 401, { error: "Invalid API key" });
    sendJson(res, 200, { ...ME, seen_key: req.headers.authorization });
  });
}

function writeConfig(configHome: string, config: unknown) {
  const dir = join(configHome, "smtpfast");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

describe("login", () => {
  test("checks the key with GET /v1/me and stores it with mode 600", async () => {
    server = await meServer();
    const r = await run(["login", "--api-key", "sf_live_abcdefghijkl", "--base-url", server.url], { tty: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in to team team_1, plan pro.");
    expect(r.stdout).not.toContain("sf_live_abcdefghijkl");
    expect(server.requests[0]!.path).toBe("/v1/me");
    const dir = join(r.configHome, "smtpfast");
    const file = join(dir, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      current: "default",
      profiles: { default: { api_key: "sf_live_abcdefghijkl", base_url: server.url } },
    });
  });

  test("reads the key from stdin when it is not a terminal", async () => {
    server = await meServer();
    const r = await run(["login", "--profile", "ci"], { stdin: "sf_from_stdin\n", env: { SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.headers.authorization).toBe("Bearer sf_from_stdin");
    const config = JSON.parse(readFileSync(join(r.configHome, "smtpfast", "config.json"), "utf8"));
    expect(config.current).toBe("ci");
    expect(config.profiles.ci.api_key).toBe("sf_from_stdin");
    expect(config.profiles.ci.base_url).toBeUndefined();
  });

  test("a rejected key is not saved", async () => {
    server = await meServer();
    const r = await run(["login", "--api-key", "bad", "--base-url", server.url]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The API rejected this key (HTTP 401: Invalid API key). Nothing was saved.");
    expect(existsSync(join(r.configHome, "smtpfast", "config.json"))).toBe(false);
  });

  test("a second profile does not replace the current one", async () => {
    server = await meServer();
    const configHome = tempDir();
    writeConfig(configHome, { current: "main", profiles: { main: { api_key: "k_main" } } });
    const r = await run(["login", "--profile", "staging", "--api-key", "k_staging", "--base-url", server.url], { configHome, tty: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Run "smtpfast profiles use staging"');
    const config = JSON.parse(readFileSync(join(configHome, "smtpfast", "config.json"), "utf8"));
    expect(config.current).toBe("main");
    expect(Object.keys(config.profiles).sort()).toEqual(["main", "staging"]);
  });
});

describe("precedence", () => {
  test("--api-key beats SMTPFAST_API_KEY, which beats the profile", async () => {
    server = await meServer();
    const configHome = tempDir();
    writeConfig(configHome, { current: "default", profiles: { default: { api_key: "k_profile", base_url: server.url } } });
    const seen = async (argv: string[], env: Record<string, string> = {}) => {
      const r = await run(["whoami", "--json", ...argv], { configHome, env });
      expect(r.code).toBe(0);
      return JSON.parse(r.stdout).seen_key;
    };
    expect(await seen([])).toBe("Bearer k_profile");
    expect(await seen([], { SMTPFAST_API_KEY: "k_env" })).toBe("Bearer k_env");
    expect(await seen(["--api-key", "k_flag"], { SMTPFAST_API_KEY: "k_env" })).toBe("Bearer k_flag");
  });

  test("--profile and SMTPFAST_PROFILE pick the profile", async () => {
    server = await meServer();
    const configHome = tempDir();
    writeConfig(configHome, { current: "a", profiles: { a: { api_key: "k_a", base_url: server.url }, b: { api_key: "k_b", base_url: server.url } } });
    const key = async (argv: string[], env: Record<string, string> = {}) =>
      JSON.parse((await run(["whoami", "--json", ...argv], { configHome, env })).stdout).seen_key;
    expect(await key([])).toBe("Bearer k_a");
    expect(await key([], { SMTPFAST_PROFILE: "b" })).toBe("Bearer k_b");
    expect(await key(["--profile", "a"], { SMTPFAST_PROFILE: "b" })).toBe("Bearer k_a");
  });

  test("base URL: flag, then env, then profile, then the default", () => {
    const config = { current: "p", profiles: { p: { api_key: "k", base_url: "https://profile.test/api" } } };
    expect(resolveSettings({ baseUrl: "https://flag.test/api/" }, { SMTPFAST_BASE_URL: "https://env.test" }, config).baseUrl).toBe("https://flag.test/api");
    expect(resolveSettings({}, { SMTPFAST_BASE_URL: "https://env.test" }, config).baseUrl).toBe("https://env.test");
    expect(resolveSettings({}, {}, config).baseUrl).toBe("https://profile.test/api");
    expect(resolveSettings({}, {}, { profiles: {} })).toMatchObject({ baseUrl: "https://smtpfa.st/api", baseUrlSource: "default", profile: "default" });
  });

  test("the config directory respects XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/smtpfast");
    expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/smtpfast");
    expect(configDir({ APPDATA: "C:\\AppData" }, "win32", "C:\\Users\\u")).toContain("smtpfast");
  });
});

describe("whoami, profiles and logout", () => {
  test("whoami shows team, plan and scopes, with the key masked", async () => {
    server = await meServer();
    const r = await run(["whoami"], { tty: true, env: { SMTPFAST_API_KEY: "sf_live_abcdefghijkl", SMTPFAST_BASE_URL: server.url } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Team\s+team_1/);
    expect(r.stdout).toMatch(/Plan\s+pro/);
    expect(r.stdout).toMatch(/Scopes\s+email:send, domain:read/);
    expect(r.stdout).toMatch(/API key\s+sf_live_...ijkl \(from SMTPFAST_API_KEY\)/);
    expect(r.stdout).not.toContain("sf_live_abcdefghijkl");
  });

  test("profiles list, use and remove", async () => {
    const configHome = tempDir();
    writeConfig(configHome, { current: "a", profiles: { a: { api_key: "sf_live_aaaaaaaaaaaa" }, b: { api_key: "sf_live_bbbbbbbbbbbb", base_url: "https://b.test/api" } } });
    const list = await run(["profiles", "list", "--json"], { configHome });
    expect(JSON.parse(list.stdout)).toEqual([
      { name: "a", current: true, api_key: "sf_live_...aaaa", base_url: null },
      { name: "b", current: false, api_key: "sf_live_...bbbb", base_url: "https://b.test/api" },
    ]);
    expect((await run(["profiles", "use", "b"], { configHome })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(configHome, "smtpfast", "config.json"), "utf8")).current).toBe("b");
    expect((await run(["profiles", "use", "zzz"], { configHome })).code).toBe(2);
    expect((await run(["profiles", "remove", "b"], { configHome })).code).toBe(0);
    const config = JSON.parse(readFileSync(join(configHome, "smtpfast", "config.json"), "utf8"));
    expect(config.current).toBeUndefined();
    expect(Object.keys(config.profiles)).toEqual(["a"]);
    const table = await run(["profiles"], { configHome, tty: true });
    expect(table.stdout).toMatch(/NAME\s+API KEY\s+BASE URL/);
  });

  test("logout removes the stored key", async () => {
    const configHome = tempDir();
    writeConfig(configHome, { current: "default", profiles: { default: { api_key: "k" } } });
    const r = await run(["logout"], { configHome });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Removed the stored key for profile "default".');
    const file = join(configHome, "smtpfast", "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ profiles: {} });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a broken config file is reported, not ignored", async () => {
    const configHome = tempDir();
    mkdirSync(join(configHome, "smtpfast"), { recursive: true });
    writeFileSync(join(configHome, "smtpfast", "config.json"), "{oops");
    const r = await run(["whoami"], { configHome });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("config.json is not valid JSON");
  });
});

describe("hidden prompt", () => {
  function fakeTty() {
    const stdin = new PassThrough() as unknown as InStream & PassThrough;
    const modes: boolean[] = [];
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      modes.push(mode);
      return stdin;
    };
    let shown = "";
    const stderr = { write: (c: string | Uint8Array) => ((shown += String(c)), true) };
    return { stdin, stderr, modes, shown: () => shown };
  }

  test("reads a line without echoing it, with backspace and arrow keys ignored", async () => {
    const t = fakeTty();
    const answer = promptHidden({ stdin: t.stdin, stderr: t.stderr }, "API key: ");
    t.stdin.write("sf_ab\u007fc\u001b[Dd\r");
    expect(await answer).toBe("sf_acd");
    expect(t.shown()).toBe("API key: \n");
    expect(t.modes).toEqual([true, false]);
  });

  test("Ctrl-C cancels with exit code 130", async () => {
    const t = fakeTty();
    const answer = promptHidden({ stdin: t.stdin, stderr: t.stderr }, "API key: ");
    t.stdin.write("sf\u0003");
    await expect(answer).rejects.toMatchObject({ exitCode: 130 });
  });
});
