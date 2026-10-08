import { expect, test } from "@playwright/test";
import { FX, command, content, openTab, terminalText, useApp } from "./harness";

// The Term deck (spec 2026-10-08-term-agent-deck T1): terminals grouped by where they run, the selected one's header,
// and the Term keys. Read-only: shells start in the vault and Claude Code in an existing workspace, so nothing is written.

const app = useApp();
const C = () => content(app().win);
const selected = () => app().win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());

test("terminals group by place: a workspace's group above the vault's; the header names the place and the host (T1)", async () => {
  const { win } = app();
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await openTab(win, "spaces");
  await C().locator(".aos-ws-row", { hasText: "harbor-map" }).first().click();
  await C().locator(".aos-ws-detail-head button", { hasText: "Claude Code here" }).click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  const groups = C().locator(".aos-tl-group");
  await expect(groups.first()).toHaveAttribute("data-group", "ws:harbor-map");
  await expect(C().locator(".aos-tl-group[data-group='vault']")).toHaveCount(1);
  await expect(C().locator(".aos-term-head .aos-term-place")).toContainText("harbor-map");
  await expect(C().locator(".aos-term-head .aos-term-chip").first()).toContainText("Claude Code");
});

test("an agent that ends shows Done, and Restart starts it again in the same place (T1)", async () => {
  const { win } = app();
  await openTab(win, "term");
  // The fixture's claude stub echoes and exits 0, so the exec'd agent ends at once.
  const row = C().locator(".aos-tl-row.aos-term-tab-active");
  await expect(row.locator(".aos-tl-end")).toHaveText("✓ Done", { timeout: 10_000 });
  const before = await C().locator(".aos-tl-row").count();
  await C().locator(".aos-term-endbar button", { hasText: "Restart" }).click();
  await expect(C().locator(".aos-tl-row")).toHaveCount(before + 1);
  await expect(C().locator(".aos-tl-group[data-group='ws:harbor-map'] ~ .aos-tl-row.aos-term-tab-active")).toHaveCount(1);
});

test("the selection survives a tab switch; ⇧⌘[ and ⇧⌘] walk the list; ⇧⌘W closes a shell at once (T1)", async () => {
  const { win } = app();
  await openTab(win, "term");
  const first = await selected();
  await openTab(win, "pulse");
  await openTab(win, "term");
  expect(await selected()).toBe(first);
  await expect(C().locator(".aos-tl-row.aos-term-tab-active")).toHaveAttribute("data-session", first ?? "");
  expect(await command(win, "agentic-os:term-next")).toBe(true);
  const next = await selected();
  expect(next).not.toBe(first);
  expect(await command(win, "agentic-os:term-previous")).toBe(true);
  expect(await selected()).toBe(first);
  // Select the vault shell and close it: a shell needs no confirmation.
  await C().locator(".aos-tl-group[data-group='vault'] ~ .aos-tl-row[data-host='shell']").first().click();
  const shells = await C().locator(".aos-tl-row[data-host='shell']").count();
  expect(await command(win, "agentic-os:term-close")).toBe(true);
  await expect(C().locator(".aos-tl-row[data-host='shell']")).toHaveCount(shells - 1);
});

test("Clear ended removes the agents that ended; the filter narrows the list", async () => {
  const { win } = app();
  await openTab(win, "term");
  await C().locator(".aos-tl-filter").fill("zzz-nothing");
  await expect(C().locator(".aos-tl-empty")).toHaveText("No terminal matches.");
  await C().locator(".aos-tl-filter").fill("");
  await expect(C().locator(".aos-tl-clear")).toBeVisible({ timeout: 10_000 });
  await C().locator(".aos-tl-clear").click();
  await expect(C().locator(".aos-tl-end")).toHaveCount(0);
  expect(FX.v("workspaces/harbor-map")).toContain("harbor-map");
});

test("the composer: hidden for a shell; for an agent ⌘L focuses it and Enter sends one paste that runs (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect(C().locator(".aos-tc")).toHaveClass(/is-hidden/);
  // A shell stands in for an agent (the fixture's agent stubs exit at once): the composer shows for a running agent row.
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { setMeta(m: object): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.setMeta({ host: "claude" });
  });
  await expect(C().locator(".aos-tc")).not.toHaveClass(/is-hidden/);
  expect(await command(win, "agentic-os:term-composer")).toBe(true);
  await expect(C().locator(".aos-tc-input")).toBeFocused();
  await C().locator(".aos-tc-input").fill("echo composer-$((6*7))");
  await win.keyboard.press("Enter");
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("composer-42");
  await expect(C().locator(".aos-tc-input")).toHaveValue("");
});
