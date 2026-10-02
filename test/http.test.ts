import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, CliError, UsageError } from "../src/errors.js";
import { ApiClient, parseRetryAfter } from "../src/http.js";
import { type MockServer, sendJson, startMockServer } from "./helpers.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(baseUrl: string, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = new ApiClient({
    baseUrl,
    apiKey: "sf_test_key",
    userAgent: "smtpfast-cli/9.9.9",
    fetch: (input, init) => fetch(input, init),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, sleeps };
}

describe("ApiClient", () => {
  test("sends auth, user agent, base URL prefix, query and JSON body", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, { id: "c_1" }));
    const { c } = client(`${server.url}/api/`);
    const res = await c.request({ method: "post", path: "/v1/contacts?x=1", query: [["limit", "5"], ["tag", "a b"]], body: { email: "a@x.com" } });
    expect(res.data).toEqual({ id: "c_1" });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/contacts");
    expect(req.query.toString()).toBe("x=1&limit=5&tag=a+b");
    expect(req.headers.authorization).toBe("Bearer sf_test_key");
    expect(req.headers["user-agent"]).toBe("smtpfast-cli/9.9.9");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.json).toEqual({ email: "a@x.com" });
    expect(req.headers["idempotency-key"]).toBeUndefined();
  });

  test("sends the Idempotency-Key header when given", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, {}));
    const { c } = client(server.url);
    await c.request({ method: "POST", path: "/v1/emails", body: {}, idempotencyKey: "order-42" });
    expect(server.requests[0]!.headers["idempotency-key"]).toBe("order-42");
  });

  test("maps API errors to status and message", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 403, { error: "API key does not have contact:write scope" }));
    const { c } = client(server.url);
    try {
      await c.request({ method: "POST", path: "/v1/contacts", body: {} });
      throw new Error("expected an error");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(403);
      expect(e.message).toBe("API key does not have contact:write scope");
      expect(e.missingScope).toBe("contact:write");
      expect(e.exitCode).toBe(1);
    }
  });

  test("reads Resend-style error objects and plain text errors", async () => {
    let n = 0;
    server = await startMockServer((_req, res) => {
      n++;
      if (n === 1) sendJson(res, 422, { error: { name: "validation_error", message: "Invalid from" } });
      else {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("upstream down");
      }
    });
    const { c } = client(server.url);
    await expect(c.request({ method: "GET", path: "/a" })).rejects.toThrow("Invalid from");
    await expect(c.request({ method: "GET", path: "/b" })).rejects.toThrow("upstream down");
  });

  test("retries a 429 once after Retry-After", async () => {
    let n = 0;
    server = await startMockServer((_req, res) => {
      n++;
      if (n === 1) sendJson(res, 429, { error: "Rate limit exceeded" }, { "retry-after": "2" });
      else sendJson(res, 200, { ok: true });
    });
    const { c, sleeps } = client(server.url);
    const res = await c.request({ method: "GET", path: "/v1/emails" });
    expect(res.data).toEqual({ ok: true });
    expect(server.requests.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  test("reports a second 429 instead of retrying again", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 429, { error: "Rate limit exceeded" }, { "retry-after": "1" }));
    const { c, sleeps } = client(server.url);
    await expect(c.request({ method: "GET", path: "/v1/emails" })).rejects.toThrow("Rate limit exceeded (retry after 1s)");
    expect(server.requests.length).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  test("does not wait out a very long Retry-After", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 429, { error: "Slow down" }, { "retry-after": "3600" }));
    const { c, sleeps } = client(server.url);
    await expect(c.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(ApiError);
    expect(server.requests.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("text, CSV and empty bodies", async () => {
    let n = 0;
    server = await startMockServer((_req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(200, { "content-type": "text/csv" });
        res.end("email\na@x.com\n");
      } else {
        res.writeHead(204);
        res.end();
      }
    });
    const { c } = client(server.url);
    expect((await c.request({ method: "GET", path: "/csv" })).data).toBe("email\na@x.com\n");
    expect((await c.request({ method: "DELETE", path: "/x" })).data).toBeNull();
  });

  test("a missing key is a usage error, and auth can be turned off", async () => {
    server = await startMockServer((_req, res) => sendJson(res, 200, {}));
    const { c } = client(server.url, { apiKey: undefined });
    await expect(c.request({ method: "GET", path: "/v1/me" })).rejects.toBeInstanceOf(UsageError);
    await c.request({ method: "GET", path: "/v1/openapi.json", auth: false });
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
  });

  test("network failures name the host", async () => {
    const { c } = client("http://127.0.0.1:9");
    try {
      await c.request({ method: "GET", path: "/v1/me" });
      throw new Error("expected an error");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toContain("Could not reach http://127.0.0.1:9");
    }
  });

  test("requests time out", async () => {
    server = await startMockServer(() => new Promise(() => {}));
    const { c } = client(server.url, { timeoutMs: 50 });
    await expect(c.request({ method: "GET", path: "/slow" })).rejects.toThrow("Request timed out");
  });
});

describe("parseRetryAfter", () => {
  test("seconds, dates and junk", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
