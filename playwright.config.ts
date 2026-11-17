import { defineConfig, devices } from "@playwright/test";

const PORT = 3220;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * End-to-end journeys run against a real dev server with the in-memory database.
 * That database is one process-wide instance, so the suite uses a single worker;
 * each test still makes its own company, which keeps tests independent of order.
 */
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  // The dev server compiles each route the first time it is opened, which can take many seconds.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: BASE_URL,
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", testIgnore: /\.phone\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    // The client side of the product is used mostly on phones. The iPhone descriptor's
    // viewport, touch and user agent run on Chromium, the one browser installed here.
    { name: "phone", testMatch: /\.phone\.spec\.ts$/, use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: `PGLITE_MEMORY=1 NEXT_DIST_DIR=.next-e2e npx next dev -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
