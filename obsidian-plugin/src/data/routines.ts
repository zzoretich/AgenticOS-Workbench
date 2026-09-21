// routines.ts — the plugin-side mirror of brain/scripts/lib/routines-store.js: parse, validate and
// serialize <vault>/brain/routines/<slug>.md, read brain/_index/routines.json, and compute the rows
// the Routines tab renders (next fire times, health). Pure core; only the two loaders touch Obsidian.
// The frontmatter subset (scalars, quoted strings, single-line flow arrays) and the key order are
// the runtime's, so a file this module writes is a file run-routine.js reads — both sides are checked
// against brain/scripts/test/fixtures/routines/*.
import type { App } from "obsidian";
import { describe, next, validateCron } from "./cron";

export const ROUTINES_DIR = "brain/routines";
export const ROUTINES_STATE_PATH = "brain/_index/routines.json";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const KINDS = ["duty", "prompt", "command"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export type RoutineKind = typeof KINDS[number];
export type Effort = typeof EFFORTS[number];
const KEY_ORDER = ["schema", "name", "kind", "schedule", "enabled", "guarded", "model", "effort", "budgetUsd", "argv", "timeoutSec", "tags"];

export type Scalar = string | number | boolean | null;
export type Frontmatter = Record<string, Scalar | Scalar[]>;

export interface Routine {
  slug: string;
  schema?: number;
  name?: string;
  kind?: RoutineKind | string;
  schedule?: string;
  enabled?: boolean;
  guarded?: boolean;
  model?: string;
  effort?: string;
  budgetUsd?: number;
  argv?: string[];
  timeoutSec?: number;
  tags?: string[];
  body: string;
  errors: string[];
}

export interface RoutineStateEntry {
  lastRunAt: string | null; lastExit: number | null; lastCostUsd: number | null; lastDurationMs: number | null;
  failStreak: number; lastTrigger: string | null; lastError: string | null;
  lastSkippedAt?: string | null; lastSkipReason?: string | null;
}
export interface RoutinesState { schema: number; routines: Record<string, RoutineStateEntry>; synced: Record<string, string>; syncedAt: string | null }

export type RoutineHealth = "ok" | "off" | "stale" | "failed" | "missed" | "invalid";
export interface RoutineRow {
  routine: Routine;
  cadence: string;
  next: Date[];
  last: RoutineStateEntry | null;
  health: RoutineHealth;
}

// ── frontmatter ──

function parseScalar(text: string): Scalar {
  const t = text.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return t;
}

export function parseFlowArray(text: string): Scalar[] {
  const inner = text.trim().slice(1, -1);
  const items: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) { cur += inner[++i]; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === ",") { items.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "" || items.length) items.push(cur);
  return items.map(parseScalar).filter((v) => v !== null);
}

export function parseRoutineFrontmatter(content: string): { frontmatter: Frontmatter; body: string; hasFrontmatter: boolean } {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const block = text.slice(4, end);
  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    fm[m[1]] = val.startsWith("[") && val.endsWith("]") ? parseFlowArray(val) : parseScalar(val);
  }
  return { frontmatter: fm, body: text.slice(end + 4).replace(/^(\r?\n)+/, ""), hasFrontmatter: true };
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function serializeScalar(v: Scalar | undefined): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (/^[A-Za-z][A-Za-z0-9 _./-]*$/.test(s) && !["true", "false", "null"].includes(s)) return s;
  return quote(s);
}
export function serializeRoutineFrontmatter(fm: Frontmatter): string {
  const keys = [...KEY_ORDER.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !KEY_ORDER.includes(k))];
  const lines: string[] = [];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(serializeScalar).join(", ")}]` : `${k}: ${serializeScalar(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

// ── routines ──

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const isMoney = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Human-readable problems; empty means valid. Mirrors routines-store.js validate() rule for rule. */
export function validateRoutine(r: Partial<Routine>): string[] {
  const errors: string[] = [];
  if (!SLUG_RE.test(String(r.slug ?? ""))) errors.push('slug must be 2-41 chars of a-z, 0-9 and "-" and start with a letter or digit');
  if (r.schema !== 1) errors.push("schema must be 1");
  if (typeof r.name !== "string" || !r.name.trim()) errors.push("name is required");
  if (!(KINDS as readonly string[]).includes(String(r.kind))) errors.push(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof r.schedule !== "string" || !r.schedule.trim()) errors.push("schedule is required");
  else { const e = validateCron(r.schedule); if (e) errors.push(`schedule: ${e}`); }
  if (typeof r.enabled !== "boolean") errors.push("enabled must be true or false");
  if (r.guarded !== undefined && typeof r.guarded !== "boolean") errors.push("guarded must be true or false");
  if (r.timeoutSec !== undefined && !(Number.isInteger(r.timeoutSec) && (r.timeoutSec as number) > 0)) errors.push("timeoutSec must be a positive integer");
  if (r.tags !== undefined && !isStringArray(r.tags)) errors.push("tags must be an array of strings");
  if (r.kind === "prompt") {
    if (typeof r.body !== "string" || !r.body.trim()) errors.push("a prompt routine needs a body");
    if (r.model !== undefined && (typeof r.model !== "string" || !r.model.trim())) errors.push("model must be a string");
    if (r.effort !== undefined && !(EFFORTS as readonly string[]).includes(String(r.effort))) errors.push(`effort must be one of ${EFFORTS.join(", ")}`);
    if (r.budgetUsd !== undefined && !isMoney(r.budgetUsd)) errors.push("budgetUsd must be a non-negative number");
  }
  if (r.kind === "command") {
    if (!isStringArray(r.argv) || r.argv.length === 0) errors.push("a command routine needs argv: a non-empty array of strings");
  }
  return errors;
}

export function routineFromFile(slug: string, content: string): Routine {
  const { frontmatter, body, hasFrontmatter } = parseRoutineFrontmatter(content);
  const routine = { slug, ...(frontmatter as Record<string, unknown>), body } as unknown as Omit<Routine, "errors">;
  const errors = hasFrontmatter ? validateRoutine(routine as Partial<Routine>) : ["no frontmatter block"];
  return { ...routine, errors } as Routine;
}

export function routineToFile(routine: Omit<Routine, "errors"> & { errors?: string[] }): string {
  const { slug, body, errors, ...fm } = routine;   // eslint-disable-line @typescript-eslint/no-unused-vars
  void slug; void errors;
  const text = String(body ?? "").replace(/\s+$/, "");
  return serializeRoutineFrontmatter(fm as Frontmatter) + (text ? `\n${text}\n` : "");
}

/** What the installed schedule depends on (kind|schedule|on/off) — a mismatch with the last sync means "stale". */
export function fingerprint(r: Pick<Routine, "kind" | "schedule" | "enabled">): string {
  return `${r.kind}|${String(r.schedule ?? "").trim().replace(/\s+/g, " ")}|${r.enabled ? "on" : "off"}`;
}

export function emptyState(): RoutinesState { return { schema: 1, routines: {}, synced: {}, syncedAt: null }; }
export function parseState(raw: string | null): RoutinesState {
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<RoutinesState>;
    if (parsed && typeof parsed === "object" && parsed.routines && typeof parsed.routines === "object") return { ...emptyState(), ...parsed, schema: 1 };
  } catch { /* missing or corrupt */ }
  return emptyState();
}

export function health(r: Routine, entry: RoutineStateEntry | null, now: Date, opts: { missedGraceMs?: number; synced?: string; syncedAt?: string | null } = {}): RoutineHealth {
  const grace = opts.missedGraceMs ?? 15 * 60_000;
  if (r.errors.length) return "invalid";
  if (!r.enabled) return "off";
  if (opts.synced !== undefined && opts.synced !== fingerprint(r)) return "stale";
  if (entry && typeof entry.lastExit === "number" && entry.lastExit !== 0) return "failed";
  const from = entry?.lastRunAt ? new Date(entry.lastRunAt) : opts.syncedAt ? new Date(opts.syncedAt) : null;
  if (from && r.schedule) {
    const due = next(r.schedule, from, 1)[0];
    if (due && now.getTime() - due.getTime() > grace) return "missed";
  }
  return "ok";
}

export function buildRows(routines: Routine[], state: RoutinesState, now = new Date()): RoutineRow[] {
  return routines.map((r) => {
    const entry = state.routines[r.slug] ?? null;
    const valid = r.errors.length === 0;
    return {
      routine: r,
      cadence: valid && r.schedule ? describe(r.schedule) : String(r.schedule ?? ""),
      next: valid && r.enabled && r.schedule ? next(r.schedule, now, 3) : [],
      last: entry && entry.lastRunAt ? entry : null,
      health: health(r, entry, now, { synced: state.synced[r.slug], syncedAt: state.syncedAt }),
    };
  });
}

/** Enabled routines whose fingerprint differs from the last sync, plus synced slugs with no file: "apply schedules" is due. */
export function schedulesOutOfDate(routines: Routine[], state: RoutinesState): string[] {
  const out: string[] = [];
  for (const r of routines) {
    if (r.errors.length) continue;
    const want = r.enabled ? fingerprint(r) : undefined;
    if (state.synced[r.slug] !== want) out.push(r.slug);
  }
  for (const slug of Object.keys(state.synced)) if (!routines.some((r) => r.slug === slug)) out.push(slug);
  return out;
}

// ── IO ──

export async function listRoutines(app: App): Promise<Routine[]> {
  const adapter = app.vault.adapter;
  let files: string[] = [];
  try { files = (await adapter.list(ROUTINES_DIR)).files.filter((f) => f.endsWith(".md") && !f.split("/").pop()!.startsWith(".") && f.split("/").pop()!.toLowerCase() !== "readme.md"); } catch { return []; }
  const out: Routine[] = [];
  for (const f of files.sort()) {
    const slug = f.split("/").pop()!.replace(/\.md$/, "");
    try { out.push(routineFromFile(slug, await adapter.read(f))); } catch (e) { out.push({ slug, body: "", errors: [`unreadable: ${e instanceof Error ? e.message : String(e)}`] }); }
  }
  return out;
}

export async function readRoutinesState(app: App): Promise<RoutinesState> {
  try { return parseState(await app.vault.adapter.read(ROUTINES_STATE_PATH)); } catch { return emptyState(); }
}
