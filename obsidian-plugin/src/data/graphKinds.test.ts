import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPath } from "./graphKinds";

test("classifyPath tags memory, patterns, agents and default-layout daily notes", () => {
  assert.equal(classifyPath("brain/memory/projects/steno.md"), "memory");
  assert.equal(classifyPath("brain/patterns/tdd.md"), "pattern");
  assert.equal(classifyPath("agents/Explorer.md"), "agent");
  assert.equal(classifyPath("2026/2026-09-September/2026-09-04.md"), "session");
  assert.equal(classifyPath("README.md"), null);
});

test("classifyPath honors a custom dailyNote.layout for session nodes (spec §5.3)", () => {
  const layout = "daily/{yyyy}-{MM}-{dd}.md";
  assert.equal(classifyPath("daily/2026-01-09.md", layout), "session");
  assert.equal(classifyPath("daily/2026-01-09.md"), null); // default layout does not know this folder
  assert.equal(classifyPath("daily/notes.md", layout), null);
});
