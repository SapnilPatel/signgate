import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { webhookDeliveries, webhooks, type Webhook } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId, newSecret } from "@/lib/ids";
import { assertActiveActor } from "./accounts";
import { ServiceError, type Actor } from "./context";
import { cleanText, recordEvent, toSafeJson } from "./events";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

/** Events the product emits to webhooks. */
export const WEBHOOK_EVENTS = [
  "file.created",
  "agreement.sent",
  "agreement.viewed",
  "agreement.signed",
  "agreement.completed",
  "agreement.declined",
  "agreement.voided",
  "agreement.expired",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_TEST_EVENT = "webhook.test";
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_TIMEOUT_MS = 8_000;
export const MAX_WEBHOOKS_PER_ORG = 10;
const MAX_URL_LENGTH = 2000;
const DNS_TIMEOUT_MS = 4_000;
/** How long a claimed delivery stays invisible to other runners. Longer than any
 *  one run can take, so a row is only picked up again if its runner died. */
const CLAIM_LEASE_MS = 5 * 60_000;
const SEND_CONCURRENCY = 5;

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
/** What list views may see. The signing secret is only returned by createWebhook. */
export type WebhookSummary = Omit<Webhook, "secret">;

/** Resolves a hostname to every address it currently points at. */
export type WebhookResolver = (hostname: string) => Promise<string[]>;

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Addresses that passed the safety check. The sender must connect to one of these
   *  and nowhere else. Empty only for the localhost exemption outside production. */
  addresses: string[];
}
/** Performs one POST and reports the status. Must not follow redirects. */
export type WebhookSender = (req: WebhookRequest) => Promise<{ status: number }>;

/** Seams for tests and for running against a different network stack. */
export interface WebhookDeps {
  resolver?: WebhookResolver;
  send?: WebhookSender;
  now?: () => Date;
  /** Defaults to env.isProduction. Decides whether http and localhost are allowed. */
  production?: boolean;
}

// ---------------------------------------------------------------------------
// URL safety (SSRF)
// ---------------------------------------------------------------------------

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches localhost on many systems
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, used inside cloud networks
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the 169.254.169.254 metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: wraps an IPv4 address this list cannot see
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4: wraps an IPv4 address
  ["fc00::", 7], // unique local, including fd00:ec2::254 metadata
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4-mapped and IPv4-compatible IPv6 (::ffff:a.b.c.d, ::a.b.c.d) as the IPv4 they reach. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when a webhook must not be delivered to this address. Anything that is not
 *  a well-formed IP address is refused too. */
export function isBlockedAddress(address: string): boolean {
  if (typeof address !== "string") return true;
  const bare = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // drop brackets and zone id
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4 && isIP(v4) === 4) return blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

const systemResolver: WebhookResolver = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((a) => a.address);
};

const invalidUrl = (message: string) => new ServiceError("invalid", message, { url: message });

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

export interface CheckedWebhookUrl {
  /** Normalized URL to store and call. */
  url: string;
  /** Addresses the hostname resolved to, all of them public. Empty for the localhost exemption. */
  addresses: string[];
}

/**
 * Decide whether Signgate may POST to this URL. Throws ServiceError("invalid") with
 * a message for the person configuring the webhook when it may not.
 *
 * A webhook URL is attacker-controlled input that makes our servers issue requests,
 * so it must never reach the cloud metadata service, localhost or a private network.
 * The hostname is resolved and every address is checked, because a public-looking
 * name can point anywhere. Called when a webhook is saved and again before each send.
 */
export async function checkWebhookUrl(input: string, deps: Pick<WebhookDeps, "resolver" | "production"> = {}): Promise<CheckedWebhookUrl> {
  const production = deps.production ?? env.isProduction;
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw invalidUrl("Enter the URL that should receive events, for example https://example.com/signgate-webhook.");
  if (raw.length > MAX_URL_LENGTH) throw invalidUrl(`Webhook URLs can be at most ${MAX_URL_LENGTH} characters. Use a shorter URL.`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidUrl("That is not a valid URL. Enter a full address that starts with https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidUrl("Webhook URLs must start with https://.");
  }
  if (url.username || url.password) {
    throw invalidUrl("Remove the username and password from the URL. Verify deliveries with the signing secret instead.");
  }
  url.hash = "";

  // URL has already canonicalized odd spellings (2130706433, 0x7f.1, 127.1) to dotted form.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw invalidUrl("That URL has no host name. Enter a full address that starts with https://.");

  if (!production && isLocalhostName(host)) {
    // Local development against a receiver on the same machine. Never reachable in production.
    return { url: url.toString(), addresses: [] };
  }
  if (url.protocol !== "https:") {
    throw invalidUrl("Webhook URLs must use https:// so event data is encrypted in transit.");
  }

  const refused = () =>
    invalidUrl("That URL points to a private or internal network address, which webhooks cannot be sent to. Use a publicly reachable https:// URL.");

  if (isIP(host)) {
    if (isBlockedAddress(host)) throw refused();
    return { url: url.toString(), addresses: [host] };
  }
  if (isLocalhostName(host)) throw refused();

  let addresses: string[];
  try {
    const resolved = await withTimeout((deps.resolver ?? systemResolver)(host), DNS_TIMEOUT_MS, () => new Error("DNS lookup timed out"));
    addresses = Array.isArray(resolved) ? resolved.filter((a): a is string => typeof a === "string" && a !== "") : [];
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    throw invalidUrl(`The host name "${cleanText(host, 100)}" could not be found. Check the URL for typos and try again.`);
  }
  // One private address among several public ones is enough to refuse: which one a
  // connection lands on is not ours to choose.
  if (addresses.some(isBlockedAddress)) throw refused();
  return { url: url.toString(), addresses };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** Header value for a body signed at `timestamp` (unix seconds): "t=<unix>,v1=<hex>". */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify an X-Signgate-Signature header against the raw request body.
 * Receivers should pass the body exactly as received, before any JSON parsing.
 * Signatures older (or newer) than the tolerance are rejected to stop replays.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  opts: { toleranceSeconds?: number; now?: Date } = {},
): boolean {
  if (typeof secret !== "string" || !secret || typeof header !== "string" || typeof body !== "string") return false;
  if (header.length > 1000) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eqAt = part.indexOf("=");
    if (eqAt < 0) continue;
    const key = part.slice(0, eqAt).trim();
    const value = part.slice(eqAt + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) candidates.push(value.toLowerCase());
  }
  if (timestamp === null || candidates.length === 0) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (tolerance > 0 && Math.abs(nowSeconds - timestamp) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  // Several v1 values may be present while a secret is being rotated.
  return candidates.some((candidate) => timingSafeEqual(Buffer.from(candidate, "hex"), expected));
}

// ---------------------------------------------------------------------------
// Managing webhooks
// ---------------------------------------------------------------------------

/** A webhook decides where the org's client data is sent, so only a signed-in owner or admin may change one. */
function assertSignedIn(actor: Actor, action: string): asserts actor is Extract<Actor, { type: "user" }> {
  if (!actor || actor.type !== "user") {
    throw new ServiceError("forbidden", `Only an owner or admin can ${action}. Ask one of them to do it for you.`);
  }
}

/** Signed in, still active and still an owner or admin according to the stored row, not the session's copy of the role. */
async function assertManager(actor: Actor, action: string): Promise<void> {
  assertSignedIn(actor, action);
  await assertActiveActor(await getDb(), actor, "manage");
}

const webhookNotFound = () => new ServiceError("not_found", "That webhook does not exist. Refresh the page to see the current list.");

function summarize(row: Webhook): WebhookSummary {
  const { secret: _secret, ...rest } = row;
  void _secret;
  return rest;
}

/** Register an endpoint. The returned row carries the signing secret; it is not shown again. */
export async function createWebhook(actor: Actor, url: string, deps: WebhookDeps = {}): Promise<Webhook> {
  await assertManager(actor, "add webhooks");
  const checked = await checkWebhookUrl(url, deps);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const existing = await tx.select({ url: webhooks.url }).from(webhooks).where(eq(webhooks.orgId, actor.orgId));
    if (existing.some((w) => w.url === checked.url)) {
      throw new ServiceError("conflict", "A webhook for this URL already exists. Edit or remove that one instead.", {
        url: "This URL already has a webhook.",
      });
    }
    if (existing.length >= MAX_WEBHOOKS_PER_ORG) {
      throw new ServiceError("conflict", `You already have ${MAX_WEBHOOKS_PER_ORG} webhooks. Remove one you no longer use, then add this one.`);
    }
    const [row] = await tx
      .insert(webhooks)
      .values({ id: newId("whk"), orgId: actor.orgId, url: checked.url, secret: `whsec_${newSecret()}` })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: "webhook.created", actor, data: { webhookId: row.id, url: checked.url } });
    return row;
  });
}

export async function listWebhooks(actor: Actor): Promise<WebhookSummary[]> {
  const db = await getDb();
  await assertActiveActor(db, actor, "read");
  const rows = await db.select().from(webhooks).where(eq(webhooks.orgId, actor.orgId)).orderBy(asc(webhooks.createdAt), asc(webhooks.id));
  return rows.map(summarize);
}

/** Remove a webhook and its delivery history. Deliveries not yet sent are dropped. */
export async function deleteWebhook(actor: Actor, id: string): Promise<void> {
  await assertManager(actor, "remove webhooks");
  if (typeof id !== "string" || !id) throw webhookNotFound();
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.orgId, actor.orgId)))
      .returning({ id: webhooks.id, url: webhooks.url });
    if (!gone) throw webhookNotFound();
    await recordEvent(tx, { orgId: actor.orgId, type: "webhook.deleted", actor, data: { webhookId: gone.id, url: gone.url } });
  });
}

/** Pause or resume a webhook. A paused webhook receives no new events, and
 *  deliveries still waiting to retry are closed as failed when they come due. */
export async function setWebhookActive(actor: Actor, id: string, active: boolean): Promise<WebhookSummary> {
  await assertManager(actor, "change webhooks");
  if (typeof id !== "string" || !id) throw webhookNotFound();
  const db = await getDb();
  const [row] = await db
    .update(webhooks)
    .set({ active: active === true })
    .where(and(eq(webhooks.id, id), eq(webhooks.orgId, actor.orgId)))
    .returning();
  if (!row) throw webhookNotFound();
  return summarize(row);
}

/** Recent deliveries for the org, newest first, optionally for one webhook. */
export async function listDeliveries(actor: Actor, opts: { webhookId?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
  const db = await getDb();
  await assertActiveActor(db, actor, "read");
  const conditions: SQL[] = [eq(webhookDeliveries.orgId, actor.orgId)];
  if (typeof opts.webhookId === "string" && opts.webhookId) conditions.push(eq(webhookDeliveries.webhookId, opts.webhookId));
  return db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(clampLimit(opts.limit, 50, 200));
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/** Header-safe event name; Node refuses to send a header containing control characters. */
function cleanEventName(event: unknown): string {
  return cleanText(event, 80).replace(/[^A-Za-z0-9._:-]/g, "") || "unknown";
}

/**
 * Queue an event for every active webhook of the org. Call it with the business
 * transaction: the delivery rows commit or roll back with the change they announce,
 * so an event is never lost and never sent for something that did not happen.
 * Nothing is sent here; deliverPendingWebhooks does that after commit.
 */
export async function enqueueWebhookEvent(db: DbOrTx, orgId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const targets = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true)));
  if (targets.length === 0) return;
  const now = new Date();
  const data = toSafeJson(payload, { maxString: 10_000 });
  await db.insert(webhookDeliveries).values(
    targets.map((target) => ({
      id: newId("whd"),
      webhookId: target.id,
      orgId,
      event: cleanEventName(event),
      payload: data,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    })),
  );
}

/** Wait before retry number `attempts + 1`: 1 min, 4 min, 16 min, about 1 h, about 4 h. */
export function webhookRetryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.min(Math.floor(attempts) || 1, WEBHOOK_MAX_ATTEMPTS));
  return 60_000 * 4 ** (n - 1);
}

/** Connect only to the addresses that were checked. Without this, the HTTP client
 *  would resolve the name a second time and a hostile DNS server could answer
 *  differently (DNS rebinding) between the check and the connection. */
function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  }) as unknown as LookupFunction;
}

const nodeSender: WebhookSender = (req) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const target = new URL(req.url);
    const client = target.protocol === "https:" ? https : http;
    // node:http never follows redirects, which is the behaviour wanted here: a 3xx
    // could point at an internal address that was never checked.
    const request = client.request(
      target,
      {
        method: "POST",
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
        agent: false,
        ...(req.addresses.length > 0 ? { lookup: pinnedLookup(req.addresses) } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // Only the status matters; do not wait for (or buffer) whatever the endpoint sends back.
        response.destroy();
        finish(() => resolve({ status }));
      },
    );
    const timer = setTimeout(() => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      request.destroy(err);
      finish(() => reject(err));
    }, req.timeoutMs);
    request.on("error", (err) => finish(() => reject(err)));
    request.end(req.body);
  });

function describeSendError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return `The endpoint did not respond within ${WEBHOOK_TIMEOUT_MS / 1000} seconds.`;
  }
  const code = typeof e.code === "string" ? e.code : "";
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME/.test(code)) return `The endpoint's TLS certificate was not accepted (${code}).`;
  if (code) return `Could not connect to the endpoint (${code}).`;
  return `The request failed: ${cleanText(e.message, 200) || "unknown error"}`;
}

interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** One POST to one endpoint. Never throws. */
async function attemptDelivery(delivery: WebhookDelivery, webhook: Pick<Webhook, "url" | "secret">, deps: WebhookDeps): Promise<AttemptResult> {
  try {
    // Checked again on every attempt: DNS for a saved URL can be repointed at any time.
    const checked = await checkWebhookUrl(webhook.url, deps);
    const body = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      created_at: delivery.createdAt.toISOString(),
      data: delivery.payload ?? {},
    });
    const timestamp = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const send = deps.send ?? nodeSender;
    const response = await withTimeout(
      send({
        url: checked.url,
        body,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        addresses: checked.addresses,
        headers: {
          "content-type": "application/json",
          "user-agent": "Signgate-Webhooks/1.0",
          "x-signgate-event": cleanEventName(delivery.event),
          "x-signgate-delivery": delivery.id,
          "x-signgate-signature": signWebhookPayload(webhook.secret, body, timestamp),
        },
      }),
      // Backstop in case a sender ignores its own timeout.
      WEBHOOK_TIMEOUT_MS + 1_000,
      () => Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    );
    const status = Number.isInteger(response?.status) ? response.status : 0;
    if (status >= 200 && status < 300) return { ok: true, status, error: null };
    if (status >= 300 && status < 400) {
      return { ok: false, status, error: `The endpoint answered with a redirect (HTTP ${status}). Redirects are not followed; set the webhook to the final URL.` };
    }
    return { ok: false, status: status || null, error: status ? `The endpoint answered with HTTP ${status}.` : "The endpoint sent no valid response." };
  } catch (err) {
    return { ok: false, status: null, error: describeSendError(err) };
  }
}

/** Write the outcome of an attempt, unless another runner has taken the row over since it was claimed. */
async function settleDelivery(delivery: WebhookDelivery, result: AttemptResult, now: Date, final: boolean): Promise<void> {
  const db = await getDb();
  const giveUp = final || delivery.attempts >= WEBHOOK_MAX_ATTEMPTS;
  await db
    .update(webhookDeliveries)
    .set(
      result.ok
        ? { status: "delivered", responseStatus: result.status, error: null, nextAttemptAt: null }
        : {
            status: giveUp ? "failed" : "pending",
            responseStatus: result.status,
            error: cleanText(result.error, 500) || "Delivery failed.",
            nextAttemptAt: giveUp ? null : new Date(now.getTime() + webhookRetryDelayMs(delivery.attempts)),
          },
    )
    .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.attempts, delivery.attempts)));
}

/**
 * Send queued deliveries that are due. Safe to run from several places at once
 * (cron, and after() following a request): each row is claimed by exactly one runner.
 * Delivery is at-least-once; receivers should deduplicate on the delivery id.
 */
export async function deliverPendingWebhooks(
  opts: { orgId?: string; limit?: number } & WebhookDeps = {},
): Promise<{ delivered: number; failed: number }> {
  const db = await getDb();
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const due: SQL[] = [
    eq(webhookDeliveries.status, "pending"),
    or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)) as SQL,
  ];
  if (typeof opts.orgId === "string" && opts.orgId) due.push(eq(webhookDeliveries.orgId, opts.orgId));

  // Claiming counts the attempt and pushes the row past the lease, so a second runner
  // either skips it (row still locked) or no longer sees it as due (claim committed).
  // If this runner dies, the row comes due again when the lease runs out.
  // The lock and the update are two statements on purpose: as one UPDATE ... WHERE id
  // IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED), Postgres may re-run the subquery
  // per row and claim more than the limit.
  const claimed = await db.transaction(async (tx) => {
    const picked = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(...due))
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.createdAt))
      .limit(clampLimit(opts.limit, 25, 100))
      .for("update", { skipLocked: true });
    if (picked.length === 0) return [];
    return tx
      .update(webhookDeliveries)
      .set({ attempts: sql`${webhookDeliveries.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
      .where(
        and(
          inArray(
            webhookDeliveries.id,
            picked.map((p) => p.id),
          ),
          ...due,
        ),
      )
      .returning();
  });
  if (claimed.length === 0) return { delivered: 0, failed: 0 };

  const hookIds = [...new Set(claimed.map((d) => d.webhookId))];
  const hooks = new Map((await db.select().from(webhooks).where(inArray(webhooks.id, hookIds))).map((w) => [w.id, w]));

  let delivered = 0;
  let failed = 0;
  const queue = [...claimed];
  const worker = async () => {
    for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
      try {
        const hook = hooks.get(delivery.webhookId);
        let result: AttemptResult;
        let final = false;
        if (delivery.attempts > WEBHOOK_MAX_ATTEMPTS) {
          // Its last allowed attempt was claimed by a runner that never reported back.
          result = { ok: false, status: null, error: `Gave up after ${WEBHOOK_MAX_ATTEMPTS} attempts.` };
          final = true;
        } else if (!hook || !hook.active) {
          result = { ok: false, status: null, error: "The webhook was paused or removed before this event could be delivered." };
          final = true;
        } else {
          result = await attemptDelivery(delivery, hook, opts);
        }
        await settleDelivery(delivery, result, clock(), final);
        if (result.ok) delivered++;
        else failed++;
      } catch {
        // Could not record the outcome (database trouble). The lease will expire and the row is retried.
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, worker));
  return { delivered, failed };
}

export interface TestEventResult {
  ok: boolean;
  /** HTTP status the endpoint answered with, if it answered. */
  status: number | null;
  /** What went wrong, in plain words; null on success. */
  error: string | null;
  deliveryId: string;
}

/** Send one sample event right now and report what the endpoint said. It is sent
 *  once, never retried, and works for a paused webhook so it can be checked before resuming. */
export async function sendTestEvent(actor: Actor, id: string, deps: WebhookDeps = {}): Promise<TestEventResult> {
  await assertManager(actor, "send test events");
  if (typeof id !== "string" || !id) throw webhookNotFound();
  const db = await getDb();
  const [hook] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.orgId, actor.orgId)))
    .limit(1);
  if (!hook) throw webhookNotFound();

  const now = deps.now?.() ?? new Date();
  // Inserted already claimed (one attempt, leased) so a concurrent runner cannot send it as well.
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      id: newId("whd"),
      webhookId: hook.id,
      orgId: actor.orgId,
      event: WEBHOOK_TEST_EVENT,
      payload: { message: "This is a test event from Signgate. Your endpoint is set up correctly if you can read this." },
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      createdAt: now,
    })
    .returning();
  const result = await attemptDelivery(delivery, hook, deps);
  await settleDelivery(delivery, result, now, true);
  return { ...result, deliveryId: delivery.id };
}

/** Delete finished deliveries older than `olderThanDays` so the log does not grow without bound. Returns how many were removed. */
export async function pruneWebhookDeliveries(olderThanDays = 30, now: Date = new Date()): Promise<number> {
  const days = Number.isFinite(olderThanDays) && olderThanDays >= 1 ? olderThanDays : 30;
  const db = await getDb();
  const removed = await db
    .delete(webhookDeliveries)
    .where(and(ne(webhookDeliveries.status, "pending"), lt(webhookDeliveries.createdAt, new Date(now.getTime() - days * 86_400_000))))
    .returning({ id: webhookDeliveries.id });
  return removed.length;
}

/** Number of deliveries per status for one org; drives the "needs attention" badge on the integrations page. */
export async function countDeliveriesByStatus(actor: Actor): Promise<Record<WebhookDelivery["status"], number>> {
  const db = await getDb();
  await assertActiveActor(db, actor, "read");
  const rows = await db
    .select({ status: webhookDeliveries.status, n: count() })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.orgId, actor.orgId))
    .groupBy(webhookDeliveries.status);
  const out = { pending: 0, delivered: 0, failed: 0 };
  for (const row of rows) out[row.status] = row.n;
  return out;
}
