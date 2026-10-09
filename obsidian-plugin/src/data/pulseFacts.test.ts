import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "module";
import type { App } from "obsidian";
import { AREAS, gatherPulseInputs, openFlags, pulseFacts, spendToday, type PulseInputs } from "./pulseFacts";
import { diskAdapter } from "./teams";

// The fixture vault is read by both sides (spec 2026-10-08-pulse-cockpit-design P8): this module and
// brain/scripts/lib/pulse-facts.js. Its times carry no offset, so the facts are the same in every timezone.
const REPO = path.resolve(__dirname, "../../..");
const VAULT = path.join(REPO, "brain/scripts/test/fixtures/pulse-vault");
const runtime = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/pulse-facts.js"));
const NOW = new Date(2026, 9, 8, 19, 24);
const withoutHash = ({ hash: _hash, ...rest }: { hash?: string }) => rest;

test("the twin: the same inputs give the runtime's facts (items, order, titles, summary)", () => {
  const inputs = runtime.read(VAULT, { now: NOW }) as PulseInputs;
  assert.deepEqual(pulseFacts(inputs, NOW), withoutHash(runtime.facts(inputs, NOW)));
  assert.deepEqual([...AREAS], runtime.AREAS);
});

test("the HUD's own reads of the fixture vault give the runtime's facts", async () => {
  const app = { vault: { adapter: diskAdapter(VAULT) } } as unknown as App;
  const inputs = await gatherPulseInputs(app, VAULT, NOW);
  assert.deepEqual(pulseFacts(inputs, NOW), withoutHash(runtime.facts(runtime.read(VAULT, { now: NOW }), NOW)));
  assert.equal(inputs.personaName, "Beacon");
  assert.deepEqual(inputs.gates.map((g) => g.item), ["site-02"]);
});

test("an empty vault: no items, nothing thrown", async () => {
  const f = pulseFacts({ personaName: null, proposals: [], stateMd: null, drafts: 0, gates: [], issues: [], workspaces: [], pipelines: {}, routines: {}, todo: null, notifications: [], trail: [], spend: { usd: 0, calls: 0 } }, NOW);
  assert.deepEqual(f.needsYou, []);
  assert.equal(f.summary.notifications.latest, null);
});

test("open flags: unchecked and bare bullets under ## Flags only, with a leading date split off", () => {
  assert.deepEqual(openFlags("## Flags\n- [ ] 2026-10-01 One\n- [x] Done\n- (none)\n* Two\n## Next\n- Not a flag"), [
    { date: "2026-10-01", text: "One" }, { date: null, text: "Two" },
  ]);
});

test("spend today: the local day's rows, every row a call, usd summed", () => {
  const text = ['{"ts":"2026-10-07T23:00:00","usd":1}', '{"ts":"2026-10-08T07:00:00","usd":0.25}', '{"ts":"2026-10-08T08:00:00"}', "torn"].join("\n");
  assert.deepEqual(spendToday(text, NOW), { usd: 0.25, calls: 2 });
});
