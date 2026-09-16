import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPipeline, pipelineStatuses, PipelinesFile, PipelineState } from "./pipelines";

const NOW = Date.parse("2026-08-05T16:00:00Z");
const mk = (over: object): PipelineState => ({
  lastRun: { startedAt: "2026-08-05T15:59:00Z", endedAt: "2026-08-05T15:59:05Z",
    durationMs: 5000, status: "ok", error: null, wrote: [], counts: {}, pid: 1, ...over },
  history: [],
});

test("fresh ok run classifies ok", () => {
  const s = classifyPipeline("scan-vault", mk({}), NOW);
  assert.equal(s.health, "ok");
});

test("old ok run classifies stale once past its freshness window", () => {
  const s = classifyPipeline("scan-vault",
    mk({ startedAt: "2026-08-05T14:00:00Z", endedAt: "2026-08-05T14:00:05Z" }), NOW);
  assert.equal(s.health, "stale"); // scan-vault window = 45 min
});

test("error run classifies failed and carries the error text", () => {
  const s = classifyPipeline("auto-cost", mk({ status: "error", error: "boom" }), NOW);
  assert.equal(s.health, "failed");
  assert.match(s.detail, /boom/);
});

test("running run older than diedAfterMs classifies died", () => {
  const s = classifyPipeline("scan-vault",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:30:00Z" }), NOW);
  assert.equal(s.health, "died"); // 30 min > 10 min diedAfter
});

test("running run within diedAfterMs stays ok (in-flight)", () => {
  const s = classifyPipeline("scan-vault",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:58:30Z" }), NOW);
  assert.equal(s.health, "ok");
  assert.match(s.label, /running/i);
});

test("missing pipeline classifies never", () => {
  const s = classifyPipeline("session-summary", undefined, NOW);
  assert.equal(s.health, "never");
});

test("pipelineStatuses covers every EXPECTED pipeline even on a null file", () => {
  const all = pipelineStatuses(null, NOW);
  assert.ok(all.length >= 4);
  assert.ok(all.every((s) => s.health === "never"));
  const file: PipelinesFile = { version: 1, pipelines: { "scan-vault": mk({}) } };
  const withOne = pipelineStatuses(file, NOW);
  assert.equal(withOne.find((s) => s.name === "scan-vault")?.health, "ok");
});

test("file-map is an expected pipeline", () => {
  const all = pipelineStatuses(null, NOW);
  assert.ok(all.some((s) => s.name === "file-map" && s.health === "never"));
});

// Regression: file-map is on-demand (brain/scripts/map-workspace.js) and has
// nothing to do while 0 files are pending, so it used to sit permanently
// "stale 9d" with no action that could clear it. Age must carry no signal here.
test("file-map never classifies stale by age, however old its last ok run", () => {
  const ancient = classifyPipeline("file-map",
    mk({ startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" }), NOW);
  assert.equal(ancient.health, "ok");
  assert.doesNotMatch(ancient.detail, /freshness window/);
});

// ...but a genuinely broken on-demand run must still surface.
test("file-map still classifies failed and died", () => {
  assert.equal(classifyPipeline("file-map",
    mk({ status: "error", error: "ollama refused" }), NOW).health, "failed");
  assert.equal(classifyPipeline("file-map",
    mk({ status: "running", endedAt: null, startedAt: "2026-08-05T15:30:00Z" }), NOW).health, "died");
});

test("an explicit null staleAfterMs disables age-based staleness", () => {
  const s = classifyPipeline("scan-vault",
    mk({ startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:05Z" }), NOW,
    { staleAfterMs: null });
  assert.equal(s.health, "ok");
});

test("auto-wrap and build-brain-md are expected pipelines that classify never on a null file", () => {
  const all = pipelineStatuses(null, NOW);
  assert.ok(all.some((s) => s.name === "auto-wrap" && s.health === "never"));
  assert.ok(all.some((s) => s.name === "build-brain-md" && s.health === "never"));
});
