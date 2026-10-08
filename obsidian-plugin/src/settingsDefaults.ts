// Pure settings shape + defaults (no obsidian import) so node:test can load it and
// data modules (nodeResolver) can take the settings object without pulling the UI in.
// Cost and telemetry are not here: they are the system's own switches (cost.enabled, telemetry.enabled), read from the
// merged config by Plugin.costOn()/telemetryOn() and changed through `aos config` (spec 2026-09-24-settings-tab D10).

import type { HostSessionAccess, HostSessionHost } from "./host";

/** One value per host the Sessions tab and Vault chat can run. */
export interface PerHost<T> { claude: T; codex: T }

/** The Sessions tab's last choice (spec 2026-10-07-sessions-ux U12): host and access globally, model and effort per
 *  host, so a new session starts where the last one left off. null means "the host's default". */
export interface SessionChoice {
  host: HostSessionHost | null;
  access: HostSessionAccess;
  models: PerHost<string | null>;
  efforts: PerHost<string | null>;
}

/** Vault chat's last choice, kept apart from the Sessions tab's: Vault chat is always read only, so it has no access,
 *  and its one-shot paths take fewer efforts. */
export interface VaultChoice {
  host: HostSessionHost | null;
  models: PerHost<string | null>;
  efforts: PerHost<string | null>;
}

export interface AgenticOSSettings {
  statusBarEnabled: boolean;
  autoOpenSidebarOnStart: boolean;
  liveTailPollMs: number;
  // Terminal
  terminalEmbedded: boolean;
  terminalEmbedHeight: number;
  terminalShell: string;
  terminalCwd: string;
  terminalFontSize: number;
  terminalScrollback: number;
  // AgenticOS (contract §5)
  vaultRoot: string;         // "" → this Obsidian vault's base path
  claudeConfigDir: string;   // "" → agenticos.json.claudeConfigDir → $CLAUDE_CONFIG_DIR → ~/.claude
  nodePath: string;          // "" → auto (src/data/nodeResolver.ts); a login-shell probe result is saved here
  // Sessions (U12): read through sanitizeSessionChoice / sanitizeVaultChoice, since data.json may hold anything
  sessionChoice: SessionChoice;
  vaultChoice: VaultChoice;
}

/** Keys data.json may still hold from earlier versions; loadSettings prunes them (the two HUD-only toggles, D10). */
export const DEAD_SETTINGS_KEYS = ["snapshotPath", "runsPath", "sessionPath", "snapshotHistoryDir", "refreshDebounceMs", "costEnabled", "telemetryEnabled"];

export const DEFAULT_SETTINGS: AgenticOSSettings = {
  statusBarEnabled: true,
  autoOpenSidebarOnStart: false,
  liveTailPollMs: 300,
  // Terminal — shell + cwd auto-resolve at plugin load if blank
  terminalEmbedded: true,
  terminalEmbedHeight: 280,
  terminalShell: "",
  terminalCwd: "",
  terminalFontSize: 13,
  terminalScrollback: 5000,
  // AgenticOS
  vaultRoot: "",
  claudeConfigDir: "",
  nodePath: "",
  // Sessions
  sessionChoice: { host: null, access: "edit", models: { claude: null, codex: null }, efforts: { claude: null, codex: null } },
  vaultChoice: { host: null, models: { claude: null, codex: null }, efforts: { claude: null, codex: null } },
};

// ── remembered choices (U12) ──
// loadSettings copies a stored value as it is, so a hand-edited or older data.json can hold any shape here. The views
// read through these sanitizers, which keep the good parts and fall back to the defaults for the rest, and never throw.
// A kept model or effort may still be one the catalog no longer lists: the view checks it against the catalog.

const HOSTS: readonly HostSessionHost[] = ["claude", "codex"];
const ACCESS: readonly HostSessionAccess[] = ["read", "edit", "run"];
/** The levels a session turn takes per host (the runtime's headless.js SESSION_EFFORTS). */
const SESSION_EFFORTS: PerHost<readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
/** The levels Vault chat's one-shot paths take: claude -p --effort, and ask.js --effort= (the chat surface's rules). */
const VAULT_EFFORTS: PerHost<readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};
/** A model id the app's session schema admits: one word, no leading dash (app/src/main/ipc/schemas.ts Model). */
const MODEL_ID = /^[A-Za-z0-9._:/[\]-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pickHost(v: unknown): HostSessionHost | null {
  return HOSTS.includes(v as HostSessionHost) ? (v as HostSessionHost) : null;
}

function pickModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  return id.length > 0 && id.length <= 80 && !id.startsWith("-") && MODEL_ID.test(id) ? id : null;
}

function pickModels(v: unknown): PerHost<string | null> {
  const r = isRecord(v) ? v : {};
  return { claude: pickModel(r.claude), codex: pickModel(r.codex) };
}

function pickEfforts(v: unknown, allowed: PerHost<readonly string[]>): PerHost<string | null> {
  const r = isRecord(v) ? v : {};
  const one = (host: HostSessionHost): string | null =>
    typeof r[host] === "string" && allowed[host].includes(r[host] as string) ? (r[host] as string) : null;
  return { claude: one("claude"), codex: one("codex") };
}

/** A clean copy of a stored Sessions choice; anything missing or malformed reads as its default. */
export function sanitizeSessionChoice(raw: unknown): SessionChoice {
  const r = isRecord(raw) ? raw : {};
  return {
    host: pickHost(r.host),
    access: ACCESS.includes(r.access as HostSessionAccess) ? (r.access as HostSessionAccess) : "edit",
    models: pickModels(r.models),
    efforts: pickEfforts(r.efforts, SESSION_EFFORTS),
  };
}

/** A clean copy of a stored Vault chat choice; anything missing or malformed reads as its default. */
export function sanitizeVaultChoice(raw: unknown): VaultChoice {
  const r = isRecord(raw) ? raw : {};
  return { host: pickHost(r.host), models: pickModels(r.models), efforts: pickEfforts(r.efforts, VAULT_EFFORTS) };
}

/** The Sessions choice after a pick: the host becomes the last host, and a model, effort or access that is given
 *  (null included) replaces the stored one for that host; one left out keeps it. Returns a new object to store. */
export function rememberSessionChoice(
  current: unknown,
  pick: { host: HostSessionHost; model?: string | null; effort?: string | null; access?: HostSessionAccess },
): SessionChoice {
  const c = sanitizeSessionChoice(current);
  c.host = pick.host;
  if (pick.model !== undefined) c.models[pick.host] = pick.model;
  if (pick.effort !== undefined) c.efforts[pick.host] = pick.effort;
  if (pick.access !== undefined) c.access = pick.access;
  return sanitizeSessionChoice(c);
}

/** The Vault chat choice after a pick, as rememberSessionChoice does it (Vault chat has no access to keep). */
export function rememberVaultChoice(
  current: unknown,
  pick: { host: HostSessionHost; model?: string | null; effort?: string | null },
): VaultChoice {
  const c = sanitizeVaultChoice(current);
  c.host = pick.host;
  if (pick.model !== undefined) c.models[pick.host] = pick.model;
  if (pick.effort !== undefined) c.efforts[pick.host] = pick.effort;
  return sanitizeVaultChoice(c);
}
