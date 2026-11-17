import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { API_ERROR_CODES } from "@/lib/api/errors";
import { EXAMPLE_BODIES, EXAMPLE_RESPONSES, EXAMPLE_WEBHOOKS, VERIFY_NODE, VERIFY_PYTHON } from "@/lib/api/examples";
import { validate } from "@/lib/api/http";
import { CreateFileBody, SendBody, UpdateFileBody, VoidBody } from "@/lib/api/schemas";
import { WEBHOOK_EVENTS, signWebhookPayload, verifyWebhookSignature } from "@/lib/services/webhooks";

/*
 * The reference page at /docs/api prints these examples. Response shapes are compared
 * with live responses in api-routes.test.ts; this file checks the rest: that the request
 * bodies shown are accepted, and that the signature code shown really verifies a
 * signature made by the code that sends webhooks.
 */

describe("documented request bodies", () => {
  it("are accepted by the same schemas the routes use", () => {
    expect(() => validate(CreateFileBody, EXAMPLE_BODIES.createFile, "body")).not.toThrow();
    expect(() => validate(CreateFileBody, EXAMPLE_BODIES.quickStart, "body")).not.toThrow();
    expect(() => validate(UpdateFileBody, EXAMPLE_BODIES.updateFile, "body")).not.toThrow();
    expect(() => validate(SendBody, EXAMPLE_BODIES.send, "body")).not.toThrow();
    expect(() => validate(SendBody, EXAMPLE_BODIES.resend, "body")).not.toThrow();
    expect(() => validate(VoidBody, EXAMPLE_BODIES.voidEnvelope, "body")).not.toThrow();
  });

  it("show no internal columns and only made-up people", () => {
    const text = JSON.stringify([EXAMPLE_RESPONSES, EXAMPLE_WEBHOOKS]);
    expect(text).not.toMatch(/token|hash"|pdfBlob|blob_|orgId|org_id"|createdBy|password/i);
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(email).toMatch(/\.example(\.com)?$|@example\.com$/);
  });

  it("use a webhook event and error codes that exist", () => {
    expect(WEBHOOK_EVENTS).toContain(EXAMPLE_WEBHOOKS.completed.event);
    expect(WEBHOOK_EVENTS).toContain(EXAMPLE_WEBHOOKS.fileCreated.event);
    for (const [code, { status }] of Object.entries(API_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("documented webhook verification", () => {
  const secret = "whsec_test_0123456789abcdef";
  const body = JSON.stringify(EXAMPLE_WEBHOOKS.completed);
  const now = Math.floor(Date.now() / 1000);
  const good = signWebhookPayload(secret, body, now);
  const stale = signWebhookPayload(secret, body, now - 3600);

  it("the header used here is one the service itself accepts", () => {
    expect(verifyWebhookSignature(secret, good, body)).toBe(true);
  });

  it("the Node example accepts a real signature and rejects a wrong secret, a changed body and an old timestamp", () => {
    const verify = new Function("require", `${VERIFY_NODE}\nreturn verifySigngateWebhook;`)(createRequire(import.meta.url)) as (secret: string, header: string, raw: string) => boolean;
    expect(verify(secret, good, body)).toBe(true);
    expect(verify("another-secret", good, body)).toBe(false);
    expect(verify(secret, good, `${body} `)).toBe(false);
    expect(verify(secret, stale, body)).toBe(false);
    expect(verify(secret, "nonsense", body)).toBe(false);
    expect(verify(secret, `t=${now},v1=abcd`, body)).toBe(false);
  });

  const python = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!python)("the Python example does the same", () => {
    const script = `${VERIFY_PYTHON}

import json, sys
secret, good, stale, body = json.loads(sys.stdin.read())
raw = body.encode()
print(json.dumps([
    verify_signgate_webhook(secret, good, raw),
    verify_signgate_webhook("another-secret", good, raw),
    verify_signgate_webhook(secret, good, raw + b" "),
    verify_signgate_webhook(secret, stale, raw),
    verify_signgate_webhook(secret, "nonsense", raw),
]))
`;
    const run = spawnSync("python3", ["-I", "-c", script], { input: JSON.stringify([secret, good, stale, body]), encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([true, false, false, false, false]);
  });
});
