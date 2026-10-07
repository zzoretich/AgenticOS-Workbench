// The README's screenshots: the app on the synthetic fixture vault (scripts/make-fixture-vault.mjs, where every name,
// note and run is made up), never a real one. The fixture's deliberate error cases, there for the e2e suite (a TEAM.md
// the reader refuses, a notification with no frontmatter, one edited by hand to carry a command), are taken out first,
// so each picture shows the Workbench as a user meets it. The app runs read-only. Pictures land in
// ../docs/assets/screens/<name>.png, or in $AOS_SCREENS_OUT. Look at every one before committing it.

import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, REPO, SETUP, appEnv, content, installSetupStubs, launchApp, openTab, restoreFixture, type AppHandle } from "../e2e/harness";

const OUT = path.resolve(process.env.AOS_SCREENS_OUT ?? path.join(REPO, "..", "docs", "assets", "screens"));
const SIZE = { width: 1440, height: 900 };
const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version;

/**
 * Takes out the fixture's test-only edge cases, which would read as bugs in a picture, and finishes the install the way
 * a user's is: the CLAUDE.md line (the health scan's one error without it), then the caches rebuilt by the runtime.
 */
function demoVault(): void {
  fs.writeFileSync(path.join(FX.claude, "CLAUDE.md"), `@${FX.v("AGENTICOS.md")}\n`);
  // The terminal's prompt: the folder it is in, not the fixture's own marker.
  const zshrc = path.join(FX.home, ".zshrc");
  fs.writeFileSync(zshrc, fs.readFileSync(zshrc, "utf8").replace(/^PROMPT=.*$/m, "PROMPT='%1~ %# '"));
  fs.rmSync(FX.v("persona/teams/broken"), { recursive: true, force: true });
  const root = FX.v("brain/notifications");
  for (const year of fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d))) {
    for (const f of fs.readdirSync(path.join(root, year))) {
      const file = path.join(root, year, f);
      const text = fs.readFileSync(file, "utf8");
      if (!text.startsWith("---") || /^actions: \[\{"kind":"run"/m.test(text)) fs.rmSync(file);
    }
  }
  for (const script of ["scan-vault.js", "build-brain-md.js"]) {
    execFileSync(process.execPath, [FX.v(`brain/scripts/${script}`)], { cwd: FX.vault, env: appEnv(), stdio: "ignore" });
  }
}

const shot = (win: Page, name: string) => win.screenshot({ path: path.join(OUT, `${name}.png`), scale: "css" });

/** The pictures are light whatever this Mac's appearance (UniDeX D6); one Pulse is taken dark. */
async function theme(h: AppHandle, source: "light" | "dark"): Promise<void> {
  await h.app.evaluate((_e, s) => { (globalThis as unknown as { __aosMain: { setTheme(s: string): unknown } }).__aosMain.setTheme(s); }, source);
  await expect(h.win.locator("body")).toHaveClass(new RegExp(`\\btheme-${source}\\b`));
}

test.describe.configure({ mode: "serial" });
test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test.describe("the Workbench", () => {
  let h: AppHandle;
  test.beforeAll(async () => {
    restoreFixture();
    // The app's own default: every surface may write (to this throwaway vault), and no READ-ONLY marker shows.
    h = await launchApp({ prepare: demoVault, size: SIZE, env: { AOS_APP_WRITE: undefined } });
    await theme(h, "light");
  });
  test.afterAll(async () => { await h?.close(); });

  // Each tab as it first draws, after its reads settle.
  for (const tab of ["pulse", "todo", "proposals", "spaces", "routines", "skills", "agent-teams", "settings"]) {
    test(tab, async () => {
      await openTab(h.win, tab);
      await h.win.waitForTimeout(1500);
      await shot(h.win, tab);
    });
  }

  test("notifications, with the morning edition open", async () => {
    await openTab(h.win, "notifications");
    // In the Unread view an opened item leaves the list (it is read now): open it from All.
    await content(h.win).getByText("All", { exact: true }).click();
    await content(h.win).locator(".aos-nt-row", { hasText: "The Morning Edition" }).click();
    await h.win.waitForTimeout(800);
    await shot(h.win, "notifications");
  });

  test("memory, as the graph", async () => {
    await openTab(h.win, "memory");
    await content(h.win).locator(".aos-mem-chip", { hasText: "◈ graph" }).click();
    await h.win.waitForTimeout(4000);   // the force layout settles
    await shot(h.win, "graph");
  });

  test("files, with a workspace open", async () => {
    await openTab(h.win, "files");
    for (const p of ["workspaces", "workspaces/harbor-map"]) await content(h.win).locator(`.aos-fl-row[data-path="${p}"]`).click();
    await h.win.waitForTimeout(800);
    await shot(h.win, "files");
  });

  test("pulse, in the dark theme", async () => {
    await theme(h, "dark");
    await openTab(h.win, "pulse");
    await h.win.waitForTimeout(1500);
    await shot(h.win, "pulse-dark");
    await theme(h, "light");
  });
});

test.describe("the setup wizard, with no install", () => {
  let h: AppHandle;
  test.beforeAll(async () => {
    restoreFixture();
    h = await launchApp({
      ready: ".aos-setup",
      noted: false,
      size: SIZE,
      // No agenticos.json; the wizard's PATH holds stand-ins (claude logged in, codex not, uv missing) and the app a
      // stand-in payload, as in tests/e2e/setup.spec.ts.
      prepare: () => { installSetupStubs(VERSION); fs.rmSync(path.join(FX.claude, "agenticos.json"), { force: true }); },
      env: { AOS_APP_VAULT: undefined, AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin },
    });
    await theme(h, "light");
  });
  test.afterAll(async () => { await h?.close(); });

  test("check: what aos init needs, with a fix for each missing piece", async () => {
    await expect(h.win.locator('.aos-setup-check[data-check="uv"]')).toBeVisible();
    await h.win.waitForTimeout(800);
    await shot(h.win, "wizard");
  });
});
