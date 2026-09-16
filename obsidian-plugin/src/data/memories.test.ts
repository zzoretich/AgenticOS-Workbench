import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryMeta, filterMemories, MemoryMeta } from "./memories";

const RAW = `---
type: memory
tags: [memory/feedback, status/active]
created: 2026-03-23
updated: 2026-05-30
---
# Working style

Prefers terse answers with file:line refs.`;

test("parseMemoryMeta extracts type, title, dates from frontmatter + H1", () => {
  const m = parseMemoryMeta("brain/memory/feedback/working-style.md", RAW);
  assert.equal(m.type, "feedback");
  assert.equal(m.title, "Working style");
  assert.equal(m.slug, "working-style");
  assert.equal(m.updated, "2026-05-30");
});

test("parseMemoryMeta falls back to slug when no H1", () => {
  const m = parseMemoryMeta("brain/memory/user/profile.md", "---\ntype: memory\n---\nno heading here");
  assert.equal(m.title, "profile");
});

test("type comes from the path segment, not the tag", () => {
  const m = parseMemoryMeta("brain/memory/reference/decisions.md", RAW);
  assert.equal(m.type, "reference");
});

test("filterMemories narrows by type and by query over title+slug", () => {
  const list: MemoryMeta[] = [
    parseMemoryMeta("brain/memory/feedback/working-style.md", RAW),
    parseMemoryMeta("brain/memory/user/profile.md", "# Profile\n"),
  ];
  assert.equal(filterMemories(list, "", "feedback").length, 1);
  assert.equal(filterMemories(list, "PROF", null).length, 1);
  assert.equal(filterMemories(list, "", null).length, 2);
});
