// settingsModel.ts — the Settings tab's logic (spec 2026-09-24-settings-tab). Pure: the tab renders what
// `aos config list --json` returns (D2) and writes through `aos config set|unset` (D3); everything it decides between
// those two calls lives here so node:test covers it. The runtime schema (brain/scripts/lib/settings-schema.js) owns
// the keys, types, bounds and sources — nothing here names a key except the master switches (D5) and the confirm rules
// (D6), both of which fall back to doing nothing for a key they do not know.
import type { SessionHost } from "./aosConfig";

export type SettingType = "bool" | "enum" | "number" | "string" | "model" | "list" | "object";
export type Source = "machine" | "vault" | "default" | "unset";

export interface ConfigRow {
  key: string; section: string; label: string; help: string; type: SettingType;
  values: (string | boolean)[] | null; min: number | null; gt: number | null; max: number | null; int: boolean; nullable: boolean;
  risk: "spend" | "autonomy" | "privacy" | null; applies: string; readonly: boolean; how: string | null; host: SessionHost | null;
  default: unknown; value: unknown; source: Source; changed: boolean; note: string | null; spentToday: number | null;
}
export interface ConfigSection { id: string; label: string }
export interface ConfigList { schema: 1; files: { machine: string; vault: string }; sections: ConfigSection[]; settings: ConfigRow[] }
export interface FollowUp { command: string; why: string }
export interface SetResult { key: string; old: unknown; value: unknown; file: string | null; source: string; dryRun: boolean; effects: string[]; followUps: FollowUp[] }

/** `aos config list --json` → the list, or null when the body is not that shape (an older or broken runtime). */
export function parseConfigList(body: unknown): ConfigList | null {
  const b = body as Partial<ConfigList> | null;
  if (!b || b.schema !== 1 || !Array.isArray(b.sections) || !Array.isArray(b.settings) || !b.files) return null;
  if (!b.settings.every((r) => r && typeof r.key === "string" && typeof r.section === "string" && typeof r.type === "string")) return null;
  return b as ConfigList;
}

/** Sections in the runtime's order, each with its rows; a section with no row is dropped. */
export function groupBySection(list: ConfigList): { section: ConfigSection; rows: ConfigRow[] }[] {
  return list.sections
    .map((section) => ({ section, rows: list.settings.filter((r) => r.section === section.id) }))
    .filter((g) => g.rows.length > 0);
}

export function changedCount(list: ConfigList): number { return list.settings.filter((r) => r.changed).length; }

// ── master switches (D5) ────────────────────────────────────────────────────────────────────────────────────────────

export interface MasterSwitch { key: string; label: string; isOn(value: unknown): boolean; valueFor(on: boolean): unknown }
const flag = (key: string, label: string): MasterSwitch => ({ key, label, isOn: (v) => v === true, valueFor: (on) => on });

export const MASTER_SWITCHES: MasterSwitch[] = [
  { key: "provider", label: "Background AI", isOn: (v) => v !== "none", valueFor: (on) => (on ? "auto" : "none") },
  flag("persona.enabled", "Chief of Staff"),
  flag("routines.enabled", "Routines"),
  flag("graph.enabled", "Knowledge graph"),
  flag("crossReview.enabled", "Cross-review"),
  flag("cost.enabled", "Session costing"),
  flag("telemetry.enabled", "Telemetry"),
  flag("updates.check", "Update checks"),
  flag("skills.sync", "Skill sharing"),
  flag("agents.sync", "Agent sharing"),
];

/** The switches whose key the runtime listed, with their row and state; an unknown key is skipped, never faked. */
export function masterRows(list: ConfigList): { sw: MasterSwitch; row: ConfigRow; on: boolean }[] {
  const byKey = new Map(list.settings.map((r) => [r.key, r]));
  return MASTER_SWITCHES.flatMap((sw) => {
    const row = byKey.get(sw.key);
    return row ? [{ sw, row, on: sw.isOn(row.value) }] : [];
  });
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function sameValue(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** A value as `aos config set <key> <value>` takes it: strings as typed, null as `null`, the rest as JSON. */
export function valueArg(v: unknown): string { return typeof v === "string" ? v : v === null ? "null" : JSON.stringify(v); }

/** What a text field shows: a string as is, null (the host default) as empty, lists and objects as JSON. */
export function inputText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * A text field's input → a value, with the schema's bounds checked here so a typo never costs a spawn. The CLI still
 * validates every write; the messages match its wording. Empty in a nullable field means null (the host default).
 */
export function parseInput(row: ConfigRow, text: string): Parsed {
  const t = text.trim();
  if (row.nullable && t === "") return { ok: true, value: null };
  if (row.type === "number") {
    const n = t === "" ? NaN : Number(t);
    if (!Number.isFinite(n)) return { ok: false, error: `${row.key} must be a number` };
    if (row.int && !Number.isInteger(n)) return { ok: false, error: `${row.key} must be a whole number` };
    if (row.gt !== null && !(n > row.gt)) return { ok: false, error: `${row.key} must be more than ${row.gt}${row.risk === "spend" ? " (to stop spending, set the matching daily cap to 0)" : ""}` };
    if (row.min !== null && n < row.min) return { ok: false, error: `${row.key} must be at least ${row.min}` };
    if (row.max !== null && n > row.max) return { ok: false, error: `${row.key} must be at most ${row.max}` };
    return { ok: true, value: n };
  }
  if (row.type === "list" || row.type === "object") {
    let v: unknown;
    try { v = JSON.parse(t); } catch { return { ok: false, error: `${row.key} takes JSON, e.g. ${row.type === "list" ? '["a","b"]' : '{"name":{}}'}` }; }
    if (row.type === "list" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return { ok: false, error: `${row.key} must be a JSON list of strings` };
    if (row.type === "object" && (v === null || typeof v !== "object" || Array.isArray(v))) return { ok: false, error: `${row.key} must be a JSON object` };
    return { ok: true, value: v };
  }
  if (t === "") return { ok: false, error: `${row.key} cannot be empty` };
  return { ok: true, value: t };
}

// ── confirmations (D6) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Confirm { title: string; message: string; cta: string }

const PAID_PROVIDERS = new Set(["auto", "claude", "codex"]);
function money(key: string, v: unknown): string {
  if (typeof v !== "number") return valueArg(v);
  return /Usd$/.test(key) ? `$${v.toFixed(2)}` : String(v);
}

/**
 * Whether changing `row` to `next` needs a yes first, and what to say. Only changes that raise spend, widen autonomy or
 * store more data ask; lowering a cap, turning something off and every other edit go straight through.
 */
export function confirmFor(row: ConfigRow, next: unknown): Confirm | null {
  if (sameValue(row.value, next)) return null;
  if (row.key === "provider") {
    if (PAID_PROVIDERS.has(String(next)) && !PAID_PROVIDERS.has(String(row.value))) {
      const who = next === "claude" ? "your Claude login" : next === "codex" ? "your Codex login" : "your Claude or Codex login";
      return { title: "Turn on paid background calls?", message: `provider ${valueArg(row.value)} → ${valueArg(next)}: background work may spend on ${who}, up to the daily caps (claude.perDayUsd, codex.perDayUsd).`, cta: "Turn on" };
    }
    return null;
  }
  if (row.risk === "spend") {
    if (row.type === "number" && typeof next === "number" && typeof row.value === "number" && next > row.value) {
      return { title: `Raise ${row.label}?`, message: `${row.key}: ${money(row.key, row.value)} → ${money(row.key, next)}.`, cta: "Raise" };
    }
    if ((row.type === "bool" || row.type === "enum") && row.value === false && (next === true || next === "auto")) {
      return { title: `Turn on ${row.label}?`, message: `${row.key} spends on your model login. ${row.help}`, cta: "Turn on" };
    }
    return null;
  }
  if (row.risk === "autonomy") {
    if (row.type === "bool" && next === true) return { title: `Turn on ${row.label}?`, message: `${row.key}: agents act on their schedule without asking each time. ${row.help}`, cta: "Turn on" };
    if (row.type === "number" && typeof next === "number" && typeof row.value === "number" && next < row.value) {
      return { title: `Lower ${row.label}?`, message: `${row.key}: ${row.value} → ${next}. ${row.help}`, cta: "Lower" };
    }
    if (row.type === "string") return { title: `Change ${row.label}?`, message: `${row.key}: ${valueArg(row.value)} → ${valueArg(next)}. ${row.help}`, cta: "Change" };
    return null;
  }
  if (row.risk === "privacy" && next === false) return { title: `Turn off ${row.label}?`, message: `${row.key}: ${row.help}`, cta: "Turn off" };
  return null;
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const APPLIES: Record<string, string> = {
  "next-call": "applies at the next model call", "next-session": "applies from the next session", "next-scan": "applies at the next scan",
  "next-duty": "applies at the next duty", "next-routine": "applies at the next routine run", "next-sync": "applies at the next sync",
  "next-check": "applies at the next update check", reinstall: "changes only through the installer",
};
export function appliesLabel(applies: string): string { return APPLIES[applies] ?? `applies: ${applies}`; }

const SOURCES: Record<Source, string> = { machine: "this machine", vault: "this vault", default: "default", unset: "not set" };
export function sourceLabel(s: Source): string { return SOURCES[s] ?? s; }
/** The pill's tooltip: which file holds the value. */
export function sourceTitle(s: Source, files: ConfigList["files"]): string {
  if (s === "machine") return `set in ${files.machine}`;
  if (s === "vault") return `set in ${files.vault}`;
  return s === "default" ? "the shipped default (neither file sets it)" : "not in agenticos.json";
}

/** D7: "today $0.12 of $0.50" on a daily cap; null on every other row or when the runtime sent no total. */
export function spendLine(row: ConfigRow): string | null {
  if (row.spentToday === null || typeof row.value !== "number") return null;
  if (row.value === 0) return `today $${row.spentToday.toFixed(2)} · no spend allowed`;
  return `today $${row.spentToday.toFixed(2)} of $${row.value.toFixed(2)}`;
}

const HOST_NAME: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
/** D8: a host-specific row on a machine where that host is off — still editable, dimmed, with the way to turn it on. */
export function hostNote(row: ConfigRow, hosts: SessionHost[]): string | null {
  if (!row.host || hosts.includes(row.host)) return null;
  return `${HOST_NAME[row.host]} is off on this machine; \`aos init --host both\` turns it on`;
}

/** The Notice after a write: the change, then what it did. */
export function resultSummary(r: SetResult): string {
  const head = `${r.key}: ${valueArg(r.old)} → ${valueArg(r.value)}`;
  return r.effects.length ? `${head}\n${r.effects.join("\n")}` : head;
}

// ── follow-ups (D9) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Steps a write left for the user (`next:` lines), kept until run; the ⚙ badge counts them. */
export class FollowUps {
  private items = new Map<string, string>();
  add(list: FollowUp[] | undefined): void { for (const f of list ?? []) if (argsFor(f.command)) this.items.set(f.command, f.why); }
  remove(command: string): void { this.items.delete(command); }
  list(): FollowUp[] { return [...this.items].map(([command, why]) => ({ command, why })); }
  get size(): number { return this.items.size; }
}

/** `aos routines sync` → ["routines", "sync"]; anything that is not a plain `aos <words>` command is never run. */
export function argsFor(command: string): string[] | null {
  const m = /^aos((?: [a-z][a-z-]*)+)$/.exec(command.trim());
  return m ? m[1].trim().split(" ") : null;
}
