import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  sent: [] as Record<string, unknown>[],
  closed: 0,
  behaviour: "ok" as "ok" | "auth" | "reject" | "hang",
}));

vi.mock("nodemailer", () => {
  const createTransport = (options: Record<string, unknown>) => {
    smtp.created.push(options);
    return {
      sendMail: async (message: Record<string, unknown>) => {
        smtp.sent.push(message);
        if (smtp.behaviour === "auth") throw Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
        if (smtp.behaviour === "reject") return { messageId: "<x@test>", accepted: [], rejected: [message.to] };
        if (smtp.behaviour === "hang") return new Promise(() => undefined);
        return { messageId: "<abc123@mail.test>", accepted: [message.to], rejected: [] };
      },
      close: () => {
        smtp.closed++;
      },
    };
  };
  return { default: { createTransport }, createTransport };
});

import { env } from "@/lib/env";
import { buildFrom, resetSmtpTransportForTests, sendThroughConfiguredTransport, sendViaSmtp } from "@/lib/services/email";

const KEYS = ["RESEND_API_KEY", "EMAIL_FROM", "SMTP_USER", "SMTP_PASS", "SMTP_HOST", "SMTP_PORT"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

const message = { to: "client@client.test", subject: "Please sign", html: "<p>Hi</p>", text: "Hi", fromName: "Northwind Legal" };

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  setEnv({});
  smtp.created.length = 0;
  smtp.sent.length = 0;
  smtp.closed = 0;
  smtp.behaviour = "ok";
  resetSmtpTransportForTests();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetSmtpTransportForTests();
});

describe("which transport is used", () => {
  it("is nothing at all with no configuration", async () => {
    expect(env.emailTransport).toBeNull();
    expect(env.emailConfigured).toBe(false);
    const result = await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_1" });
    expect(result).toMatchObject({ ok: false, transport: null });
    expect(smtp.created).toHaveLength(0);
  });

  it("needs both halves of each configuration", () => {
    setEnv({ RESEND_API_KEY: "re_key" });
    expect(env.emailTransport).toBeNull();
    setEnv({ EMAIL_FROM: "Agreements <agreements@northwind.test>" });
    expect(env.emailTransport).toBeNull();
    setEnv({ SMTP_USER: "office@northwind.test" });
    expect(env.emailTransport).toBeNull();
    setEnv({ SMTP_PASS: "app password" });
    expect(env.emailTransport).toBeNull();
    setEnv({ SMTP_USER: "  ", SMTP_PASS: "pw" });
    expect(env.emailConfigured).toBe(false);
  });

  it("is SMTP when only a mailbox and password are set, sending from that mailbox with the company's name", async () => {
    setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "abcd efgh ijkl mnop" });
    expect(env.emailTransport).toBe("smtp");
    expect(env.emailConfigured).toBe(true);
    const fetched = fakeFetch();
    const result = await sendThroughConfiguredTransport({ ...message, replyTo: "partner@northwind.test" }, { idempotencyKey: "eml_1", fetchImpl: fetched.impl });
    expect(result).toEqual({ ok: true, id: "<abc123@mail.test>", transport: "smtp" });
    expect(fetched.calls).toHaveLength(0);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ from: "Northwind Legal <office@northwind.test>", to: "client@client.test", subject: "Please sign", replyTo: "partner@northwind.test", html: "<p>Hi</p>", text: "Hi" });
    // Gmail by default, TLS from the first byte, pooled, with every wait bounded. Google prints app passwords in groups; the spaces are not part of it.
    expect(smtp.created[0]).toMatchObject({ pool: true, host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "office@northwind.test", pass: "abcdefghijklmnop" } });
    for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) expect(smtp.created[0][key]).toBeLessThanOrEqual(15_000);
  });

  it("prefers Resend when both are fully configured", async () => {
    setEnv({ RESEND_API_KEY: "re_key", EMAIL_FROM: "Agreements <agreements@northwind.test>", SMTP_USER: "office@northwind.test", SMTP_PASS: "pw" });
    expect(env.emailTransport).toBe("resend");
    const fetched = fakeFetch();
    const result = await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_9", fetchImpl: fetched.impl });
    expect(result).toEqual({ ok: true, id: "re_123", transport: "resend" });
    expect(smtp.sent).toHaveLength(0);
    expect(fetched.calls).toHaveLength(1);
    const body = JSON.parse(String(fetched.calls[0].init.body));
    expect(body.from).toBe("Northwind Legal <agreements@northwind.test>");
    expect((fetched.calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe("eml_9");
  });

  it("falls back to SMTP when Resend is only half configured", async () => {
    setEnv({ RESEND_API_KEY: "re_key", SMTP_USER: "office@northwind.test", SMTP_PASS: "pw" });
    expect(env.emailTransport).toBe("smtp");
    setEnv({ EMAIL_FROM: "Front Desk <desk@northwind.test>", SMTP_USER: "office@northwind.test", SMTP_PASS: "pw" });
    expect(env.emailTransport).toBe("smtp");
    // EMAIL_FROM only lends its display name over SMTP; the address is always the mailbox.
    expect(buildFrom("", "smtp")).toEqual({ from: "Front Desk <office@northwind.test>" });
    expect(buildFrom('Evil" <ceo@bank.example>', "smtp")).toEqual({ from: "Evil ceo bank.example <office@northwind.test>" });
  });

  it("honours another host and port, upgrading the connection before the password is sent", async () => {
    setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "p w", SMTP_HOST: "smtp.fastmail.test", SMTP_PORT: "587" });
    await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_1" });
    expect(smtp.created[0]).toMatchObject({ host: "smtp.fastmail.test", port: 587, secure: false, requireTLS: true, auth: { pass: "p w" } });
    setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "pw", SMTP_PORT: "not-a-port" });
    expect(env.smtpPort).toBe(465);
  });

  it("says what to fix when the SMTP user is not an address and there is nothing else to send from", async () => {
    setEnv({ SMTP_USER: "apikey", SMTP_PASS: "pw" });
    const result = await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SMTP_USER/);
    expect(smtp.sent).toHaveLength(0);
    setEnv({ SMTP_USER: "apikey", SMTP_PASS: "pw", EMAIL_FROM: "agreements@northwind.test" });
    expect((await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_2" })).ok).toBe(true);
    expect(smtp.sent[0].from).toBe("Northwind Legal <agreements@northwind.test>");
  });
});

describe("the pooled transporter", () => {
  it("is built once per process and rebuilt only when the configuration changes", async () => {
    setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "pw" });
    for (let i = 0; i < 3; i++) await sendThroughConfiguredTransport(message, { idempotencyKey: `eml_${i}` });
    expect(smtp.created).toHaveLength(1);
    expect(smtp.sent).toHaveLength(3);
    setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "rotated" });
    await sendThroughConfiguredTransport(message, { idempotencyKey: "eml_4" });
    expect(smtp.created).toHaveLength(2);
    expect(smtp.closed).toBe(1);
  });
});

describe("sendViaSmtp", () => {
  const payload = { from: "Northwind <office@northwind.test>", to: "client@client.test", subject: "S", html: "<p>h</p>", text: "h" };
  beforeEach(() => setEnv({ SMTP_USER: "office@northwind.test", SMTP_PASS: "pw" }));

  it("never throws: a refused sign-in comes back as a reason that names the setting", async () => {
    smtp.behaviour = "auth";
    const result = await sendViaSmtp(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/SMTP_USER and SMTP_PASS/);
      expect(result.error).toMatch(/app password/);
      expect(result.error).not.toMatch(/[\r\n]/);
    }
    // One attempt only: SMTP has no idempotency key, so a retry could deliver twice.
    expect(smtp.sent).toHaveLength(1);
  });

  it("reports a recipient the server refused", async () => {
    smtp.behaviour = "reject";
    const result = await sendViaSmtp(payload);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/client@client\.test/);
  });

  it("gives up after a bounded time when the server never answers", async () => {
    smtp.behaviour = "hang";
    const started = Date.now();
    const result = await sendViaSmtp(payload, { timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/did not respond/);
  });

  it("sends attachments as bytes and never lets a value be read as a file path", async () => {
    await sendViaSmtp({ ...payload, attachments: [{ filename: "Agreement (signed).pdf", content: Buffer.from("%PDF-1.7") }] });
    const sentMessage = smtp.sent[0] as { attachments: { filename: string; content: Buffer; contentType?: string }[]; disableFileAccess: boolean; disableUrlAccess: boolean };
    expect(sentMessage.attachments).toHaveLength(1);
    expect(sentMessage.attachments[0]).toMatchObject({ filename: "Agreement (signed).pdf", contentType: "application/pdf" });
    expect(Buffer.isBuffer(sentMessage.attachments[0].content)).toBe(true);
    expect(sentMessage.disableFileAccess).toBe(true);
    expect(sentMessage.disableUrlAccess).toBe(true);
  });
});
