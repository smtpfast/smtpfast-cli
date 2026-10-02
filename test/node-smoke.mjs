// Runs the built npm package (dist/cli.js) on plain Node against a local mock
// server. CI runs it on every supported Node version after `npm run build`.
//
//   npm run build && node test/node-smoke.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "dist", "cli.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/api/v1/emails" && req.method === "GET") return send(200, { object: "list", has_more: false, data: [{ id: "em_1" }] });
    if (url.pathname === "/api/v1/contacts" && req.method === "POST") return send(201, { id: "c_1" });
    if (url.pathname === "/api/v1/domains") return send(403, { error: "API key does not have domain:read scope" });
    send(404, { error: "Not found" });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
const configHome = mkdtempSync(join(tmpdir(), "smtpfast-smoke-"));

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configHome,
        SMTPFAST_NO_UPDATE_CHECK: "1",
        SMTPFAST_API_KEY: "sf_smoke",
        SMTPFAST_BASE_URL: baseUrl,
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let checks = 0;
try {
  const version = await cli(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), `smtpfast ${pkg.version}`);
  checks++;

  const list = await cli(["emails", "list", "--limit", "2"]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).data[0].id, "em_1");
  const listReq = requests.at(-1);
  assert.equal(listReq.headers.authorization, "Bearer sf_smoke");
  assert.equal(listReq.headers["user-agent"], `smtpfast-cli/${pkg.version}`);
  assert.equal(listReq.query.get("limit"), "2");
  checks++;

  const create = await cli(["contacts", "create", "--email", "a@example.com", "--properties", "plan=pro", "--quiet"]);
  assert.equal(create.code, 0, create.stderr);
  assert.equal(create.stdout, "c_1\n");
  assert.deepEqual(JSON.parse(requests.at(-1).body), { email: "a@example.com", properties: { plan: "pro" } });
  checks++;

  const denied = await cli(["domains", "list"]);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /HTTP 403 Forbidden: API key does not have domain:read scope/);
  checks++;

  const usage = await cli(["emails", "get"]);
  assert.equal(usage.code, 2);
  checks++;

  const tree = await cli(["commands", "--json"]);
  assert.equal(tree.code, 0, tree.stderr);
  assert.ok(JSON.parse(tree.stdout).length >= 80);
  checks++;

  const help = await cli(["send", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--attach <path>/);
  checks++;

  console.log(`Node ${process.version}: ${checks} smoke checks passed`);
} finally {
  server.close();
}
