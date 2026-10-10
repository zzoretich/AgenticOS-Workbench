import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, sessionsChip, sessionsTitle, shortenCwd, outsideRows } from "./hostSessions";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

test("sessionsChip names the hosts that have sessions and the age of the newest", () => {
  assert.equal(sessionsChip({ claude: 12, codex: 3, total: 15, lastAt: "2026-09-19T09:00:00.000Z" }, NOW), "claude 12 · codex 3 · 2d ago");
  assert.equal(sessionsChip({ claude: 0, codex: 1, total: 1, lastAt: "2026-09-21T09:00:00.000Z" }, NOW), "codex 1 · today");
  assert.equal(sessionsChip({ claude: 2, codex: 0, total: 2, lastAt: null }, NOW), "claude 2 · never");
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: null }, NOW), null);
  assert.equal(sessionsChip(undefined, NOW), null);
});

test("the chip reads the window: counts are the last windowDays days, older sessions read 'none in 30d' (spaces-redesign D34)", () => {
  const w = { windowDays: 30, recent: [] };
  assert.equal(sessionsChip({ claude: 1, codex: 2, total: 3, lastAt: "2026-09-20T09:00:00.000Z", ...w }, NOW), "claude 1 · codex 2 · 1d ago");
  // Every session is older than the window: the counts are 0, but the workspace was worked on.
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", ...w }, NOW), "none in 30d · 45d ago");
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 14 }, NOW), "none in 14d · 45d ago");
  // Never any session, or a snapshot from before the window (all-time counts): no chip, as before.
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: null, ...w }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "garbage", ...w }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z" }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 0 }, NOW), null);
});

test("sessionsTitle names the window and both hosts; none without a window or a chip", () => {
  assert.equal(sessionsTitle({ claude: 1, codex: 2, total: 3, lastAt: "2026-09-20T09:00:00.000Z", windowDays: 30 }, NOW),
    "Sessions in the last 30 days, both hosts: Claude Code 1, Codex 2; the newest 1d ago");
  assert.equal(sessionsTitle({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 30 }, NOW),
    "Sessions in the last 30 days, both hosts: Claude Code 0, Codex 0; the newest 45d ago");
  assert.equal(sessionsTitle({ claude: 2, codex: 0, total: 2, lastAt: null, windowDays: 30 }, NOW), "Sessions in the last 30 days, both hosts: Claude Code 2, Codex 0");
  assert.equal(sessionsTitle({ claude: 12, codex: 3, total: 15, lastAt: "2026-09-19T09:00:00.000Z" }, NOW), null, "an all-time snapshot names no window");
  assert.equal(sessionsTitle({ claude: 0, codex: 0, total: 0, lastAt: null, windowDays: 30 }, NOW), null);
  assert.equal(sessionsTitle(null, NOW), null);
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

test("outsideRows reads the snapshot's window: rows with sessions keep their chip, older ones read 'none in 30d'", () => {
  const list = [
    { cwd: "/opt/sample/scratchpad", claude: 2, codex: 0, total: 2, lastAt: "2026-09-21T09:00:00.000Z", exists: true, match: null, git: null, worktrees: 0 },
    { cwd: "/home/demo/old", claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", exists: false, match: null, git: null, worktrees: 0 },
  ];
  assert.deepEqual(outsideRows(list, 8, NOW, "/home/demo", 30).map((r) => r.chip), ["claude 2 · today", "none in 30d · 45d ago"]);
  assert.deepEqual(outsideRows(list, 8, NOW, "/home/demo").map((r) => r.chip), ["claude 2 · today", "45d ago"], "no window: today's fallback");
});
