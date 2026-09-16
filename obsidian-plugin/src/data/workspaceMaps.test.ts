import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStats, filterFiles, WorkspaceMap } from "./workspaceMaps";

const MAP: WorkspaceMap = {
  workspace: "Alpha", generatedAt: "2026-08-05T21:00:00Z", pending: 1,
  files: [
    { path: "src/main.js", desc: "Entry point that boots the app", descAt: "2026-08-05T21:00:00Z", mtime: 1, size: 10, status: "fresh" },
    { path: "README.md", desc: null, descAt: null, mtime: 2, size: 20, status: "new" },
    { path: "docs/guide.md", desc: "How to use Alpha end to end", descAt: "2026-08-05T21:00:00Z", mtime: 3, size: 30, status: "changed" },
  ],
};

test("mapStats counts mapped vs pending", () => {
  assert.deepEqual(mapStats(MAP), { mapped: 1, pending: 2, total: 3 });
});

test("filterFiles matches path and description, case-insensitive", () => {
  assert.deepEqual(filterFiles(MAP, "BOOT").map((f) => f.path), ["src/main.js"]);
  assert.deepEqual(filterFiles(MAP, "docs/").map((f) => f.path), ["docs/guide.md"]);
  assert.equal(filterFiles(MAP, "").length, 3);
});

test("mapStats on empty map", () => {
  assert.deepEqual(mapStats({ workspace: "x", generatedAt: null, pending: 0, files: [] } as unknown as WorkspaceMap),
    { mapped: 0, pending: 0, total: 0 });
});
