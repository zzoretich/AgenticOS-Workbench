import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { createRequire } from "module";
import { parseStatusline, isStale, barSegments, workbenchTabFrom, StatuslineModel } from "./statusline";

// The on-disk contract is shared with brain/scripts/lib/statusline-model.js (spec 2026-09-28-statusline-design D3): the
// runtime builds the model from a fixture vault and this parser must read it back field for field.
const REPO = path.resolve(__dirname, "../../..");
const runtime = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/statusline-model.js"));
const NOW = new Date("2026-09-28T19:00:00Z");

const FULL: StatuslineModel = {
  schema: 1, at: NOW.toISOString(), vault: "AgenticOS",
  needs: { gates: [{ team: "dev", item: "devbar-01", stage: "ship" }, { team: "dev", item: "site-02", stage: null }], alerts: 2, breaking: 1, flags: 1 },
  runs: [{ team: "dev", member: "woz", stage: "execute", item: "devbar-01" }, { team: "dev", member: "jordan", stage: "execute", item: "x" }],
  spend: { family: "crossReview", usd: 8.5, cap: 10 },
  health: { update: "0.21.0", provider: "claude-not-logged-in", unwrapped: true, drafts: 11 },
};

test("parseStatusline reads what the runtime writes, field for field", () => {
  const built = runtime.build(path.resolve(__dirname, "fixtures/teams-vault"), { now: NOW, alive: () => false });
  const parsed = parseStatusline(JSON.stringify(built));
  assert.ok(parsed);
  assert.equal(parsed.at, built.at);
  assert.deepEqual(parsed.needs.gates, built.needs.gates.map((g: { team: string; item: string; stage: string | null }) => ({ team: g.team, item: g.item, stage: g.stage })));
  assert.equal(parsed.needs.gates.length > 0, true, "the teams fixture has a pending gate to carry");
  assert.deepEqual(parsed.health, built.health);
  assert.deepEqual(parseStatusline(JSON.stringify(FULL)), FULL);
});

test("parseStatusline refuses anything but a schema-1 model and coerces bad fields", () => {
  for (const raw of [null, "", "nope", "[]", JSON.stringify({ ...FULL, schema: 2 }), JSON.stringify({ schema: 1 })]) assert.equal(parseStatusline(raw), null, String(raw));
  const odd = parseStatusline(JSON.stringify({ schema: 1, at: "x", needs: { gates: [{ item: 3 }, "g", { item: "ok" }], alerts: -2, flags: "1" }, runs: "no", spend: { family: "hooks", usd: 1, cap: 0 } }));
  assert.deepEqual(odd?.needs, { gates: [{ team: "", item: "ok", stage: null }], alerts: 0, breaking: 0, flags: 0 });
  assert.deepEqual(odd?.runs, []);
  assert.equal(odd?.spend, null, "a zero cap is no spend line");
});

test("isStale: older than 15 s (D3), absent, or from the future", () => {
  assert.equal(isStale(FULL, NOW.getTime() + 10_000), false);
  assert.equal(isStale(FULL, NOW.getTime() + 16_000), true);
  assert.equal(isStale(FULL, NOW.getTime() - 120_000), true);
  assert.equal(isStale(null), true);
});

test("barSegments: what needs you first, each opening where it is handled", () => {
  assert.deepEqual(barSegments(FULL).map((s) => [s.text, s.tone, s.tab ?? s.file ?? null]), [
    ["◆ 2 gates", "violet", "agent-teams"],
    ["1 breaking", "rose", "notifications"],
    ["2 alerts", "amber", "notifications"],
    ["1 flag", "amber", "persona/STATE.md"],
    ["▶ woz execute +1", "cyan", "agent-teams"],
    ["cross-review $8.50/$10", "rose", "settings"],
    ["↑ 0.21.0", "amber", "settings"],
    ["provider none", "rose", "settings"],
    ["not wrapped", "amber", null],
    ["11 drafts", "dim", null],
  ]);
  const one = barSegments({ ...FULL, needs: { gates: [FULL.needs.gates[0]], alerts: 0, breaking: 0, flags: 0 }, runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 } });
  assert.deepEqual(one.map((s) => [s.text, s.title]), [["◆ gate devbar-01", "devbar-01 · ship gate waits on you"]]);
  assert.deepEqual(barSegments({ ...FULL, needs: { gates: [], alerts: 0, breaking: 0, flags: 0 }, runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 } }), []);
});

test("workbenchTabFrom: only a rail tab id opens a tab", () => {
  const ids = ["pulse", "agent-teams", "notifications", "settings"];
  assert.equal(workbenchTabFrom({ action: "agenticos", tab: "agent-teams" }, ids), "agent-teams");
  assert.equal(workbenchTabFrom({ action: "agenticos", tab: "../../etc" }, ids), null);
  assert.equal(workbenchTabFrom({ action: "agenticos" }, ids), null);
});
