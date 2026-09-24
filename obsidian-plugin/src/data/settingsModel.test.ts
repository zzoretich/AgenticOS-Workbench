import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseConfigList, groupBySection, changedCount, masterRows, MASTER_SWITCHES, valueArg, inputText, parseInput, confirmFor,
  appliesLabel, sourceLabel, sourceTitle, spendLine, hostNote, resultSummary, FollowUps, argsFor,
} from "./settingsModel";
import type { ConfigRow, ConfigList } from "./settingsModel";

const row = (over: Partial<ConfigRow>): ConfigRow => ({
  key: "k", section: "provider", label: "K", help: "Help.", type: "bool", values: null, min: null, gt: null, max: null, int: false,
  nullable: false, risk: null, applies: "next-call", readonly: false, how: null, host: null, default: true, value: true,
  source: "default", changed: false, note: null, spentToday: null, ...over,
});

const LIST: ConfigList = {
  schema: 1,
  files: { machine: "/cfg/agenticos.json", vault: "/v/brain/config.json" },
  sections: [{ id: "provider", label: "Provider & models" }, { id: "spend", label: "Spend limits" }, { id: "empty", label: "Nothing" }],
  settings: [
    row({ key: "provider", type: "enum", values: ["auto", "ollama", "claude", "codex", "none"], value: "none", default: "auto", changed: true, risk: "spend" }),
    row({ key: "claude.perDayUsd", section: "spend", type: "number", min: 0, value: 0.5, default: 0.5, risk: "spend", spentToday: 0.12, host: "claude" }),
    row({ key: "persona.enabled", section: "spend", value: false, default: true, changed: true, risk: "autonomy" }),
  ],
};

test("parseConfigList accepts schema 1 only, and every row needs a key, section and type", () => {
  assert.equal(parseConfigList(LIST), LIST);
  assert.equal(parseConfigList({ ...LIST, schema: 2 }), null);
  assert.equal(parseConfigList({ ...LIST, settings: [{ key: 1 }] }), null);
  assert.equal(parseConfigList(null), null);
  assert.equal(parseConfigList("x"), null);
});

test("groupBySection keeps the runtime's order and drops an empty section; changedCount counts *", () => {
  assert.deepEqual(groupBySection(LIST).map((g) => [g.section.id, g.rows.map((r) => r.key)]), [["provider", ["provider"]], ["spend", ["claude.perDayUsd", "persona.enabled"]]]);
  assert.equal(changedCount(LIST), 2);
});

test("master switches (D5): Background AI is provider none ↔ auto; flags are true/false; unknown keys skipped", () => {
  const m = masterRows(LIST);
  assert.deepEqual(m.map((x) => [x.sw.key, x.on]), [["provider", false], ["persona.enabled", false]]);
  const ai = MASTER_SWITCHES[0];
  assert.equal(ai.valueFor(true), "auto");
  assert.equal(ai.valueFor(false), "none");
  assert.equal(ai.isOn("ollama"), true);
  assert.equal(MASTER_SWITCHES.length, 10);
  assert.equal(new Set(MASTER_SWITCHES.map((s) => s.key)).size, 10);
});

test("valueArg and inputText: strings as typed, null as `null` / empty, the rest as JSON", () => {
  assert.equal(valueArg("auto"), "auto");
  assert.equal(valueArg(null), "null");
  assert.equal(valueArg(false), "false");
  assert.equal(valueArg(["a"]), '["a"]');
  assert.equal(inputText(null), "");
  assert.equal(inputText(0.5), "0.5");
  assert.equal(inputText({ a: 1 }), '{"a":1}');
});

test("parseInput: bounds, whole numbers, nullable empty, JSON lists and objects, empty strings", () => {
  const num = row({ key: "claude.perCallUsd", type: "number", gt: 0, risk: "spend" });
  assert.deepEqual(parseInput(num, " 0.2 "), { ok: true, value: 0.2 });
  assert.deepEqual(parseInput(num, "0"), { ok: false, error: "claude.perCallUsd must be more than 0 (to stop spending, set the matching daily cap to 0)" });
  assert.deepEqual(parseInput(num, "abc"), { ok: false, error: "claude.perCallUsd must be a number" });
  assert.deepEqual(parseInput(num, ""), { ok: false, error: "claude.perCallUsd must be a number" });
  const port = row({ key: "ollama.port", type: "number", int: true, min: 1, max: 65535 });
  assert.equal(parseInput(port, "1.5").ok, false);
  assert.deepEqual(parseInput(port, "70000"), { ok: false, error: "ollama.port must be at most 65535" });
  assert.deepEqual(parseInput(row({ key: "codex.model", type: "model", nullable: true }), "  "), { ok: true, value: null });
  assert.deepEqual(parseInput(row({ key: "claude.model", type: "model" }), ""), { ok: false, error: "claude.model cannot be empty" });
  const list = row({ key: "recallRoots", type: "list" });
  assert.deepEqual(parseInput(list, '["brain/memory"]'), { ok: true, value: ["brain/memory"] });
  assert.equal(parseInput(list, "brain/memory").ok, false);
  assert.equal(parseInput(list, "[1]").ok, false);
  assert.equal(parseInput(row({ key: "roster.orchestrators", type: "object" }), "[]").ok, false);
});

test("confirmFor (D6): raising spend asks; lowering does not", () => {
  const cap = row({ key: "claude.perDayUsd", label: "Background daily cap (Claude)", type: "number", min: 0, value: 0.5, risk: "spend" });
  assert.deepEqual(confirmFor(cap, 5), { title: "Raise Background daily cap (Claude)?", message: "claude.perDayUsd: $0.50 → $5.00.", cta: "Raise" });
  assert.equal(confirmFor(cap, 0.1), null);
  assert.equal(confirmFor(cap, 0.5), null, "no change, no question");
  const files = row({ key: "scan.fileMapBudgetUnderClaude", type: "number", min: 0, value: 0, risk: "spend" });
  assert.match(confirmFor(files, 10)!.message, /: 0 → 10\.$/, "not money");
});

test("confirmFor (D6): the provider asks only when moving from free to paid", () => {
  const p = row({ key: "provider", type: "enum", value: "none", risk: "spend" });
  assert.equal(confirmFor(p, "auto")!.cta, "Turn on");
  assert.match(confirmFor(p, "codex")!.message, /your Codex login/);
  assert.equal(confirmFor({ ...p, value: "ollama" }, "claude")!.cta, "Turn on");
  assert.equal(confirmFor({ ...p, value: "claude" }, "none"), null);
  assert.equal(confirmFor({ ...p, value: "auto" }, "claude"), null, "already paid");
  assert.equal(confirmFor(p, "ollama"), null);
});

test("confirmFor (D6): spend switches, autonomy, privacy", () => {
  const sem = row({ key: "graph.semantic.enabled", label: "Semantic graph pass", type: "enum", values: [true, false, "auto"], value: false, risk: "spend" });
  assert.equal(confirmFor(sem, "auto")!.title, "Turn on Semantic graph pass?");
  assert.equal(confirmFor({ ...sem, value: true }, false), null);
  const cos = row({ key: "persona.enabled", label: "Chief of Staff", value: false, risk: "autonomy" });
  assert.equal(confirmFor(cos, true)!.cta, "Turn on");
  assert.equal(confirmFor({ ...cos, value: true }, false), null, "turning it off never asks");
  const min = row({ key: "persona.autoapply.minVerified", label: "Autoapply threshold", type: "number", value: 3, risk: "autonomy" });
  assert.equal(confirmFor(min, 1)!.cta, "Lower");
  assert.equal(confirmFor(min, 5), null);
  assert.equal(confirmFor(row({ key: "routines.tools", type: "string", value: "Read,Glob,Grep", risk: "autonomy" }), "Read,Write")!.cta, "Change");
  const redact = row({ key: "telemetry.redact", label: "Redact tool inputs", value: true, risk: "privacy" });
  assert.equal(confirmFor(redact, false)!.cta, "Turn off");
  assert.equal(confirmFor({ ...redact, value: false }, true), null);
  assert.equal(confirmFor(row({ key: "updates.check", value: true }), false), null, "no risk class, no question");
});

test("labels: applies, source and its tooltip", () => {
  assert.equal(appliesLabel("next-scan"), "applies at the next scan");
  assert.equal(appliesLabel("later"), "applies: later");
  assert.equal(sourceLabel("machine"), "this machine");
  assert.equal(sourceLabel("vault"), "this vault");
  assert.equal(sourceTitle("machine", LIST.files), "set in /cfg/agenticos.json");
  assert.match(sourceTitle("default", LIST.files), /neither file/);
});

test("spendLine (D7): today against the cap; 0 means no spend; other rows none", () => {
  assert.equal(spendLine(row({ type: "number", value: 0.5, spentToday: 0.12 })), "today $0.12 of $0.50");
  assert.equal(spendLine(row({ type: "number", value: 0, spentToday: 0 })), "today $0.00 · no spend allowed");
  assert.equal(spendLine(row({ type: "number", value: 0.05, spentToday: null })), null);
});

test("hostNote (D8): only a host-specific row on a machine without that host", () => {
  assert.match(hostNote(row({ host: "codex" }), ["claude"])!, /^Codex is off on this machine; `aos init --host both`/);
  assert.match(hostNote(row({ host: "claude" }), ["codex"])!, /^Claude Code is off/);
  assert.equal(hostNote(row({ host: "codex" }), ["claude", "codex"]), null);
  assert.equal(hostNote(row({ host: null }), ["claude"]), null);
});

test("resultSummary: the change, then each effect on its own line", () => {
  assert.equal(resultSummary({ key: "provider", old: "auto", value: "none", file: "/f", source: "machine", dryRun: false, effects: ["cleared the cached provider probe"], followUps: [] }),
    "provider: auto → none\ncleared the cached provider probe");
  assert.equal(resultSummary({ key: "codex.model", old: null, value: "gpt-5", file: "/f", source: "vault", dryRun: false, effects: [], followUps: [] }), "codex.model: null → gpt-5");
});

test("FollowUps (D9): deduped, removable, and only plain aos commands are kept", () => {
  const f = new FollowUps();
  f.add([{ command: "aos routines sync", why: "schedules" }, { command: "aos routines sync", why: "again" }, { command: "rm -rf /", why: "no" }]);
  f.add(undefined);
  assert.equal(f.size, 1);
  assert.deepEqual(f.list(), [{ command: "aos routines sync", why: "again" }]);
  f.remove("aos routines sync");
  assert.equal(f.size, 0);
  assert.deepEqual(argsFor("aos skills sync"), ["skills", "sync"]);
  assert.equal(argsFor("aos routines sync; rm x"), null);
  assert.equal(argsFor("routines sync"), null);
});
