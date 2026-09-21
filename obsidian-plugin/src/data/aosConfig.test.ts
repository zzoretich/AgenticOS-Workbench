import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  VAULT_CONFIG_DEFAULTS, readAgenticosJson, readVaultConfig, dailyNoteLayout, readProviderState, deepMerge, personaName,
} from "./aosConfig";

let vault: string;
let cfgDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-plugin-vault-"));
  fs.mkdirSync(path.join(vault, "brain", "_index"), { recursive: true });
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-plugin-cfg-"));
  for (const k of ["CLAUDE_CONFIG_DIR", "AOS_CONFIG"]) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
});
afterEach(() => {
  for (const k of ["CLAUDE_CONFIG_DIR", "AOS_CONFIG"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("defaults mirror config.default.json", () => {
  assert.equal(VAULT_CONFIG_DEFAULTS.dailyNote.layout, "{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md");
  assert.deepEqual(VAULT_CONFIG_DEFAULTS.roster.orchestrators, {});
  assert.equal(VAULT_CONFIG_DEFAULTS.scan.autoSweepOrphans, false);
  assert.equal(VAULT_CONFIG_DEFAULTS.scan.fileMapBudgetUnderClaude, 0); // Plan 2 Task 3's one added key
  assert.equal(VAULT_CONFIG_DEFAULTS.cost.enabled, false);
  assert.equal(VAULT_CONFIG_DEFAULTS.cost.monthlyBudget, null);
  assert.equal(VAULT_CONFIG_DEFAULTS.claude.model, "haiku");
  assert.equal(VAULT_CONFIG_DEFAULTS.reasoner.model, "claude-opus-5");
  assert.equal(VAULT_CONFIG_DEFAULTS.reasoner.perCallUsd, 0.5);
  assert.equal(VAULT_CONFIG_DEFAULTS.persona.enabled, true);
  assert.equal(VAULT_CONFIG_DEFAULTS.persona.perDutyUsd, 2);
  assert.equal(VAULT_CONFIG_DEFAULTS.persona.perDayUsd, 6); // contract §1: persona caps ship in config.default.json
  assert.equal(VAULT_CONFIG_DEFAULTS.routines.perDayUsd, 6);
  assert.deepEqual(VAULT_CONFIG_DEFAULTS.routines.externalLabels, []);
  const upstream = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../brain/scripts/config.default.json"), "utf8"));
  assert.deepEqual(VAULT_CONFIG_DEFAULTS, upstream);
});

test("readAgenticosJson is null when the file is missing and parses it when present", () => {
  assert.equal(readAgenticosJson(), null);
  fs.writeFileSync(path.join(cfgDir, "agenticos.json"), JSON.stringify({ vault, node: "/opt/x/bin/node", provider: "none" }));
  const j = readAgenticosJson();
  assert.equal(j?.node, "/opt/x/bin/node");
  assert.equal(j?.provider, "none");
});

test("AOS_CONFIG overrides the agenticos.json location", () => {
  const alt = path.join(cfgDir, "elsewhere.json");
  fs.writeFileSync(alt, JSON.stringify({ node: "/alt/node" }));
  process.env.AOS_CONFIG = alt;
  assert.equal(readAgenticosJson()?.node, "/alt/node");
});

test("readVaultConfig returns defaults for an empty vault and deep-merges brain/config.json", () => {
  assert.deepEqual(readVaultConfig(vault), VAULT_CONFIG_DEFAULTS);
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({
    scan: { fileMapBudget: 5 },
    cost: { monthlyBudget: 120 },
    roster: { orchestrators: { Planner: { nickname: "PLAN", trigger: "/plan" } } },
  }));
  const c = readVaultConfig(vault);
  assert.equal(c.scan.fileMapBudget, 5);
  assert.equal(c.scan.embedBudget, 40);
  assert.equal(c.cost.monthlyBudget, 120);
  assert.equal(c.cost.enabled, false);
  assert.equal(c.roster.orchestrators.Planner.nickname, "PLAN");
});

test("agenticos.json overrides brain/config.json (same precedence as lib/config.js)", () => {
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ provider: "ollama", cost: { enabled: false } }));
  fs.writeFileSync(path.join(cfgDir, "agenticos.json"), JSON.stringify({ provider: "none", cost: { enabled: true } }));
  const c = readVaultConfig(vault);
  assert.equal(c.provider, "none");
  assert.equal(c.cost.enabled, true);
});

test("dailyNoteLayout reads dailyNote.layout from the vault config", () => {
  assert.equal(dailyNoteLayout(vault), VAULT_CONFIG_DEFAULTS.dailyNote.layout);
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ dailyNote: { layout: "daily/{yyyy}-{MM}-{dd}.md" } }));
  assert.equal(dailyNoteLayout(vault), "daily/{yyyy}-{MM}-{dd}.md");
});

test("readProviderState is null when absent or malformed, parsed when present", () => {
  assert.equal(readProviderState(vault), null);
  fs.writeFileSync(path.join(vault, "brain", "_index", "provider-state.json"), "{ not json");
  assert.equal(readProviderState(vault), null);
  fs.writeFileSync(path.join(vault, "brain", "_index", "provider-state.json"), JSON.stringify({
    checkedAt: "2026-09-04T10:00:00Z", name: "claude", reason: "claude-logged-in",
    claude: { loggedIn: true, checkedAt: "2026-09-04T10:00:00Z", bin: "/home/alice/.local/bin/claude" },
  }));
  const s = readProviderState(vault);
  assert.equal(s?.name, "claude");
  assert.equal(s?.claude?.bin, "/home/alice/.local/bin/claude");
});

test("deepMerge replaces arrays and merges nested objects", () => {
  const out = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, list: [9] });
});

test("personaName is the first H1 of persona/IDENTITY.md, null when the file or H1 is absent", () => {
  assert.equal(personaName(vault), null);
  fs.mkdirSync(path.join(vault, "persona"), { recursive: true });
  fs.writeFileSync(path.join(vault, "persona", "IDENTITY.md"), "---\ntype: persona-identity\n---\n\nno heading yet\n");
  assert.equal(personaName(vault), null);
  fs.writeFileSync(path.join(vault, "persona", "IDENTITY.md"),
    "---\ntype: persona-identity\n---\n\n# Atlas\n\nAtlas is the chief of staff for this vault.\n\n## Voice\n\n# Not this one\n");
  assert.equal(personaName(vault), "Atlas");
});
