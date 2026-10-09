// Everything the Pulse cockpit and its popup show, read once per refresh (spec 2026-10-08-pulse-cockpit-design §4).
// The facts (data/pulseFacts.ts) decide what needs the user; the rest is what the tiles and the popup's areas list.
import * as path from "path";
import type AgenticOSPlugin from "../../../main";
import { gatherPulseInputs, pulseFacts, type PulseFacts, type PulseInputs } from "../../data/pulseFacts";
import { BRIEFING_PATH, chooseParagraph, parseBriefing, sinceLine, type BriefingFile, type Paragraph } from "../../data/briefingBand";
import { loadSnapshot, type Snapshot } from "../../data/snapshot";
import { loadPipelines, pipelineStatuses, type PipelineStatus } from "../../data/pipelines";
import { buildFixQueue, type FixAction } from "../../data/fixQueue";
import { loadTrail, isPendingReview, type TrailEntry } from "../../data/promoteTrail";
import { loadAllMaps, mapStats } from "../../data/workspaceMaps";
import { buildMonthlyBudget, formatUSD, type BudgetConfig } from "../../data/cost";
import { loadRunsForMonth, type AgentRun } from "../../data/runs";
import { loadStaff, type StaffAgent } from "../../data/staff";
import { loadPersonaHeartbeat, type PersonaHeartbeat } from "../../data/personaHeartbeat";
import { buildRows, listRoutines, readRoutinesState, type RoutineRow } from "../../data/routines";
import { parseTodos, localDay, type Todo } from "../../data/todos";
import { proposalTitle } from "../../data/pulseFacts";
import { ageDays } from "../../data/proposals";
import { readAgenticosJson, readVaultConfig } from "../../data/aosConfig";
import { TERM_HOST_LABEL } from "../../data/terminalLaunch";
import { diskAdapter, memberStatus, pendingGates, readTeams } from "../../data/teams";
import { env, fs, sessionsHost } from "../../host";

export const BRIEFING_ROUTINE_PATH = "brain/routines/briefing.md";

export interface LiveRow { title: string; sub: string; host: string }
export interface TeamRow { id: string; name: string; members: number; working: number; blocked: number; gates: number; paused: boolean }
export interface SpendFamily { family: string; usd: number; calls: number }
export interface DecisionRow { kind: "proposal" | "gate" | "flag" | "drafts"; title: string; sub: string; ref: string; days: number | null }

export interface PulseModel {
  now: Date;
  inputs: PulseInputs;
  facts: PulseFacts;
  paragraph: Paragraph;
  briefing: BriefingFile | null;
  since: { parts: string[]; at: string } | null;
  personaOff: boolean;
  briefingOff: boolean;
  routineInstalled: boolean;
  snapshot: Snapshot | null;
  statuses: PipelineStatus[];
  queue: FixAction[];
  costActive: boolean;
  costLine: string;
  costWarn: boolean;
  trailRows: { entry: TrailEntry; pendingReview: boolean }[];
  staff: StaffAgent[];
  heartbeat: PersonaHeartbeat | null;
  live: LiveRow[];
  routineRows: RoutineRow[];
  todos: Todo[];
  spendDays: { day: string; usd: number }[];
  spendFamilies: SpendFamily[];
  teams: TeamRow[];
  decisions: DecisionRow[];
}

/** USD per local day for the last `days` days, oldest first, from provider-spend.jsonl text. */
export function spendDays(text: string | null, now: Date, days = 7): { day: string; usd: number }[] {
  const out: { day: string; usd: number }[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)), usd: 0 });
  const at = new Map(out.map((d, i) => [d.day, i]));
  for (const line of (text ?? "").split("\n")) {
    let r: { ts?: string; usd?: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    const t = new Date(String(r?.ts));
    if (Number.isNaN(t.getTime()) || typeof r.usd !== "number" || !Number.isFinite(r.usd)) continue;
    const i = at.get(localDay(t));
    if (i !== undefined) out[i].usd += r.usd;
  }
  return out.map((d) => ({ day: d.day, usd: Math.round(d.usd * 100) / 100 }));
}

const FAMILIES: [RegExp, string][] = [
  [/^duty:/, "Chief of Staff duties"], [/^reason:/, "Reasoner"], [/^routine:/, "Routines"], [/^graph:/, "Graph"],
  [/^cross-review:/, "Cross-review"], [/^team:/, "Agent teams"], [/^session:/, "Sessions"],
];

/** Today's spend by family (lib/statusline-model.js familyOf; every other row is a background hook call), largest first. */
export function spendFamilies(text: string | null, now: Date): SpendFamily[] {
  const day = localDay(now);
  const by = new Map<string, SpendFamily>();
  for (const line of (text ?? "").split("\n")) {
    let r: { ts?: string; usd?: unknown; feature?: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    const t = new Date(String(r?.ts));
    if (Number.isNaN(t.getTime()) || localDay(t) !== day) continue;
    const feature = String(r.feature ?? "");
    const family = FAMILIES.find(([re]) => re.test(feature))?.[1] ?? "Background hooks";
    const f = by.get(family) ?? { family, usd: 0, calls: 0 };
    f.calls++;
    if (typeof r.usd === "number" && Number.isFinite(r.usd)) f.usd += r.usd;
    by.set(family, f);
  }
  return [...by.values()].map((f) => ({ ...f, usd: Math.round(f.usd * 100) / 100 })).sort((a, b) => b.usd - a.usd || b.calls - a.calls);
}

/** True when <claude-config-dir>/projects/<any slug>/<sid>.jsonl exists — mirrors auto-cost.js findTranscript(). */
function transcriptExists(sid: string, configDir: string): boolean {
  const root = path.join(configDir, "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return false; }
  return dirs.some((d) => fs.existsSync(path.join(root, d, `${sid}.jsonl`)));
}

/** True when a Codex rollout for `sid` exists under <codex home>/sessions/YYYY/MM/DD or archived_sessions — mirrors
 *  lib/host.js findTranscript('codex'), so a Codex run counts as backfillable exactly when auto-cost can cost it. */
function codexRolloutExists(sid: string, codexHome: string): boolean {
  const named = (f: string) => f.startsWith("rollout-") && f.endsWith(`-${sid}.jsonl`);
  const ls = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };
  if (ls(path.join(codexHome, "archived_sessions")).some(named)) return true;
  const root = path.join(codexHome, "sessions");
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    if (ls(path.join(root, y, m, d)).some(named)) return true;
  }
  return false;
}

/**
 * Runs the "Run auto-cost backfill" card can actually repair. Mirrors auto-cost.js's backfill() gate exactly (same
 * session-id fallback, transcript path, existence check and per-session dedup): a run lacking cost_usd whose transcript
 * is gone is NOT backfillable, and counting it would make the card unclearable.
 */
function countBackfillable(plugin: AgenticOSPlugin, runs: AgentRun[]): number {
  try {
    const configDir = plugin.claudeConfigDir();
    const cfg = readAgenticosJson();
    const codexHome = cfg?.hosts?.codex?.home || env.get("CODEX_HOME") || path.join(env.homedir(), ".codex");
    const seen = new Set<string>();
    let count = 0;
    for (const r of runs) {
      if (typeof r.cost_usd === "number") continue; // already costed — a genuine $0.00 counts
      const sid = (r as AgentRun & { session_id?: string }).session_id || (r.id || "").replace(/^sess-/, "");
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const isCodex = (r as AgentRun & { host?: string }).host === "codex";
      if (isCodex ? codexRolloutExists(sid, codexHome) : transcriptExists(sid, configDir)) count++;
    }
    return count;
  } catch (e) {
    console.warn("[agentic-os] countBackfillable failed, falling back to raw count:", e);
    return runs.filter((r) => typeof r.cost_usd !== "number").length;
  }
}

/** The running agents: Sessions threads with a turn running, and Term's agent terminals that have not ended. */
async function liveRows(plugin: AgenticOSPlugin): Promise<LiveRow[]> {
  const out: LiveRow[] = [];
  try {
    const h = sessionsHost();
    const r = h ? await h.sessions.list() : null;
    if (r && r.ok) for (const t of r.data.filter((x) => x.running)) out.push({ title: t.title || "Session", sub: `${TERM_HOST_LABEL[t.host] ?? t.host} · ${t.workspace} · Sessions`, host: t.host });
  } catch { /* no sessions host (plain Node, tests) */ }
  try {
    for (const s of plugin.terminalPool.list()) {
      if (s.isExited || s.meta.host === "shell") continue;
      const place = s.meta.place ? s.meta.place.label : path.basename(s.cwd);
      out.push({ title: s.getTitle(), sub: `${TERM_HOST_LABEL[s.meta.host]} · ${place} · Code`, host: s.meta.host });
    }
  } catch { /* no terminals */ }
  return out;
}

export async function loadPulseModel(plugin: AgenticOSPlugin, seenAt: string | null, now: Date = new Date()): Promise<PulseModel> {
  const app = plugin.app;
  const a = app.vault.adapter;
  const root = plugin.vaultRoot();
  const read = async (p: string): Promise<string | null> => { try { return (await a.exists(p)) ? await a.read(p) : null; } catch { return null; } };

  const inputs = await gatherPulseInputs(app, root, now);
  const facts = pulseFacts(inputs, now);
  const vcfg = readVaultConfig(root, plugin.claudeConfigDir());
  const persona = vcfg.persona;
  const briefing = parseBriefing(await read(BRIEFING_PATH));
  const staleHours = persona.briefing?.staleHours > 0 ? persona.briefing.staleHours : 3;
  const personaOff = persona.enabled === false || (await a.exists("persona/DISABLED").catch(() => false));

  const snapshot = await loadSnapshot(app);
  const statuses = pipelineStatuses(await loadPipelines(app), now.getTime());

  // The Fix Queue and the cost line, as the old Pulse computed them (its tests and the Health area keep them).
  const monthRuns = await loadRunsForMonth(app);
  let budgetConfig: Partial<BudgetConfig> | undefined;
  try { budgetConfig = JSON.parse(await a.read("brain/_index/cost-budget.json")) as Partial<BudgetConfig>; } catch { budgetConfig = undefined; }
  const sysCost = vcfg.cost;
  const costActive = sysCost.enabled === true && typeof sysCost.monthlyBudget === "number";
  const budget = buildMonthlyBudget(monthRuns, budgetConfig, now, sysCost.monthlyBudget);
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const costLine = monthRuns.length === 0 && !budget.anchored
    ? "no cost data"
    : `${formatUSD(budget.monthToDate)} this month · ${(budget.pctOfBudget * 100).toFixed(1)}% of ${formatUSD(budget.budget)}`;
  const issues = snapshot?.health?.issues ?? [];
  const wsNames = (snapshot?.workspaces ?? []).map((w) => w.name);
  const maps = await loadAllMaps(app, wsNames);
  const queue = buildFixQueue({
    statuses,
    costMonth: budgetConfig?.month ?? null,
    currentMonth,
    calibration: budget.calibration,
    uncostedRuns: countBackfillable(plugin, monthRuns),
    healthErrors: issues.filter((i) => i.severity === "error").length,
    staleArtifacts: issues.filter((i) => i.area === "artifacts").length,
    mapPending: wsNames.map((n) => ({ workspace: n, pending: maps[n] ? mapStats(maps[n]!).pending : 0 })).filter((m) => m.pending > 0),
    costEnabled: costActive,
  });

  const trail = await loadTrail(app, 8);
  const trailRows = await Promise.all(trail.map(async (entry) => ({ entry, pendingReview: entry.action === "written" && (await isPendingReview(app, entry)) })));

  let routineRows: RoutineRow[] = [];
  try { routineRows = buildRows(await listRoutines(app), await readRoutinesState(app), now); } catch { /* none */ }

  const ledger = await read("brain/_index/provider-spend.jsonl");
  let teams: TeamRow[] = [];
  try {
    teams = (await readTeams(diskAdapter(root))).filter((t) => !t.error).map((t) => {
      const ms = memberStatus(t);
      return { id: t.id, name: t.name || t.id, members: ms.length, working: ms.filter((m) => m.status === "working").length, blocked: ms.filter((m) => m.status === "blocked").length, gates: pendingGates(t).length, paused: t.disabled };
    });
  } catch { /* no teams */ }

  const decisions: DecisionRow[] = [];
  for (const g of inputs.gates) decisions.push({ kind: "gate", title: `${g.title || g.item}`, sub: `${g.team} · ${g.stage ?? "gate"} gate`, ref: `${g.team}/${g.item}`, days: g.since ? ageDays(g.since.slice(0, 10), now) : null });
  for (const p of inputs.proposals) {
    const { title, filed } = proposalTitle(p.name, p.text);
    decisions.push({ kind: "proposal", title, sub: `proposal · filed ${filed}`, ref: p.name, days: ageDays(filed, now) });
  }
  for (const n of facts.needsYou.filter((x) => x.kind === "flag")) decisions.push({ kind: "flag", title: n.title, sub: `flag${n.since ? ` · since ${n.since}` : ""} · persona/STATE.md`, ref: n.ref, days: n.since ? ageDays(n.since, now) : null });
  if (inputs.drafts) decisions.push({ kind: "drafts", title: `${inputs.drafts} feedback rule draft${inputs.drafts === 1 ? "" : "s"}`, sub: "brain/memory/feedback/_drafts · feedback-review", ref: "feedback-drafts", days: null });

  return {
    now, inputs, facts, briefing,
    paragraph: chooseParagraph(briefing, facts, now, staleHours),
    since: sinceLine(inputs, seenAt, now),
    personaOff, briefingOff: persona.briefing?.enabled === false,
    routineInstalled: await a.exists(BRIEFING_ROUTINE_PATH).catch(() => false),
    snapshot, statuses, queue, costActive, costLine, costWarn: budget.stale || budget.calibration <= 0,
    trailRows,
    staff: await loadStaff(app).catch(() => []),
    heartbeat: await loadPersonaHeartbeat(app).catch(() => null),
    live: await liveRows(plugin),
    routineRows,
    todos: parseTodos(inputs.todo ?? ""),
    spendDays: spendDays(ledger, now),
    spendFamilies: spendFamilies(ledger, now),
    teams,
    decisions,
  };
}
