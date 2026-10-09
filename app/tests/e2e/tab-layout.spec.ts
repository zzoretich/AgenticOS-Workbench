import { expect, test, type Page } from "@playwright/test";
import { RAIL_ORDER, content, openTab, useApp } from "./harness";

// Every tab draws into one content area. A tab must never leave its own layout on it for the next one: in 1.4.0 the Term
// deck's classes (aos-term, aos-term-deck: a row) stayed after a visit to Term, and every tab after it was laid out in a
// row until the app restarted. Read-only.

const app = useApp();
const C = () => content(app().win);
const box = async (win: Page, selector: string) => {
  const b = await content(win).locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};

test("after Code and Agent Teams, the content area carries none of their classes", async () => {
  const { win } = app();
  await openTab(win, "agent-teams");
  await openTab(win, "term");
  // Sessions (chat) is on the rail only with a model provider; variants.spec.ts covers it.
  for (const t of RAIL_ORDER.filter((x) => x !== "term" && x !== "agent-teams" && x !== "chat")) {
    await openTab(win, t);
    const cls = ((await C().getAttribute("class")) ?? "").split(/\s+/);
    expect(cls, t).toContain("aos-wb-content");
    expect(cls.filter((c) => c.startsWith("aos-term") || c === "aos-at"), t).toEqual([]);
  }
});

test("after a visit to Code, the tabs keep their layout: lists beside their reading panes, toolbars above their lists", async () => {
  const { win } = app();
  await openTab(win, "term");

  // Notifications and Proposals: the list on the left, the reading pane beside it, both under the head.
  for (const t of ["notifications", "proposals"]) {
    await openTab(win, t);
    const list = await box(win, ".aos-split-list");
    const pane = await box(win, ".aos-split-detail");
    expect(list.x + list.width).toBeLessThanOrEqual(pane.x + 1);
    expect(Math.abs(list.y - pane.y)).toBeLessThan(8);
  }

  // Files: the search box above the tree, both at the left.
  await openTab(win, "files");
  const query = await box(win, ".aos-fl-query");
  const tree = await box(win, ".aos-fl-tree");
  expect(query.y + query.height).toBeLessThanOrEqual(tree.y + 1);
  expect(Math.abs(query.x - tree.x)).toBeLessThan(40);

  // To-Do: one list, every row starting at the same left edge.
  await openTab(win, "todo");
  const xs = await C().locator(".aos-td-row").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().x)));
  expect(xs.length).toBeGreaterThan(2);
  expect(new Set(xs).size).toBe(1);

  // Agent Teams: the team switch above the board.
  await openTab(win, "agent-teams");
  const teams = await box(win, ".aos-at-teams");
  const board = await box(win, ".aos-at-board");
  expect(teams.y + teams.height).toBeLessThanOrEqual(board.y + 1);
});
