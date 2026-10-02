import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MockServer, run, sendJson, startMockServer, tempDir } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function env(url: string, extra: Record<string, string> = {}) {
  return { SMTPFAST_API_KEY: "sf_test_key", SMTPFAST_BASE_URL: url, ...extra };
}

describe("send", () => {
  test("encodes attachments and builds the full body", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_123", status: "queued" }));
    const dir = tempDir();
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10]);
    writeFileSync(join(dir, "report.bin"), bytes);
    writeFileSync(join(dir, "body.html"), "<p>Hi</p>");
    const r = await run(
      [
        "send",
        "--from", "Acme <hi@acme.test>",
        "--to", "a@x.test,b@x.test",
        "--to", "c@x.test",
        "--subject", "Report",
        "--html-file", "body.html",
        "--text", "Hi",
        "--cc", "cc@x.test",
        "--bcc", "bcc@x.test",
        "--reply-to", "reply@acme.test",
        "--attach", "report.bin",
        "--tag", "kind=report",
        "--header", "X-Entity-Ref: 42",
        "--scheduled-at", "2026-11-01T09:00:00Z",
        "--idempotency-key", "report-2026-11",
      ],
      { env: env(server.url), cwd: dir },
    );
    expect(r.code).toBe(0);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/emails");
    expect(req.headers["idempotency-key"]).toBe("report-2026-11");
    expect(req.json).toEqual({
      from: "Acme <hi@acme.test>",
      to: ["a@x.test", "b@x.test", "c@x.test"],
      subject: "Report",
      text: "Hi",
      html: "<p>Hi</p>",
      cc: ["cc@x.test"],
      bcc: ["bcc@x.test"],
      reply_to: "reply@acme.test",
      attachments: [{ filename: "report.bin", content: bytes.toString("base64") }],
      scheduled_at: "2026-11-01T09:00:00Z",
      tags: [{ name: "kind", value: "report" }],
      headers: { "X-Entity-Ref": "42" },
    });
    expect(JSON.parse(r.stdout)).toEqual({ id: "em_123", status: "queued" });
  });

  test("reads the text body from stdin and prints a summary on a terminal", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_9", status: "queued" }));
    const r = await run(["send", "--from", "a@x.test", "--to", "b@x.test", "--subject", "s", "--text-file", "-"], { env: env(server.url), stdin: "from stdin\n", tty: true });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.json.text).toBe("from stdin\n");
    expect(r.stdout).toContain("Email em_9 queued: b@x.test");
  });

  test("--quiet prints only the id", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_q" }));
    const r = await run(["send", "-q", "--from", "a@x.test", "--to", "b@x.test", "--subject", "s", "--text", "t"], { env: env(server.url), tty: true });
    expect(r.stdout).toBe("em_q\n");
  });

  test("a missing body or recipient is a usage error with exit code 2", async () => {
    const r = await run(["send", "--from", "a@x.test", "--to", "b@x.test", "--subject", "s"], { env: env("http://127.0.0.1:9") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Give a body with --text");
    const r2 = await run(["send", "--from", "a@x.test", "--subject", "s", "--text", "t"], { env: env("http://127.0.0.1:9") });
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("Missing required flag: --to");
  });
});

describe("domains verify", () => {
  test("--wait resolves a name and polls until verified", async () => {
    let verifyCalls = 0;
    server = await startMockServer((req, res) => {
      if (req.method === "GET" && req.path === "/v1/domains") return sendJson(res, 200, [{ id: "dom_1", domain: "acme.test", status: "pending" }]);
      if (req.method === "GET" && req.path === "/v1/domains/dom_1")
        return sendJson(res, 200, { id: "dom_1", domain: "acme.test", dns_records: [{ type: "TXT", name: "_dmarc.acme.test", value: "v=DMARC1" }] });
      if (req.method === "POST" && req.path === "/v1/domains/dom_1/verify") {
        verifyCalls++;
        const verified = verifyCalls >= 3;
        return sendJson(res, 200, {
          domain: "acme.test",
          status: verified ? "verified" : "pending",
          checks: { dkim: "verified", spf: verified ? "verified" : "pending", dmarc: verified ? "verified" : "pending", mail_from: verified ? "verified" : "pending" },
        });
      }
      sendJson(res, 404, { error: "not found" });
    });
    const sleeps: number[] = [];
    const r = await run(["domains", "verify", "acme.test", "--wait", "--interval", "5s"], {
      env: env(server.url),
      tty: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.code).toBe(0);
    expect(verifyCalls).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
    expect(r.stdout).toContain("acme.test: pending");
    expect(r.stdout).toMatch(/SPF\s+pending/);
    expect(r.stdout).toMatch(/MAIL FROM\s+verified/);
    expect(r.stdout).toContain("_dmarc.acme.test");
    expect(r.stdout).toContain("acme.test is verified.");
  });

  test("--wait gives up after the timeout with exit code 1", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { domain: "acme.test", status: "pending", checks: { dkim: "pending" } }));
    let clock = 0;
    const r = await run(["domains", "verify", "dom_1", "--wait", "--timeout", "30s", "--interval", "10s", "--json"], {
      env: env(server.url),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Timed out after 30s: acme.test is still pending");
    // Checks at 0s, 10s, 20s and 30s.
    expect(server.requests.filter((q) => q.path === "/v1/domains/dom_1/verify").length).toBe(4);
  });

  test("without --wait it verifies once and prints JSON when piped", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { domain: "acme.test", status: "verified" }));
    const r = await run(["domains", "verify", "dom_1"], { env: env(server.url) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ domain: "acme.test", status: "verified" });
  });

  test("an unknown domain name is reported", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, []));
    const r = await run(["domains", "verify", "nope.test"], { env: env(server.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No domain named nope.test");
  });
});

describe("logs tail", () => {
  test("prints the backlog oldest first, then new events, until interrupted", async () => {
    server = await startMockServer((req, res) => {
      if (!req.query.get("before")) {
        return sendJson(res, 200, { object: "list", has_more: true, data: [{ id: "ev_3", type: "delivered" }, { id: "ev_2", type: "sent" }, { id: "ev_1", type: "queued" }] });
      }
      if (req.query.get("before") === "ev_3") return sendJson(res, 200, { object: "list", has_more: true, data: [{ id: "ev_5", type: "opened" }, { id: "ev_4", type: "clicked" }] });
      if (req.query.get("before") === "ev_5") return sendJson(res, 200, { object: "list", has_more: false, data: [{ id: "ev_6", type: "bounced" }] });
      sendJson(res, 200, { object: "list", has_more: false, data: [] });
    });
    let interrupt: (() => void) | undefined;
    let sleeps = 0;
    const r = await run(["logs", "tail", "--type", "delivered", "--type", "opened,clicked", "--recipient", "a@x.test", "--backlog", "2"], {
      env: env(server.url),
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) interrupt?.();
      },
    });
    expect(r.code).toBe(0);
    const ids = r.stdout.trim().split("\n").map((l) => JSON.parse(l).id);
    expect(ids).toEqual(["ev_2", "ev_3", "ev_4", "ev_5", "ev_6"]);
    const first = server.requests[0]!;
    expect(first.query.get("type")).toBe("delivered,opened,clicked");
    expect(first.query.get("recipient")).toBe("a@x.test");
    expect(first.query.get("limit")).toBe("2");
    expect(server.requests.map((q) => q.query.get("before"))).toEqual([null, "ev_3", "ev_5"]);
  });

  test("a missing scope stops the tail with a hint", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 403, { error: "API key does not have logs:read scope" }));
    const r = await run(["logs", "tail"], { env: env(server.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 403 Forbidden: API key does not have logs:read scope");
    expect(r.stderr).toContain("does not have the logs:read scope");
  });
});

describe("api", () => {
  test("passes method, path, query, headers and body through", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 201, { id: "c_1" }));
    const r = await run(["api", "post", "/v1/contacts", "--query", "dry_run=1", "--header", "X-Test: yes", "--data", '{"email":"a@x.test"}', "--idempotency-key", "k1"], { env: env(server.url) });
    expect(r.code).toBe(0);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/contacts");
    expect(req.query.get("dry_run")).toBe("1");
    expect(req.headers["x-test"]).toBe("yes");
    expect(req.headers["idempotency-key"]).toBe("k1");
    expect(req.json).toEqual({ email: "a@x.test" });
    expect(JSON.parse(r.stdout)).toEqual({ id: "c_1" });
  });

  test("refuses full URLs so the key never leaves the base URL", async () => {
    const r = await run(["api", "GET", "https://elsewhere.test/v1/me"], { env: env("http://127.0.0.1:9") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a full URL");
  });
});

describe("generated commands", () => {
  test("query flags, JSON output and the user agent", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { object: "list", has_more: false, data: [{ id: "em_1", subject: "Hi", status: "delivered" }] }));
    const r = await run(["emails", "list", "--limit", "5", "--status", "delivered"], { env: env(server.url) });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.query.toString()).toBe("limit=5&status=delivered");
    expect(server.requests[0]!.headers["user-agent"]).toMatch(/^smtpfast-cli\/\d+\.\d+\.\d+$/);
    expect(JSON.parse(r.stdout).data[0].id).toBe("em_1");
  });

  test("global flags work before the command too", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1" }));
    const r = await run(["--quiet", "--base-url", server.url, "--api-key", "k", "emails", "get", "em_1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("em_1\n");
    expect(server.requests[0]!.headers.authorization).toBe("Bearer k");
  });

  test("a table on a terminal, with a next page hint", async () => {
    server = await startMockServer((_req, res) =>
      sendJson(res, 200, { object: "list", has_more: true, data: [{ id: "em_1", subject: "Hello", status: "delivered", created_at: "2026-10-01T10:00:00Z", to: ["a@x.test"] }] }),
    );
    const r = await run(["emails", "list"], { env: env(server.url), tty: true });
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^ID\s+TO\s+SUBJECT\s+STATUS\s+CREATED AT$/);
    expect(lines[1]).toMatch(/^em_1\s+a@x\.test\s+Hello\s+delivered\s+2026-10-01T10:00:00Z$/);
    expect(r.stdout).toContain("More results. Next page: --after em_1");
  });

  test("a list with summary fields beside data is still a table", async () => {
    server = await startMockServer((_req, res) =>
      sendJson(res, 200, { object: "list", has_more: false, disposable: 3, data: [{ id: "ct_1", email: "a@x.test", status: "subscribed" }] }),
    );
    const r = await run(["contacts", "list"], { env: env(server.url), tty: true });
    expect(r.stdout).toMatch(/^ID\s+EMAIL\s+STATUS$/m);
    expect(r.stdout).toMatch(/^ct_1\s+a@x\.test\s+subscribed$/m);
    expect(r.stdout).toContain("disposable: 3");
  });

  test("a key-value view for one object on a terminal", async () => {
    server = await startMockServer((_req, res) =>
      sendJson(res, 200, { id: "dom_1", domain: "acme.test", status: "verified", dns_records: [{ type: "CNAME", name: "x._domainkey", value: "y" }] }),
    );
    const r = await run(["domains", "get", "dom_1"], { env: env(server.url), tty: true });
    expect(r.stdout).toMatch(/^id\s+dom_1$/m);
    expect(r.stdout).toMatch(/^status\s+verified$/m);
    expect(r.stdout).toContain("dns_records");
    expect(r.stdout).toMatch(/^TYPE\s+NAME\s+VALUE$/m);
    expect(r.stdout).toMatch(/^CNAME\s+x\._domainkey\s+y$/m);
  });

  test("API errors exit 1 and name the missing scope", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 403, { error: "API key does not have contact:write scope" }));
    const r = await run(["contacts", "create", "--email", "a@x.test"], { env: env(server.url) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: HTTP 403 Forbidden: API key does not have contact:write scope");
    expect(r.stderr).toContain("Hint: This API key does not have the contact:write scope.");
  });

  test("usage errors exit 2 before any request", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, {}));
    const r = await run(["emails", "get"], { env: env(server.url) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing argument <id>");
    expect(r.stderr).toContain('Run "smtpfast emails get --help" for usage.');
    expect(server.requests.length).toBe(0);
  });

  test("a dot segment argument never reaches the server", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, {}));
    for (const id of ["..", "%2e%2e", "."]) {
      const r = await run(["emails", "get", id], { env: env(server.url) });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`<id> cannot be "${id}"`);
    }
    const v = await run(["domains", "verify", "%2e%2e"], { env: env(server.url) });
    expect(v.code).toBe(2);
    expect(server.requests.length).toBe(0);
  });

  test("unknown commands suggest the closest match", async () => {
    const r = await run(["emials", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Did you mean "smtpfast emails"?');
    const r2 = await run(["webhooks", "retry"]);
    expect(r2.stderr).toContain('Unknown command "webhooks retry"');
    expect(r2.stderr).toContain('Run "smtpfast webhooks --help"');
  });

  test("a missing API key is a setup error", async () => {
    const r = await run(["emails", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No API key found");
    expect(r.stderr).not.toContain("--help");
  });
});

describe("flag parsing", () => {
  test("a command's value flag takes a value that looks like a global flag", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1" }));
    for (const subject of ["--help", "-h", "--version", "--json"]) {
      const r = await run(["send", "--subject", subject, "--from", "a@x.test", "--to", "b@x.test", "--text", "t"], { env: env(server.url) });
      expect(r.code).toBe(0);
      expect(server.requests.at(-1)!.json.subject).toBe(subject);
    }
    const p = await run(["send", "--from", "a@x.test", "--to", "b@x.test", "--text", "--profile", "--subject", "s"], { env: env(server.url) });
    expect(p.code).toBe(0);
    expect(server.requests.at(-1)!.json).toMatchObject({ text: "--profile", subject: "s" });
  });

  test("global flags work before, between and after the command words", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1" }));
    for (const argv of [
      ["--quiet", "emails", "get", "em_1"],
      ["emails", "--quiet", "get", "em_1"],
      ["emails", "get", "em_1", "--quiet"],
      ["emails", "get", "-q", "em_1"],
    ]) {
      const r = await run(argv, { env: env(server.url), tty: true });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("em_1\n");
    }
  });

  test("--help works at every level, before or after the command", async () => {
    const top = await run(["--help"]);
    expect(top.stdout).toContain("smtpfast: the command-line tool");
    for (const argv of [["emails", "--help"], ["--help", "emails"], ["emails", "-h"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("smtpfast emails <command> [args] [flags]");
    }
    for (const argv of [["emails", "list", "--help"], ["--help", "emails", "list"], ["emails", "--help", "list"], ["help", "emails", "list"], ["emails", "list", "--limit", "5", "-h"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("API: GET /v1/emails (listEmails)");
    }
    const hand = await run(["send", "--help"]);
    expect(hand.stdout).toContain("--attach <path>");
    const ext = await run(["logs", "tail", "--help"]);
    expect(ext.stdout).toContain("Print email events as they happen");
  });

  test("-- ends flag parsing", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "--odd" }));
    const r = await run(["emails", "get", "--", "--odd"], { env: env(server.url) });
    expect(r.code).toBe(0);
    expect(server.requests[0]!.path).toBe("/v1/emails/--odd");
    const r2 = await run(["--json", "--", "emails", "get", "--help"], { env: env(server.url) });
    expect(r2.code).toBe(0);
    expect(server.requests[1]!.path).toBe("/v1/emails/--help");
  });

  test("--no-debug turns off SMTPFAST_DEBUG", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "em_1" }));
    const on = await run(["emails", "get", "em_1"], { env: env(server.url, { SMTPFAST_DEBUG: "1" }) });
    expect(on.stderr).toContain("> GET");
    const off = await run(["emails", "get", "em_1", "--no-debug"], { env: env(server.url, { SMTPFAST_DEBUG: "1" }) });
    expect(off.stderr).not.toContain("> GET");
  });

  test("flags before the command must be global, and a group needs a command before its flags", async () => {
    const r = await run(["--limit", "5", "emails", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown flag --limit");
    const g = await run(["emails", "--limit", "5"]);
    expect(g.code).toBe(2);
    expect(g.stderr).toContain('Put the command name before flags, like "smtpfast emails <command> --limit"');
  });
});

describe("help", () => {
  test("command help shows args, typed flags, required markers and an example", async () => {
    const r = await run(["webhooks", "create", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:\n  smtpfast webhooks create [flags]");
    expect(r.stdout).toMatch(/--url <string>\s+\(required\)/);
    expect(r.stdout).toMatch(/--events <string>\s+\(required\)/);
    expect(r.stdout).toContain("Example:\n  smtpfast webhooks create --events email.delivered,email.bounced --url https://yourapp.com/webhooks/smtpfast");
    expect(r.stdout).toContain("API: POST /v1/webhooks (createWebhook)");
    const r2 = await run(["help", "webhooks", "retry-delivery"]);
    expect(r2.stdout).toContain("smtpfast webhooks retry-delivery <id> <delivery_id> [flags]");
    expect(r2.stdout).toContain("Arguments:");
  });

  test("group help lists commands, including hand-written ones", async () => {
    const r = await run(["logs", "--help"]);
    expect(r.stdout).toMatch(/list\s+List email events/);
    expect(r.stdout).toMatch(/tail\s+Print email events as they happen/);
    const r2 = await run(["domains"]);
    expect(r2.stdout).toMatch(/verify <id-or-name>\s+Verify a domain/);
    expect(r2.stdout).not.toContain("verify <id> ");
  });

  test("top-level help and the command tree", async () => {
    const r = await run(["--help"]);
    expect(r.stdout).toContain("smtpfast: the command-line tool for the SMTPfast email API.");
    expect(r.stdout).toContain("contact-properties");
    const tree = await run(["commands", "--json"]);
    const entries = JSON.parse(tree.stdout) as Array<{ command: string; source: string }>;
    expect(entries.find((e) => e.command === "domains verify")?.source).toBe("hand-written");
    expect(entries.find((e) => e.command === "emails list")?.source).toBe("built-in");
    expect(entries.filter((e) => e.source === "built-in").length).toBe(77);
  });

  test("--version prints the version", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^smtpfast \d+\.\d+\.\d+\n$/);
  });
});

describe("completion", () => {
  test("prints scripts for each shell", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const r = await run(["completion", shell]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("smtpfast __complete");
    }
    expect((await run(["completion", "tcsh"])).code).toBe(2);
  });

  test("__complete suggests groups, commands and flags", async () => {
    expect((await run(["__complete", "dom"])).stdout).toBe("domains\n");
    expect((await run(["__complete", "webhooks", "re"])).stdout).toBe("replace\nretry-delivery\n");
    const flags = (await run(["__complete", "emails", "send", "--su"])).stdout;
    expect(flags).toBe("--subject\n");
    expect((await run(["__complete", "--profile", "x", "logs", "t"])).stdout).toBe("tail\n");
    expect((await run(["__complete", "completion", ""])).stdout).toBe("bash\nfish\nzsh\n");
  });
});

describe("API keys in errors", () => {
  const KEY = "sf_live_secret_0123456789";
  const echoServer = () =>
    startMockServer((req, res) => {
      const auth = String(req.headers.authorization ?? "");
      const key = auth.replace(/^Bearer /, "");
      sendJson(res, 401, { error: `Invalid API key ${key}`, received: auth, url: `/v1/x?key=${encodeURIComponent(key)}` });
    });

  test("an API error that echoes the key does not print it, with or without --debug", async () => {
    server = await echoServer();
    for (const argv of [["emails", "list"], ["emails", "list", "--debug"], ["--debug", "emails", "list", "--api-key", KEY]]) {
      const r = await run(argv, { env: env(server.url, { SMTPFAST_API_KEY: KEY }) });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("HTTP 401 Unauthorized: Invalid API key [redacted]");
      expect(r.stderr).not.toContain(KEY);
      expect(r.stdout).not.toContain(KEY);
    }
    const debug = await run(["emails", "list", "--debug"], { env: env(server.url, { SMTPFAST_API_KEY: KEY }) });
    expect(debug.stderr).toContain('"received": "Bearer [redacted]"');
  });

  test("a key from a stored profile is redacted too", async () => {
    server = await echoServer();
    const configHome = tempDir();
    const dir = join(configHome, "smtpfast");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ current: "p", profiles: { p: { api_key: KEY, base_url: server.url } } }));
    const r = await run(["whoami", "--debug"], { configHome });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(KEY);
  });

  test("a login failure does not print the key it was given", async () => {
    server = await echoServer();
    const flag = await run(["login", "--api-key", KEY, "--base-url", server.url, "--debug"]);
    expect(flag.code).toBe(1);
    expect(flag.stderr).toContain("The API rejected this key (HTTP 401: Invalid API key [redacted])");
    expect(flag.stderr).not.toContain(KEY);
    const piped = await run(["login", "--debug"], { stdin: `${KEY}\n`, env: { SMTPFAST_BASE_URL: server.url } });
    expect(piped.code).toBe(1);
    expect(piped.stderr).toContain("[redacted]");
    expect(piped.stderr).not.toContain(KEY);
  });

  test("a usage error that repeats an --api-key value does not print it", async () => {
    const r = await run([KEY, "--api-key", KEY]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command "[redacted]"');
    expect(r.stderr).not.toContain(KEY);
  });
});
