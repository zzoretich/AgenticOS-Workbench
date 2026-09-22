import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, sessionsChip, shortenCwd, outsideRows } from "./hostSessions";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

test("sessionsChip names the hosts that have sessions and the age of the newest", () => {
  assert.equal(sessionsChip({ claude: 12, codex: 3, total: 15, lastAt: "2026-09-19T09:00:00.000Z" }, NOW), "claude 12 · codex 3 · 2d ago");
  assert.equal(sessionsChip({ claude: 0, codex: 1, total: 1, lastAt: "2026-09-21T09:00:00.000Z" }, NOW), "codex 1 · today");
  assert.equal(sessionsChip({ claude: 2, codex: 0, total: 2, lastAt: null }, NOW), "claude 2 · never");
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: null }, NOW), null);
  assert.equal(sessionsChip(undefined, NOW), null);
});

test("agoLabel and shortenCwd", () => {
  assert.equal(agoLabel("2026-09-20T09:00:00.000Z", NOW), "1d ago");
  assert.equal(agoLabel("garbage", NOW), "never");
  assert.equal(shortenCwd("/home/demo/Documents/x", "/home/demo"), "~/Documents/x");
  assert.equal(shortenCwd("/home/demoted/x", "/home/demo"), "/home/demoted/x", "a shared name prefix is not the home dir");
  assert.equal(shortenCwd("/home/demo", "/home/demo"), "~");
});

test("outsideRows caps, shortens and labels", () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ cwd: `/home/demo/p${i}`, claude: i % 2, codex: 1, total: 1 + (i % 2), lastAt: "2026-09-21T09:00:00.000Z" }));
  const rows = outsideRows(list, 3, NOW, "/home/demo");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { cwd: "/home/demo/p1", label: "~/p1", chip: "claude 1 · codex 1 · today" });
  assert.deepEqual(outsideRows(undefined), []);
});
