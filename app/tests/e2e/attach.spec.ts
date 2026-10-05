// Phase 5, attach mode: an existing install opens straight into the Workbench. The "What changed" note shows once per
// vault; a vault whose runtime is older than the one the app carries gets a status bar item and a dialog that runs
// `aos upgrade` from the payload, on request only; the app's own update shows as Restart to update once downloaded.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, SETUP, aosCalls, installSetupStubs, launchApp, restoreFixture, type AppHandle } from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const AGENTICOS = path.join(FX.claude, "agenticos.json");

test.describe.configure({ mode: "serial" });

let h: AppHandle | null = null;
test.afterEach(async () => { await h?.close(); h = null; });

test("the What changed note shows the first time a vault is opened, and not again", async () => {
  restoreFixture();
  h = await launchApp({ noted: false });
  const note = h.win.locator(".aos-attach-modal");
  await expect(note.locator(".modal-title")).toHaveText("AgenticOS Workbench is an app now");
  await expect(note.locator(".aos-attach-list li")).toHaveCount(4);
  await note.locator(".aos-attach-ok").click();
  await expect(note).toHaveCount(0);
  // No payload in a dev run: nothing to upgrade from.
  await expect(h.win.locator(".aos-host-runtime")).toHaveCount(0);
  expect(h.errors).toEqual([]);
  await h.close();

  // Same data folder (launchApp only forgets the note when asked): no note.
  h = await launchApp({ noted: true });
  await h.win.waitForTimeout(500);
  await expect(h.win.locator(".aos-attach-modal")).toHaveCount(0);
});

test("a runtime older than the app's offers aos upgrade, and runs it only when asked", async () => {
  restoreFixture();
  h = await launchApp({
    prepare: () => {
      installSetupStubs(VERSION);
      const cfg = JSON.parse(fs.readFileSync(AGENTICOS, "utf8")) as { version: string };
      cfg.version = "0.1.0";
      fs.writeFileSync(AGENTICOS, `${JSON.stringify(cfg, null, 2)}\n`);
    },
    env: { AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin },
  });
  const { win } = h;
  await expect(win.locator(".aos-host-runtime")).toHaveText(`⬆ Runtime 0.1.0 → ${VERSION}`);
  // The dialog opens on its own once per launch; nothing has run yet.
  const dialog = win.locator(".aos-runtime-modal");
  await expect(dialog.locator(".modal-title")).toHaveText("Update the runtime in your vault");
  expect(aosCalls()).toEqual([]);
  await win.screenshot({ path: test.info().outputPath("runtime-dialog.png") });
  await dialog.locator(".aos-runtime-go").click();
  await expect(dialog.locator(".aos-setup-status")).toHaveText(`Updated to ${VERSION}.`, { timeout: 20_000 });
  expect(aosCalls().map((c) => c.argv)).toEqual([["upgrade"]]);
  expect((JSON.parse(fs.readFileSync(AGENTICOS, "utf8")) as { version: string }).version).toBe(VERSION);
  await dialog.locator("button", { hasText: "Close" }).click();
  await expect(win.locator(".aos-host-runtime")).toHaveClass(/is-hidden/);
  expect(h.errors).toEqual([]);
});

test("the app's own update: off in a dev run, and Restart to update asks main once one is downloaded", async () => {
  restoreFixture();
  h = await launchApp();
  const { app, win } = h;
  const boot = await win.evaluate(() => (window as unknown as { aosHost: { info: { update: unknown } } }).aosHost.info.update);
  expect(boot).toMatchObject({ status: "off", reason: "a development run" });
  const item = win.locator(".aos-host-update");
  await expect(item).toHaveClass(/is-hidden/);
  await app.evaluate(() => (globalThis as unknown as { __aosMain: { setUpdateState(s: unknown): void } }).__aosMain.setUpdateState({ status: "downloaded", version: "9.9.9", percent: 100 }));
  await expect(item).toHaveText("⬆ Restart to update to 9.9.9");
  await item.click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __aosMain: { installRequests(): number } }).__aosMain.installRequests())).toBe(1);
  // The menu offers the same.
  const label = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((i) => i.label).find((l) => /Update/.test(l)));
  expect(label).toBe("Restart to Update to 9.9.9");
  expect(h.errors).toEqual([]);
});
