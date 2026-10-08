import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTerminals, rowEnd, stepRow, groupKey } from "./termGroups";
import type { Place } from "./terminalLaunch";

const ws = (n: string): Place => ({ kind: n === "scratch" ? "scratch" : "workspace", label: n === "scratch" ? "Scratch" : n, dir: `/v/workspaces/${n}`, workspace: n });
const vault: Place = { kind: "vault", label: "Vault", dir: "/v" };
const other: Place = { kind: "other", label: "app", dir: "/code/app" };
const row = (id: string, place: Place, startedAt: number, extra: Partial<Parameters<typeof groupTerminals>[0][number]> = {}) =>
  ({ id, host: "claude" as const, title: `t${id}`, place, origin: null, startedAt, exited: false, exitCode: null, ...extra });

test("groups by place, the newest launch first, the vault and other folders last; rows newest first", () => {
  const g = groupTerminals([row("1", vault, 50), row("2", ws("kite"), 10), row("3", ws("scratch"), 30), row("4", ws("kite"), 40), row("5", other, 99)]);
  assert.deepEqual(g.map((x) => x.label), ["kite", "Scratch", "Vault", "app"]);
  assert.deepEqual(g[0].rows.map((r) => r.id), ["4", "2"]);
});

test("a linked code folder groups with its workspace", () => {
  const linked: Place = { kind: "workspace", label: "notes", dir: "/code/app", workspace: "notes", linked: true };
  assert.equal(groupKey(linked), groupKey(ws("notes")));
  assert.equal(groupTerminals([row("1", linked, 1), row("2", ws("notes"), 2)]).length, 1);
});

test("end states: running, Done on exit 0, Exited n otherwise", () => {
  assert.deepEqual(rowEnd({ exited: false, exitCode: null }), { end: "running", endText: null });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 0 }), { end: "done", endText: "Done" });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 127 }), { end: "failed", endText: "Exited 127" });
});

test("the filter matches title, place and origin", () => {
  const rows = [row("1", vault, 1, { origin: "Skills" }), row("2", ws("kite"), 2, { title: "Fix the race" })];
  assert.deepEqual(groupTerminals(rows, "skills").flatMap((g) => g.rows.map((r) => r.id)), ["1"]);
  assert.deepEqual(groupTerminals(rows, "race").flatMap((g) => g.rows.map((r) => r.id)), ["2"]);
  assert.deepEqual(groupTerminals(rows, "KITE").flatMap((g) => g.rows.map((r) => r.id)), ["2"]);
});

test("stepRow walks the list order and wraps", () => {
  const g = groupTerminals([row("1", ws("a"), 3), row("2", ws("a"), 2), row("3", vault, 1)]);
  assert.equal(stepRow(g, "1", 1), "2");
  assert.equal(stepRow(g, "3", 1), "1");
  assert.equal(stepRow(g, "1", -1), "3");
  assert.equal(stepRow(g, null, 1), "1");
  assert.equal(stepRow([], null, 1), null);
});
