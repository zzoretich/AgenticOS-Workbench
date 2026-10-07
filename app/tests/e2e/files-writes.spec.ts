// The Files tab with its write surface on (AOS_APP_WRITE=files): a new note in a new folder, opened at once; the form's
// refusals; rename and move keeping the bytes; and delete going to the Trash (the fixture's, see harness.ts) only after
// a confirm. Every write is the surface's own: the guard refuses nothing.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, content, drawer, guardWrites, notePath, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "files" } });

const row = (win: Page, p: string) => content(win).locator(`.aos-fl-row[data-path="${p}"]`);
const act = async (win: Page, p: string, glyph: string) => { await row(win, p).hover(); await row(win, p).locator(".aos-fl-act", { hasText: glyph }).click(); };
const inputs = (win: Page) => drawer(win).locator(".aos-rt-input");
const note = (win: Page) => drawer(win).locator(".aos-rt-errors");
const button = (win: Page, text: string) => drawer(win).locator(".aos-capture-actions button", { hasText: text });

/** Opens folders down to `dir` in the tree (each click toggles, so only closed ones are clicked). */
async function reveal(win: Page, dir: string): Promise<void> {
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!(await row(win, p).getAttribute("class"))?.includes("is-open")) await row(win, p).click();
  }
}

test.beforeEach(async () => {
  const { win } = app();
  await closeNotes(win);
  await openTab(win, "files");
});

test.afterEach(async () => {
  expect(await guardWrites(app())).toEqual([]);
  const d = drawer(app().win);
  if (await d.evaluate((e) => e.classList.contains("is-open"))) await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
});

test("Files is the one surface on: the status bar names it", async () => {
  await expect(app().win.locator(".aos-host-status .aos-host-mode")).toHaveText("WRITES: Files");
});

test("+ note makes a Markdown note in a new folder, opens it, and shows it in the tree", async () => {
  const { win } = app();
  await content(win).locator(".aos-rt-actions button", { hasText: "+ note" }).click();
  // The name first, then the folder (its suggestion list could commit an entry when focus leaves it).
  await inputs(win).nth(1).fill("Tide windows");
  await inputs(win).nth(0).fill("workspaces/harbor-map/notes");
  await expect(note(win)).toHaveText("→ workspaces/harbor-map/notes/Tide windows.md");
  await button(win, "create").click();
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/notes/Tide windows.md");
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/notes/Tide windows.md"), "utf8")).toBe("");
  await closeNotes(win);
  await openTab(win, "files");
  await expect(row(win, "workspaces/harbor-map/notes/Tide windows.md")).toBeVisible();
});

test("the new-note form says why it refuses, and create stays off", async () => {
  const { win } = app();
  await content(win).locator(".aos-rt-actions button", { hasText: "+ note" }).click();
  const check = async (folder: string, name: string, why: string) => {
    await inputs(win).nth(1).fill(name);
    await inputs(win).nth(0).fill(folder);
    await expect(note(win)).toHaveText(why);
    await expect(button(win, "create")).toBeDisabled();
  };
  await check("workspaces/harbor-map", "PLAN", "workspaces/harbor-map/PLAN.md already exists");
  await check("brain/_index", "x", "brain/_index/ is written by the runtime itself");
  await check("", "../outside", "a path cannot climb out of the vault (..)");
  await check("notes", "", "a name is required");
});

test("rename keeps the folder, the extension and the bytes", async () => {
  const { win } = app();
  const before = fs.readFileSync(FX.v("workspaces/harbor-map/PLAN.md"));
  await reveal(win, "workspaces/harbor-map");
  await act(win, "workspaces/harbor-map/PLAN.md", "✎");
  await expect(drawer(win).locator(".aos-wb-drawertitle")).toHaveText("Rename");
  await inputs(win).nth(0).fill("ROADMAP");
  await expect(note(win)).toHaveText("→ workspaces/harbor-map/ROADMAP.md");
  await button(win, "rename").click();
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/ROADMAP.md"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/ROADMAP.md")).equals(before)).toBe(true);
  await expect(row(win, "workspaces/harbor-map/ROADMAP.md")).toBeVisible();
});

test("move puts the file in another folder, creating it, and keeps the bytes", async () => {
  const { win } = app();
  const before = fs.readFileSync(FX.v("workspaces/harbor-map/README.md"));
  await reveal(win, "workspaces/harbor-map");
  await act(win, "workspaces/harbor-map/README.md", "→");
  await inputs(win).nth(0).fill("archive/2026");
  await expect(note(win)).toHaveText("→ archive/2026/README.md");
  await button(win, "move").click();
  await expect.poll(() => fs.existsSync(FX.v("archive/2026/README.md"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/README.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("archive/2026/README.md")).equals(before)).toBe(true);
  await expect(row(win, "archive/2026/README.md")).toBeVisible();
});

test("✕ asks first: Cancel keeps the file; Move to Trash hands it to the Trash", async () => {
  const h = app();
  const { win } = h;
  const file = "workspaces/harbor-map/workspace.md";
  const before = fs.readFileSync(FX.v(file));
  await reveal(win, "workspaces/harbor-map");
  await act(win, file, "✕");
  const modal = win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Move to the Trash");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(win.locator(".modal")).toHaveCount(0);
  expect(fs.existsSync(FX.v(file))).toBe(true);

  await act(win, file, "✕");
  await win.locator(".modal button.mod-cta", { hasText: "Move to Trash" }).click();
  await expect.poll(() => fs.existsSync(FX.v(file))).toBe(false);
  expect((await h.opened()).filter((o) => o.fn === "trashItem").map((o) => o.arg)).toEqual([path.join(FX.vault, file)]);
  expect(fs.readFileSync(path.join(FX.home, ".Trash", "workspace.md")).equals(before)).toBe(true);
  await expect.poll(() => h.notices.includes(`${file} moved to the Trash`)).toBe(true);
  await expect(row(win, file)).toHaveCount(0);
});
