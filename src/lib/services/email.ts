/**
 * Email delivery. One entry point, `sendEmail`, which never throws: callers are
 * user actions (send, sign, void) that must succeed whether or not the email does.
 * Every attempt leaves an email_log row so a failed delivery is visible, not silent.
 *
 * Two transports: Resend over HTTPS, or any SMTP mailbox (Gmail by default) through
 * nodemailer. `env.emailTransport` decides which; with neither, messages are skipped.
 *
 * Do not await `sendEmail` inside an open database transaction: the log row is
 * written on the shared handle, and the embedded database (PGlite) serializes
 * queries behind the open transaction.
 */
import "server-only";
import { getDb } from "@/lib/db";
import { emailLog } from "@/lib/db/schema";
import { env, PRODUCT_NAME } from "@/lib/env";
import { newId } from "@/lib/ids";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface EmailMessage {
  orgId?: string | null;
  envelopeId?: string | null;
  kind: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  attachments?: EmailAttachment[];
  /**
   * Set when the caller has decided this message must not go out (for example the
   * company's owner has not confirmed their email address yet). Nothing is sent; the
   * attempt is logged as skipped with this reason, so the history still shows it.
   */
  holdReason?: string;
}

export interface EmailResult {
  status: "sent" | "failed" | "skipped";
  error?: string;
  id?: string;
}

/**
 * Attachments larger than this in total are left out and the email still goes.
 * Base64 adds a third, and many mailboxes reject messages above 10 MB, so a
 * bigger attachment would turn "here is your signed copy" into a bounce.
 */
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

const RESEND_URL = "https://api.resend.com/emails";
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 800;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_ERROR_LENGTH = 500;

// ---------------------------------------------------------------------------
// Sanitizing what goes into headers
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

function oneLine(value: unknown, max: number): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return clip(raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim(), max);
}

/** Returns the trimmed address when it is a single deliverable-looking address, otherwise null. */
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (address.length < 6 || address.length > 254) return null;
  // One address only: separators, brackets, quotes, whitespace and control
  // characters would let a value smuggle in extra recipients or headers.
  if (/[\s<>,;:"()[\]\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(address)) return null;
  const at = address.lastIndexOf("@");
  if (at < 1 || address.indexOf("@") !== at) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  if (labels[labels.length - 1].length < 2) return null;
  return address;
}

/**
 * Display name for the From header. Characters with meaning in an address list
 * are removed rather than quoted, because quoting rules differ between providers
 * and a name such as `Acme" <ceo@bank.example>` must never become an address.
 */
function sanitizeDisplayName(value: unknown): string {
  return oneLine(String(value ?? "").replace(/[<>"\\,;:@()[\]]/g, " "), 80);
}

export type EmailTransport = "resend" | "smtp";

/**
 * The From header for a transport. Over SMTP the address is the mailbox that signs in
 * (Gmail rewrites any other address to it anyway); EMAIL_FROM then only supplies a
 * fallback display name, and the address for providers whose SMTP user is not an address.
 */
export function buildFrom(fromName: unknown, transport: EmailTransport = "resend"): { from: string } | { error: string } {
  const configured = env.emailFrom ?? (env.isTest && transport === "resend" ? `${PRODUCT_NAME} <agreements@signgate.test>` : "");
  const match = /^(.*)<([^<>]*)>\s*$/.exec(configured);
  const configuredAddress = normalizeEmailAddress(match ? match[2] : configured);
  const address = transport === "smtp" ? (normalizeEmailAddress(env.smtpUser) ?? configuredAddress) : configuredAddress;
  if (!address) {
    return {
      error:
        transport === "smtp"
          ? "SMTP_USER is not an email address, so there is no address to send from. Set SMTP_USER to the mailbox address, or set EMAIL_FROM to the address to send from."
          : 'EMAIL_FROM is not a valid sender. Set it to something like "Agreements <agreements@yourdomain.com>".',
    };
  }
  const name = sanitizeDisplayName(fromName) || sanitizeDisplayName(match ? match[1] : "") || (transport === "smtp" ? PRODUCT_NAME : "");
  return { from: name ? `${name} <${address}>` : address };
}

function cleanAttachments(input: unknown): { attachments: EmailAttachment[]; dropped: boolean } {
  if (!Array.isArray(input)) return { attachments: [], dropped: false };
  const attachments: EmailAttachment[] = [];
  let total = 0;
  for (const item of input) {
    const content: unknown = item?.content;
    if (!(content instanceof Uint8Array) || content.length === 0) continue;
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    // Path separators and control characters stripped so a filename is only ever a name.
    const filename = oneLine(String(item?.filename ?? "").replace(/[\\/:*?"<>|]/g, "-"), 120) || "attachment";
    attachments.push({ filename, content: buffer });
    total += buffer.length;
  }
  // All or nothing: sending two of three attachments would look like a complete set.
  if (total > MAX_ATTACHMENT_BYTES) return { attachments: [], dropped: true };
  return { attachments, dropped: false };
}

/** True when these attachments are small enough to be sent, so a caller can word the email body accordingly. */
export function attachmentsFit(attachments: { content: Uint8Array }[] | undefined | null): boolean {
  if (!attachments) return true;
  let total = 0;
  for (const a of attachments) total += a?.content?.length ?? 0;
  return total <= MAX_ATTACHMENT_BYTES;
}

// ---------------------------------------------------------------------------
// Provider transport
// ---------------------------------------------------------------------------

export interface ResendPayload {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export type TransportResult = { ok: true; id?: string } | { ok: false; error: string };

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "Unknown error";
}

function providerMessage(status: number, body: string): string {
  let detail = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const message = record.message ?? (record.error as Record<string, unknown> | undefined)?.message ?? record.error;
      if (typeof message === "string") detail = message;
    }
  } catch {
    detail = body;
  }
  detail = oneLine(detail, 300);
  const hint =
    status === 401
      ? " Check that RESEND_API_KEY is correct."
      : status === 403
        ? " Check that the EMAIL_FROM domain is verified with the email provider."
        : status === 429
          ? " The email provider is rate limiting; try again in a minute."
          : "";
  return `Email provider returned ${status}${detail ? `: ${detail}` : ""}.${hint}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts one message to Resend. Retries once on 429, 5xx or a network error; the
 * idempotency key makes that retry safe when the first attempt was accepted but
 * its response was lost. Exported so the retry and error handling can be tested
 * against a fake fetch; application code calls `sendEmail`.
 */
export async function sendViaResend(
  payload: ResendPayload,
  options: {
    apiKey: string;
    idempotencyKey: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    retryDelayMs?: number;
  },
): Promise<TransportResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const body = JSON.stringify({
    from: payload.from,
    to: [payload.to],
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
    ...(payload.attachments?.length
      ? { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })) }
      : {}),
  });

  let lastError = "Email could not be sent.";
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let retryAfterMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    try {
      const response = await doFetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": options.idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await response.text().catch(() => "");
      if (response.ok) {
        let id: string | undefined;
        try {
          const parsed: unknown = JSON.parse(responseBody);
          const value = (parsed as { id?: unknown } | null)?.id;
          if (typeof value === "string") id = value;
        } catch {
          // Accepted without a readable body: still a successful send.
        }
        return { ok: true, id };
      }
      lastError = providerMessage(response.status, responseBody);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) return { ok: false, error: lastError };
      const header = Number(response.headers?.get?.("retry-after"));
      if (options.retryDelayMs === undefined && Number.isFinite(header) && header > 0) {
        retryAfterMs = Math.min(header * 1000, MAX_RETRY_DELAY_MS);
      }
    } catch (err) {
      if (timedOut) {
        // No retry after a timeout: a second 10 s wait would hold the user's
        // request for longer than a serverless function can be relied on to run.
        return { ok: false, error: `The email provider did not respond within ${Math.round(timeoutMs / 1000)} seconds. Try sending again.` };
      }
      lastError = `Could not reach the email provider: ${oneLine(describeError(err), 200)}.`;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await sleep(retryAfterMs);
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// SMTP transport
// ---------------------------------------------------------------------------

/** The part of a nodemailer transporter this module uses; lets tests pass a fake. */
export interface SmtpTransporter {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  close?: () => void;
}

interface SmtpPoolState {
  key: string;
  transporter: SmtpTransporter;
}

// On globalThis for the same reason as the database handle: one pool per process,
// even when a bundler evaluates this module more than once.
const smtpGlobal = globalThis as unknown as { __signgateSmtp?: SmtpPoolState };

const SMTP_CONNECT_TIMEOUT_MS = 8_000;
const SMTP_SOCKET_TIMEOUT_MS = 12_000;
/** Upper bound on one SMTP send, whatever the server does. Above the socket timeouts so they report first. */
const SMTP_TOTAL_TIMEOUT_MS = 15_000;

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * One pooled transporter per process and configuration. Opening a TLS session and
 * signing in costs about a second with Gmail, and Gmail limits how often a mailbox
 * may sign in, so the connection is kept and reused by every send of this instance.
 */
async function smtpTransporter(): Promise<SmtpTransporter> {
  const host = env.smtpHost;
  const port = env.smtpPort;
  const user = env.smtpUser as string;
  const pass = env.smtpPass as string;
  // The password is part of the key by hash only, so a rotated password gets a new pool.
  const key = `${host}:${port}:${user}:${pass.length}:${hashForKey(pass)}`;
  const cached = smtpGlobal.__signgateSmtp;
  if (cached && cached.key === key) return cached.transporter;
  try {
    cached?.transporter.close?.();
  } catch {
    // An old pool that will not close is simply left to time out.
  }
  // Loaded on first use so a deployment that sends through Resend never pays for it.
  const nodemailer = await import("nodemailer");
  const createTransport = nodemailer.createTransport ?? nodemailer.default?.createTransport;
  const transporter = createTransport({
    pool: true,
    host,
    port,
    // 465 is TLS from the first byte. Any other port must upgrade before the password
    // is sent, except a mail catcher on this machine, which has no certificate.
    secure: port === 465,
    requireTLS: port !== 465 && !isLocalHost(host),
    auth: { user, pass },
    // A serverless instance handles one request at a time; more connections only
    // multiply sign-ins against the mailbox's limits.
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: SMTP_CONNECT_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECT_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    dnsTimeout: SMTP_CONNECT_TIMEOUT_MS,
  }) as unknown as SmtpTransporter;
  smtpGlobal.__signgateSmtp = { key, transporter };
  return transporter;
}

function hashForKey(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Test helper: forget the pooled transporter so the next send builds one from the current environment. */
export function resetSmtpTransportForTests(): void {
  try {
    smtpGlobal.__signgateSmtp?.transporter.close?.();
  } catch {
    // Nothing to do: the pool is being discarded.
  }
  smtpGlobal.__signgateSmtp = undefined;
}

function smtpMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; response?: unknown; command?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  const detail = oneLine(typeof e.response === "string" && e.response ? e.response : describeError(err), 300);
  if (code === "EAUTH" || status === 534 || status === 535) {
    return `The mail server refused the sign-in for SMTP_USER. Check SMTP_USER and SMTP_PASS; with Gmail, SMTP_PASS must be an app password, not the account password. (${detail})`;
  }
  if (code === "EDNS" || code === "ENOTFOUND" || code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ESOCKET" || code === "ETLS") {
    return `Could not reach the mail server at ${env.smtpHost}:${env.smtpPort}. Check SMTP_HOST and SMTP_PORT. (${detail})`;
  }
  if (code === "ETIMEDOUT") return "The mail server did not respond in time. Try sending again.";
  if (status === 421 || status === 450 || status === 451 || status === 452 || status === 454) {
    return `The mail server is busy or rate limiting this mailbox; try again in a few minutes. (${detail})`;
  }
  if (status === 550 && /daily|limit|quota/i.test(detail)) {
    return `The mailbox has reached its sending limit for today. Sending resumes when the limit resets. (${detail})`;
  }
  return `The mail server did not accept the message: ${detail}`;
}

/**
 * Sends one message through the SMTP mailbox. One attempt only: unlike Resend there
 * is no idempotency key, so a retry after a dropped connection could deliver the
 * same email twice. Exported so the error handling can be tested against a fake
 * transporter; application code calls `sendEmail`.
 */
export async function sendViaSmtp(payload: ResendPayload, options: { transporter?: SmtpTransporter; timeoutMs?: number } = {}): Promise<TransportResult> {
  const timeoutMs = options.timeoutMs ?? SMTP_TOTAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transporter = options.transporter ?? (await smtpTransporter());
    const sending = transporter.sendMail({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      ...(payload.attachments?.length
        ? { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: /\.pdf$/i.test(a.filename) ? "application/pdf" : undefined })) }
        : {}),
      // Header and address values were sanitized by the caller; this stops nodemailer
      // reading a file or URL if a string were ever mistaken for one.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    // A send that finishes after the deadline must not surface as an unhandled rejection.
    sending.catch(() => undefined);
    const timedOut = Symbol("timeout");
    const info = await Promise.race([
      sending,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (info === timedOut) {
      return { ok: false, error: `The mail server did not respond within ${Math.round(timeoutMs / 1000)} seconds. Try sending again.` };
    }
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    const accepted = Array.isArray(info?.accepted) ? info.accepted : null;
    if (rejected.length > 0 && (!accepted || accepted.length === 0)) {
      return { ok: false, error: `The mail server refused the recipient address ${payload.to}. Check the address and send again.` };
    }
    return { ok: true, id: typeof info?.messageId === "string" && info.messageId ? oneLine(info.messageId, 200) : undefined };
  } catch (err) {
    return { ok: false, error: smtpMessage(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Hands a prepared message to whichever transport the environment configures.
 * Exported for tests of the selection; application code calls `sendEmail`.
 */
export async function sendThroughConfiguredTransport(
  message: Omit<ResendPayload, "from"> & { fromName?: unknown },
  options: { idempotencyKey: string; fetchImpl?: typeof fetch },
): Promise<TransportResult & { transport: EmailTransport | null }> {
  const transport = env.emailTransport;
  if (!transport) return { ok: false, error: "Email is not set up.", transport };
  const sender = buildFrom(message.fromName, transport);
  if ("error" in sender) return { ok: false, error: sender.error, transport };
  const { fromName: _fromName, ...rest } = message;
  void _fromName;
  const payload: ResendPayload = { ...rest, from: sender.from };
  const result =
    transport === "resend"
      ? await sendViaResend(payload, { apiKey: env.resendApiKey as string, idempotencyKey: options.idempotencyKey, fetchImpl: options.fetchImpl })
      : await sendViaSmtp(payload);
  return { ...result, transport };
}

// ---------------------------------------------------------------------------
// Test capture
// ---------------------------------------------------------------------------

export interface CapturedEmail {
  id: string;
  orgId: string | null;
  envelopeId: string | null;
  kind: string;
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

interface TestState {
  outbox: CapturedEmail[];
  failure: { error: string; onlyTo?: string } | null;
  unconfigured: boolean;
}

// On globalThis so the outbox is shared even if a bundler or test runner
// evaluates this module more than once.
const globalState = globalThis as unknown as { __signgateEmailTest?: TestState };
const testState: TestState = (globalState.__signgateEmailTest ??= { outbox: [], failure: null, unconfigured: false });

/** Messages "sent" during tests, oldest first. Failed and skipped messages are not included. */
export function getTestOutbox(): CapturedEmail[] {
  return [...testState.outbox];
}

/** Empties the outbox and clears any forced failure or forced unconfigured state. */
export function clearTestOutbox(): void {
  testState.outbox.length = 0;
  testState.failure = null;
  testState.unconfigured = false;
}

/**
 * Makes sends fail in tests with the given provider error until cleared with
 * `null` (or `clearTestOutbox`). With `onlyTo`, only that recipient fails.
 */
export function setTestEmailFailure(error: string | null, onlyTo?: string): void {
  testState.failure = error === null ? null : { error, onlyTo: onlyTo?.trim().toLowerCase() };
}

/** Makes tests behave as if no email provider were configured. */
export function setTestEmailUnconfigured(unconfigured: boolean): void {
  testState.unconfigured = unconfigured;
}

/**
 * True when a message handed to `sendEmail` would actually be sent somewhere. Callers
 * use it to decide whether rules that only matter for real email (such as requiring a
 * verified owner address) apply at all.
 */
export function emailIsConfigured(): boolean {
  return env.isTest ? !testState.unconfigured : env.emailConfigured;
}

// ---------------------------------------------------------------------------
// Log and send
// ---------------------------------------------------------------------------

async function writeLog(row: {
  id: string;
  orgId: string | null;
  envelopeId: string | null;
  kind: string;
  to: string;
  subject: string;
  status: EmailResult["status"];
  providerId?: string;
  error?: string;
}): Promise<void> {
  const values = { ...row, providerId: row.providerId ?? null, error: row.error ?? null };
  try {
    const db = await getDb();
    try {
      await db.insert(emailLog).values(values);
    } catch (err) {
      if (!row.orgId && !row.envelopeId) throw err;
      // The org or envelope may have been deleted between the action and the
      // send. Keep the record anyway, without the dangling references.
      await db.insert(emailLog).values({ ...values, orgId: null, envelopeId: null });
    }
  } catch (err) {
    console.error(`[email] could not record ${row.kind} email (${row.status}) in email_log: ${describeError(err)}`);
  }
}

function extractLinks(text: string): string[] {
  const links = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  return [...new Set(links)].slice(0, 5);
}

export async function sendEmail(msg: {
  orgId?: string | null;
  envelopeId?: string | null;
  kind: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  attachments?: { filename: string; content: Buffer }[];
  holdReason?: string;
}): Promise<{ status: "sent" | "failed" | "skipped"; error?: string; id?: string }> {
  const id = newId("eml");
  const log = {
    id,
    orgId: typeof msg?.orgId === "string" && msg.orgId ? msg.orgId : null,
    envelopeId: typeof msg?.envelopeId === "string" && msg.envelopeId ? msg.envelopeId : null,
    kind: oneLine(msg?.kind, 60) || "unknown",
    to: oneLine(msg?.to, 254) || "(missing)",
    subject: oneLine(msg?.subject, 200) || `Message from ${PRODUCT_NAME}`,
  };

  const finish = async (result: EmailResult): Promise<EmailResult> => {
    const error = result.error ? clip(result.error, MAX_ERROR_LENGTH) : undefined;
    await writeLog({ ...log, status: result.status, providerId: result.id, error });
    return { status: result.status, ...(error ? { error } : {}), ...(result.id ? { id: result.id } : {}) };
  };

  try {
    const to = normalizeEmailAddress(msg?.to);
    if (!to) {
      return await finish({
        status: "failed",
        error: `"${log.to}" is not a valid email address. Correct the address and send again.`,
      });
    }
    log.to = to;

    const html = typeof msg.html === "string" ? msg.html : "";
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!html.trim() && !text.trim()) {
      return await finish({ status: "failed", error: "The email has no content, so it was not sent." });
    }

    const held = oneLine(msg.holdReason, 300);
    if (held) return await finish({ status: "skipped", error: held });

    if (!emailIsConfigured()) {
      if (!env.isProduction) {
        // Lets a developer without an email provider follow the signing link.
        const links = extractLinks(text || html);
        console.info(
          `[email not configured] ${log.kind} to ${to}: ${log.subject}` + links.map((link) => `\n  ${link}`).join(""),
        );
      }
      return await finish({ status: "skipped" });
    }

    // A bad reply-to is dropped rather than failing the send: the email itself is still correct.
    const replyTo = normalizeEmailAddress(msg.replyTo) ?? undefined;
    const { attachments } = cleanAttachments(msg.attachments);

    if (env.isTest) {
      const sender = buildFrom(msg.fromName);
      if ("error" in sender) return await finish({ status: "failed", error: sender.error });
      const payload: ResendPayload = { from: sender.from, to, subject: log.subject, html, text, replyTo, attachments };
      const failure = testState.failure;
      if (failure && (!failure.onlyTo || failure.onlyTo === to.toLowerCase())) {
        return await finish({ status: "failed", error: failure.error });
      }
      testState.outbox.push({
        id,
        orgId: log.orgId,
        envelopeId: log.envelopeId,
        kind: log.kind,
        to,
        from: payload.from,
        replyTo,
        subject: payload.subject,
        html,
        text,
        attachments,
      });
      return await finish({ status: "sent", id: `test_${id}` });
    }

    const result = await sendThroughConfiguredTransport({ fromName: msg.fromName, to, subject: log.subject, html, text, replyTo, attachments }, { idempotencyKey: id });
    return await finish(result.ok ? { status: "sent", id: result.id } : { status: "failed", error: result.error });
  } catch (err) {
    const error = `Email could not be sent: ${oneLine(describeError(err), 300)}`;
    try {
      return await finish({ status: "failed", error });
    } catch {
      return { status: "failed", error };
    }
  }
}
