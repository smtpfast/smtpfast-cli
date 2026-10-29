import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.js";
import { type MockServer, type RecordedRequest, run, sendJson, startMockServer, tempDir } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const NEW_KEY = `sf_${"cd34".repeat(16)}`;
const OLD_KEY = `sf_${"ef56".repeat(16)}`;
const SIGNUP_ID = "AbCdEfGhIjKlMnOpQrStUvWx";
const CREATED = {
  id: "key_new",
  name: "CLI on test-host (2026-10-29)",
  key: NEW_KEY,
  prefix: NEW_KEY.slice(0, 12),
  scopes: ["email:send", "domain:read", "domain:write"],
  created_at: "2026-10-29T12:00:00.000Z",
  team: { id: "team_1", name: "Ada's Team" },
  account: { id: "u1", email: "ada@example.com", status: "pending", plan: "free" },
  activation: { required: true, docs: "https://smtpfa.st/docs/headless#activate" },
};
const pending = { status: "pending", email: "ada@example.com", plan: "free", email_verified: true, free_trial_requested_at: null, rejection_reason: null };
const active = { ...pending, status: "active" };

type Answer = [status: number, body: unknown];
type Routes = Record<string, Answer | Answer[] | ((req: RecordedRequest) => Answer)>;

/** Answers by "METHOD /path". A list answers in order and repeats its last entry. */
function api(routes: Routes) {
  const queues = new Map<string, Answer[]>();
  return startMockServer((req, res) => {
    const route = routes[`${req.method} ${req.path}`];
    if (!route) return sendJson(res, 404, { error: "not found" });
    if (typeof route === "function") {
      const [status, body] = route(req);
      return sendJson(res, status, body);
    }
    if (!Array.isArray(route[0])) return sendJson(res, (route as Answer)[0], (route as Answer)[1]);
    const list = queues.get(req.path) ?? [...(route as Answer[])];
    queues.set(req.path, list);
    const [status, body] = list.length > 1 ? list.shift()! : list[0]!;
    sendJson(res, status, body);
  });
}

const paths = (s: MockServer) => s.requests.map((r) => `${r.method} ${r.path}`);
const configOf = (home: string) => JSON.parse(readFileSync(join(home, "smtpfast", "config.json"), "utf8"));

function withKey(key = OLD_KEY): string {
  const home = tempDir("smtpfast-xdg-");
  mkdirSync(join(home, "smtpfast"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "smtpfast", "config.json"), JSON.stringify({ current: "default", profiles: { default: { api_key: key } } }), { mode: 0o600 });
  return home;
}

const signupRoutes = (extra: Routes = {}): Routes => ({
  "POST /v1/cli/signup": [200, { signup_id: SIGNUP_ID, email: "ada@example.com", expires_in: 600, code_length: 8 }],
  "POST /v1/cli/signup/verify": [200, CREATED],
  "GET /v1/account/activation": [200, pending],
  ...extra,
});

describe("smtpfast signup", () => {
  test("asks for the address and the code, saves the key, and leaves activation for later", async () => {
    server = await api(signupRoutes());
    const r = await run(["signup", "--base-url", server.url], { tty: true, stdinTTY: true, stdin: "ada@example.com\nAda\n\n4831-0927\n4\n" });
    expect(r.stderr).toContain("Get the monthly product update email? [Y/n]");
    expect(r.code).toBe(0);
    expect(paths(server)).toEqual(["POST /v1/cli/signup", "POST /v1/cli/signup/verify", "GET /v1/account/activation"]);
    expect(server.requests[0]!.json).toEqual({ email: "ada@example.com", name: "Ada", newsletter: true, client_name: `SMTPfast CLI ${VERSION}`, hostname: "test-host" });
    expect(server.requests[1]!.json).toEqual({ signup_id: SIGNUP_ID, code: "4831-0927" });
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(server.requests[1]!.headers.authorization).toBeUndefined();
    expect(server.requests[2]!.headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    expect(r.stdout).toContain(`Created account ada@example.com and team "Ada's Team". Saved key`);
    expect(r.stdout).toContain("smtpfast activate");
    expect(r.stderr).toContain("pending activation");
    expect(r.stdout + r.stderr).not.toContain(NEW_KEY);
    expect(configOf(r.configHome).profiles.default.api_key).toBe(NEW_KEY);
  });

  test("lets a person try the code again", async () => {
    server = await api(
      signupRoutes({
        "POST /v1/cli/signup/verify": [
          [400, { error: "invalid_code", error_description: "That code is not right.", attempts_remaining: 4 }],
          [200, CREATED],
        ],
      }),
    );
    const r = await run(["signup", "--email", "ada@example.com", "--name", "Ada", "--base-url", server.url], { stdinTTY: true, stdin: "0000-0000\n4831-0927\n4\n" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("That code is not right. 4 tries left.");
    // Given --email, nothing about the newsletter is asked: it is the form's default.
    expect(server.requests[0]!.json.newsletter).toBe(true);
    expect(r.stderr).not.toContain("4831-0927");
    expect(server.requests.filter((q) => q.path === "/v1/cli/signup/verify").map((q) => q.json.code)).toEqual(["0000-0000", "4831-0927"]);
  });

  test("reads the code from stdin for an agent, activates with --plan, and prints JSON", async () => {
    server = await api(signupRoutes({ "POST /v1/account/activation/checkout": [200, { url: "https://checkout.stripe.com/c/pay/cs_test" }] }));
    const r = await run(["signup", "--email", "ada@example.com", "--no-newsletter", "--plan", "growth", "--base-url", server.url], { stdin: "48310927\n" });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.json.newsletter).toBe(false);
    expect(server.requests[1]!.json.code).toBe("48310927");
    const checkout = server.requests.find((q) => q.path === "/v1/account/activation/checkout")!;
    expect(checkout.json).toEqual({ plan: "growth" });
    expect(checkout.headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    expect(r.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_test"]);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ profile: "default", current: true, account: { email: "ada@example.com", status: "pending" }, team: { name: "Ada's Team" } });
    expect(r.stdout).not.toContain(NEW_KEY);
  });

  test("runs in two steps with --send-only and --signup-id", async () => {
    server = await api(signupRoutes());
    const first = await run(["signup", "--email", "ada@example.com", "--send-only", "--base-url", server.url]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ signup_id: SIGNUP_ID });
    expect(paths(server)).toEqual(["POST /v1/cli/signup"]);
    expect(existsSync(join(first.configHome, "smtpfast", "config.json"))).toBe(false);

    const second = await run(["signup", "--signup-id", SIGNUP_ID, "--code", "4831-0927", "--base-url", server.url]);
    expect(second.code).toBe(0);
    expect(paths(server)).toEqual(["POST /v1/cli/signup", "POST /v1/cli/signup/verify"]);
    expect(configOf(second.configHome).profiles.default.api_key).toBe(NEW_KEY);
  });

  test("stops on an address with an account, and saves nothing", async () => {
    server = await api(signupRoutes({ "POST /v1/cli/signup/verify": [409, { error: "account_exists", error_description: "This address already has an SMTPfast account. Run smtpfast login." }] }));
    const r = await run(["signup", "--email", "ada@example.com", "--code", "4831-0927", "--base-url", server.url]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already has an SMTPfast account");
    expect(existsSync(join(r.configHome, "smtpfast", "config.json"))).toBe(false);
  });

  test("will not overwrite a profile that already has a key", async () => {
    server = await api(signupRoutes());
    const r = await run(["signup", "--email", "ada@example.com", "--base-url", server.url], { configHome: withKey() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Profile "default" already has an API key');
    expect(server.requests).toHaveLength(0);
    expect(configOf(r.configHome).profiles.default.api_key).toBe(OLD_KEY);
  });

  test("never prints the key, even when the server puts it in another field", async () => {
    server = await api(
      signupRoutes({ "POST /v1/cli/signup/verify": [200, { ...CREATED, prefix: NEW_KEY, team: { id: "team_1", name: NEW_KEY }, account: { ...CREATED.account, email: NEW_KEY } }] }),
    );
    const json = await run(["signup", "--email", "ada@example.com", "--code", "4831-0927", "--base-url", server.url]);
    expect(json.code).toBe(0);
    expect(json.stdout).not.toContain(NEW_KEY);
    expect(configOf(json.configHome).profiles.default.email).toBeUndefined();
    const human = await run(["signup", "--email", "ada@example.com", "--code", "4831-0927", "--base-url", server.url], { tty: true });
    expect(human.code).toBe(0);
    expect(human.stdout + human.stderr).not.toContain(NEW_KEY);
  });

  test("saves to a new profile when another run stored a key while the code was on its way", async () => {
    const configHome = tempDir("smtpfast-xdg-");
    server = await api(
      signupRoutes({
        "POST /v1/cli/signup/verify": () => {
          mkdirSync(join(configHome, "smtpfast"), { recursive: true, mode: 0o700 });
          writeFileSync(join(configHome, "smtpfast", "config.json"), JSON.stringify({ current: "default", profiles: { default: { api_key: OLD_KEY, base_url: server!.url }, staging: { api_key: OLD_KEY } } }), { mode: 0o600 });
          return [200, CREATED];
        },
      }),
    );
    mkdirSync(join(configHome, "smtpfast"), { recursive: true, mode: 0o700 });
    writeFileSync(join(configHome, "smtpfast", "config.json"), JSON.stringify({ current: "default", profiles: { default: { base_url: server.url } } }), { mode: 0o600 });
    const r = await run(["signup", "--email", "ada@example.com", "--code", "4831-0927"], { configHome });
    expect(r.code).toBe(0);
    const config = configOf(configHome);
    expect(config.profiles.default.api_key).toBe(OLD_KEY);
    expect(config.profiles.staging.api_key).toBe(OLD_KEY);
    expect(config.profiles["default-signup"]).toEqual({ api_key: NEW_KEY, base_url: server.url, email: "ada@example.com" });
    expect(r.stderr).toContain('saved as profile "default-signup"');
  });

  test("needs an address and a code when nobody can be asked", async () => {
    server = await api(signupRoutes());
    expect((await run(["signup", "--base-url", server.url])).code).toBe(2);
    const noCode = await run(["signup", "--email", "ada@example.com", "--base-url", server.url], { stdin: "" });
    expect(noCode.code).toBe(2);
    expect(noCode.stderr).toContain("No code given");
  });
});

describe("smtpfast activate", () => {
  test("redeems an invite code", async () => {
    server = await api({ "GET /v1/account/activation": [200, pending], "POST /v1/account/activation/invite": [200, { status: "active", plan: "free" }] });
    const r = await run(["activate", "--invite", "SF-AB12-CD34", "--base-url", server.url], { tty: true, configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(server.requests[1]!.json).toEqual({ code: "SF-AB12-CD34" });
    expect(r.stderr).toContain("active on the free plan");
  });

  test("requests the free plan with the use case", async () => {
    server = await api({
      "GET /v1/account/activation": [200, pending],
      "POST /v1/account/activation/free-trial": [200, { requested: true, message: "Invite request sent. We will email you when it is approved." }],
    });
    const r = await run(["activate", "--free-trial", "Password resets and receipts for our app", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(server.requests[1]!.json).toEqual({ use_case: "Password resets and receipts for our app" });
    expect(JSON.parse(r.stdout)).toEqual({ status: "pending" });
  });

  test("on a terminal, opens Checkout and waits until the payment turns the account active", async () => {
    server = await api({
      "GET /v1/account/activation": [[200, pending], [200, pending], [200, pending], [200, active]],
      "POST /v1/account/activation/checkout": [200, { url: "https://checkout.stripe.com/c/pay/cs_test" }],
    });
    const r = await run(["activate", "--base-url", server.url], { tty: true, stdinTTY: true, stdin: "1\nscale\nyearly\n", configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(server.requests.find((q) => q.path === "/v1/account/activation/checkout")!.json).toEqual({ plan: "scale", interval: "yearly" });
    expect(r.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_test"]);
    expect(r.stderr).toContain("Payment received");
    expect(r.stdout).toContain("Active.");
  });

  test("says so when the account is already active, and refuses two methods at once", async () => {
    server = await api({ "GET /v1/account/activation": [200, { ...active, plan: "growth" }] });
    const r = await run(["activate", "--base-url", server.url], { tty: true, configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("The account is active on the growth plan.");
    expect((await run(["activate", "--plan", "growth", "--invite", "SF-1", "--base-url", server.url], { configHome: withKey(NEW_KEY) })).code).toBe(2);
    expect((await run(["activate", "--plan", "free", "--base-url", server.url], { configHome: withKey(NEW_KEY) })).code).toBe(2);
  });
});

const VERIFIED_DOMAIN = { id: "dom_1", domain: "mail.example.com", status: "verified", dns_records: [] };
const RECORDS = [
  { type: "TXT", name: "abc._domainkey.mail.example.com", value: "p=MIGf" },
  { type: "MX", name: "bounce.mail.example.com", value: "feedback-smtp.us-east-1.amazonses.com" },
];

describe("smtpfast init", () => {
  test("adds the domain, sets DNS through Domain Connect, waits for verification and sends a test email", async () => {
    server = await api({
      "GET /v1/account/activation": [200, active],
      "GET /v1/domains": [200, { object: "list", has_more: false, data: [] }],
      "POST /v1/domains": [200, { id: "dom_1", domain: "mail.example.com", status: "pending", dns_records: RECORDS, created_at: "2026-10-29T12:00:00Z" }],
      "POST /v1/domains/dom_1/domain-connect/cloudflare": [200, { url: "https://dash.cloudflare.com/domainconnect/v2/apply?x=1", provider: "Cloudflare" }],
      "POST /v1/domains/dom_1/verify": [[200, { domain: "mail.example.com", status: "pending" }], [200, { domain: "mail.example.com", status: "verified" }]],
      "POST /v1/emails": [200, { id: "em_1" }],
    });
    const r = await run(["init", "--domain", "Mail.Example.com.", "--test-email", "--to", "ada@example.com", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(server.requests.find((q) => q.path === "/v1/domains" && q.method === "POST")!.json).toEqual({ domain: "mail.example.com" });
    expect(r.opened).toEqual(["https://dash.cloudflare.com/domainconnect/v2/apply?x=1"]);
    const email = server.requests.find((q) => q.path === "/v1/emails")!;
    expect(email.json).toMatchObject({ from: "hello@mail.example.com", to: "ada@example.com", subject: "Your SMTPfast test email" });
    expect(JSON.parse(r.stdout)).toMatchObject({
      account_status: "active",
      domain: { id: "dom_1", name: "mail.example.com" },
      domain_connect_url: "https://dash.cloudflare.com/domainconnect/v2/apply?x=1",
      verified: true,
      test_email: { id: "em_1", to: "ada@example.com" },
    });
    expect(r.stderr).toContain("[6/6] Test email");
  });

  test("is a no-op for a domain that is already there and verified", async () => {
    server = await api({
      "GET /v1/account/activation": [200, active],
      "GET /v1/domains": [200, { object: "list", has_more: false, data: [VERIFIED_DOMAIN] }],
    });
    const r = await run(["init", "--domain", "mail.example.com", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(paths(server)).toEqual(["GET /v1/account/activation", "GET /v1/domains"]);
    expect(r.stderr).toContain("already on the account");
    expect(JSON.parse(r.stdout)).toMatchObject({ verified: true });
  });

  test("prints the records when the DNS host has no Domain Connect", async () => {
    server = await api({
      "GET /v1/account/activation": [200, active],
      "GET /v1/domains": [200, { object: "list", has_more: false, data: [{ ...VERIFIED_DOMAIN, status: "pending" }] }],
      "POST /v1/domains/dom_1/domain-connect/cloudflare": [409, { error: "Automatic DNS setup is currently available for Cloudflare-hosted domains only." }],
      "GET /v1/domains/dom_1": [200, { ...VERIFIED_DOMAIN, status: "pending", dns_records: RECORDS }],
      "POST /v1/domains/dom_1/verify": [200, { domain: "mail.example.com", status: "pending" }],
    });
    const r = await run(["init", "--domain", "mail.example.com", "--no-wait", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("abc._domainkey.mail.example.com");
    expect(r.opened).toEqual([]);
    expect(JSON.parse(r.stdout)).toMatchObject({ verified: false, dns_records: RECORDS });
    expect(paths(server)).not.toContain("POST /v1/emails");
  });

  test("gives up at the timeout and says how to carry on", async () => {
    server = await api({
      "GET /v1/account/activation": [200, active],
      "GET /v1/domains": [200, { object: "list", has_more: false, data: [{ ...VERIFIED_DOMAIN, status: "pending" }] }],
      "POST /v1/domains/dom_1/domain-connect/cloudflare": [409, { error: "No" }],
      "GET /v1/domains/dom_1": [200, { ...VERIFIED_DOMAIN, status: "pending", dns_records: RECORDS }],
      "POST /v1/domains/dom_1/verify": [200, { domain: "mail.example.com", status: "pending" }],
    });
    let now = 1_000_000;
    const r = await run(["init", "--domain", "mail.example.com", "--timeout", "30s", "--base-url", server.url], {
      configHome: withKey(NEW_KEY),
      now: () => now,
      sleep: async (ms) => void (now += ms),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Timed out after 30s");
    expect(r.stderr).toContain("smtpfast domains verify mail.example.com --wait");
    expect(JSON.parse(r.stdout)).toMatchObject({ verified: false });
  });

  test("stops before the domain while the account is pending, when nobody can be asked", async () => {
    server = await api({ "GET /v1/account/activation": [200, pending] });
    const r = await run(["init", "--domain", "mail.example.com", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The account is not active yet.");
    expect(paths(server)).toEqual(["GET /v1/account/activation"]);
  });

  test("needs a key when nobody can be asked", async () => {
    const r = await run(["init", "--domain", "mail.example.com"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("smtpfast signup");
  });

  test("carries on with the profile signup saved to, not the one another run filled", async () => {
    const configHome = tempDir("smtpfast-xdg-");
    server = await api({
      ...signupRoutes(),
      "POST /v1/cli/signup/verify": () => {
        mkdirSync(join(configHome, "smtpfast"), { recursive: true, mode: 0o700 });
        writeFileSync(join(configHome, "smtpfast", "config.json"), JSON.stringify({ current: "default", profiles: { default: { api_key: OLD_KEY } } }), { mode: 0o600 });
        return [200, CREATED];
      },
      "GET /v1/account/activation": [200, active],
    });
    const r = await run(["init", "--base-url", server.url], { configHome, stdinTTY: true, stdin: "s\nada@example.com\n\n\n4831-0927\n\n" });
    expect(r.code).toBe(0);
    const activation = server.requests.find((q) => q.path === "/v1/account/activation")!;
    expect(activation.headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    expect(JSON.parse(r.stdout)).toMatchObject({ profile: "default-signup" });
  });

  test("with --yes asks nothing, even on a terminal", async () => {
    const noKey = await run(["init", "--yes"], { stdinTTY: true, stdin: "s\n" });
    expect(noKey.code).toBe(2);
    server = await api({ "GET /v1/account/activation": [200, pending] });
    const r = await run(["init", "--yes", "--base-url", server.url], { stdinTTY: true, stdin: "1\ngrowth\nmonthly\n", configHome: withKey(NEW_KEY) });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("Choice [1-4]");
    expect(paths(server)).toEqual(["GET /v1/account/activation"]);
  });

  test("sends the test email to the address signup saved", async () => {
    const home = tempDir("smtpfast-xdg-");
    mkdirSync(join(home, "smtpfast"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "smtpfast", "config.json"), JSON.stringify({ current: "default", profiles: { default: { api_key: NEW_KEY, email: "ada@example.com" } } }), { mode: 0o600 });
    server = await api({
      "GET /v1/account/activation": [200, active],
      "GET /v1/domains": [200, { object: "list", has_more: false, data: [VERIFIED_DOMAIN] }],
      "POST /v1/emails": [200, { id: "em_1" }],
    });
    const r = await run(["init", "--domain", "mail.example.com", "--test-email", "--base-url", server.url], { configHome: home });
    expect(r.code).toBe(0);
    expect(server.requests.find((q) => q.path === "/v1/emails")!.json).toMatchObject({ to: "ada@example.com" });
    const none = await run(["init", "--domain", "mail.example.com", "--test-email", "--base-url", server.url], { configHome: withKey(NEW_KEY) });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("--to");
  });

  test("passes --no-browser on to the login", async () => {
    server = await api({
      "POST /v1/cli/device": [200, { device_code: "Qm9iYnlzLWNvZGUt.dGhpcy1pcy1ub3QtYS1yZWFsLWRldmljZS1jb2RlLW9r", user_code: "BCDF-GHJK", verification_uri: "https://smtpfa.st/cli/device", verification_uri_complete: "https://smtpfa.st/cli/device?code=BCDF-GHJK", expires_in: 600, interval: 5 }],
      "POST /v1/cli/token": [200, { ...CREATED, account: undefined, activation: undefined }],
      "GET /v1/me": [200, { api_key_id: "key_new", scopes: ["email:send"], team_id: "team_1", account: { tier: "free", status: "active" } }],
      "GET /v1/account/activation": [200, active],
    });
    const r = await run(["init", "--no-browser", "--base-url", server.url], { stdinTTY: true, stdin: "l\n\n" });
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([]);
    expect(JSON.parse(r.stdout)).toMatchObject({ profile: "default", account_status: "active" });
    expect(r.stderr).toContain("https://smtpfa.st/cli/device?code=BCDF-GHJK");
  });

  test("on a terminal without a key, signs up first and then carries on", async () => {
    server = await api({
      ...signupRoutes(),
      "GET /v1/account/activation": [200, active],
    });
    const r = await run(["init", "--base-url", server.url], { tty: true, stdinTTY: true, stdin: "s\nada@example.com\n\n\n4831-0927\n\n" });
    expect(r.code).toBe(0);
    expect(paths(server)).toEqual(["POST /v1/cli/signup", "POST /v1/cli/signup/verify", "GET /v1/account/activation"]);
    expect(configOf(r.configHome).profiles.default).toMatchObject({ api_key: NEW_KEY, email: "ada@example.com" });
    expect(r.stderr).toContain("No domain given");
  });
});
