import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "../src/args.js";
import { UsageError } from "../src/errors.js";
import { buildRequest, coerce, operationFlagDefs } from "../src/request.js";
import { buildManifest } from "../src/spec/build.js";
import type { OperationSpec } from "../src/spec/types.js";
import { fixtureSpec, tempDir } from "./helpers.js";

const { manifest } = buildManifest(fixtureSpec());
const op = (id: string): OperationSpec => manifest.operations.find((o) => o.operationId === id)!;

async function build(id: string, argv: string[], stdin = "", cwd = process.cwd()) {
  const o = op(id);
  return buildRequest(o, parseArgs(argv, operationFlagDefs(o)), { cwd, stdin: Readable.from([stdin]) });
}

async function usageError(promise: Promise<unknown>): Promise<UsageError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error("expected a usage error");
}

describe("path and query", () => {
  test("path params are positional and URL encoded", async () => {
    const r = await build("retryWebhookDelivery", ["wh_1", "del/2"]);
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/v1/webhooks/wh_1/deliveries/del%2F2/retry");
  });

  test("dot segment arguments are refused, plain or percent-encoded", async () => {
    for (const v of [".", "..", "%2e", "%2E%2e", ".%2E", "%2e.", "%252e%252e"]) {
      expect((await usageError(build("getEmail", [v]))).message).toBe(`<id> cannot be "${v}"`);
    }
    expect((await build("getEmail", ["..."])).path).toBe("/v1/emails/...");
    expect((await build("getEmail", ["a..b"])).path).toBe("/v1/emails/a..b");
    expect((await build("getEmail", ["../x"])).path).toBe("/v1/emails/..%2Fx");
  });

  test("an operation with an unsafe path is refused before any request", async () => {
    const hostile = { ...op("getEmail"), path: "/v1/../admin/{id}" };
    await expect(buildRequest(hostile, parseArgs(["x"], operationFlagDefs(hostile)), { cwd: process.cwd(), stdin: Readable.from([""]) })).rejects.toThrow(
      "Refusing to call /v1/../admin/{id}",
    );
  });

  test("missing and extra arguments are usage errors", async () => {
    expect((await usageError(build("getEmail", []))).message).toBe("Missing argument <id>");
    expect((await usageError(build("getEmail", ["a", "b"]))).message).toBe('Unexpected argument "b"');
  });

  test("query flags are typed", async () => {
    const r = await build("listLogs", ["--limit", "5", "--domain-id", "dom_1", "--type", "bounced,failed"]);
    expect(r.query).toEqual([
      ["domain_id", "dom_1"],
      ["limit", "5"],
      ["type", "bounced,failed"],
    ]);
    expect((await usageError(build("listLogs", ["--limit", "five"]))).message).toBe('--limit takes an integer, got "five"');
  });

  test("boolean query flags send true and false", async () => {
    expect((await build("listContacts", ["--disposable"])).query).toEqual([["disposable", "true"]]);
    expect((await build("listContacts", ["--no-disposable"])).query).toEqual([["disposable", "false"]]);
  });

  test("required query flags are checked", async () => {
    expect((await usageError(build("getDomainClaimRecord", []))).message).toBe("Missing required flag: --domain");
  });

  test("GET requests have no body", async () => {
    expect((await build("listEmails", [])).body).toBeUndefined();
  });
});

describe("body", () => {
  test("field flags become typed body fields", async () => {
    const r = await build("sendEmail", ["--from", "a@x.com", "--to", "b@x.com, c@x.com", "--to", "d@x.com", "--subject", "Hi"]);
    expect(r.body).toEqual({ from: "a@x.com", to: ["b@x.com", "c@x.com", "d@x.com"], subject: "Hi" });
  });

  test("commas inside display names do not split", () => {
    const to = op("sendEmail").body!.fields.find((f) => f.name === "to")!;
    expect(coerce(to, ['"Doe, Jane" <jane@x.com>,bob@x.com'])).toEqual(['"Doe, Jane" <jane@x.com>', "bob@x.com"]);
  });

  test("booleans, integers, objects and arrays of objects", async () => {
    const r = await build("createContact", ["--email", "j@x.com", "--no-unsubscribed", "--properties", "company=Acme", "--properties", '{"plan":"pro"}', "--segment-ids", "s1,s2"]);
    expect(r.body).toEqual({ email: "j@x.com", unsubscribed: false, properties: { company: "Acme", plan: "pro" }, segment_ids: ["s1", "s2"] });
    const share = await build("shareEmail", ["em_1", "--expires-in", "3600"]);
    expect(share.body).toEqual({ expires_in: 3600 });
    const att = await build("sendEmail", ["--from", "a@x.com", "--to", "b@x.com", "--subject", "s", "--attachments", '{"filename":"a.txt","content":"aGk="}']);
    expect((att.body as Record<string, unknown>).attachments).toEqual([{ filename: "a.txt", content: "aGk=" }]);
  });

  test("the exact API name works as a flag too", async () => {
    const r = await build("createContact", ["--email", "j@x.com", "--first_name", "Jo", "--firstName", "J"]);
    expect(r.body).toEqual({ email: "j@x.com", first_name: "Jo", firstName: "J" });
  });

  test("nullable fields accept null", async () => {
    const r = await build("updateBroadcast", ["b_1", "--name", "n", "--reply-to", "null"]);
    expect(r.body).toEqual({ name: "n", reply_to: null });
  });

  test("--data inline, merged with flags that win", async () => {
    const r = await build("sendEmail", ["--data", '{"from":"a@x.com","to":["b@x.com"],"subject":"Old","cc":["c@x.com"]}', "--subject", "New"]);
    expect(r.body).toEqual({ from: "a@x.com", to: ["b@x.com"], subject: "New", cc: ["c@x.com"] });
  });

  test("--data from a file and from stdin", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "body.json"), '{"email":"file@x.com"}');
    expect((await build("createContact", ["--data", "@body.json"], "", dir)).body).toEqual({ email: "file@x.com" });
    expect((await build("createContact", ["--data", "-"], '{"email":"stdin@x.com"}')).body).toEqual({ email: "stdin@x.com" });
    expect((await usageError(build("createContact", ["--data", "@missing.json"], "", dir))).message).toBe("Cannot read missing.json: ENOENT");
  });

  test("invalid JSON in --data is a usage error", async () => {
    expect((await usageError(build("createContact", ["--data", "{nope"]))).message).toContain("--data is not valid JSON");
  });

  test("an array body comes only from --data", async () => {
    const r = await build("sendEmailBatch", ["--data", '[{"from":"a@x.com","to":"b@x.com","subject":"s","text":"t"}]']);
    expect(Array.isArray(r.body)).toBe(true);
    expect((await usageError(build("sendEmailBatch", []))).message).toBe("This command takes a JSON array as its body");
  });

  test("an array in --data cannot be mixed with field flags", async () => {
    expect((await usageError(build("createContact", ["--data", "[]", "--email", "a@x.com"]))).message).toContain("must be a JSON object");
  });

  test("missing required fields are listed together", async () => {
    const err = await usageError(build("sendEmail", ["--from", "a@x.com"]));
    expect(err.message).toBe("Missing required flags: --subject, --to");
  });

  test("required fields can come from --data", async () => {
    const r = await build("createWebhook", ["--data", '{"url":"https://x.test/h","events":["email.sent"]}']);
    expect(r.body).toEqual({ url: "https://x.test/h", events: ["email.sent"] });
  });

  test("an optional object body with no flags is an empty object", async () => {
    expect((await build("shareEmail", ["em_1"])).body).toEqual({});
  });

  test("POST without a declared body still accepts --data", async () => {
    const r = await build("createContactProperty", ["--data", '{"key":"plan","type":"string"}']);
    expect(r.body).toEqual({ key: "plan", type: "string" });
    expect((await build("cancelEmail", ["em_1"])).body).toBeUndefined();
  });
});
