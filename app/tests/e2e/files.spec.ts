// The Files tab, read-only (the harness default): the vault tree, a note opened from it, search across notes and every
// text file, Open file… and Search vault…, folders AgenticOS writes itself shown without actions, and, with the Files
// surface off, a new note and a trash refused with nothing written and nothing handed to the OS.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, command, content, drawer, notePath, openTab, rail, useApp } from "./harness";

const app = useApp();

const row = (win: Page, p: string) => content(win).locator(`.aos-fl-row[data-path="${p}"]`);
const names = (win: Page) => content(win).locator(".aos-fl-tree > .aos-fl-row .aos-fl-name").allTextContents();
const query = (win: Page) => content(win).locator(".aos-fl-query");

/** Opens folders down to `dir` (a click toggles, and the tab keeps what was open between tests, so only closed ones). */
async function reveal(win: Page, dir: string): Promise<void> {
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!(await row(win, p).getAttribute("class"))?.includes("is-open")) await row(win, p).click();
  }
}

/** The vault's top level as the index lists it: no dot-names or dependency folders, folders first, names in order. */
function topLevel(): string[] {
  const skip = (n: string) => n.startsWith(".") || ["node_modules", "_worktrees", "graphify-out"].includes(n);
  const all = fs.readdirSync(FX.vault, { withFileTypes: true }).filter((e) => !skip(e.name));
  const sorted = (xs: string[]) => xs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return [...sorted(all.filter((e) => e.isDirectory()).map((e) => e.name)), ...sorted(all.filter((e) => e.isFile()).map((e) => e.name))];
}

test.beforeEach(async () => {
  const { win } = app();
  await closeNotes(win);
  await openTab(win, "files");
  if (await query(win).inputValue()) { await query(win).fill(""); }
});

test("Files opens from the rail and lists the vault's top level, folders first", async () => {
  const { win } = app();
  await expect(rail(win, "files")).toHaveClass(/is-active/);
  await expect(content(win).locator(".aos-rt-title")).toHaveText("Files");
  await expect(content(win).locator(".aos-rt-count")).toHaveText(/^\d+ files$/);
  expect(await names(win)).toEqual(topLevel());
});

test("a folder opens and closes in place; a click on a note opens it in a tab", async () => {
  const { win } = app();
  await reveal(win, "workspaces/harbor-map");
  await expect(row(win, "workspaces")).toHaveClass(/is-open/);
  const inner = await content(win).locator('.aos-fl-row[data-path^="workspaces/harbor-map/"] .aos-fl-name').allTextContents();
  expect(inner).toEqual(["src", "PLAN.md", "README.md", "workspace.md"]);
  await row(win, "workspaces/harbor-map/README.md").click();
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/README.md");
  await closeNotes(win);
  await openTab(win, "files");
  await row(win, "workspaces").click();
  await expect(row(win, "workspaces/harbor-map")).toHaveCount(0);
});

test("search finds lines across notes and highlights the hit; a line opens its note; every text file on request", async () => {
  const { win } = app();
  await query(win).fill("tide");
  await expect(content(win).locator(".aos-fl-summary")).toHaveText(/^\d+ lines? in \d+ files? · \d+ searched$/);
  const hit = content(win).locator('.aos-fl-hit[data-path="brain/memory/reference/tide-api-notes.md"]');
  await expect(hit).toBeVisible();
  await expect(hit.locator(".aos-fl-mark").first()).toHaveText(/^tide$/i);
  await expect(content(win).locator('.aos-fl-hit[data-path="workspaces/harbor-map/src/tides.js"]')).toHaveCount(0);
  await content(win).locator(".aos-fl-scope input").check();
  await expect(content(win).locator('.aos-fl-hit[data-path="workspaces/harbor-map/src/tides.js"]')).toBeVisible();
  await content(win).locator(".aos-fl-scope input").uncheck();
  await hit.locator(".aos-fl-line").first().click();
  await expect(notePath(win)).toHaveText("brain/memory/reference/tide-api-notes.md");
  await closeNotes(win);
  await openTab(win, "files");
  // Escape clears the search and the tree is back.
  await query(win).press("Escape");
  await expect(content(win).locator(".aos-fl-tree")).toBeVisible();
  await query(win).fill("no such words anywhere in the vault");
  await expect(content(win).locator(".aos-fl-summary")).toHaveText(/^No matches in \d+ files$/);
});

test("Open file… matches paths fuzzily, Markdown first, and opens the choice", async () => {
  const { win } = app();
  expect(await command(win, "agentic-os:open-file")).toBe(true);
  const input = win.locator(".modal.prompt .prompt-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", /^Open a file \(\d+ in the vault\)…$/);
  await input.fill("harbor plan");
  const first = win.locator(".modal.prompt .suggestion-item").first();
  await expect(first.locator(".aos-omni-label")).toHaveText("PLAN.md");
  await expect(first.locator(".aos-omni-hint")).toHaveText("workspaces/harbor-map");
  await input.press("Enter");
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/PLAN.md");
});

test("Search vault… opens Files with the cursor in the search box", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  expect(await command(win, "agentic-os:search-vault")).toBe(true);
  await expect(rail(win, "files")).toHaveClass(/is-active/);
  await expect(query(win)).toBeFocused();
});

test("folders AgenticOS writes itself have no new-note action, and their files no actions", async () => {
  const { win } = app();
  await row(win, "brain").click();
  await expect(row(win, "brain").locator(".aos-fl-act")).toHaveCount(1);   // + note
  await expect(row(win, "brain/_index").locator(".aos-fl-act")).toHaveCount(0);
  await expect(row(win, "brain/scripts").locator(".aos-fl-act")).toHaveCount(0);
  await row(win, "brain/_index").click();
  await expect(row(win, "brain/_index/BRAIN.md").locator(".aos-fl-act")).toHaveCount(0);
  await row(win, "brain").click();
});

test("with the Files surface off, a new note is refused and a trash refused: nothing written, nothing sent to the OS", async () => {
  const h = app();
  const { win } = h;
  const before = (await h.guard()).length;
  await content(win).locator(".aos-rt-actions button", { hasText: "+ note" }).click();
  const d = drawer(win);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("New note");
  const [folder, name] = [d.locator(".aos-rt-input").nth(0), d.locator(".aos-rt-input").nth(1)];
  // The name first: the folder field has a suggestion list, and leaving it with the list open can commit a suggestion.
  await name.fill("first idea");
  await folder.fill("inbox");
  await expect(d.locator(".aos-rt-errors")).toHaveText("→ inbox/first idea.md");
  await d.locator(".aos-capture-actions button", { hasText: "create" }).click();
  await expect(d.locator(".aos-rt-errors")).toHaveText(/^Not done: /);
  expect(fs.existsSync(FX.v("inbox/first idea.md"))).toBe(false);
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();

  await reveal(win, "workspaces/harbor-map");
  const plan = row(win, "workspaces/harbor-map/PLAN.md");
  await plan.hover();
  await plan.locator(".aos-fl-act", { hasText: "✕" }).click();
  await win.locator(".modal button.mod-cta", { hasText: "Move to Trash" }).click();
  await expect.poll(() => h.notices.some((n) => n.startsWith("Not moved to the Trash: "))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(true);
  expect((await h.opened()).filter((o) => o.fn === "trashItem")).toEqual([]);
  const refused = (await h.guard()).slice(before).filter((e) => e.kind === "write");
  expect(refused.length).toBeGreaterThanOrEqual(2);
  await row(win, "workspaces").click();
  expect(fs.existsSync(path.join(FX.home, ".Trash"))).toBe(false);
});

test("the new-note form defers nothing: a field filled at once keeps its text, however late the page's timers run", async () => {
  const { win } = app();
  // fill() is a focus and a select-all, then the typing. Hold this page's zero-delay timers, as a loaded runner can,
  // and run them in between: a focus the form deferred to one would move the folder's typing into the name field.
  await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const real = window.setTimeout.bind(window);
    const held: (() => void)[] = [];
    w.__held = held;
    w.__setTimeout = window.setTimeout;
    w.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms) return real(fn, ms, ...args);
      held.push(() => fn(...args));
      return 0;
    };
  });
  const d = drawer(win);
  try {
    await content(win).locator(".aos-rt-actions button", { hasText: "+ note" }).click();
    await expect(d.locator(".aos-wb-drawertitle")).toHaveText("New note");
    const [folder, name] = [d.locator(".aos-rt-input").nth(0), d.locator(".aos-rt-input").nth(1)];
    await name.fill("first idea");
    await folder.focus();
    await folder.selectText();
    await win.evaluate(() => { for (const f of ((window as unknown as Record<string, unknown>).__held as (() => void)[]).splice(0)) f(); });
    await win.keyboard.insertText("inbox");
    await expect(d.locator(".aos-rt-errors")).toHaveText("→ inbox/first idea.md");
  } finally {
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.setTimeout = w.__setTimeout;
      for (const f of (w.__held as (() => void)[]).splice(0)) f();
      delete w.__setTimeout;
      delete w.__held;
    });
  }
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  expect(fs.existsSync(FX.v("inbox/first idea.md"))).toBe(false);
});
