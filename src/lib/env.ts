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
  get emailConfigured(): boolean {
    return Boolean(this.resendApiKey && this.emailFrom);
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
