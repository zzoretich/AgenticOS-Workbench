import { test } from "node:test";
import assert from "node:assert/strict";
import { lastStderrLine } from "./askSpawner";

test("lastStderrLine skips stack frames and blank lines, returning the last meaningful line", () => {
  assert.equal(
    lastStderrLine("Invalid API key\nNot logged in · Please run /login\n    at foo (x.js:1:1)\n"),
    "Not logged in · Please run /login",
  );
  assert.equal(lastStderrLine(""), "");
  assert.equal(lastStderrLine("    at foo (x.js:1:1)\n    at bar (y.js:2:2)\n"), "");
});
