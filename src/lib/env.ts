/**
 * Central place for environment configuration. Everything optional degrades
 * gracefully: no email provider means signing links are shown for manual
 * sharing, no AI key means rule-based field detection.
 */
export const env = {
  /** Public base URL used in emailed links. Falls back to the Vercel URL, then localhost. */
  get appUrl(): string {
    const explicit = process.env.APP_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (vercel) return `https://${vercel}`;
    return `http://localhost:${process.env.PORT ?? 3000}`;
  },
  /** Key for deriving signing-link secrets. Required in production. */
  get appSecret(): string {
    const secret = process.env.APP_SECRET?.trim();
    if (secret && secret.length >= 32) return secret;
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_SECRET is not set (or is shorter than 32 characters). Set it to a long random string.");
    }
    return "dev-only-secret-do-not-use-in-production-0000";
  },
  get resendApiKey(): string | undefined {
    return process.env.RESEND_API_KEY?.trim() || undefined;
  },
  /** e.g. "Signgate <agreements@example.com>"; the domain must be verified with the provider. */
  get emailFrom(): string | undefined {
    return process.env.EMAIL_FROM?.trim() || undefined;
  },
  /** Mailbox to send through over SMTP, e.g. a Gmail or Google Workspace address. Also the From address. */
  get smtpUser(): string | undefined {
    return process.env.SMTP_USER?.trim() || undefined;
  },
  /** For Gmail this is an app password, not the account password. Spaces are ignored, as Google prints it in groups of four. */
  get smtpPass(): string | undefined {
    const raw = process.env.SMTP_PASS?.trim();
    if (!raw) return undefined;
    return this.smtpHost === "smtp.gmail.com" ? raw.replace(/\s+/g, "") : raw;
  },
  get smtpHost(): string {
    return process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  },
  get smtpPort(): number {
    const port = Number(process.env.SMTP_PORT?.trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 465;
  },
  /**
   * Which way email leaves: Resend when it is fully configured, otherwise SMTP when a
   * mailbox and password are set, otherwise nowhere (links are shown for sharing by hand).
   */
  get emailTransport(): "resend" | "smtp" | null {
    if (this.resendApiKey && this.emailFrom) return "resend";
    if (this.smtpUser && this.smtpPass) return "smtp";
    return null;
  },
  get emailConfigured(): boolean {
    return this.emailTransport !== null;
  },
  get anthropicApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  },
  /** Shared secret that authorizes the scheduled-jobs endpoint. */
  get cronSecret(): string | undefined {
    return process.env.CRON_SECRET?.trim() || undefined;
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  get isTest(): boolean {
    return process.env.NODE_ENV === "test";
  },
};

export const PRODUCT_NAME = "Signgate";
