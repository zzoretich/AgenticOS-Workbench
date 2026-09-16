import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyNotePath, isDailyNotePath } from "./dailyNote";

test("dailyNotePath builds the 2026/<month folder>/<date>.md convention", () => {
  assert.equal(dailyNotePath(new Date(2026, 7, 5)), "2026/2026-08-August/2026-08-05.md");
  assert.equal(dailyNotePath(new Date(2026, 0, 1)), "2026/2026-01-January/2026-01-01.md");
  assert.equal(dailyNotePath(new Date(2026, 11, 31)), "2026/2026-12-December/2026-12-31.md");
});

test("isDailyNotePath matches daily notes anywhere under a year root", () => {
  assert.equal(isDailyNotePath("2026/2026-08-August/2026-08-05.md"), true);
  assert.equal(isDailyNotePath("2026/2026-08-04.md"), true); // stray-at-root still counts
  assert.equal(isDailyNotePath("brain/memory/projects/steno.md"), false);
  assert.equal(isDailyNotePath("brain/sessions/2026-08-05.md"), false); // legacy path is NOT valid
});
