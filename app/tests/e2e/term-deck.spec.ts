import { expect, test } from "@playwright/test";
import { FX, closeNotes, command, content, notePath, openTab, terminalText, useApp } from "./harness";

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

test("the composer sits under every running terminal, a shell too: ⌘L focuses it and Enter runs what was written (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect(C().locator(".aos-tc")).not.toHaveClass(/is-hidden/);
  await expect(C().locator(".aos-tc-input")).toHaveAttribute("placeholder", "Write a command…");
  await expect(C().locator(".aos-tc-hint")).not.toContainText("/ commands");
  expect(await command(win, "agentic-os:term-composer")).toBe(true);
  await expect(C().locator(".aos-tc-input")).toBeFocused();
  await C().locator(".aos-tc-input").fill("echo composer-$((6*7))");
  await win.keyboard.press("Enter");
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("composer-42");
  await expect(C().locator(".aos-tc-input")).toHaveValue("");
  // An agent's composer names it and offers its / commands.
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { setMeta(m: object): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.setMeta({ host: "claude" });
  });
  await C().locator(".aos-tl-row.aos-term-tab-active").click();
  await expect(C().locator(".aos-tc-input")).toHaveAttribute("placeholder", "Write to Claude Code…");
});

test("⌘F finds in the selected terminal: a count, Enter and ⇧Enter step, Escape closes and clears; ⌘F reopens", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  // Two matches in the output and none in the typed line: only the shell works out $((6*7)).
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.write("echo find-$((6*7))-me; echo find-$((6*7))-me\r");
  });
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("find-42-me");
  const bar = C().locator(".aos-tf");
  const count = bar.locator(".aos-tf-count");
  await expect(bar).toBeHidden();
  expect(await command(win, "agentic-os:term-find")).toBe(true);
  await expect(bar.locator(".aos-tf-input")).toBeFocused();
  await bar.locator(".aos-tf-input").fill("find-42-me");
  await expect(count).toHaveText("1 of 2");
  await expect(C().locator(".xterm-find-active-result-decoration")).toHaveCount(1);
  await win.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await win.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("1 of 2");
  await bar.locator(".aos-tf-input").fill("zzz-nowhere");
  await expect(count).toHaveText("No results");
  await bar.locator(".aos-tf-input").fill("find-42-me");
  await expect(count).toHaveText("1 of 2");
  // Escape closes the bar, clears the highlights and gives the keys back to the terminal.
  await win.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(C().locator(".xterm-find-result-decoration")).toHaveCount(0);
  await expect(C().locator(".aos-term-xterm:visible .xterm-helper-textarea")).toBeFocused();
  // The real key, from inside the terminal: the bar comes back with the last words selected and found again.
  await win.keyboard.press("Meta+f");
  await expect(bar.locator(".aos-tf-input")).toBeFocused();
  await expect(count).toHaveText("1 of 2");
  await win.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("the New menu stays open while you switch its host, by Tab or by a click, and keeps the typing in its filter", async () => {
  const { win } = app();
  await openTab(win, "term");
  const pop = C().locator(".aos-ntm-pop");
  const active = () => C().locator(".aos-ntm-pop .aos-ntm-host.is-active");
  await C().locator(".aos-ntm-caret").click();
  await expect(pop).toHaveCount(1);
  await expect(C().locator(".aos-ntm-filter")).toBeFocused();
  const first = (await active().innerText()).trim();
  await win.keyboard.press("Tab");
  await expect(pop).toHaveCount(1);
  await expect(active()).not.toHaveText(first);
  await expect(C().locator(".aos-ntm-filter")).toBeFocused();
  await C().locator(".aos-ntm-pop .aos-ntm-host", { hasText: first }).click();
  await expect(pop).toHaveCount(1);
  await expect(active()).toHaveText(first);
  await win.keyboard.type("harbor");
  await expect(C().locator(".aos-ntm-filter")).toHaveValue("harbor");
  await win.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("⇧⏎ in a Claude Code terminal sends one line feed and nothing after it (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  // A shell stands in for Claude Code (the fixture's agent stubs exit at once): it prints the raw bytes it reads. Its
  // prompt comes first, since a shell drops what was typed before it.
  type S = { setMeta(m: object): void; write(d: string): void; getScrollback(): string };
  const sel = () => win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): S | undefined } } } }).aosHost.plugin.terminalPool;
    return p.get(p.selectedId() ?? "")?.getScrollback() ?? "";
  });
  await expect.poll(async () => /[%$#] ?$/.test((await sel()).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd()), { timeout: 10_000 }).toBe(true);
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): S | undefined } } } }).aosHost.plugin.terminalPool;
    const s = p.get(p.selectedId() ?? "");
    s?.setMeta({ host: "claude" });
    s?.write("stty raw -echo; printf 'REA%sDY'; dd bs=1 count=2 2>/dev/null | od -An -c; stty sane\r");
  });
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("READY");
  await win.evaluate(() => (document.querySelector(".aos-term-xterm:not([style*=none]) .xterm-helper-textarea") as HTMLElement | null)?.focus());
  await win.keyboard.press("Shift+Enter");
  await win.keyboard.type("x");
  // od prints the two bytes: a line feed, then the x. Before the fix the keypress after it sent a carriage return.
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(/\\n\s+x/);
  expect(await terminalText(win)).not.toMatch(/\\n\s+\\r/);
});

test("links an app prints in a terminal open: an agenticos:// note in the Workbench, a tab link on its tab (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  const scrollback = () => win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { getScrollback(): string } | undefined } } } }).aosHost.plugin.terminalPool;
    return p.get(p.selectedId() ?? "")?.getScrollback() ?? "";
  });
  await expect.poll(async () => /[%$#] ?$/.test((await scrollback()).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd()), { timeout: 10_000 }).toBe(true);
  // OSC 8 links, as Claude Code's status line prints them (the labels are put together by printf, so only the output
  // carries them whole).
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.write("printf '\\033]8;;agenticos://note?file=workspaces/harbor-map/PLAN.md\\007OPEN-%s\\033]8;;\\007\\n' PLAN; printf '\\033]8;;agenticos://workbench?tab=todo\\007OPEN-%s\\033]8;;\\007\\n' TODO\r");
  });
  const label = (t: string) => C().locator(".aos-term-xterm:visible .xterm-rows span", { hasText: t }).last();
  await expect(label("OPEN-PLAN")).toBeVisible({ timeout: 10_000 });
  await label("OPEN-PLAN").hover();
  await label("OPEN-PLAN").click();
  await expect(notePath(win)).toContainText("PLAN.md", { timeout: 10_000 });
  await closeNotes(win);
  await openTab(win, "term");
  await label("OPEN-TODO").hover();
  await label("OPEN-TODO").click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='todo']")).toHaveClass(/is-active/, { timeout: 10_000 });
});

test("opening Term defers nothing that takes the focus: the list filter keeps its typing, however late the page's frames run", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  // fill() is a focus and a select-all, then the typing. Hold this page's animation frames, as a loaded runner can, and
  // run them in between: a terminal focus the panel deferred to one would take the typing into the shell.
  await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const held: FrameRequestCallback[] = [];
    w.__heldRaf = held;
    w.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => { held.push(cb); return 0; };
  });
  const filter = C().locator(".aos-tl-filter");
  try {
    await openTab(win, "term");
    await filter.focus();
    await filter.selectText();
    await win.evaluate(() => { for (const f of ((window as unknown as Record<string, unknown>).__heldRaf as FrameRequestCallback[]).splice(0)) f(performance.now()); });
    await win.keyboard.insertText("zzz-nothing");
    await expect(filter).toHaveValue("zzz-nothing");
  } finally {
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      window.requestAnimationFrame = w.__raf as typeof window.requestAnimationFrame;
      for (const f of (w.__heldRaf as FrameRequestCallback[]).splice(0)) f(performance.now());
      delete w.__raf;
      delete w.__heldRaf;
    });
  }
  await expect(C().locator(".aos-tl-empty")).toHaveText("No terminal matches.");
  await filter.fill("");
});
