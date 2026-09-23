import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalBadge, badgeText, touchesBadges } from "./badges";

test("proposalBadge counts proposal files and skips the README and non-Markdown", () => {
  assert.equal(proposalBadge([]), 0);
  assert.equal(proposalBadge([
    "persona/proposals/README.md",
    "persona/proposals/2026-09-20-a.md",
    "persona/proposals/2026-09-21-b.md",
    "persona/proposals/.DS_Store",
    "persona/proposals/notes.txt",
  ]), 2);
  assert.equal(proposalBadge(["2026-09-20-a.md"]), 1, "bare names work too");
});

test("badgeText hides zero and caps at 99+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-1), "");
  assert.equal(badgeText(Number.NaN), "");
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("touchesBadges matches the proposals folder and its files only", () => {
  assert.equal(touchesBadges("persona/proposals"), true);
  assert.equal(touchesBadges("persona/proposals/2026-09-20-a.md"), true);
  assert.equal(touchesBadges("persona/proposals-old/x.md"), false);
  assert.equal(touchesBadges("persona/STATE.md"), false);
});
