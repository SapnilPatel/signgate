import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, emailLog } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  sendEmail,
  sendViaResend,
  getTestOutbox,
  clearTestOutbox,
  setTestEmailFailure,
  setTestEmailUnconfigured,
  normalizeEmailAddress,
  attachmentsFit,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/services/email";
import {
  signingRequestEmail,
  reminderEmail,
  countersignRequestEmail,
  completedEmail,
  declinedEmail,
  voidedEmail,
  expiredEmail,
  deliveryFailedEmail,
  passwordResetEmail,
  inviteEmail,
  inviteExistingAccountEmail,
  signInAlertEmail,
  verifyEmailEmail,
  linkExpiredEmail,
  agreementNotCompletedEmail,
  countersignOverdueEmail,
  finalCopyFailedEmail,
  buttonColors,
  type EmailContent,
} from "@/lib/services/email-templates";

const brand = { orgName: "Northwind Legal", brandColor: "#1f3a5f" };
const SIGN_URL = "https://app.example.test/sign/abc123?x=1&y=2";
const FILE_URL = "https://app.example.test/files/file_1";

/** One of every email, built with the given hostile or ordinary string in every free-text slot. */
function allEmails(s: string, url = SIGN_URL): Record<string, EmailContent> {
  const b = { orgName: s, brandColor: "#1f3a5f" };
  return {
    signing: signingRequestEmail({ brand: b, signerName: s, agreementName: s, fileReference: s, url, message: s, expiresAt: new Date("2026-12-24T10:00:00Z") }),
    reminder: reminderEmail({ brand: b, signerName: s, agreementName: s, fileReference: s, url, reminderNumber: 2, expiresAt: "2026-12-24T10:00:00Z" }),
    countersign: countersignRequestEmail({ brand: b, signerName: s, clientName: s, agreementName: s, fileReference: s, url }),
    completed: completedEmail({ brand: b, recipientName: s, agreementName: s, fileReference: s, downloadUrl: url, attached: true }),
    declined: declinedEmail({ brand: b, recipientName: s, clientName: s, agreementName: s, fileReference: s, reason: s, fileUrl: url }),
    voided: voidedEmail({ brand: b, signerName: s, agreementName: s, reason: s }),
    expired: expiredEmail({ brand: b, recipientName: s, clientName: s, agreementName: s, fileReference: s, fileUrl: url }),
    deliveryFailed: deliveryFailedEmail({ brand: b, recipientName: s, clientName: s, clientEmail: s, fileReference: s, fileUrl: url }),
    passwordReset: passwordResetEmail({ name: s, url }),
    invite: inviteEmail({ orgName: s, inviterName: s, url }),
    inviteExistingAccount: inviteExistingAccountEmail({ orgName: s, inviterName: s, resetUrl: url }),
    signInAlert: signInAlertEmail({ name: s, resetUrl: url }),
    verifyEmail: verifyEmailEmail({ name: s, orgName: s, url }),
    linkExpired: linkExpiredEmail({ brand: b, signerName: s, agreementName: s, expiredOn: s }),
    notCompleted: agreementNotCompletedEmail({ brand: b, signerName: s, agreementName: s }),
    countersignOverdue: countersignOverdueEmail({ brand: b, recipientName: s, clientName: s, agreementName: s, fileReference: s, countersignerName: s, reason: s, fileUrl: url }),
    finalCopyFailed: finalCopyFailedEmail({ brand: b, recipientName: s, clientName: s, agreementName: s, fileReference: s, error: s, fileUrl: url }),
  };
}

function luminance(hex: string): number {
  const c = (o: number) => {
    const v = parseInt(hex.slice(o, o + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("email templates", () => {
  it("escapes every interpolated value in every email", () => {
    const hostile = `<script>alert("x")</script> O'Brien & Sons <img src=x onerror=alert(1)> "quoted"`;
    for (const [name, email] of Object.entries(allEmails(hostile))) {
      expect(email.html, name).not.toMatch(/<script/i);
      expect(email.html, name).not.toMatch(/<img src=x/i);
      expect(email.html, name).not.toMatch(/onerror=alert\(1\)>/);
      expect(email.html, name).toContain("&lt;script&gt;");
      expect(email.html, name).toContain("O&#39;Brien &amp; Sons");
      // No raw double quote from the input may survive inside the markup.
      expect(email.html, name).not.toContain(`alert("x")`);
      // The text alternative carries the value as written.
      expect(email.text, name).toContain("O'Brien & Sons");
    }
  });

  it("keeps emoji and non-Latin names intact", () => {
    const name = "Zoë 🎉 山田太郎";
    for (const [key, email] of Object.entries(allEmails(name))) {
      expect(email.html, key).toContain(name);
      expect(email.text, key).toContain(name);
    }
    const signing = signingRequestEmail({ brand, signerName: name, agreementName: "Client Agreement 🎉", fileReference: "F-1", url: SIGN_URL });
    expect(signing.subject).toContain("Client Agreement 🎉");
  });

  it("does not cut an emoji in half when truncating a long value", () => {
    const long = "🎉".repeat(500);
    const email = signingRequestEmail({ brand, signerName: long, agreementName: long, fileReference: "F-1", url: SIGN_URL });
    // A lone surrogate would make the string ill-formed.
    expect(email.subject.isWellFormed()).toBe(true);
    expect(email.html.isWellFormed()).toBe(true);
    expect(Array.from(email.subject).length).toBeLessThanOrEqual(200);
  });

  it("strips line breaks and control characters from subjects", () => {
    const inject = "Agreement\r\nBcc: attacker@evil.test\nX-Injected: 1\u2028more\u0000";
    for (const [name, email] of Object.entries(allEmails(inject))) {
      expect(email.subject, name).not.toMatch(/[\r\n\u2028\u2029\u0000-\u001f\u007f-\u009f]/);
      expect(email.subject.length, name).toBeLessThanOrEqual(200);
      expect(email.subject.length, name).toBeGreaterThan(0);
    }
  });

  it("removes bidirectional override characters that can disguise a name", () => {
    const email = declinedEmail({ brand, recipientName: "Sam", clientName: "Jo\u202egro.live", agreementName: "A", fileReference: "F-1", fileUrl: FILE_URL });
    expect(email.html).not.toContain("\u202e");
    expect(email.text).not.toContain("\u202e");
    expect(email.subject).not.toContain("\u202e");
  });

  it("gives every email a complete plain-text alternative", () => {
    const emails = allEmails("Dana Example");
    for (const [name, email] of Object.entries(emails)) {
      expect(email.text, name).not.toMatch(/<[a-z!/]/i);
      expect(email.text, name).not.toMatch(/&(amp|lt|gt|quot|#39|nbsp);/);
      expect(email.text.length, name).toBeGreaterThan(120);
      // These three tell someone a link is dead; they deliberately carry no link.
      if (!["voided", "linkExpired", "notCompleted"].includes(name)) {
        // The link appears unescaped, on its own line, so it stays clickable in a text client.
        expect(email.text.split("\n"), name).toContain(SIGN_URL);
        // And in the HTML both as the button and as visible raw text.
        const escaped = SIGN_URL.replace(/&/g, "&amp;");
        expect(email.html.split(`href="${escaped}"`).length - 1, name).toBe(2);
        expect(email.html, name).toContain(`>${escaped}</a>`);
      }
    }
    // Every sentence a reader sees in the HTML is also in the text version.
    const signing = signingRequestEmail({
      brand,
      signerName: "Dana Example",
      agreementName: "Client Services Agreement",
      fileReference: "F-2026-0007",
      url: SIGN_URL,
      message: "Thanks for choosing us.\nCall if anything is unclear.",
      expiresAt: new Date("2026-12-24T23:30:00Z"),
    });
    for (const fragment of [
      "Hi Dana Example,",
      "Northwind Legal has sent you Client Services Agreement to sign for file F-2026-0007.",
      "> Thanks for choosing us.\n> Call if anything is unclear.",
      "about two minutes",
      "24 December 2026",
      "This request comes from Northwind Legal.",
    ]) {
      expect(signing.text).toContain(fragment);
    }
    expect(signing.html).toContain("Thanks for choosing us.<br>Call if anything is unclear.");
  });

  it("makes the signing request come from the organization, not the product", () => {
    const email = signingRequestEmail({ brand, signerName: "Dana", agreementName: "Client Agreement", fileReference: "F-1", url: SIGN_URL });
    expect(email.subject).toBe("Northwind Legal needs your signature: Client Agreement (F-1)");
    expect(email.subject).not.toContain("Signgate");
    expect(email.text.indexOf("Northwind Legal")).toBeLessThan(email.text.indexOf("Signgate"));
    // The product is named once, in the footer, so the recipient can see who relays the message.
    expect(email.text.match(/Signgate/g)).toHaveLength(1);
  });

  it("omits optional parts cleanly when they are missing or invalid", () => {
    const email = signingRequestEmail({ brand: { orgName: "" }, signerName: "  ", agreementName: "", fileReference: "", url: SIGN_URL, message: "   ", expiresAt: "not a date" });
    expect(email.text).toContain("Hello,");
    expect(email.text).not.toContain("A note from");
    expect(email.text).not.toContain("stops working");
    expect(email.text).not.toContain("undefined");
    expect(email.text).not.toContain("()");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("Invalid Date");

    const runtimeJunk = signingRequestEmail({
      brand: undefined as never,
      signerName: null as never,
      agreementName: 42 as never,
      fileReference: undefined as never,
      url: undefined as never,
    });
    expect(runtimeJunk.subject.length).toBeGreaterThan(0);
    expect(runtimeJunk.text).not.toMatch(/undefined|null/);
  });

  it("never emits a link that is not http(s)", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "not a url", "", "  ", "file:///etc/passwd"]) {
      for (const [name, email] of Object.entries(allEmails("Dana", bad))) {
        expect(email.html, `${name} ${bad}`).not.toContain("href=");
        expect(email.html, `${name} ${bad}`).not.toMatch(/javascript:|data:text|file:\/\//);
      }
    }
    const quoted = signingRequestEmail({ brand, signerName: "D", agreementName: "A", fileReference: "F", url: `https://app.example.test/sign/a"onmouseover="x` });
    expect(quoted.html).not.toMatch(/href="[^"]*"onmouseover/);
  });

  it("uses a logo only when it is a real URL", () => {
    const withLogo = signingRequestEmail({ brand: { ...brand, logoUrl: "https://cdn.example.test/logo.png" }, signerName: "D", agreementName: "A", fileReference: "F", url: SIGN_URL });
    expect(withLogo.html).toContain(`<img src="https://cdn.example.test/logo.png" alt="Northwind Legal"`);
    for (const logoUrl of ["data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)", "logo.png", ""]) {
      const email = signingRequestEmail({ brand: { ...brand, logoUrl }, signerName: "D", agreementName: "A", fileReference: "F", url: SIGN_URL });
      expect(email.html, logoUrl).not.toContain("<img");
      expect(email.html, logoUrl).toContain("Northwind Legal");
    }
  });

  it("picks a readable text colour for any brand colour", () => {
    for (const color of ["#ffffff", "#fff8b0", "#ffff00", "#00ff00", "#ff0000", "#1f3a5f", "#000000", "#808080", "#abc", "7a7a7a"]) {
      const { background, text } = buttonColors(color);
      expect(background).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(background, text), color).toBeGreaterThanOrEqual(4.5);
    }
    expect(buttonColors("#fff8b0").text).toBe("#111827");
    expect(buttonColors("#1f3a5f").text).toBe("#ffffff");
    // A white button gets an outline so it is visible on the white card.
    expect(buttonColors("#ffffff").border).not.toBe("#ffffff");
  });

  it("falls back to the default colour for anything that is not a hex colour", () => {
    for (const bad of ["red", "#12345", "url(javascript:1)", `#fff;background:url(x)`, `"><script>`, "", undefined]) {
      expect(buttonColors(bad).background).toBe("#1f3a5f");
      const email = signingRequestEmail({ brand: { orgName: "Acme", brandColor: bad }, signerName: "D", agreementName: "A", fileReference: "F", url: SIGN_URL });
      expect(email.html).not.toContain("<script>");
      expect(email.html).not.toContain("url(");
    }
  });

  it("uses only inline styles and a table layout capped at 600 pixels", () => {
    for (const [name, email] of Object.entries(allEmails("Dana"))) {
      expect(email.html, name).not.toMatch(/<style|<link|@import|@font-face|<script/i);
      expect(email.html, name).toContain("max-width:600px");
      expect(email.html, name).toContain('role="presentation"');
      expect(email.html.startsWith("<!DOCTYPE html>"), name).toBe(true);
    }
  });

  it("words each email for its situation", () => {
    const attached = completedEmail({ brand, recipientName: "Dana", agreementName: "Client Agreement", fileReference: "F-1", downloadUrl: SIGN_URL, attached: true });
    const linked = completedEmail({ brand, recipientName: "Dana", agreementName: "Client Agreement", fileReference: "F-1", downloadUrl: SIGN_URL, attached: false });
    expect(attached.text).toContain("is attached");
    expect(linked.text).not.toContain("attached");
    expect(linked.text).toContain(SIGN_URL);

    const noReason = declinedEmail({ brand, recipientName: "Sam", clientName: "Dana", agreementName: "A", fileReference: "F-1", fileUrl: FILE_URL });
    expect(noReason.text).toContain("did not give a reason");
    const withReason = declinedEmail({ brand, recipientName: "Sam", clientName: "Dana", agreementName: "A", fileReference: "F-1", reason: "Clause 4 is wrong", fileUrl: FILE_URL });
    expect(withReason.text).toContain("> Clause 4 is wrong");

    const first = reminderEmail({ brand, signerName: "Dana", agreementName: "A", fileReference: "F-1", url: SIGN_URL, reminderNumber: 1 });
    const later = reminderEmail({ brand, signerName: "Dana", agreementName: "A", fileReference: "F-1", url: SIGN_URL, reminderNumber: Number.NaN });
    expect(first.text).toContain("A quick reminder");
    expect(later.text).toContain("A quick reminder");
    expect(reminderEmail({ brand, signerName: "Dana", agreementName: "A", fileReference: "F-1", url: SIGN_URL, reminderNumber: 3 }).text).toContain("Following up again");

    const failed = deliveryFailedEmail({ brand, recipientName: "Sam", clientName: "Dana Example", clientEmail: "dana@exmaple.test", fileReference: "F-9", fileUrl: FILE_URL });
    expect(failed.text).toContain("Email used: dana@exmaple.test");
    expect(failed.text).toContain(FILE_URL);

    const voided = voidedEmail({ brand, signerName: "Dana", agreementName: "A", reason: "Sent to the wrong person" });
    expect(voided.html).not.toContain("href=");
    expect(voided.text).toContain("> Sent to the wrong person");
  });
});

describe("notices added for held links and stuck agreements", () => {
  it("tells a signer their link expired in the company's own branding, without saying anyone cancelled", () => {
    const email = linkExpiredEmail({ brand, signerName: "Fay Client", agreementName: "Engagement letter", expiredOn: "3 December 2026" });
    expect(email.subject).toBe("Your signing link for Engagement letter has expired");
    expect(email.text).toMatch(/expired on 3 December 2026 before the agreement was signed/);
    expect(email.text).toMatch(/ask them to send the agreement again/);
    expect(email.text).not.toMatch(/cancel/i);
    // Branded like every other client email: the accent bar and the company as sender.
    expect(email.html).toContain("background-color:#1f3a5f");
    expect(email.html).toContain("Northwind Legal");
    expect(email.text).toMatch(/Sent by Northwind Legal through/);
    expect(linkExpiredEmail({ brand, signerName: "", agreementName: "" }).text).toMatch(/^Hello,\n\nThe link Northwind Legal sent you to sign the agreement expired before/);
  });

  it("tells a client who signed that the agreement is not in effect", () => {
    const email = agreementNotCompletedEmail({ brand, signerName: "Fay Client", agreementName: "Engagement letter" });
    expect(email.subject).toBe("Engagement letter with Northwind Legal was not completed");
    expect(email.text).toMatch(/You signed Engagement letter, but Northwind Legal did not countersign it/);
    expect(email.text).toMatch(/not in effect/);
    expect(email.html).toContain("background-color:#1f3a5f");
  });

  it("tells the team the company's own signature is overdue, with why and where to act", () => {
    const email = countersignOverdueEmail({
      brand,
      recipientName: "Olive Owner",
      clientName: "Casey Example",
      agreementName: "Engagement letter",
      fileReference: "F-2026-0007",
      countersignerName: "Sam Lee",
      reason: "Sam Lee was asked to countersign and has not done so after 5 reminders.",
      fileUrl: FILE_URL,
    });
    expect(email.subject).toBe("Countersignature overdue: Casey Example is waiting on Engagement letter (F-2026-0007)");
    expect(email.text).toMatch(/Casey Example has signed Engagement letter for file F-2026-0007, but it has not been countersigned for Northwind Legal/);
    expect(email.text).toMatch(/after 5 reminders\.\n/);
    expect(email.text).toContain(`Open the file:\n${FILE_URL}`);
    expect(email.text).toMatch(/You are receiving this because you are on the Northwind Legal team/);
    // Without a reason it still says something true.
    const bare = countersignOverdueEmail({ brand, recipientName: "O", clientName: "C", agreementName: "A", fileReference: "", fileUrl: FILE_URL });
    expect(bare.text).toMatch(/Nobody is set up to countersign for your company\./);
    expect(countersignOverdueEmail({ brand, recipientName: "O", clientName: "C", agreementName: "A", fileReference: "", countersignerName: "Sam Lee", fileUrl: FILE_URL }).text).toMatch(
      /Sam Lee was asked to countersign and has not done so\./,
    );
  });

  it("tells the team the final copy is stuck, that signatures are safe and that it is being retried", () => {
    const email = finalCopyFailedEmail({
      brand,
      recipientName: "Olive Owner",
      clientName: "Casey Example",
      agreementName: "Engagement letter",
      fileReference: "F-2026-0007",
      error: "The original agreement PDF is missing from storage.",
      fileUrl: FILE_URL,
    });
    expect(email.subject).toBe("Signed, but the final copy could not be produced: Engagement letter (F-2026-0007)");
    expect(email.text).toMatch(/Casey Example has not received their copy yet/);
    expect(email.text).toMatch(/nothing needs to be signed again/);
    expect(email.text).toMatch(/What went wrong: The original agreement PDF is missing from storage\./);
    expect(email.text).toContain(FILE_URL);
    expect(finalCopyFailedEmail({ brand, recipientName: "O", clientName: "C", agreementName: "A", fileReference: "", fileUrl: FILE_URL }).text).not.toMatch(/What went wrong/);
  });

  it("asks a new owner to confirm their address and says what is on hold until they do", () => {
    const email = verifyEmailEmail({ name: "Fran Founder", orgName: "Northwind Legal", url: "https://app.example.test/verify-email/abc" });
    expect(email.subject).toMatch(/^Confirm your email address/);
    expect(email.text).toContain("Confirm my email address:\nhttps://app.example.test/verify-email/abc");
    expect(email.text).toMatch(/does not email agreements to your clients/);
    expect(email.text).toMatch(/copy each signing link/);
    expect(email.text).toMatch(/expires after 48 hours/);
  });
});

describe("account notices", () => {
  const RESET = "https://app.example.test/forgot-password";

  it("tells an invited person with an existing account why they cannot join and what to do, without a join link", () => {
    const mail = inviteExistingAccountEmail({ orgName: "Northwind Legal", inviterName: "Dana Reyes", resetUrl: RESET });
    expect(mail.subject).toBe("Dana Reyes tried to invite you to Northwind Legal on Signgate");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("already has a Signgate account with a different company");
      expect(body).toContain("invite you at a different email address");
      expect(body).toContain(RESET);
      expect(body).not.toContain("/invite/");
    }
  });

  it("tells an account holder about failed sign-ins and that they are not locked out", () => {
    const mail = signInAlertEmail({ name: "Dana Reyes", resetUrl: RESET });
    expect(mail.subject).toBe("Many failed sign-in attempts on your Signgate account");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Dana");
      expect(body).toContain("not locked");
      expect(body).toContain(RESET);
    }
  });

  it("falls back to safe wording when names are missing or not strings", () => {
    const mail = inviteExistingAccountEmail({ orgName: null as never, inviterName: 42 as never, resetUrl: "javascript:alert(1)" });
    expect(mail.subject).toContain("tried to invite you to");
    expect(mail.html).not.toContain("javascript:");
    expect(() => signInAlertEmail({ name: undefined as never, resetUrl: undefined as never })).not.toThrow();
  });
});

describe("sendEmail", () => {
  let orgId: string;
  const base = { kind: "signing_request", subject: "Please sign", html: "<p>Hello</p>", text: `Hello\n${SIGN_URL}` };

  async function logFor(to: string) {
    const db = await getDb();
    return db.select().from(emailLog).where(eq(emailLog.to, to));
  }

  beforeAll(async () => {
    const db = await getDb();
    orgId = newId("org");
    await db.insert(orgs).values({ id: orgId, name: "Northwind Legal", slug: "northwind-email-test" });
  });

  beforeEach(() => {
    clearTestOutbox();
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures the message in tests and logs it as sent", async () => {
    const result = await sendEmail({ ...base, orgId, to: " dana@example.test ", replyTo: "office@northwind.test", fromName: "Northwind Legal" });
    expect(result.status).toBe("sent");
    expect(result.id).toBeTruthy();
    expect(result.error).toBeUndefined();

    const outbox = getTestOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      to: "dana@example.test",
      from: "Northwind Legal <agreements@signgate.test>",
      replyTo: "office@northwind.test",
      subject: "Please sign",
      kind: "signing_request",
      orgId,
    });

    const rows = await logFor("dana@example.test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId, status: "sent", kind: "signing_request", subject: "Please sign", error: null, providerId: result.id });
  });

  it("uses the configured sender address and only replaces the display name", async () => {
    process.env.EMAIL_FROM = "Signgate <agreements@mail.example.test>";
    await sendEmail({ ...base, to: "a1@example.test", fromName: "Northwind Legal" });
    await sendEmail({ ...base, to: "a2@example.test" });
    process.env.EMAIL_FROM = "bare@mail.example.test";
    await sendEmail({ ...base, to: "a3@example.test" });
    const [named, fallback, bare] = getTestOutbox();
    expect(named.from).toBe("Northwind Legal <agreements@mail.example.test>");
    expect(fallback.from).toBe("Signgate <agreements@mail.example.test>");
    expect(bare.from).toBe("bare@mail.example.test");
  });

  it("neutralizes header injection in the sender name, subject and reply-to", async () => {
    await sendEmail({
      ...base,
      to: "inject@example.test",
      subject: "Please sign\r\nBcc: attacker@evil.test\n\nX: 1",
      fromName: `Acme" <ceo@bank.test>\r\nBcc: attacker@evil.test, Other <x@y.test>`,
      replyTo: "office@northwind.test\r\nBcc: attacker@evil.test",
    });
    const [sent] = getTestOutbox();
    expect(sent.subject).toBe("Please sign Bcc: attacker@evil.test X: 1");
    expect(sent.from).not.toMatch(/[\r\n"]/);
    // Exactly one address, and it is ours.
    expect(sent.from.match(/[<>@]/g)).toEqual(["<", "@", ">"]);
    expect(sent.from.endsWith("<agreements@signgate.test>")).toBe(true);
    expect(sent.replyTo).toBeUndefined();
    const [row] = await logFor("inject@example.test");
    expect(row.subject).not.toMatch(/[\r\n]/);
  });

  it("falls back to the configured name when the sender name is only unsafe characters", async () => {
    await sendEmail({ ...base, to: "blank@example.test", fromName: `<>"\r\n@,;` });
    expect(getTestOutbox()[0].from).toBe("Signgate <agreements@signgate.test>");
  });

  it("rejects invalid recipients without sending or throwing", async () => {
    const bad = [
      "",
      "   ",
      "no-at-sign",
      "two@@example.test",
      "a@b",
      "a b@example.test",
      "dana@example.test, other@example.test",
      "dana@example.test\r\nBcc: x@y.test",
      "Dana <dana@example.test>",
      ".dana@example.test",
      "dana@-example.test",
      "dana@example..test",
      `${"a".repeat(65)}@example.test`,
      `a@${"b".repeat(250)}.test`,
    ];
    for (const to of bad) {
      const result = await sendEmail({ ...base, to });
      expect(result.status, JSON.stringify(to)).toBe("failed");
      expect(result.error, JSON.stringify(to)).toMatch(/not a valid email address/);
    }
    for (const to of [undefined, null, 42, {}, ["a@example.test"]]) {
      const result = await sendEmail({ ...base, to: to as never });
      expect(result.status).toBe("failed");
    }
    expect(getTestOutbox()).toHaveLength(0);
    const db = await getDb();
    const failed = await db.select().from(emailLog).where(eq(emailLog.status, "failed"));
    expect(failed.length).toBeGreaterThanOrEqual(bad.length);
    expect(failed.every((row) => !/[\r\n]/.test(row.to))).toBe(true);
  });

  it("accepts ordinary and unusual but valid addresses", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.co.uk", "o'brien@example.test", "UPPER@EXAMPLE.TEST", "user@xn--bcher-kva.example"]) {
      expect(normalizeEmailAddress(ok), ok).toBe(ok);
    }
    expect(normalizeEmailAddress("  padded@example.test \n")).toBe("padded@example.test");
  });

  it("survives a message that is missing fields entirely", async () => {
    await expect(sendEmail(undefined as never)).resolves.toMatchObject({ status: "failed" });
    await expect(sendEmail({} as never)).resolves.toMatchObject({ status: "failed" });
    const empty = await sendEmail({ kind: "x", to: "empty@example.test", subject: "", html: "", text: "  " });
    expect(empty).toMatchObject({ status: "failed", error: expect.stringContaining("no content") });
    const noSubject = await sendEmail({ kind: "", to: "nosubject@example.test", subject: undefined as never, html: "<p>x</p>", text: "x" });
    expect(noSubject.status).toBe("sent");
    expect(getTestOutbox()[0].subject).toBe("Message from Signgate");
    expect((await logFor("nosubject@example.test"))[0].kind).toBe("unknown");
  });

  it("records a forced failure with the provider's error text", async () => {
    setTestEmailFailure("Email provider returned 422: The domain is not verified.");
    const result = await sendEmail({ ...base, orgId, to: "fail@example.test" });
    expect(result).toEqual({ status: "failed", error: "Email provider returned 422: The domain is not verified." });
    expect(getTestOutbox()).toHaveLength(0);
    const [row] = await logFor("fail@example.test");
    expect(row).toMatchObject({ status: "failed", error: "Email provider returned 422: The domain is not verified.", providerId: null });

    setTestEmailFailure(null);
    expect((await sendEmail({ ...base, to: "recovered@example.test" })).status).toBe("sent");
  });

  it("can fail one recipient while others are delivered", async () => {
    setTestEmailFailure("Mailbox does not exist", "Bounce@Example.test");
    expect((await sendEmail({ ...base, to: "bounce@example.test" })).status).toBe("failed");
    expect((await sendEmail({ ...base, to: "fine@example.test" })).status).toBe("sent");
    expect(getTestOutbox().map((m) => m.to)).toEqual(["fine@example.test"]);
  });

  it("skips and logs the link for the developer when email is not configured", async () => {
    setTestEmailUnconfigured(true);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await sendEmail({ ...base, orgId, to: "skipped@example.test" });
    expect(result).toEqual({ status: "skipped" });
    expect(getTestOutbox()).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
    const logged = String(info.mock.calls[0][0]);
    expect(logged).toContain("Please sign");
    expect(logged).toContain(SIGN_URL);
    const [row] = await logFor("skipped@example.test");
    expect(row).toMatchObject({ status: "skipped", error: null });
  });

  it("still reports an invalid address when email is not configured", async () => {
    setTestEmailUnconfigured(true);
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await sendEmail({ ...base, to: "nope" })).status).toBe("failed");
  });

  it("keeps the log row when the org or envelope reference no longer exists", async () => {
    const result = await sendEmail({ ...base, orgId: "org_deleted_long_ago", envelopeId: "env_never_existed", to: "orphan@example.test" });
    expect(result.status).toBe("sent");
    const [row] = await logFor("orphan@example.test");
    expect(row).toMatchObject({ status: "sent", orgId: null, envelopeId: null });
  });

  it("cleans NUL bytes, which Postgres cannot store, before writing the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendEmail({ ...base, kind: "k\u0000ind", subject: "Sub\u0000ject", to: "nul@example.test" });
    expect(result.status).toBe("sent");
    expect((await logFor("nul@example.test"))[0]).toMatchObject({ kind: "k ind", subject: "Sub ject" });
    expect(error).not.toHaveBeenCalled();
  });

  it("sends small attachments and drops them when they are too large", async () => {
    const pdf = Buffer.from("%PDF-1.7 test data");
    await sendEmail({ ...base, to: "small@example.test", attachments: [{ filename: "../../etc/Signed: agreement.pdf", content: pdf }] });
    const [small] = getTestOutbox();
    expect(small.attachments).toHaveLength(1);
    expect(small.attachments[0].filename).toBe("..-..-etc-Signed- agreement.pdf");
    expect(small.attachments[0].content.equals(pdf)).toBe(true);

    clearTestOutbox();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
    const result = await sendEmail({ ...base, to: "big@example.test", attachments: [{ filename: "signed.pdf", content: big }] });
    expect(result.status).toBe("sent");
    expect(getTestOutbox()[0].attachments).toEqual([]);

    // The limit is on the total, and it is all or nothing.
    clearTestOutbox();
    const half = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1, 1);
    await sendEmail({ ...base, to: "two@example.test", attachments: [{ filename: "a.pdf", content: half }, { filename: "b.pdf", content: half }] });
    expect(getTestOutbox()[0].attachments).toEqual([]);

    expect(attachmentsFit([{ content: pdf }])).toBe(true);
    expect(attachmentsFit([{ content: big }])).toBe(false);
    expect(attachmentsFit([{ content: half }, { content: half }])).toBe(false);
    expect(attachmentsFit(undefined)).toBe(true);
  });

  it("ignores malformed attachments instead of failing the send", async () => {
    const result = await sendEmail({
      ...base,
      to: "malformed@example.test",
      attachments: [null, { filename: "empty.pdf", content: Buffer.alloc(0) }, { filename: "str.pdf", content: "not bytes" }, { content: Buffer.from("ok") }] as never,
    });
    expect(result.status).toBe("sent");
    expect(getTestOutbox()[0].attachments.map((a) => a.filename)).toEqual(["attachment"]);
    expect((await sendEmail({ ...base, to: "notarray@example.test", attachments: "nope" as never })).status).toBe("sent");
  });

  it("delivers a real template end to end", async () => {
    const email = signingRequestEmail({ brand, signerName: "Dana <b>Example</b>", agreementName: "Client Agreement", fileReference: "F-1", url: SIGN_URL });
    const result = await sendEmail({ ...email, kind: "signing_request", orgId, to: "template@example.test", fromName: brand.orgName });
    expect(result.status).toBe("sent");
    const [sent] = getTestOutbox();
    expect(sent.html).toContain("Dana &lt;b&gt;Example&lt;/b&gt;");
    expect(sent.text).toContain(SIGN_URL);
  });
});

describe("sendViaResend", () => {
  const payload = { from: "Northwind Legal <agreements@mail.example.test>", to: "dana@example.test", subject: "Please sign", html: "<p>Hi</p>", text: "Hi" };
  const options = { apiKey: "re_test_key", idempotencyKey: "eml_abc", retryDelayMs: 1 };
  const json = (status: number, body: unknown, headers?: Record<string, string>) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

  it("posts the message and returns the provider id", async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: "re_123" }));
    const result = await sendViaResend(
      { ...payload, replyTo: "office@northwind.test", attachments: [{ filename: "signed.pdf", content: Buffer.from("pdf") }] },
      { ...options, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: true, id: "re_123" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Idempotency-Key"]).toBe("eml_abc");
    expect(JSON.parse(String(init.body))).toEqual({
      from: payload.from,
      to: ["dana@example.test"],
      subject: "Please sign",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: "office@northwind.test",
      attachments: [{ filename: "signed.pdf", content: Buffer.from("pdf").toString("base64") }],
    });
  });

  it("retries once after a 429 or 5xx, with the same idempotency key", async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(json(status, { message: "busy" })).mockResolvedValueOnce(json(200, { id: "re_ok" }));
      const result = await sendViaResend(payload, { ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(result, String(status)).toEqual({ ok: true, id: "re_ok" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const keys = fetchImpl.mock.calls.map((call) => (call[1].headers as Record<string, string>)["Idempotency-Key"]);
      expect(keys).toEqual(["eml_abc", "eml_abc"]);
    }
  });

  it("gives up after the second failure and reports the provider's words", async () => {
    const fetchImpl = vi.fn(async () => json(503, { statusCode: 503, name: "internal_server_error", message: "Service unavailable" }));
    const result = await sendViaResend(payload, { ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error: "Email provider returned 503: Service unavailable." });
  });

  it("does not retry a rejection the provider will repeat", async () => {
    const fetchImpl = vi.fn(async () => json(403, { message: "The example.test domain is not verified." }));
    const result = await sendViaResend(payload, { ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("403");
      expect(result.error).toContain("domain is not verified");
      expect(result.error).toContain("EMAIL_FROM");
    }
  });

  it("copes with error bodies that are not JSON", async () => {
    const fetchImpl = vi.fn(async () => json(400, "<html>\r\n<h1>Bad Gateway</h1></html>"));
    const result = await sendViaResend(payload, { ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/[\r\n]/);
  });

  it("treats a 2xx with an unreadable body as sent", async () => {
    const fetchImpl = vi.fn(async () => json(200, "ok"));
    expect(await sendViaResend(payload, { ...options, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: true, id: undefined });
  });

  it("retries once on a network error and then reports it", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(200, { id: "re_2" }));
    expect(await sendViaResend(payload, { ...options, fetchImpl: flaky as unknown as typeof fetch })).toEqual({ ok: true, id: "re_2" });

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await sendViaResend(payload, { ...options, fetchImpl: down as unknown as typeof fetch });
    expect(down).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error: "Could not reach the email provider: fetch failed." });
  });

  it("stops waiting when the provider hangs", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    const result = await sendViaResend(payload, { ...options, timeoutMs: 40, fetchImpl: hang as unknown as typeof fetch });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hang).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not respond");
  });
});
