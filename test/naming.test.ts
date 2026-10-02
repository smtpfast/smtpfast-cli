import { describe, expect, test } from "bun:test";
import { buildManifest } from "../src/spec/build.js";
import { groupFor, kebab, nameOperation, splitWords, synthesizeOperationId } from "../src/spec/naming.js";
import { fixtureSpec } from "./helpers.js";

// The full command table for the fixture spec. A change here is a visible
// change to the CLI, so it should be on purpose.
const EXPECTED: Record<string, string> = {
  getCapabilities: "account capabilities",
  getUsage: "account usage",
  getAnalytics: "analytics get",
  createApiKey: "api-keys create",
  listApiKeys: "api-keys list",
  revokeApiKey: "api-keys revoke",
  updateApiKey: "api-keys update",
  cancelBroadcast: "broadcasts cancel",
  listBroadcastClickedLinks: "broadcasts clicked-links",
  createBroadcast: "broadcasts create",
  deleteBroadcast: "broadcasts delete",
  duplicateBroadcast: "broadcasts duplicate",
  getBroadcast: "broadcasts get",
  listBroadcasts: "broadcasts list",
  sendBroadcast: "broadcasts send",
  sendBroadcastTest: "broadcasts send-test",
  updateBroadcast: "broadcasts update",
  createContactProperty: "contact-properties create",
  deleteContactProperty: "contact-properties delete",
  getContactProperty: "contact-properties get",
  listContactProperties: "contact-properties list",
  updateContactProperty: "contact-properties update",
  createContact: "contacts create",
  deleteContact: "contacts delete",
  exportContacts: "contacts export",
  getContact: "contacts get",
  listContacts: "contacts list",
  updateContact: "contacts update",
  addDomain: "domains add",
  claimDomain: "domains claim",
  getDomainClaimRecord: "domains claim-record",
  getDomain: "domains get",
  listDomains: "domains list",
  updateDomainReceiving: "domains update-receiving",
  verifyDomain: "domains verify",
  cancelEmail: "emails cancel",
  getEmail: "emails get",
  listEmails: "emails list",
  sendEmail: "emails send",
  sendEmailBatch: "emails send-batch",
  shareEmail: "emails share",
  updateEmail: "emails update",
  approveAllPendingSignups: "forms approve-all-pending",
  approvePendingSignup: "forms approve-pending",
  createSignupForm: "forms create",
  deleteSignupForm: "forms delete",
  getSignupForm: "forms get",
  listSignupForms: "forms list",
  listPendingSignups: "forms pending",
  removePendingSignup: "forms remove-pending",
  updateSignupForm: "forms update",
  listLogs: "logs list",
  listReceivedEmailAttachments: "received attachments",
  deleteReceivedEmail: "received delete",
  getReceivedEmail: "received get",
  getReceivedEmailAttachment: "received get-attachment",
  listReceivedEmails: "received list",
  replyToReceivedEmail: "received reply",
  listSegmentContacts: "segments contacts",
  createSegment: "segments create",
  deleteSegment: "segments delete",
  getSegment: "segments get",
  listSegments: "segments list",
  updateSegment: "segments update",
  createSuppression: "suppressions create",
  deleteSuppression: "suppressions delete",
  getSuppression: "suppressions get",
  listSuppressions: "suppressions list",
  createWebhook: "webhooks create",
  deleteWebhook: "webhooks delete",
  listWebhookDeliveries: "webhooks deliveries",
  getWebhook: "webhooks get",
  getWebhookDelivery: "webhooks get-delivery",
  listWebhooks: "webhooks list",
  updateWebhook: "webhooks replace",
  retryWebhookDelivery: "webhooks retry-delivery",
  testWebhook: "webhooks test",
  patchWebhook: "webhooks update",
};

describe("command naming", () => {
  const { manifest, warnings } = buildManifest(fixtureSpec());

  test("every operation in the fixture gets a command", () => {
    const spec = fixtureSpec();
    let count = 0;
    for (const item of Object.values<Record<string, unknown>>(spec.paths)) {
      count += Object.keys(item).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)).length;
    }
    expect(manifest.operations.length).toBe(count);
    expect(count).toBe(78);
  });

  test("names match the expected table", () => {
    const actual = Object.fromEntries(manifest.operations.map((o) => [o.operationId, `${o.group} ${o.command}`]));
    expect(actual).toEqual(EXPECTED);
  });

  test("every command name is unique", () => {
    const names = manifest.operations.map((o) => `${o.group} ${o.command}`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the rules name every fixture operation without falling back", () => {
    expect(warnings).toEqual([]);
  });

  test("the examples from the design brief", () => {
    const usage = (id: string) => {
      const op = manifest.operations.find((o) => o.operationId === id)!;
      return [op.group, op.command, ...op.pathParams.map((p) => `<${p.name}>`)].join(" ");
    };
    expect(usage("listEmails")).toBe("emails list");
    expect(usage("getEmail")).toBe("emails get <id>");
    expect(usage("sendEmail")).toBe("emails send");
    expect(usage("sendEmailBatch")).toBe("emails send-batch");
    expect(usage("listReceivedEmails")).toBe("received list");
    expect(usage("replyToReceivedEmail")).toBe("received reply <id>");
    expect(usage("getDomainClaimRecord")).toBe("domains claim-record");
    expect(usage("listWebhookDeliveries")).toBe("webhooks deliveries <id>");
    expect(usage("retryWebhookDelivery")).toBe("webhooks retry-delivery <id> <delivery_id>");
    expect(usage("approvePendingSignup")).toBe("forms approve-pending <id> <pendingId>");
  });
});

describe("naming helpers", () => {
  test("splitWords and kebab handle camelCase, snake_case and acronyms", () => {
    expect(splitWords("listAPIKeys")).toEqual(["list", "api", "keys"]);
    expect(kebab("first_name")).toBe("first-name");
    expect(kebab("firstName")).toBe("first-name");
    expect(kebab("Idempotency-Key")).toBe("idempotency-key");
  });

  test("groups come from the first path segment, with aliases", () => {
    expect(groupFor("/v1/emails/{id}").group).toBe("emails");
    expect(groupFor("/v1/emails/receiving/{id}/reply").group).toBe("received");
    expect(groupFor("/v1/contact-properties").group).toBe("contact-properties");
    expect(groupFor("/v1/me").group).toBe("account");
    expect(groupFor("/v2/things").group).toBe("things");
  });

  test("a group that clashes with a top-level command is renamed", () => {
    expect(nameOperation("listProfiles", "GET", "/v1/profiles")).toEqual({ group: "profiles-api", command: "list", overridden: false });
  });

  test("operations without an operationId get one from the method and path", () => {
    expect(synthesizeOperationId("POST", "/v1/domains/{id}/verify")).toBe("verify");
    expect(synthesizeOperationId("GET", "/v1/webhooks/{id}/deliveries")).toBe("listDeliveries");
    expect(synthesizeOperationId("GET", "/v1/widgets/{id}")).toBe("get");
    expect(synthesizeOperationId("POST", "/v1/forms/{id}/pending/approve-all")).toBe("approveAllPending");
    expect(nameOperation(synthesizeOperationId("GET", "/v1/webhooks/{id}/deliveries"), "GET", "/v1/webhooks/{id}/deliveries").command).toBe("deliveries");
  });

  test("new operations follow the same rules", () => {
    expect(nameOperation("archiveEmail", "POST", "/v1/emails/{id}/archive").command).toBe("archive");
    expect(nameOperation("getEmailStats", "GET", "/v1/emails/stats").command).toBe("stats");
    expect(nameOperation("listContactSegments", "GET", "/v1/contacts/{id}/segments").command).toBe("segments");
  });
});
