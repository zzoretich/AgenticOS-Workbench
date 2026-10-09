import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BRIEFING_ROUTINE, bandLabels, touchesPulse } from "./meta";

const REPO = path.resolve(__dirname, "../../../..");

test("'Turn on' writes exactly the routine new vaults get (vault-template/brain/routines/briefing.md)", () => {
  assert.equal(BRIEFING_ROUTINE, fs.readFileSync(path.join(REPO, "vault-template/brain/routines/briefing.md"), "utf8"));
});

test("Pulse redraws for its facts, caches and the briefing, and not for unrelated files", () => {
  for (const p of ["brain/_index/briefing.json", "brain/_index/snapshot.json", "persona/proposals/x.md", "persona/STATE.md", "TODO.md",
    "brain/notifications/2026/x.md", "brain/memory/feedback/_drafts/a.md", "brain/routines/briefing.md", "persona/teams/lab/board.jsonl"]) {
    assert.ok(touchesPulse(p), p);
  }
  for (const p of ["notes/x.md", "brain/_index/recall-index.json", "workspaces/a/README.md"]) assert.ok(!touchesPulse(p), p);
});

test("the band's buttons say what they do; two that would read alike name their items", () => {
  const item = (kind: string, title: string, ref = "") => ({ kind, title, ref });
  assert.deepEqual(bandLabels([{ n: item("error", "hooks point nowhere"), label: "Fix in a session →", jump: true }, { n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }]),
    ["See the error →", "Review the proposal →"]);
  assert.deepEqual(bandLabels([{ n: item("routine", "x", "nightly-scan"), label: "Run now", jump: false }, { n: item("pipeline", "x", "embed"), label: "See →", jump: true }]),
    ["Run nightly-scan", "See embed →"]);
  assert.deepEqual(bandLabels([{ n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }, { n: item("proposal", "An idea with loose ends that runs long"), label: "Review →", jump: true }]),
    ["Review “Trim the playbook” →", "Review “An idea with loose ends…” →"]);
  assert.deepEqual(bandLabels([{ n: item("proposal", "Trim the playbook"), label: "Review →", jump: true }]), ["Review the proposal →"]);
});
