// The README's screenshots (`npm run screens`): tests/screens on the synthetic fixture vault the e2e suite uses, built
// by the same global setup into $AOS_E2E_FIXTURE (the npm script points it outside the checkout, so the e2e fixture and
// any path a picture shows stay apart from this folder).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/screens",
  testMatch: /.*\.screens\.ts$/,
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results/screens",
});
