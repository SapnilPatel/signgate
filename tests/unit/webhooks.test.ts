import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, users, webhooks, webhookDeliveries } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { systemActor, type Actor } from "@/lib/services/context";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  setWebhookActive,
  listDeliveries,
  enqueueWebhookEvent,
  deliverPendingWebhooks,
  sendTestEvent,
  verifyWebhookSignature,
  signWebhookPayload,
  checkWebhookUrl,
  isBlockedAddress,
  webhookRetryDelayMs,
  pruneWebhookDeliveries,
  countDeliveriesByStatus,
  WEBHOOK_MAX_ATTEMPTS,
  MAX_WEBHOOKS_PER_ORG,
  type WebhookRequest,
  type WebhookResolver,
} from "@/lib/services/webhooks";

async function makeOrg(): Promise<string> {
  const db = await getDb();
  const id = newId("org");
  await db.insert(orgs).values({ id, name: "Test Co", slug: id });
  // Permissions are read from the stored user row, so each org gets one real user per role.
  await db.insert(users).values(
    ROLES.map((role) => ({ id: userIdFor(id, role), orgId: id, email: `${role}-${id}@example.com`, name: "Sam Lee", passwordHash: "x", role })),
  );
  return id;
}

const ROLES = ["owner", "admin", "member"] as const;
const userIdFor = (orgId: string, role: (typeof ROLES)[number] = "owner") => `usr_${role}_${orgId.slice(4)}`;

const actorFor = (orgId: string, role: "owner" | "admin" | "member" = "owner"): Actor => ({
  type: "user",
  orgId,
  userId: userIdFor(orgId, role),
  role,
  label: "Sam Lee",
});

const PUBLIC_IP = "93.184.216.34";
/** DNS stand-in: every name is public unless listed. Tests never touch the network. */
const resolverWith =
  (table: Record<string, string[]> = {}): WebhookResolver =>
  async (hostname) => {
    if (hostname in table) return table[hostname];
    if (hostname.endsWith(".invalid")) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [PUBLIC_IP];
  };

/** Production rules (https only, no localhost) with fake DNS. */
const prod = (table?: Record<string, string[]>) => ({ production: true, resolver: resolverWith(table) });

function recorder(respond: (req: WebhookRequest, n: number) => number | Promise<number> = () => 200) {
  const requests: WebhookRequest[] = [];
  const send = async (req: WebhookRequest) => {
    requests.push(req);
    return { status: await respond(req, requests.length) };
  };
  return { requests, send };
}

/** Deliveries are queued with the real clock, so a simulated clock has to start just after it. */
const clockStart = () => new Date(Math.ceil(Date.now() / 1000) * 1000 + 5000);

async function deliveriesFor(orgId: string) {
  const db = await getDb();
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
}

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, metadata and reserved ranges", () => {
    const blockedAddrs = [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "169.254.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "[::1]",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "not an ip",
      "",
      "999.1.1.1",
    ];
    for (const address of blockedAddrs) expect(isBlockedAddress(address), address).toBe(true);
    expect(isBlockedAddress(undefined as never)).toBe(true);
  });

  it("allows public addresses", () => {
    for (const address of [PUBLIC_IP, "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("checkWebhookUrl", () => {
  it("accepts a public https URL and normalizes it", async () => {
    const checked = await checkWebhookUrl("  https://Hooks.Example.com/in?x=1#frag ", prod());
    expect(checked).toEqual({ url: "https://hooks.example.com/in?x=1", addresses: [PUBLIC_IP] });
  });

  it("refuses private, loopback, link-local and metadata targets in every spelling", async () => {
    const urls = [
      "https://127.0.0.1/hook",
      "https://127.1/hook",
      "https://2130706433/hook", // decimal 127.0.0.1
      "https://0x7f.0.0.1/hook",
      "https://0177.0.0.1/hook", // octal
      "https://10.1.2.3/hook",
      "https://192.168.0.10:8443/hook",
      "https://172.20.0.1/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fe80::1]/hook",
      "https://[fd00:ec2::254]/hook",
      "https://0.0.0.0/hook",
      "https://localhost/hook",
      "https://LOCALHOST./hook",
      "https://api.localhost/hook",
    ];
    for (const url of urls) {
      await expect(checkWebhookUrl(url, prod()), url).rejects.toMatchObject({
        name: "ServiceError",
        code: "invalid",
        message: expect.stringContaining("private or internal"),
      });
    }
  });

  it("refuses a public-looking hostname that resolves to a private address", async () => {
    const table = {
      "rebind.example.com": ["10.0.0.5"],
      "metadata.example.com": ["169.254.169.254"],
      "v6.example.com": ["::1"],
      "mixed.example.com": [PUBLIC_IP, "192.168.1.1"], // one bad address is enough
      "garbage.example.com": ["definitely-not-an-ip"],
    };
    for (const host of Object.keys(table)) {
      await expect(checkWebhookUrl(`https://${host}/hook`, prod(table)), host).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("refuses hostnames that do not resolve, and survives a resolver that misbehaves", async () => {
    await expect(checkWebhookUrl("https://nowhere.invalid/hook", prod())).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("could not be found"),
    });
    await expect(checkWebhookUrl("https://empty.example.com/", prod({ "empty.example.com": [] }))).rejects.toMatchObject({ code: "invalid" });
    await expect(
      checkWebhookUrl("https://weird.example.com/", { production: true, resolver: (async () => null) as never }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("requires https in production and rejects credentials, other schemes and junk", async () => {
    const bad = [
      "http://hooks.example.com/in",
      "ftp://hooks.example.com/in",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gopher://hooks.example.com",
      "https://user:pass@hooks.example.com/in",
      "hooks.example.com/in",
      "https://",
      "",
      "   ",
      "not a url",
      `https://hooks.example.com/${"a".repeat(3000)}`,
    ];
    for (const url of bad) await expect(checkWebhookUrl(url, prod()), url).rejects.toMatchObject({ code: "invalid" });
    for (const notString of [null, undefined, 42, {}, []]) {
      await expect(checkWebhookUrl(notString as never, prod())).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("allows http and localhost only outside production", async () => {
    const dev = { production: false, resolver: resolverWith() };
    expect(await checkWebhookUrl("http://localhost:4000/hook", dev)).toEqual({ url: "http://localhost:4000/hook", addresses: [] });
    expect((await checkWebhookUrl("http://127.0.0.1:4000/hook", dev)).addresses).toEqual([]);
    expect((await checkWebhookUrl("http://[::1]:4000/hook", dev)).addresses).toEqual([]);
    // Plain http to anything else, and other private addresses, stay blocked in development too.
    await expect(checkWebhookUrl("http://hooks.example.com/in", dev)).rejects.toMatchObject({ code: "invalid" });
    await expect(checkWebhookUrl("https://10.0.0.1/in", dev)).rejects.toMatchObject({ code: "invalid" });
    await expect(checkWebhookUrl("http://169.254.169.254/", dev)).rejects.toMatchObject({ code: "invalid" });
    await expect(checkWebhookUrl("http://localhost:4000/hook", prod())).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("signatures", () => {
  const secret = "whsec_testsecret";
  const body = '{"id":"whd_1","event":"agreement.signed"}';
  const at = new Date("2026-03-01T10:00:00Z");
  const t = Math.floor(at.getTime() / 1000);

  it("verifies a signature it produced", () => {
    const header = signWebhookPayload(secret, body, t);
    expect(header).toMatch(new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
    expect(verifyWebhookSignature(secret, header, body, { now: at })).toBe(true);
    expect(verifyWebhookSignature(secret, ` ${header.replace(",", " , ")} `, body, { now: at })).toBe(true);
  });

  it("rejects a changed body, secret, timestamp or signature", () => {
    const header = signWebhookPayload(secret, body, t);
    expect(verifyWebhookSignature(secret, header, `${body} `, { now: at })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", header, body, { now: at })).toBe(false);
    expect(verifyWebhookSignature(secret, header.replace(`t=${t}`, `t=${t + 1}`), body, { now: at })).toBe(false);
    const flipped = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
    expect(verifyWebhookSignature(secret, flipped, body, { now: at })).toBe(false);
  });

  it("rejects replays outside the tolerance window", () => {
    const header = signWebhookPayload(secret, body, t);
    expect(verifyWebhookSignature(secret, header, body, { now: new Date(at.getTime() + 299_000) })).toBe(true);
    expect(verifyWebhookSignature(secret, header, body, { now: new Date(at.getTime() + 301_000) })).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, { now: new Date(at.getTime() - 301_000) })).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, { now: new Date(at.getTime() + 86_400_000), toleranceSeconds: 0 })).toBe(true);
  });

  it("accepts any matching v1 during secret rotation and ignores unknown schemes", () => {
    const good = signWebhookPayload(secret, body, t).split(",")[1];
    expect(verifyWebhookSignature(secret, `t=${t},v1=${"0".repeat(64)},${good},v0=abc`, body, { now: at })).toBe(true);
  });

  it("returns false, never throws, for malformed input", () => {
    const junk = [null, undefined, "", "garbage", "t=,v1=", `t=${t}`, `v1=${"a".repeat(64)}`, `t=${t},v1=zz`, `t=${t},v1=${"a".repeat(63)}`, "t=abc,v1=abc", ",,,==,", "x".repeat(5000)];
    for (const header of junk) expect(verifyWebhookSignature(secret, header, body, { now: at })).toBe(false);
    expect(verifyWebhookSignature("", signWebhookPayload("", body, t), body, { now: at })).toBe(false);
    expect(verifyWebhookSignature(secret, 42 as never, body)).toBe(false);
    expect(verifyWebhookSignature(secret, signWebhookPayload(secret, body, t), null as never, { now: at })).toBe(false);
  });
});

describe("managing webhooks", () => {
  it("creates a webhook with a secret that list views never return", async () => {
    const orgId = await makeOrg();
    const hook = await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    expect(hook).toMatchObject({ orgId, url: "https://hooks.example.com/in", active: true });
    expect(hook.secret).toMatch(/^whsec_[0-9a-z]{32}$/);
    const listed = await listWebhooks(actorFor(orgId));
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(listed)).not.toContain(hook.secret);
  });

  it("does not save an unsafe URL", async () => {
    const orgId = await makeOrg();
    await expect(createWebhook(actorFor(orgId), "https://169.254.169.254/latest", prod())).rejects.toMatchObject({ code: "invalid" });
    await expect(createWebhook(actorFor(orgId), "https://internal.example.com/x", prod({ "internal.example.com": ["10.0.0.9"] }))).rejects.toMatchObject({
      code: "invalid",
      fields: { url: expect.any(String) },
    });
    expect(await listWebhooks(actorFor(orgId))).toEqual([]);
  });

  it("is manager-only for every change", async () => {
    const orgId = await makeOrg();
    const hook = await createWebhook(actorFor(orgId, "admin"), "https://hooks.example.com/in", prod());
    const member = actorFor(orgId, "member");
    await expect(createWebhook(member, "https://other.example.com/in", prod())).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWebhook(systemActor(orgId), "https://other.example.com/in", prod())).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteWebhook(member, hook.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(setWebhookActive(member, hook.id, false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendTestEvent(member, hook.id, prod())).rejects.toMatchObject({ code: "forbidden" });
    expect(await listWebhooks(member)).toHaveLength(1);
  });

  it("rejects duplicates and caps webhooks per org", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    await createWebhook(actor, "https://hooks.example.com/in", prod());
    await expect(createWebhook(actor, "https://HOOKS.example.com/in#x", prod())).rejects.toMatchObject({ code: "conflict" });
    for (let i = 1; i < MAX_WEBHOOKS_PER_ORG; i++) await createWebhook(actor, `https://hooks.example.com/in/${i}`, prod());
    await expect(createWebhook(actor, "https://hooks.example.com/one-too-many", prod())).rejects.toMatchObject({ code: "conflict" });
  });

  it("isolates tenants", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const hookA = await createWebhook(actorFor(a), "https://a.example.com/in", prod());
    await createWebhook(actorFor(b), "https://b.example.com/in", prod());
    const db = await getDb();
    await enqueueWebhookEvent(db, a, "file.created", { reference: "F-1" });

    expect((await listWebhooks(actorFor(b))).map((w) => w.url)).toEqual(["https://b.example.com/in"]);
    expect(await listDeliveries(actorFor(b))).toEqual([]);
    expect(await listDeliveries(actorFor(b), { webhookId: hookA.id })).toEqual([]);
    expect(await listDeliveries(actorFor(a))).toHaveLength(1);
    expect(await countDeliveriesByStatus(actorFor(b))).toEqual({ pending: 0, delivered: 0, failed: 0 });

    await expect(deleteWebhook(actorFor(b), hookA.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setWebhookActive(actorFor(b), hookA.id, false)).rejects.toMatchObject({ code: "not_found" });
    await expect(sendTestEvent(actorFor(b), hookA.id, prod())).rejects.toMatchObject({ code: "not_found" });
    expect((await listWebhooks(actorFor(a)))[0].active).toBe(true);

    // Delivering for org B must not send org A's event.
    const { requests, send } = recorder();
    expect(await deliverPendingWebhooks({ orgId: b, send, ...prod() })).toEqual({ delivered: 0, failed: 0 });
    expect(requests).toHaveLength(0);
    // Clean up so later global delivery runs in this file start from an empty queue.
    await deliverPendingWebhooks({ send, ...prod() });
  });

  it("deletes a webhook together with its deliveries", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const hook = await createWebhook(actor, "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(await getDb(), orgId, "file.created", {});
    await deleteWebhook(actor, hook.id);
    expect(await listWebhooks(actor)).toEqual([]);
    expect(await deliveriesFor(orgId)).toEqual([]);
    await expect(deleteWebhook(actor, hook.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteWebhook(actor, null as never)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("enqueueWebhookEvent", () => {
  it("queues one delivery per active webhook and none for paused ones", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const one = await createWebhook(actor, "https://one.example.com/in", prod());
    const two = await createWebhook(actor, "https://two.example.com/in", prod());
    const paused = await createWebhook(actor, "https://paused.example.com/in", prod());
    await setWebhookActive(actor, paused.id, false);

    await enqueueWebhookEvent(db, orgId, "agreement.sent", { file: { reference: "F-1" } });
    const rows = await deliveriesFor(orgId);
    expect(rows.map((r) => r.webhookId).sort()).toEqual([one.id, two.id].sort());
    expect(rows.every((r) => r.status === "pending" && r.attempts === 0 && r.event === "agreement.sent")).toBe(true);
    await deliverPendingWebhooks({ send: recorder().send, ...prod() });
  });

  it("does nothing when the org has no webhooks", async () => {
    const orgId = await makeOrg();
    await enqueueWebhookEvent(await getDb(), orgId, "file.created", { a: 1 });
    expect(await deliveriesFor(orgId)).toEqual([]);
  });

  it("is rolled back with the business transaction", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await expect(
      db.transaction(async (tx) => {
        await enqueueWebhookEvent(tx, orgId, "agreement.signed", {});
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await deliveriesFor(orgId)).toEqual([]);
  });

  it("accepts payloads and event names that are not clean JSON or header-safe", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    const circular: Record<string, unknown> = { note: "nul\u0000byte" };
    circular.self = circular;
    await enqueueWebhookEvent(db, orgId, "agreement.signed\r\nX-Injected: 1", circular);
    await enqueueWebhookEvent(db, orgId, "", null as never);
    const { requests, send } = recorder();
    expect(await deliverPendingWebhooks({ orgId, send, ...prod() })).toEqual({ delivered: 2, failed: 0 });
    const events = requests.map((r) => r.headers["x-signgate-event"]).sort();
    expect(events).toEqual(["agreement.signedX-Injected:1", "unknown"]);
    const body = JSON.parse(requests.find((r) => r.headers["x-signgate-event"] !== "unknown")!.body);
    expect(body.data).toEqual({ note: "nulbyte", self: null });
  });
});

describe("deliverPendingWebhooks", () => {
  it("POSTs a signed JSON envelope and marks the delivery delivered", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const hook = await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.completed", { file: { reference: "F-2026-0001" }, signed: true });

    const now = clockStart();
    const { requests, send } = recorder(() => 204);
    const result = await deliverPendingWebhooks({ orgId, send, now: () => now, ...prod() });
    expect(result).toEqual({ delivered: 1, failed: 0 });

    expect(requests).toHaveLength(1);
    const req = requests[0];
    const [row] = await deliveriesFor(orgId);
    expect(req.url).toBe("https://hooks.example.com/in");
    expect(req.addresses).toEqual([PUBLIC_IP]);
    expect(req.timeoutMs).toBe(8000);
    expect(req.headers).toMatchObject({
      "content-type": "application/json",
      "x-signgate-event": "agreement.completed",
      "x-signgate-delivery": row.id,
    });
    expect(JSON.parse(req.body)).toEqual({
      id: row.id,
      event: "agreement.completed",
      created_at: row.createdAt.toISOString(),
      data: { file: { reference: "F-2026-0001" }, signed: true },
    });
    expect(verifyWebhookSignature(hook.secret, req.headers["x-signgate-signature"], req.body, { now })).toBe(true);
    expect(verifyWebhookSignature("whsec_wrong", req.headers["x-signgate-signature"], req.body, { now })).toBe(false);

    expect(row).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 204, error: null, nextAttemptAt: null });
    // Nothing left to send.
    expect(await deliverPendingWebhooks({ orgId, send, now: () => now, ...prod() })).toEqual({ delivered: 0, failed: 0 });
    expect(requests).toHaveLength(1);
  });

  it("retries failures with exponential backoff and gives up after six attempts", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});

    let now = clockStart();
    const { requests, send } = recorder(() => 500);
    const run = () => deliverPendingWebhooks({ orgId, send, now: () => now, ...prod() });
    const minutes = [1, 4, 16, 64, 256];

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      expect(await run()).toEqual({ delivered: 0, failed: 1 });
      const [row] = await deliveriesFor(orgId);
      expect(row.attempts).toBe(attempt);
      expect(row.responseStatus).toBe(500);
      expect(row.error).toContain("HTTP 500");
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        const wait = minutes[attempt - 1] * 60_000;
        expect(webhookRetryDelayMs(attempt)).toBe(wait);
        expect(row.status).toBe("pending");
        expect(row.nextAttemptAt).toEqual(new Date(now.getTime() + wait));
        // One second early: not due, nothing is sent.
        now = new Date(now.getTime() + wait - 1000);
        expect(await run()).toEqual({ delivered: 0, failed: 0 });
        now = new Date(now.getTime() + 1000);
      } else {
        expect(row).toMatchObject({ status: "failed", nextAttemptAt: null });
      }
    }
    expect(requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    now = new Date(now.getTime() + 365 * 86_400_000);
    expect(await run()).toEqual({ delivered: 0, failed: 0 });
    expect(requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(await countDeliveriesByStatus(actorFor(orgId))).toEqual({ pending: 0, delivered: 0, failed: 1 });
  });

  it("recovers on a later attempt", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});
    let now = clockStart();
    const { send } = recorder((_req, n) => (n === 1 ? 503 : 200));
    expect(await deliverPendingWebhooks({ orgId, send, now: () => now, ...prod() })).toEqual({ delivered: 0, failed: 1 });
    now = new Date(now.getTime() + 60_000);
    expect(await deliverPendingWebhooks({ orgId, send, now: () => now, ...prod() })).toEqual({ delivered: 1, failed: 0 });
    expect((await deliveriesFor(orgId))[0]).toMatchObject({ status: "delivered", attempts: 2, responseStatus: 200, error: null });
  });

  it("treats redirects, odd statuses, thrown errors and timeouts as failures without throwing", async () => {
    const db = await getDb();
    const cases: Array<[() => Promise<{ status: number }>, RegExp, number | null]> = [
      [async () => ({ status: 302 }), /redirect/i, 302],
      [async () => ({ status: 199 }), /HTTP 199/, 199],
      [async () => ({ status: Number.NaN }), /no valid response/, null],
      [async () => undefined as never, /no valid response/, null],
      [async () => Promise.reject(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })), /ECONNREFUSED/, null],
      [async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), /did not respond within 8 seconds/, null],
      [async () => Promise.reject(Object.assign(new Error("c"), { code: "CERT_HAS_EXPIRED" })), /certificate/, null],
      [async () => Promise.reject("just a string"), /request failed/i, null],
      [
        () => {
          throw new Error("sync throw");
        },
        /sync throw/,
        null,
      ],
    ];
    for (const [send, message, status] of cases) {
      const orgId = await makeOrg();
      await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
      await enqueueWebhookEvent(db, orgId, "agreement.signed", {});
      expect(await deliverPendingWebhooks({ orgId, send, ...prod() })).toEqual({ delivered: 0, failed: 1 });
      const [row] = await deliveriesFor(orgId);
      expect(row.status).toBe("pending");
      expect(row.error).toMatch(message);
      expect(row.responseStatus).toBe(status);
      await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
    }
  });

  it("re-checks DNS before each delivery and never calls an address that turned private", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://rebind.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});

    // The name was public when saved; now it points at the metadata service.
    const { requests, send } = recorder();
    const result = await deliverPendingWebhooks({ orgId, send, ...prod({ "rebind.example.com": ["169.254.169.254"] }) });
    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(requests).toHaveLength(0);
    const [row] = await deliveriesFor(orgId);
    expect(row.status).toBe("pending");
    expect(row.error).toContain("private or internal");
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
  });

  it("refuses a stored URL that is unsafe even if it bypassed validation when saved", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await db.insert(webhooks).values({ id: newId("whk"), orgId, url: "http://127.0.0.1:9/admin", secret: "whsec_x" });
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});
    const { requests, send } = recorder();
    expect(await deliverPendingWebhooks({ orgId, send, ...prod() })).toEqual({ delivered: 0, failed: 1 });
    expect(requests).toHaveLength(0);
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
  });

  it("claims each delivery exactly once when runners overlap", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    for (let i = 0; i < 12; i++) await enqueueWebhookEvent(db, orgId, "file.created", { i });

    const seen: string[] = [];
    const send = async (req: WebhookRequest) => {
      seen.push(req.headers["x-signgate-delivery"]);
      // Stay in flight long enough for the other runners to look for work.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200 };
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => deliverPendingWebhooks({ orgId, send, limit: 5, ...prod() })));

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(12);
    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(12);
    const rows = await deliveriesFor(orgId);
    expect(rows.every((r) => r.status === "delivered" && r.attempts === 1)).toBe(true);
  });

  it("does not resend a delivery another runner is still sending, but picks it up if that runner dies", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});
    const start = clockStart();

    // Runner one claims the row and then hangs forever (a crashed function).
    let release: (v: { status: number }) => void = () => {};
    const hung = deliverPendingWebhooks({ orgId, send: () => new Promise((resolve) => (release = resolve)), now: () => start, ...prod() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = recorder();
    expect(await deliverPendingWebhooks({ orgId, send: second.send, now: () => new Date(start.getTime() + 60_000), ...prod() })).toEqual({ delivered: 0, failed: 0 });
    expect(second.requests).toHaveLength(0);

    // After the lease has run out the delivery is taken over.
    const later = new Date(start.getTime() + 6 * 60_000);
    expect(await deliverPendingWebhooks({ orgId, send: second.send, now: () => later, ...prod() })).toEqual({ delivered: 1, failed: 0 });
    expect((await deliveriesFor(orgId))[0]).toMatchObject({ status: "delivered", attempts: 2 });

    // The first runner finally reports a failure; it must not undo the recorded success.
    release({ status: 500 });
    await hung;
    expect((await deliveriesFor(orgId))[0]).toMatchObject({ status: "delivered", attempts: 2, responseStatus: 200 });
  });

  it("closes deliveries for a webhook that was paused after the event was queued", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const hook = await createWebhook(actor, "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "agreement.signed", {});
    await setWebhookActive(actor, hook.id, false);
    const { requests, send } = recorder();
    expect(await deliverPendingWebhooks({ orgId, send, ...prod() })).toEqual({ delivered: 0, failed: 1 });
    expect(requests).toHaveLength(0);
    expect((await deliveriesFor(orgId))[0]).toMatchObject({ status: "failed", nextAttemptAt: null });
  });

  it("honours the limit and tolerates nonsense options", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    for (let i = 0; i < 5; i++) await enqueueWebhookEvent(db, orgId, "file.created", { i });
    const { send } = recorder();
    expect(await deliverPendingWebhooks({ orgId, send, limit: 2, ...prod() })).toEqual({ delivered: 2, failed: 0 });
    expect(await deliverPendingWebhooks({ orgId, send, limit: -1, ...prod() })).toEqual({ delivered: 3, failed: 0 });
    expect(await deliverPendingWebhooks({ orgId, send, limit: Number.NaN, ...prod() })).toEqual({ delivered: 0, failed: 0 });
  });
});

describe("real HTTP delivery (loopback server, development rules)", () => {
  async function withServer(handler: http.RequestListener, run: (url: string) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("sends a verifiable request over the wire", async () => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string; method?: string }> = [];
    await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          received.push({ headers: req.headers, body, method: req.method });
          res.writeHead(200).end("ok");
        });
      },
      async (base) => {
        const orgId = await makeOrg();
        const hook = await createWebhook(actorFor(orgId), `${base}/hook`, { production: false });
        await enqueueWebhookEvent(await getDb(), orgId, "agreement.signed", { client: "Jane Doe (test)", note: "ünïcode ✓" });
        expect(await deliverPendingWebhooks({ orgId, production: false })).toEqual({ delivered: 1, failed: 0 });
        expect(received).toHaveLength(1);
        const got = received[0];
        expect(got.method).toBe("POST");
        expect(got.headers["content-type"]).toBe("application/json");
        expect(got.headers["x-signgate-event"]).toBe("agreement.signed");
        expect(Number(got.headers["content-length"])).toBe(Buffer.byteLength(got.body));
        expect(verifyWebhookSignature(hook.secret, got.headers["x-signgate-signature"] as string, got.body)).toBe(true);
        expect(JSON.parse(got.body).data).toEqual({ client: "Jane Doe (test)", note: "ünïcode ✓" });
      },
    );
  });

  it("does not follow a redirect", async () => {
    let hits = 0;
    let followed = 0;
    await withServer(
      (req, res) => {
        if (req.url === "/internal") {
          followed++;
          res.writeHead(200).end();
          return;
        }
        hits++;
        res.writeHead(307, { location: "/internal" }).end();
      },
      async (base) => {
        const orgId = await makeOrg();
        const hook = await createWebhook(actorFor(orgId), `${base}/hook`, { production: false });
        const result = await sendTestEvent(actorFor(orgId), hook.id, { production: false });
        expect(result).toMatchObject({ ok: false, status: 307 });
        expect(result.error).toMatch(/redirect/i);
        expect(hits).toBe(1);
        expect(followed).toBe(0);
      },
    );
  });

  it("reports a refused connection as a failed delivery", async () => {
    let base = "";
    await withServer(
      () => {},
      async (url) => {
        base = url;
      },
    );
    // The server is closed now, so the port refuses connections.
    const orgId = await makeOrg();
    const hook = await createWebhook(actorFor(orgId), `${base}/hook`, { production: false });
    const result = await sendTestEvent(actorFor(orgId), hook.id, { production: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not connect/);
  });
});

describe("sendTestEvent", () => {
  it("sends once, records the delivery and never retries a failure", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const hook = await createWebhook(actor, "https://hooks.example.com/in", prod());

    const ok = recorder();
    const good = await sendTestEvent(actor, hook.id, { send: ok.send, ...prod() });
    expect(good).toMatchObject({ ok: true, status: 200, error: null });
    expect(ok.requests[0].headers["x-signgate-event"]).toBe("webhook.test");
    expect(verifyWebhookSignature(hook.secret, ok.requests[0].headers["x-signgate-signature"], ok.requests[0].body)).toBe(true);

    const bad = await sendTestEvent(actor, hook.id, { send: recorder(() => 500).send, ...prod() });
    expect(bad).toMatchObject({ ok: false, status: 500 });
    const rows = await listDeliveries(actor, { webhookId: hook.id });
    expect(rows.map((r) => r.status).sort()).toEqual(["delivered", "failed"]);
    expect(rows.every((r) => r.event === "webhook.test" && r.nextAttemptAt === null)).toBe(true);

    const later = recorder();
    await deliverPendingWebhooks({ orgId, send: later.send, now: () => new Date(Date.now() + 365 * 86_400_000), ...prod() });
    expect(later.requests).toHaveLength(0);
  });

  it("works for a paused webhook so it can be checked before resuming", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const hook = await createWebhook(actor, "https://hooks.example.com/in", prod());
    await setWebhookActive(actor, hook.id, false);
    expect((await sendTestEvent(actor, hook.id, { send: recorder().send, ...prod() })).ok).toBe(true);
  });
});

describe("pruneWebhookDeliveries", () => {
  it("removes old finished deliveries and keeps pending and recent ones", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const hook = await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    const old = new Date("2025-01-01T00:00:00Z");
    const base = { webhookId: hook.id, orgId, event: "file.created", payload: {} };
    await db.insert(webhookDeliveries).values([
      { ...base, id: "whd_old_done", status: "delivered", createdAt: old },
      { ...base, id: "whd_old_failed", status: "failed", createdAt: old },
      { ...base, id: "whd_old_pending", status: "pending", createdAt: old, nextAttemptAt: new Date("2999-01-01T00:00:00Z") },
      { ...base, id: "whd_new_done", status: "delivered", createdAt: new Date() },
    ]);
    expect(await pruneWebhookDeliveries(30)).toBe(2);
    expect((await deliveriesFor(orgId)).map((r) => r.id).sort()).toEqual(["whd_new_done", "whd_old_pending"]);
  });
});

describe("permissions follow the stored user, not the session's copy", () => {
  it("refuses a demoted admin whose Actor still says admin", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const stale = actorFor(orgId, "admin");
    const hook = await createWebhook(stale, "https://hooks.example.com/in", prod());
    await db.update(users).set({ role: "member" }).where(eq(users.id, userIdFor(orgId, "admin")));

    await expect(createWebhook(stale, "https://other.example.com/in", prod())).rejects.toMatchObject({ code: "forbidden" });
    await expect(setWebhookActive(stale, hook.id, false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendTestEvent(stale, hook.id, { send: recorder().send, ...prod() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteWebhook(stale, hook.id)).rejects.toMatchObject({ code: "forbidden" });
    // Still on the team, so the list of endpoints is fine; the delivery log holds client data and is not.
    expect(await listWebhooks(stale)).toHaveLength(1);
    await expect(listDeliveries(stale)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("shows the delivery log, which holds client details, to owners and admins only", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await createWebhook(actorFor(orgId), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "file.created", { fileId: "fil_1", clientName: "Test Client" });
    expect(await listDeliveries(actorFor(orgId, "owner"))).toHaveLength(1);
    expect(await listDeliveries(actorFor(orgId, "admin"))).toHaveLength(1);
    const refused = await listDeliveries(actorFor(orgId, "member")).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    expect(refused).toMatchObject({ code: "forbidden" });
    expect(refused?.message).toMatch(/owner or admin/);
    // A member who claims to be an owner in a stale session is still read from the stored row.
    await expect(listDeliveries({ ...actorFor(orgId, "member"), role: "owner" } as Actor)).rejects.toMatchObject({ code: "forbidden" });
    // The badge count carries no client data and stays visible to the team.
    expect(await countDeliveriesByStatus(actorFor(orgId, "member"))).toMatchObject({ pending: 1 });
  });

  it("refuses a disabled person every call, including the delivery log", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const stale = actorFor(orgId, "owner");
    const hook = await createWebhook(stale, "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(db, orgId, "file.created", { fileId: "fil_1", clientName: "Test Client" });
    expect(await listDeliveries(stale)).toHaveLength(1);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userIdFor(orgId, "owner")));

    await expect(listDeliveries(stale)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listDeliveries(stale, { webhookId: hook.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(countDeliveriesByStatus(stale)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listWebhooks(stale)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWebhook(stale, "https://other.example.com/in", prod())).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteWebhook(stale, hook.id)).rejects.toMatchObject({ code: "forbidden" });
    // Server-side callers are unaffected.
    expect(await listDeliveries(systemActor(orgId))).toHaveLength(1);
  });

  it("refuses the delivery log to an Actor that names no real user or no company", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await createWebhook(actorFor(b), "https://hooks.example.com/in", prod());
    await enqueueWebhookEvent(await getDb(), b, "file.created", {});
    const forged: Actor = { type: "user", orgId: b, userId: userIdFor(a, "owner"), role: "owner", label: "Sam Lee" };
    await expect(listDeliveries(forged)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listDeliveries(undefined as never)).rejects.toMatchObject({ code: "forbidden" });
    await expect(countDeliveriesByStatus({ type: "user" } as never)).rejects.toMatchObject({ code: "forbidden" });
  });
});
