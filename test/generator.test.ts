import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generate, PATHS } from "../scripts/generate.js";
import { BEGIN_MARKER, END_MARKER, updateReadme } from "../scripts/reference.js";
import { assignFlags, buildManifest, isSafeSpecPath, serializeManifest } from "../src/spec/build.js";
import { specHash } from "../src/spec/hash.js";
import type { OperationSpec, ParamSpec } from "../src/spec/types.js";
import { fixtureSpec } from "./helpers.js";

const { manifest } = buildManifest(fixtureSpec());
const op = (id: string): OperationSpec => manifest.operations.find((o) => o.operationId === id)!;
const field = (id: string, name: string): ParamSpec | undefined => op(id).body?.fields.find((f) => f.name === name);

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v)]));
  }
  return value;
}

describe("manifest from the fixture spec", () => {
  test("covers every operation and group", () => {
    expect(manifest.operationCount).toBe(78);
    expect(manifest.groups.map((g) => g.name)).toEqual([
      "account",
      "analytics",
      "api-keys",
      "broadcasts",
      "contact-properties",
      "contacts",
      "domains",
      "emails",
      "forms",
      "logs",
      "received",
      "segments",
      "suppressions",
      "webhooks",
    ]);
    const routes = new Set(manifest.operations.map((o) => `${o.method} ${o.path}`));
    for (const [path, item] of Object.entries<Record<string, unknown>>(fixtureSpec().paths)) {
      for (const method of Object.keys(item)) routes.delete(`${method.toUpperCase()} ${path}`);
    }
    expect(routes.size).toBe(0);
  });

  test("query parameters keep their names, types and descriptions", () => {
    const logs = op("listLogs");
    expect(logs.queryParams.map((p) => p.name)).toEqual(["after", "before", "domain", "domain_id", "email_id", "limit", "recipient", "since", "tag", "type", "until"]);
    const limit = logs.queryParams.find((p) => p.name === "limit")!;
    expect(limit).toMatchObject({ type: "integer", default: 20, required: false, flag: "limit" });
    expect(logs.queryParams.find((p) => p.name === "domain_id")!.flag).toBe("domain-id");
    expect(logs.queryParams.find((p) => p.name === "type")!.description).toContain("comma-separated");
    expect(op("getDomainClaimRecord").queryParams[0]).toMatchObject({ name: "domain", required: true });
  });

  test("path parameters are positional, in path order", () => {
    expect(op("retryWebhookDelivery").pathParams.map((p) => p.name)).toEqual(["id", "delivery_id"]);
    expect(op("approvePendingSignup").pathParams.map((p) => p.name)).toEqual(["id", "pendingId"]);
  });

  test("body fields resolve through $ref", () => {
    const send = op("sendEmail").body!;
    expect(send.type).toBe("object");
    expect(send.fields.filter((f) => f.required).map((f) => f.name).sort()).toEqual(["from", "subject", "to"]);
    expect(field("sendEmail", "to")).toMatchObject({ type: "array", items: "string", example: "user@example.com" });
    expect(field("sendEmail", "attachments")).toMatchObject({ type: "array", items: "object" });
  });

  test("allOf is merged", () => {
    const create = op("createBroadcast").body!.fields.map((f) => f.name);
    const update = op("updateBroadcast").body!.fields.map((f) => f.name);
    expect(update).toEqual(create);
    expect(create).toContain("segment_id");
  });

  test("oneOf of a string and a list becomes a list", () => {
    expect(field("replyToReceivedEmail", "to")).toMatchObject({ type: "array", items: "string" });
    expect(op("replyToReceivedEmail").idempotencyKey).toBe(true);
    expect(op("replyToReceivedEmail").headerParams).toEqual([]);
  });

  test("objects, enums, nullable fields and array bodies", () => {
    expect(field("createContact", "properties")!.type).toBe("object");
    expect(field("createWebhook", "events")!.enum).toContain("email.delivered");
    expect(field("createBroadcast", "reply_to")!.nullable).toBe(true);
    expect(op("sendEmailBatch").body).toMatchObject({ type: "array", fields: [] });
    expect(op("listEmails").body).toBeNull();
  });

  test("clashing flag names keep both fields reachable", () => {
    const flags = Object.fromEntries(op("createContact").body!.fields.map((f) => [f.name, f.flag]));
    expect(flags.first_name).toBe("first-name");
    expect(flags.firstName).toBe("firstName");
    expect(flags.segment_ids).toBe("segment-ids");
  });

  test("operations are sorted by group and command", () => {
    const keys = manifest.operations.map((o) => `${o.group} ${o.command}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("determinism", () => {
  test("the same spec gives byte-identical output", () => {
    expect(serializeManifest(buildManifest(fixtureSpec()).manifest)).toBe(serializeManifest(manifest));
  });

  test("key order in the spec does not matter", () => {
    const shuffled = shuffleKeys(fixtureSpec());
    expect(specHash(shuffled)).toBe(manifest.specHash);
    expect(serializeManifest(buildManifest(shuffled).manifest)).toBe(serializeManifest(manifest));
  });

  test("the committed manifest and README match spec/openapi.json", () => {
    const result = generate(readFileSync(PATHS.spec, "utf8"), readFileSync(PATHS.readme, "utf8"));
    expect(result.files[PATHS.manifest]).toBe(readFileSync(PATHS.manifest, "utf8"));
    expect(result.files[PATHS.readme]).toBe(readFileSync(PATHS.readme, "utf8"));
    expect(result.warnings).toEqual([]);
  });

  test("the current spec snapshot also maps to unique commands", () => {
    const snapshot = buildManifest(JSON.parse(readFileSync(PATHS.spec, "utf8"))).manifest;
    const names = snapshot.operations.map((o) => `${o.group} ${o.command}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("spec edge cases", () => {
  const base = (paths: Record<string, unknown>, components: Record<string, unknown> = {}) => ({
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths,
    components,
  });

  test("missing operationId, undeclared path params and $ref parameters", () => {
    const { manifest: m, warnings } = buildManifest(
      base(
        {
          "/v1/widgets/{id}/spin": {
            post: { summary: "Spin", parameters: [{ $ref: "#/components/parameters/Speed" }] },
          },
        },
        { parameters: { Speed: { name: "speed", in: "query", required: true, schema: { type: ["integer", "null"] } } } },
      ),
    );
    const o = m.operations[0]!;
    expect(o.operationId).toBe("spin");
    expect(`${o.group} ${o.command}`).toBe("widgets spin");
    expect(o.pathParams.map((p) => p.name)).toEqual(["id"]);
    expect(o.queryParams[0]).toMatchObject({ name: "speed", type: "integer", nullable: true, required: true });
    expect(warnings.map((w) => w.message)).toEqual(["No operationId; using spin", "Path parameter {id} is not declared"]);
  });

  test("clashing names fall back to the operationId", () => {
    const { manifest: m, warnings } = buildManifest(
      base({
        "/v1/things": { get: { operationId: "listThings", summary: "a" } },
        "/v1/things/all": { get: { operationId: "listAllThings", summary: "b" }, post: { operationId: "list", summary: "c" } },
      }),
    );
    const names = m.operations.map((o) => `${o.group} ${o.command}`);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("things all");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a field named like a global flag gets another flag", () => {
    const params: ParamSpec[] = [
      { name: "data", flag: "", in: "body", type: "object", required: false },
      { name: "profile", flag: "", in: "query", type: "string", required: false },
    ];
    assignFlags(params);
    expect(params.map((p) => p.flag)).toEqual(["body-data", "query-profile"]);
  });

  test("a field that would collide with a global --no- form gets another flag", () => {
    const params: ParamSpec[] = [
      { name: "no-debug", flag: "", in: "query", type: "string", required: false },
      { name: "no_json", flag: "", in: "query", type: "string", required: false },
      { name: "color", flag: "", in: "query", type: "boolean", required: false },
      { name: "update_check", flag: "", in: "body", type: "boolean", required: false },
      { name: "update-mode", flag: "", in: "body", type: "boolean", required: false },
    ];
    assignFlags(params);
    expect(params.map((p) => p.flag)).toEqual(["query-no-debug", "no_json", "query-color", "update_check", "update-mode"]);
  });

  test("readOnly properties are not flags", () => {
    const { manifest: m } = buildManifest(
      base({
        "/v1/things": {
          post: {
            operationId: "createThing",
            summary: "x",
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" } } } } } },
          },
        },
      }),
    );
    expect(m.operations[0]!.body!.fields.map((f) => f.name)).toEqual(["name"]);
  });

  test("only safe /v1/ paths become commands", () => {
    for (const p of ["/v1/emails", "/v1/emails/{id}", "/v1/webhooks/{id}/deliveries/{delivery_id}/retry", "/v1/emails/receiving/{id}"]) {
      expect(isSafeSpecPath(p)).toBe(true);
    }
    const unsafe = [
      "/v2/emails",
      "/admin/users",
      "v1/emails",
      "/v1/../admin",
      "/v1/./emails",
      "/v1/%2e%2e/admin",
      "/v1/%2E./admin",
      "/v1/%252e%252e/admin",
      "/v1//emails",
      "//evil.test/v1/emails",
      "https://evil.test/v1/emails",
      "/v1/emails\\..\\admin",
      "/v1/a%2F..%2F..%2Fadmin",
      "/v1/emails?x=1",
      "/v1/emails#x",
      "/v1/emails list",
    ];
    for (const p of unsafe) expect(isSafeSpecPath(p)).toBe(false);
    const { manifest: m, warnings } = buildManifest(
      base({
        "/v1/things": { get: { operationId: "listThings", summary: "a" } },
        "/v1/%2e%2e/admin/users": { get: { operationId: "listAdminUsers", summary: "b" } },
        "//evil.test/v1/x": { get: { operationId: "evil", summary: "c" } },
      }),
    );
    expect(m.operations.map((o) => o.operationId)).toEqual(["listThings"]);
    expect(warnings.filter((w) => w.message.startsWith("Skipped")).map((w) => w.operation).sort()).toEqual(["//evil.test/v1/x", "/v1/%2e%2e/admin/users"]);
  });

  test("a document without paths is rejected", () => {
    expect(() => buildManifest({ openapi: "3.1.0" })).toThrow("missing paths");
  });
});

describe("README reference", () => {
  test("lists every operation between the markers and is idempotent", () => {
    const readme = `# x\n\n${BEGIN_MARKER}\nold\n${END_MARKER}\n\nafter\n`;
    const once = updateReadme(readme, manifest);
    expect(updateReadme(once, manifest)).toBe(once);
    expect(once.endsWith("\n\nafter\n")).toBe(true);
    for (const o of manifest.operations) expect(once).toContain(`\`${o.method} ${o.path}\``);
    expect(once).toContain("`smtpfast domains verify <id-or-name>`");
    expect(once).toContain("`smtpfast send`");
  });

  test("missing markers are an error", () => {
    expect(() => updateReadme("# no markers", manifest)).toThrow("markers");
  });
});
