// The Pulse model's pure parts (views/pulse/model.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPendingRows } from "./model";
import type { WorkspaceEntry } from "../../data/snapshot";
import type { WorkspaceMap } from "../../data/workspaceMaps";

const map = (workspace: string, pending: number): WorkspaceMap => ({
  workspace, generatedAt: null, pending,
  files: Array.from({ length: pending + 1 }, (_, i) => ({ path: `f${i}`, desc: i < pending ? null : "described", descAt: null, mtime: 0, size: 1, status: "fresh" as const })),
});

test("mapPendingRows: a hidden entry's stale map gives no Fix Queue row, a visible one's does (spaces-redesign D22)", () => {
  const ws = [
    { name: "harbor-map" },
    { name: "_spikes", hidden: true, hiddenReason: "underscore" },
    { name: "_archive/pier-repairs", hidden: true, hiddenReason: "archived" },
    { name: "field-notes" },
  ] as WorkspaceEntry[];
  const maps = { "harbor-map": map("harbor-map", 3), _spikes: map("_spikes", 5), "_archive/pier-repairs": map("pier-repairs", 2), "field-notes": map("field-notes", 0) };
  assert.deepEqual(mapPendingRows(ws, maps), [{ workspace: "harbor-map", pending: 3 }]);
  assert.deepEqual(mapPendingRows(undefined, maps), []);
});
