import { defineConfig } from "@playwright/test";

/**
 * Runs the live smoke test against a deployed instance:
 *   LIVE_URL=https://... SMTP_USER=... SMTP_PASS=... npx playwright test -c playwright.live.config.ts
 * It creates a real company and sends real email, so it uses a mailbox we control.
 */
export default defineConfig({
  testDir: "tests/live",
  outputDir: "test-results/live",
  workers: 1,
  reporter: [["list"]],
  timeout: 420_000,
  expect: { timeout: 45_000 },
  use: {
    baseURL: process.env.LIVE_URL,
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
