import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./support/globalSetup";

// E2E and UAT for the web app. `pnpm e2e` (repo root) builds the Worker, then runs this.
// One worker: all specs share one Postgres, one fake Auth server and one wrangler dev.
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./support/globalSetup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]] : "list",
  outputDir: "../test-results",
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
