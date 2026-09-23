// aosConfig.ts — the plugin-side readers for the three config surfaces the brain
// scripts use. Pure (fs/os/path only) so node:test can load it.
//   <configDir>/agenticos.json              written by `aos init`      (contract §2)
//   <vault>/brain/config.json               user-editable product config (contract §1 Config)
//   <vault>/brain/_index/provider-state.json written by sdk/lib/provider.js (contract §3)
// VAULT_CONFIG_DEFAULTS is a verbatim copy of brain/scripts/config.default.json as it stands
// after Plan 2 Task 3 (contract §1 shape + scan.fileMapBudgetUnderClaude); the merge order
// (defaults ← vault config ← agenticos.json) matches lib/config.js loadConfig().
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ProviderName = "ollama" | "claude" | "codex" | "none";
export type ProviderMode = ProviderName | "auto";

export interface AgenticosJson {
  version?: string;
  vault?: string;
  node?: string;
  claudeConfigDir?: string;
  provider?: ProviderMode;
  // bin: the absolute `claude` path aos init/upgrade resolved (contract §2, Task 0); absent in configs written before Plan 4.
  claude?: { model?: string; perCallUsd?: number; perDayUsd?: number; bin?: string };
  // The codex provider (design D9): model null = the user's own Codex default; caps over the same hook ledger.
  codex?: { model?: string | null; perCallUsd?: number; perDayUsd?: number; bin?: string };
  // The hosts a session may run under (design D1); absent in configs written before hosts existed (Claude-only).
  hosts?: { claude?: { enabled?: boolean; configDir?: string; bin?: string }; codex?: { enabled?: boolean; home?: string; bin?: string } };
  reasoner?: { model?: string; perCallUsd?: number; perDayUsd?: number; effort?: string };
  ollama?: { host?: string; port?: number };
  telemetry?: { enabled?: boolean; redact?: boolean; retentionDays?: number; staleAfterMinutes?: number };
  updates?: { check?: boolean; intervalHours?: number };
  cost?: { enabled?: boolean; monthlyBudget?: number | null };
  persona?: { enabled?: boolean };
  routines?: { enabled?: boolean; perRunUsd?: number; perDayUsd?: number; tools?: string; externalLabels?: string[] };
}

export interface OrchestratorEntry { nickname?: string; trigger?: string; match?: string }

export interface VaultConfig {
  dailyNote: { layout: string };
  recallRoots: string[];
  quickLinks: string[];
  roster: { orchestrators: Record<string, OrchestratorEntry> };
  scan: { fileMapBudget: number; embedBudget: number; fileMapBudgetUnderClaude: number; insightsUnderClaude: boolean; autoSweepOrphans: boolean };
  provider: ProviderMode;
  claude: { model: string; perCallUsd: number; perDayUsd: number };
  codex: { model: string | null; perCallUsd: number; perDayUsd: number };
  // The reasoner role: a Claude model with its own caps (reason:* ledger rows), used by the Chat tab.
  reasoner: { model: string; perCallUsd: number; perDayUsd: number; effort: string };
  ollama: { host: string; port: number };
  telemetry: { enabled: boolean; redact: boolean; retentionDays: number; staleAfterMinutes: number };
  updates: { check: boolean; intervalHours: number };
  cost: { enabled: boolean; monthlyBudget: number | null };
  graph: { enabled: boolean; out: string; timeoutSec: number; staleDays: number };
  persona: { enabled: boolean; runner: "auto" | "claude" | "codex"; perDutyUsd: number; perDayUsd: number; watchdog: { graceMinutes: number; notify: boolean }; tick: { flagAgeDays: number; earlyReflect: { corrections: number; dutyFailures: number } }; autoapply: { minVerified: number } };
  // Routines (brain/routines/*.md): caps for the prompt kind and the launchd labels the Routines tab lists read-only.
  routines: { enabled: boolean; runner: "auto" | "claude" | "codex"; perRunUsd: number; perDayUsd: number; tools: string; externalLabels: string[] };
}

export interface ProviderState {
  checkedAt: string;
  name: ProviderName;
  reason: string;
  ollama?: { reachable: boolean; checkedAt: string };
  // bin is `null` in the file whenever provider.js probed and found no CLI (contract §3), so the
  // type must admit null as well as absence; every reader guards with a truthiness check.
  claude?: { loggedIn: boolean; checkedAt: string; bin?: string | null };
  codex?: { loggedIn: boolean; checkedAt: string; bin?: string | null };
}

export const VAULT_CONFIG_DEFAULTS: VaultConfig = {
  dailyNote: { layout: "{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md" },
  recallRoots: ["brain/memory", "brain/patterns", "persona/journal"],
  quickLinks: [
    "- Memory index: `MEMORY.md` (root) · Working memory: [[SESSION]]",
    "- Projects: `brain/memory/projects/` · Reference: `brain/memory/reference/` · Patterns: `brain/patterns/`",
    "- Daily logs: `<year>/<year>-<month>/<date>.md`",
  ],
  roster: { orchestrators: {} },
  scan: { fileMapBudget: 40, embedBudget: 40, fileMapBudgetUnderClaude: 0, insightsUnderClaude: false, autoSweepOrphans: false },
  provider: "auto",
  claude: { model: "haiku", perCallUsd: 0.05, perDayUsd: 0.5 },
  codex: { model: null, perCallUsd: 0.05, perDayUsd: 0.5 },
  reasoner: { model: "claude-opus-5", perCallUsd: 0.5, perDayUsd: 5.0, effort: "medium" },
  ollama: { host: "127.0.0.1", port: 11434 },
  telemetry: { enabled: true, redact: true, retentionDays: 30, staleAfterMinutes: 30 },
  updates: { check: true, intervalHours: 24 },
  cost: { enabled: false, monthlyBudget: null },
  graph: { enabled: true, out: "brain/graphify-out", timeoutSec: 120, staleDays: 7 },
  persona: { enabled: true, runner: "auto", perDutyUsd: 2.0, perDayUsd: 6.0, watchdog: { graceMinutes: 45, notify: true }, tick: { flagAgeDays: 7, earlyReflect: { corrections: 3, dutyFailures: 2 } }, autoapply: { minVerified: 3 } },
  routines: { enabled: true, runner: "auto", perRunUsd: 2.0, perDayUsd: 6.0, tools: "Read,Glob,Grep", externalLabels: [] },
};

export const PROVIDER_STATE_PATH = "brain/_index/provider-state.json";
export const VAULT_CONFIG_PATH = "brain/config.json";

export function claudeConfigDir(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

/**
 * Where agenticos.json lives. `configDir` is Plugin.claudeConfigDir() (Task 3) — the setting,
 * then agenticos.json's own claudeConfigDir, then the env chain — so a plugin read never
 * disagrees with the folder the settings tab names. Omitted, this is the env chain alone.
 * $AOS_CONFIG still outranks both: it names the file directly (the CLI/test knob).
 */
export function agenticosJsonPath(configDir?: string): string {
  return path.resolve(process.env.AOS_CONFIG || path.join(configDir || claudeConfigDir(), "agenticos.json"));
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T extends object>(base: T, over: unknown): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!isPlainObject(over)) return out as T;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function readAgenticosJson(configDir?: string): AgenticosJson | null {
  const j = readJson<unknown>(agenticosJsonPath(configDir));
  return isPlainObject(j) ? (j as AgenticosJson) : null;
}

export function readVaultConfig(vaultRoot: string, configDir?: string): VaultConfig {
  const vaultCfg = readJson<unknown>(path.join(vaultRoot, VAULT_CONFIG_PATH)) ?? {};
  const userCfg = readAgenticosJson(configDir) ?? {};
  // structuredClone so an untouched nested subtree (e.g. VAULT_CONFIG_DEFAULTS.roster) is never
  // handed out by reference — contract §1 requires the same of the scripts' loadConfig().
  return structuredClone(deepMerge(deepMerge(VAULT_CONFIG_DEFAULTS, vaultCfg), userCfg));
}

export function dailyNoteLayout(vaultRoot: string): string {
  return readVaultConfig(vaultRoot).dailyNote.layout;
}

export function readProviderState(vaultRoot: string): ProviderState | null {
  const s = readJson<unknown>(path.join(vaultRoot, PROVIDER_STATE_PATH));
  if (!isPlainObject(s) || typeof s.name !== "string") return null;
  return s as unknown as ProviderState;
}

export const PERSONA_IDENTITY_PATH = "persona/IDENTITY.md";

/**
 * The agent's chosen name (contract §6): the first Markdown H1 of <vault>/persona/IDENTITY.md,
 * which `aos init` renders from identity.template.md with {{AGENT_NAME}}. null when the persona
 * layer is absent or the file has no H1 — callers fall back to a neutral label.
 */
export function personaName(vaultRoot: string): string | null {
  let text: string;
  try { text = fs.readFileSync(path.join(vaultRoot, PERSONA_IDENTITY_PATH), "utf8"); } catch { return null; }
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(text);
  return m ? m[1] : null;
}
