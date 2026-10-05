// End-to-end parity suite: the HUD checklist (../docs/plugin-smoke.md) as Playwright `_electron` specs against a synthetic
// vault. `npm run test:e2e` builds the app first. Electron windows appear on screen; one worker keeps them sequential.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
});
