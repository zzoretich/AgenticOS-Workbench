// teams.ts — the Agent Teams tab's reader (spec 2026-09-28-agent-teams-design §4.4, D12). The store is
// persona/teams/<id>/ and its one writer is `aos team` (brain/scripts/team.js, lib/teams.js); this module reads the same
// files by the same rules, which the shared fixture vault proves (teams.test.ts reads it with both). Pure over its text
// inputs; only readTeams touches storage, through a tiny adapter so tests stub it without "obsidian".
//
// JSONL follows the prototype reader's rule: a bad complete line is someone's hand edit and is skipped (and counted); an
// unparsable last line with no newline is an append still in flight, so it is left out and the tab reads again.
import { stepIn } from "./settingsModel";
import type { AgentsCache, AgentHost } from "./agents";

export const TEAMS_DIR = "persona/teams";
export const DEFAULT_STAGES = ["discuss", "plan", "execute", "verify", "ship"];
export const TEAM_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;
/** The channel the Interact pane shows: the last posts, newest last. */
export const CHANNEL_WINDOW = 60;

export type Scalar = string | number | boolean | null | Scalar[] | { [k: string]: Scalar };
export type Row = Record<string, unknown>;

export interface Member {
  id: string; name: string; role: string; agent: string | null; provider: string | null; model: string | null;
  effort: string | null; stage: string[]; paused: boolean;
}
export interface Gate { name: string; state: string; by: string | null; ts: string | null; note: string }
export interface Budget { usd: number; spentUsd: number; codexRuns: number }
export interface BoardItem {
  id: string; title: string; stage: string; status: string; owners: string[]; gate: Gate | null; budget: Budget;
  ts: string; by: string | null; raw: Row;
}
export interface Post { ts: string; from: string; item: string | null; kind: string; text: string }
export interface RunRow { ts: string; member: string; item: string | null; provider: string | null; status: string; usd: number | null; ms: number | null }
export interface Marker { run: string; member: string; item: string | null; provider: string | null; startedAt: string | null; reservedUsd: number }
export interface MemberStatus extends Member {
  lead: boolean; status: "idle" | "working" | "blocked" | "paused"; item: string | null;
  lastRun: { item: string | null; status: string; ms: number | null; usd: number | null; ts: string } | null;
}
export interface Team {
  id: string; name: string; lead: string; reportsTo: string | null; parent: string | null;
  stages: string[]; gates: string[]; budgetDefault: number; disabled: boolean; members: Member[];
  state: string[]; board: BoardItem[]; channel: Post[]; runs: RunRow[]; live: Marker[];
  /** When each pending gate began waiting, by item id (the first snapshot of the current pending gate). */
  pendingSince: Record<string, string>;
  /** The item's last snapshot before its current pending gate opened: a pitch posted before it was for an earlier gate. */
  pendingAfter: Record<string, string>;
  skipped: number; torn: boolean; error: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Row : null);

// ── TEAM.md: the strict YAML subset of lib/teams.js ──

export function parseScalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "") return "";
  if (s === "null" || s === "~") return null;
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return JSON.parse(s) as Scalar;
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map(parseScalar) : [];
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const o: Record<string, Scalar> = {};
    const inner = s.slice(1, -1).trim();
    if (inner) for (const part of inner.split(",")) {
      const i = part.indexOf(":");
      if (i < 0) throw new Error(`bad inline map entry: ${part}`);
      o[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
    }
    return o;
  }
  return s;
}

/** The frontmatter as lib/teams.js parseFrontmatter reads it; throws on a line the subset does not allow. */
export function parseFrontmatter(text: string): Record<string, Scalar> {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end <= 0) throw new Error("TEAM.md has no frontmatter");
  const out: Record<string, Scalar> = {};
  let list: Scalar[] | null = null;
  let cur: Record<string, Scalar> | null = null;
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let m: RegExpExecArray | null;
    if ((m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw))) {
      cur = null;
      list = m[2] === "" ? (out[m[1]] = []) as Scalar[] : null;
      if (m[2] !== "") out[m[1]] = parseScalar(m[2]);
    } else if (list && (m = /^\s+-\s+([\w-]+):\s*(.*)$/.exec(raw))) {
      cur = { [m[1]]: parseScalar(m[2]) };
      list.push(cur);
    } else if (cur && (m = /^\s+([\w-]+):\s*(.*)$/.exec(raw))) {
      cur[m[1]] = parseScalar(m[2]);
    } else {
      throw new Error(`unsupported TEAM.md line: ${raw.trim()}`);
    }
  }
  return out;
}

function memberFrom(v: Scalar): Member | null {
  const o = obj(v);
  const id = o && (typeof o.id === "string" || typeof o.id === "number") ? String(o.id) : null;
  if (!o || !id) return null;
  const s = (k: string) => (o[k] == null || o[k] === "" ? null : String(o[k]));
  return {
    id, name: s("name") ?? id, role: s("role") ?? "", agent: s("agent"), provider: s("provider"), model: s("model"),
    effort: s("effort"), stage: ([] as Scalar[]).concat((o.stage as Scalar) ?? []).map(String), paused: !!o.paused,
  };
}

// ── JSONL ──

/** Rows of a JSONL file: a bad complete line is skipped and counted; an unparsable unterminated tail is `torn`. */
export function parseJsonl(text: string | null): { rows: Row[]; skipped: number; torn: boolean } {
  const rows: Row[] = [];
  let skipped = 0;
  let torn = false;
  if (!text) return { rows, skipped, torn };
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const one = (line: string): Row | null => {
    const r: unknown = JSON.parse(line);
    return obj(r);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const r = one(line); if (r) rows.push(r); else skipped++; } catch { skipped++; }
  }
  if (tail.trim()) {
    try { const r = one(tail); if (r) rows.push(r); } catch { torn = true; }
  }
  return { rows, skipped, torn };
}

/** The last snapshot of each item, in the order ids first appear (lib/teams.js boardItems). */
export function latestRows(rows: Row[]): Map<string, Row> {
  const latest = new Map<string, Row>();
  for (const r of rows) if (typeof r.id === "string") latest.set(r.id, r);
  return latest;
}

export function ownersOf(r: Row): string[] {
  if (r.owner == null || r.owner === "") return [];
  return Array.isArray(r.owner) ? r.owner.map(String) : [String(r.owner)];
}

function itemFrom(r: Row): BoardItem {
  const g = obj(r.gate);
  const b = obj(r.budget) ?? {};
  return {
    id: r.id as string, title: str(r.title) ?? "", stage: str(r.stage) ?? "", status: str(r.status) ?? "todo", owners: ownersOf(r),
    gate: g && str(g.name) ? { name: g.name as string, state: str(g.state) ?? "pending", by: str(g.by), ts: str(g.ts), note: str(g.note) ?? "" } : null,
    budget: { usd: num(b.usd) ?? 0, spentUsd: num(b.spentUsd) ?? 0, codexRuns: num(b.codexRuns) ?? 0 },
    ts: str(r.ts) ?? "", by: str(r.by), raw: r,
  };
}

/** When each item's current pending gate began (the first snapshot of an unbroken run of that gate pending), and the
 *  snapshot just before that run, which bounds the lead's pitch for this gate from below. */
function pendingSinceOf(rows: Row[]): { since: Record<string, string>; after: Record<string, string> } {
  const since: Record<string, { name: string; ts: string; after: string }> = {};
  const last: Record<string, string> = {};
  for (const r of rows) {
    if (typeof r.id !== "string") continue;
    const ts = str(r.ts) ?? "";
    const g = obj(r.gate);
    if (!g || g.state !== "pending") delete since[r.id];
    else {
      const name = str(g.name) ?? "gate";
      if (since[r.id]?.name !== name) since[r.id] = { name, ts, after: last[r.id] ?? "" };
    }
    last[r.id] = ts;
  }
  const out = { since: {} as Record<string, string>, after: {} as Record<string, string> };
  for (const [id, v] of Object.entries(since)) {
    if (v.ts) out.since[id] = v.ts;
    if (v.after) out.after[id] = v.after;
  }
  return out;
}

function postFrom(r: Row): Post {
  return { ts: str(r.ts) ?? "", from: str(r.from) ?? "?", item: str(r.item), kind: str(r.kind) ?? "note", text: typeof r.text === "string" ? r.text : "" };
}
function runFrom(r: Row): RunRow {
  return { ts: str(r.ts) ?? "", member: str(r.member) ?? "", item: str(r.item), provider: str(r.provider), status: str(r.status) ?? "?", usd: num(r.usd), ms: num(r.ms) };
}
function markerFrom(r: Row): Marker | null {
  const run = str(r.run);
  if (!run) return null;
  return { run, member: str(r.member) ?? "", item: str(r.item), provider: str(r.provider), startedAt: str(r.startedAt), reservedUsd: num(r.reservedUsd) ?? 0 };
}

/** STATE.md: the lead's first three non-heading lines, frontmatter dropped (lib/teams.js readState). */
export function parseState(text: string | null): string[] {
  if (!text) return [];
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, 3);
}

export interface TeamFiles {
  id: string; teamMd: string; board: string | null; channel: string | null; runs: string | null;
  markers: string[]; state: string | null; disabled: boolean;
}

/** A team from its files. A TEAM.md the subset refuses gives a team with `error` set and nothing else read. */
export function teamFrom(f: TeamFiles): Team {
  const base: Team = {
    id: f.id, name: f.id, lead: "", reportsTo: null, parent: null, stages: DEFAULT_STAGES, gates: [], budgetDefault: 0,
    disabled: f.disabled, members: [], state: [], board: [], channel: [], runs: [], live: [], pendingSince: {}, pendingAfter: {}, skipped: 0, torn: false, error: null,
  };
  let fm: Record<string, Scalar>;
  try { fm = parseFrontmatter(f.teamMd); } catch (e) { return { ...base, error: (e as Error).message }; }
  const board = parseJsonl(f.board);
  const channel = parseJsonl(f.channel);
  const runs = parseJsonl(f.runs);
  const budget = obj(fm.budget);
  const pending = pendingSinceOf(board.rows);
  return {
    ...base,
    name: str(fm.name) ?? f.id, lead: fm.lead == null ? "" : String(fm.lead), reportsTo: str(fm.reportsTo), parent: str(fm.parent),
    stages: Array.isArray(fm.stages) && fm.stages.length ? fm.stages.map(String) : DEFAULT_STAGES,
    gates: Array.isArray(fm.gates) ? fm.gates.map(String) : [],
    budgetDefault: (budget && Number(budget.default)) || 0,
    members: Array.isArray(fm.members) ? fm.members.map(memberFrom).filter((m): m is Member => m !== null) : [],
    state: parseState(f.state),
    board: [...latestRows(board.rows).values()].map(itemFrom),
    channel: channel.rows.map(postFrom),
    runs: runs.rows.map(runFrom),
    live: f.markers.map((t) => { try { const o = obj(JSON.parse(t)); return o ? markerFrom(o) : null; } catch { return null; } }).filter((m): m is Marker => m !== null),
    pendingSince: pending.since,
    pendingAfter: pending.after,
    skipped: board.skipped + channel.skipped + runs.skipped,
    torn: board.torn || channel.torn || runs.torn,
  };
}

// ── status (lib/teams.js memberStatus, pendingGates) ──

/** Each member as the files show it now: working (a live marker), blocked (owns a blocked item), paused, or idle. */
export function memberStatus(t: Team): MemberStatus[] {
  return t.members.map((m) => {
    const marker = t.live.find((x) => x.member === m.id);
    const owned = t.board.filter((it) => it.status !== "done" && it.owners.includes(m.id));
    const last = [...t.runs].reverse().find((r) => r.member === m.id) ?? null;
    const status = m.paused || t.disabled ? "paused" : marker ? "working" : owned.some((it) => it.status === "blocked") ? "blocked" : "idle";
    return {
      ...m, lead: m.id === t.lead, status, item: marker ? marker.item : owned[0]?.id ?? null,
      lastRun: last ? { item: last.item, status: last.status, ms: last.ms, usd: last.usd, ts: last.ts } : null,
    };
  });
}

export function pendingGates(t: Team): BoardItem[] {
  return t.board.filter((it) => it.status === "gate" && it.gate?.state === "pending");
}

/** The rail badge: gates pending across every readable team. */
export function gateBadge(teams: Team[]): number {
  return teams.reduce((n, t) => n + (t.error ? 0 : pendingGates(t).length), 0);
}

/** Teams in tree order (a parent before its children, siblings by id), each with its depth. A missing parent is a root. */
export function orderTeams(teams: Team[]): { team: Team; depth: number }[] {
  const ids = new Set(teams.map((t) => t.id));
  const kids = new Map<string | null, Team[]>();
  for (const t of teams) {
    const p = t.parent && ids.has(t.parent) && t.parent !== t.id ? t.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), t]);
  }
  const out: { team: Team; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null, depth: number) => {
    for (const t of [...(kids.get(p) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ team: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  // A parent cycle has no root: list what the walk could not reach.
  for (const t of [...teams].sort((a, b) => a.id.localeCompare(b.id))) if (!seen.has(t.id)) out.push({ team: t, depth: 0 });
  return out;
}

// ── the work board ──

export interface Column { stage: string; items: BoardItem[]; done: BoardItem[] }

/** One column per stage, open items first by board order; items in a stage the team no longer lists go last. */
export function boardColumns(t: Team): Column[] {
  const cols: Column[] = t.stages.map((stage) => ({ stage, items: [], done: [] }));
  let other: Column | null = null;
  for (const it of t.board) {
    let col = cols.find((c) => c.stage === it.stage);
    if (!col) col = other ??= { stage: "other", items: [], done: [] };
    (it.status === "done" ? col.done : col.items).push(it);
  }
  return other ? [...cols, other] : cols;
}

export type Tone = "is-ok" | "is-neutral" | "is-stale" | "is-failed" | "is-off" | "is-live";
/** The chip for an item's status: live work cyan, waiting on the user amber, blocked rose, done green. */
export function itemTone(it: BoardItem): Tone {
  switch (it.status) {
    case "working": return "is-live";
    case "gate": return "is-stale";
    case "blocked": return "is-failed";
    case "done": return "is-ok";
    case "paused": return "is-off";
    default: return "is-neutral";
  }
}
export function memberTone(s: MemberStatus["status"]): Tone {
  return s === "working" ? "is-live" : s === "blocked" ? "is-failed" : s === "paused" ? "is-off" : "is-neutral";
}
export function runTone(status: string): Tone {
  return status === "ok" ? "is-ok" : status === "failed" || status === "killed" ? "is-failed" : status === "blocked" ? "is-stale" : "is-neutral";
}

/** "$20", "$125.50", "$3.44": whole dollars plain, anything else to the cent, as the CLI records it. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const cents = Math.round(n * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
export function titleCase(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ── gates ──

/** The gate that funds the work: the one on the team's first stage (the Discuss gate by default), which takes --usd. */
export function isBudgetGate(t: Team, it: BoardItem): boolean {
  return !!it.gate && it.gate.name === t.stages[0];
}

/** What live Claude runs on the item hold of its budget: the floor, with spend, below which the CLI refuses a budget. */
export function budgetFloor(t: Team, it: BoardItem): number {
  const held = t.live.filter((m) => m.item === it.id && m.provider === "claude").reduce((s, m) => s + m.reservedUsd, 0);
  return Math.round((it.budget.spentUsd + held) * 100) / 100;
}

/** The largest phase budget the CLI takes (lib/teams.js usdOf). */
export const MAX_BUDGET_USD = 10000;

/** The budget choices on a gate card: half the proposal, the proposal, double it (whole dollars, each at least $1, none
 *  above the CLI's maximum). */
export function budgetPresets(proposal: number, fallback = 10): number[] {
  const p = proposal > 0 ? proposal : fallback > 0 ? fallback : 10;
  return [...new Set([Math.max(1, Math.round(p / 2)), Math.round(p * 100) / 100, Math.round(p * 2)])].filter((n) => n <= MAX_BUDGET_USD).sort((a, b) => a - b);
}

/** The amount a budget control starts on: `want` when the CLI would take it, else the smallest preset at or above the
 *  floor, else the floor itself; null when even the floor is above the maximum (nothing can be approved). */
export function budgetPick(want: number, presets: number[], floor: number): number | null {
  if (want >= floor && want > 0 && want <= MAX_BUDGET_USD) return want;
  const up = presets.find((p) => p >= floor);
  if (up !== undefined) return up;
  const f = Math.max(1, Math.ceil(floor * 100) / 100);
  return f <= MAX_BUDGET_USD ? f : null;
}

/** The − / + ladder the steppers walk (plus the card's own presets). */
export const BUDGET_LADDER = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000];

/** The next amount below (-1) or above (+1) `current`, never under `floor`; null at the ends. */
export function stepBudget(current: number, dir: -1 | 1, presets: number[], floor: number): number | null {
  return stepIn([...BUDGET_LADDER, ...presets].filter((n) => n >= floor && n > 0 && n <= MAX_BUDGET_USD), current, dir);
}

/** The team's own case for the gate now pending: the last `gate` post on the item by a member (not the user's decision,
 *  not dispatch) made after the snapshot before this gate opened, so an earlier gate's proposal never stands in for it. */
export function gatePitch(t: Team, itemId: string): Post | null {
  const after = t.pendingAfter[itemId] ?? "";
  const members = new Set(t.members.map((m) => m.id));
  return [...t.channel].reverse().find((p) => p.item === itemId && p.kind === "gate" && members.has(p.from) && (!after || p.ts > after)) ?? null;
}

export interface GateCard { team: Team; item: BoardItem; since: string | null; pitch: Post | null; budget: boolean }
/** Every pending gate across teams, the longest-waiting first. */
export function gateCards(teams: Team[]): GateCard[] {
  const out: GateCard[] = [];
  for (const t of teams) {
    if (t.error) continue;
    for (const it of pendingGates(t)) out.push({ team: t, item: it, since: t.pendingSince[it.id] ?? null, pitch: gatePitch(t, it.id), budget: isBudgetGate(t, it) });
  }
  return out.sort((a, b) => (a.since ?? "~").localeCompare(b.since ?? "~") || a.team.id.localeCompare(b.team.id) || a.item.id.localeCompare(b.item.id));
}

// ── the channel ──

export function channelView(t: Team, item: string | null, n = CHANNEL_WINDOW): Post[] {
  return (item ? t.channel.filter((p) => p.item === item) : t.channel).slice(-n);
}

/** Text split around @mentions; `known` marks a mention of a member (or the user). */
export function splitMentions(text: string, members: string[]): { text: string; mention: boolean; known: boolean }[] {
  const out: { text: string; mention: boolean; known: boolean }[] = [];
  const re = /@([a-z][a-z0-9-]*)/gi;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > 0 && /[\w.]/.test(text[m.index - 1])) continue; // an email address, not a mention
    if (m.index > at) out.push({ text: text.slice(at, m.index), mention: false, known: false });
    out.push({ text: m[0], mention: true, known: m[1] === "user" || members.includes(m[1].toLowerCase()) });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mention: false, known: false });
  return out;
}

// ── terminal sessions with a member ──

/** One shell word, single-quoted: a `$` or an apostrophe in a prompt reaches the agent as typed. */
export function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

/**
 * What a "Talk to" or Redirect button types into a fresh terminal on `host`: the agent's own run command from
 * agents.json, plus an opening prompt when there is one. Codex has no `--agent`, so its prompt asks for the agent by
 * name. Null when that host does not have the agent.
 */
export function sessionCommand(agents: AgentsCache, agent: string | null, host: AgentHost, prompt?: string): string | null {
  if (!agent) return null;
  const row = agents.agents.find((a) => a.id === agent) ?? agents.agents.find((a) => a.name === agent);
  const run = row?.on[host]?.run ?? null;
  if (!run) return null;
  if (!prompt) return run;
  return host === "claude" ? `${run} ${shq(prompt)}` : `codex ${shq(`Use the ${agent} agent for this. ${prompt}`)}`;
}

/** The --expect a write sends: the snapshot the user saw, by its timestamp (D3). */
export function expectOf(it: BoardItem): string { return JSON.stringify({ ts: it.ts }); }

/** The lead's opening prompt for a redirect: the user says what should change in the session, and the lead records it. */
export function redirectPrompt(t: Team, it: BoardItem): string {
  const gate = titleCase(it.gate?.name ?? "the");
  return `The user is redirecting the ${gate} gate on ${it.id}${it.title ? ` (${it.title})` : ""} in the ${t.id} team. `
    + "Ask the user what should change. Record their answer with this command, the note in single quotes: "
    + `aos team gate redirect ${t.id} ${it.id} --expect '${expectOf(it)}' --note '<what should change>'. Then take the next step.`;
}

// ── storage ──

export interface TeamsAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Every team folder with a TEAM.md. `boardOnly` (the rail badge) skips the channel, runs, state and markers. */
export async function readTeams(a: TeamsAdapter, { boardOnly = false } = {}): Promise<Team[]> {
  let folders: string[] = [];
  try { folders = (await a.list(TEAMS_DIR)).folders; } catch { return []; }
  const readOr = async (p: string): Promise<string | null> => { try { return (await a.exists(p)) ? await a.read(p) : null; } catch { return null; } };
  const out: Team[] = [];
  for (const dir of folders.sort()) {
    const id = dir.split("/").pop() ?? "";
    if (!TEAM_ID_RE.test(id)) continue;
    const teamMd = await readOr(`${dir}/TEAM.md`);
    if (teamMd === null) continue;
    const markers: string[] = [];
    if (!boardOnly) {
      let files: string[] = [];
      try { files = (await a.list(`${dir}/running`)).files; } catch { /* no live runs */ }
      for (const f of files.filter((x) => x.endsWith(".json"))) { const t = await readOr(f); if (t !== null) markers.push(t); }
    }
    out.push(teamFrom({
      id, teamMd, board: await readOr(`${dir}/board.jsonl`),
      channel: boardOnly ? null : await readOr(`${dir}/channel.jsonl`), runs: boardOnly ? null : await readOr(`${dir}/runs.jsonl`),
      markers, state: boardOnly ? null : await readOr(`${dir}/STATE.md`), disabled: await a.exists(`${dir}/DISABLED`).catch(() => false),
    }));
  }
  return out;
}

/** Whether a vault event on `path` can change a team. */
export function touchesTeams(path: string): boolean {
  return path === TEAMS_DIR || path.startsWith(`${TEAMS_DIR}/`);
}
