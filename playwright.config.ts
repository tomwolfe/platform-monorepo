import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright Configuration for E2E Tests
 *
 * Tests critical user journeys:
 * - Reservation flow
 * - Driver dashboard
 * - Authentication flows
 *
 * @see Phase 2.1: Add Critical Path E2E Tests
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html"], ["json", { outputFile: "e2e-results.json" }]]
    : [["list"], ["html"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    // Mobile viewports
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
    },
  ],

  outputDir: "e2e-results/",

  webServer: process.env.CI
    ? undefined
    : {
        command: "pnpm dev --filter=@repo/table-stack",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120000,
      },
});
